// Claude Code 常驻 Compute 适配器(AC-51、需求文档 D27):一个 Compute 一个常驻 CLI 进程,跨轮同一 PID、同一会话 id,从 stdin 接新输入。
//   - 启动:claude -p --input-format stream-json --output-format stream-json --verbose --session-id <S> --model <M> [--effort <E>] + 与一次性适配器相同的隔离参数
//     (--bare、--strict-mcp-config + report_progress MCP、--tools/--allowedTools、--permission-mode dontAsk、--append-system-prompt);
//     首个提示作为第一条 user 消息写入 stdin。每轮以 result 结束,进程不退出,等下一条输入。
//   - 每轮带生效模型(D27 第 4 节第 1、2 条):resume 的第三参是这一轮宿主现场解析出的 {model, effort}。适配器记着会话当前实际模型
//     (每轮 init 的 model、set_model 回包的 model),不同就在轮边界先发 control_request set_model,等 control_response success 再写输入;
//     只改 effort 用 apply_flag_settings {effortLevel};没变就什么切换请求都不发。
//   - 在途这一轮不打断(第 3 条):轮进行中来的 resume 排到这一轮 result 之后才计划和切换;steer 直接插进当前这一轮,不换模型。
//   - 切换失败不静默(第 4 条):set_model 回 error 或超时,这一轮输入不写入,resume 返回 code:"model-switch-failed" 与两条修复路径;不退回旧模型继续跑。
//     超时后会话当前模型记为不明,下一轮无论如何先切再发。
//   - 兜底重启(第 5 条):只有能力声明 inSessionModelSwitch:false,或 harness 回报切换请求本身不可用(不是模型被拒)时,
//     在轮边界结束旧进程,用 --resume <S> --model <新> 重启,会话 id 不变。空闲回收(idleReclaimMs)后下一轮同样用同一会话 id、带这一轮的生效模型恢复。
//   - 账本(第 6 条):completed/failed 事件带这一轮开始时会话模型 model 与 harness 回报这一轮实际用过的模型 models(model_usage_since_last_result 的键)。
//   - 受阻:report_progress blocked 受理后这一轮以 blocked 结束(不再产出 completed),进程照常等 stdin,不需要 SIGSTOP 冻结。
//   - 停止:照 mirasim 0.0.774 z2 的 POSIX 路径(g-group#2309):SIGTERM 只发主进程,reapForceMs 后仍未退出才对进程组 SIGKILL;stopped 立即产出。
//   - 停止确认(AC-23,§8.1 已定第 16 条):停止时先记下主进程的后代与同组成员;quiesce 等主进程退出,再把它们还活着的 SIGKILL、轮询到都退出才回报
//     (与一次性适配器同一套,stop-confirm.ts)。这一轮已失败或完成、常驻进程还活着时,quiesce 先结束它,下一轮用同一会话 id 恢复。
//   - 勾选能力(AC-29,D07 §3):spawn 收 configDir / pluginDirs / mcpServers,设 CLAUDE_CONFIG_DIR、逐个 --plugin-dir,勾选 MCP 与 host 合并进
//     --mcp-config;每个进程(含恢复、兜底重启)都按它起;每轮 init 按 harness 自报核对配置生效(isolation.ts,与一次性适配器同一套)。
//   - 活动(AC-43,D26 第 8.3 节):--include-partial-messages,stdout 每一行经 activityOf 认出活动推给 activity() 的订阅者;
//     只在这个进程的 init 核验通过、这一轮在跑且没被判违规时推。只观察 harness 的输出,不拦截 Compute 的任何调用。
// 外部输入(选项、brief、spawn 选项、computeId、续接文本、生效模型)读取前按纯数据合同判定(plain.ts),合同限定内置原型未被改的环境(g-group#2662)。
// CLI 输出每行在受控边界里处理:任何解码/映射异常只让当前 Compute 记违规并回收,不逸出 readline 回调。
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DEFAULT_RUNNER, REPORT_MCP_PATH, activityHub, resolveReapForceMs } from "./adapter.ts";
import { checkBrief, checkSnapshot } from "./brief.ts";
import { SYSTEM_PROMPT, allowedTools, cliEnv } from "./cli.ts";
import { type AcceptedReport, activityOf, preInitFrame, streamParser } from "./events.ts";
import { type Isolation, NO_ISOLATION, checkInitIsolation, isolationOf, mcpConfigFor, promptWithSkills } from "./isolation.ts";
import { freezeDeep, isPlainRecord, plainData } from "./plain.ts";
import { IS_WINDOWS, type ProcRow, signalGroup } from "./procgroup.ts";
import { confirmStopped, treeNow } from "./stop-confirm.ts";
import { checkTurnModel, planTurn, type SessionModel, switchRefusalKind } from "./turn-model.ts";
import type { AdapterOptions, Brief, ComputeActivity, ComputeAdapter, ComputeEvent, HandoffSnapshot, Manifest, QuiesceResult, Refusal, RejectedReport, TurnModel } from "./types.ts";

export interface ResidentAdapterOptions extends AdapterOptions {
  /** harness 支持会话内换模型 id;false 时换模型走兜底重启(同一会话 id)。默认 true(Claude Code 2.1.319 实测 set_model 可用) */
  readonly inSessionModelSwitch?: boolean;
  /** harness 支持会话内改推理强度(apply_flag_settings effortLevel);false 时只改 effort 也走兜底重启。默认 true */
  readonly inSessionEffort?: boolean;
  /** 等 set_model / apply_flag_settings 回包的上限(毫秒),超时算切换失败。默认 60000(实测换到不存在的模型约 15 秒才回 error) */
  readonly switchTimeoutMs?: number;
  /** 一轮结束后空闲多久回收进程(毫秒);下一轮用同一会话 id 恢复。不给就不回收 */
  readonly idleReclaimMs?: number;
}

export const DEFAULT_SWITCH_TIMEOUT_MS = 60_000;
const OPTION_KEYS: readonly string[] = Object.freeze(["runner", "hostEnv", "reapForceMs", "reportServer", "inSessionModelSwitch", "inSessionEffort", "switchTimeoutMs", "idleReclaimMs"]);
const SPAWN_KEYS: readonly string[] = Object.freeze(["handoff", "cwd", "model", "effort", "configDir", "pluginDirs", "mcpServers"]);
const FIXES = Object.freeze(["explicit-compatible-model", "change-harness"] as const);

type Command = { readonly command: string; readonly args?: readonly string[] };
interface Config {
  readonly runner: Command;
  readonly hostEnv: Readonly<Record<string, string>> | undefined;
  readonly reapForceMs: number | undefined;
  readonly server: Command;
  readonly inSessionModelSwitch: boolean;
  readonly inSessionEffort: boolean;
  readonly switchTimeoutMs: number;
  readonly idleReclaimMs: number | undefined;
}

const isStrArr = (x: unknown): x is readonly string[] => Array.isArray(x) && x.every((s) => typeof s === "string");
const isNonNeg = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
const refuse = (reason: string): Refusal => ({ ok: false, reason });
const switchFailed = (reason: string): Refusal => Object.freeze({ ok: false, reason, code: "model-switch-failed", fixes: FIXES });
const errorText = (err: unknown): string => (err instanceof Error && typeof err.message === "string" ? err.message : "非 Error 异常");
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function commandOf(x: unknown, name: string): Command | undefined {
  if (x === undefined) return undefined;
  if (!isPlainRecord(x) || typeof x.command !== "string" || !x.command || Object.keys(x).some((k) => k !== "command" && k !== "args") || (x.args !== undefined && !isStrArr(x.args))) {
    throw new TypeError(`适配器选项 ${name} 必须是 {command: 非空字符串, args?: 字符串数组}`);
  }
  return x as Command;
}

function residentConfig(options: unknown): Config {
  const p = plainData(options, "适配器选项");
  if (!p.ok) throw new TypeError(`适配器选项必须是纯数据:${p.path} ${p.why}`);
  const o = p.value;
  if (!isPlainRecord(o)) throw new TypeError("适配器选项必须是对象");
  const extra = Object.keys(o).filter((k) => !OPTION_KEYS.includes(k));
  if (extra.length) throw new TypeError(`适配器选项只收 ${OPTION_KEYS.join("/")},拒绝 ${extra.join(", ")}`);
  const { hostEnv, reapForceMs, inSessionModelSwitch, inSessionEffort, switchTimeoutMs, idleReclaimMs } = o;
  if (hostEnv !== undefined && !(isPlainRecord(hostEnv) && Object.values(hostEnv).every((v) => typeof v === "string"))) throw new TypeError("适配器选项 hostEnv 必须是字符串到字符串的对象");
  if (reapForceMs !== undefined && !isNonNeg(reapForceMs)) throw new TypeError("适配器选项 reapForceMs 必须是非负有限数");
  if (inSessionModelSwitch !== undefined && typeof inSessionModelSwitch !== "boolean") throw new TypeError("适配器选项 inSessionModelSwitch 必须是布尔值");
  if (inSessionEffort !== undefined && typeof inSessionEffort !== "boolean") throw new TypeError("适配器选项 inSessionEffort 必须是布尔值");
  if (switchTimeoutMs !== undefined && !(isNonNeg(switchTimeoutMs) && switchTimeoutMs > 0)) throw new TypeError("适配器选项 switchTimeoutMs 必须是正数");
  if (idleReclaimMs !== undefined && !isNonNeg(idleReclaimMs)) throw new TypeError("适配器选项 idleReclaimMs 必须是非负有限数");
  return {
    runner: commandOf(o.runner, "runner") ?? DEFAULT_RUNNER,
    hostEnv: hostEnv as Readonly<Record<string, string>> | undefined,
    reapForceMs: reapForceMs as number | undefined,
    server: commandOf(o.reportServer, "reportServer") ?? { command: process.execPath, args: [REPORT_MCP_PATH] },
    inSessionModelSwitch: inSessionModelSwitch ?? true,
    inSessionEffort: inSessionEffort ?? true,
    switchTimeoutMs: (switchTimeoutMs as number | undefined) ?? DEFAULT_SWITCH_TIMEOUT_MS,
    idleReclaimMs: idleReclaimMs as number | undefined,
  };
}

interface SpawnOpts {
  readonly handoff: HandoffSnapshot | undefined;
  readonly cwd: string | undefined;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  /** 勾选能力(AC-29) */
  readonly iso: Isolation;
}
function spawnOptions(opts: unknown): ({ readonly ok: true } & SpawnOpts) | Refusal {
  if (opts === undefined) return { ok: true, handoff: undefined, cwd: undefined, model: undefined, effort: undefined, iso: NO_ISOLATION };
  const p = plainData(opts, "spawn 选项");
  if (!p.ok) return refuse(`spawn 选项必须是纯数据:${p.path} ${p.why}`);
  const o = p.value;
  if (!isPlainRecord(o)) return refuse("spawn 选项必须是对象");
  const extra = Object.keys(o).filter((k) => !SPAWN_KEYS.includes(k));
  if (extra.length) return refuse(`spawn 选项只收 ${SPAWN_KEYS.join("/")},拒绝 ${extra.join(", ")}`);
  for (const k of ["cwd", "model", "effort"] as const) if (o[k] !== undefined && (typeof o[k] !== "string" || !o[k])) return refuse(`spawn 选项 ${k} 必须是非空字符串`);
  const iso = isolationOf(o);
  if (typeof iso === "string") return refuse(iso);
  let handoff: HandoffSnapshot | undefined;
  if (o.handoff !== undefined) {
    const h = checkSnapshot(o.handoff);
    if (!h.ok) return h;
    handoff = h.snapshot;
  }
  return { ok: true, handoff, cwd: o.cwd as string | undefined, model: o.model as string | undefined, effort: o.effort as string | undefined, iso };
}

/** 常驻 CLI 的启动参数:与一次性适配器相同的隔离做法,换成从 stdin 收 stream-json;resume=true 时接回同一会话。
 *  pluginDirs(绝对路径)逐个 --plugin-dir,mcpServers(勾选的 MCP 服务器名)整组进 --allowedTools(AC-29) */
export function residentArgs(input: Brief, mcpConfigPath: string, launch: { readonly sessionId: string; readonly resume: boolean; readonly model?: string; readonly effort?: string; readonly pluginDirs?: readonly string[]; readonly mcpServers?: readonly string[] }): readonly string[] {
  const b = checkBrief(input);
  if (!b.ok) throw new TypeError(`residentArgs 的 brief 不合格:${b.reason}`);
  if (typeof mcpConfigPath !== "string" || !mcpConfigPath) throw new TypeError("residentArgs 的 mcpConfigPath 必须是非空字符串");
  const p = plainData(launch, "launch");
  if (!p.ok || !isPlainRecord(p.value)) throw new TypeError("residentArgs 的 launch 必须是纯数据对象");
  const l = p.value;
  if (typeof l.sessionId !== "string" || !l.sessionId || typeof l.resume !== "boolean") throw new TypeError("residentArgs 的 launch 需要 sessionId 与 resume");
  if ((l.model !== undefined && (typeof l.model !== "string" || !l.model)) || (l.effort !== undefined && (typeof l.effort !== "string" || !l.effort))) throw new TypeError("residentArgs 的 model/effort 必须是非空字符串");
  if (l.pluginDirs !== undefined && !(isStrArr(l.pluginDirs) && l.pluginDirs.every((d) => path.isAbsolute(d)))) throw new TypeError("residentArgs 的 pluginDirs 必须是绝对路径数组");
  if (l.mcpServers !== undefined && !isStrArr(l.mcpServers)) throw new TypeError("residentArgs 的 mcpServers 必须是字符串数组");
  const pluginDirs = (l.pluginDirs as readonly string[] | undefined) ?? [];
  const brief = b.brief;
  return Object.freeze([
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    // 流式增量(D26 第 8.3 节):首字节与长输出进行中都有行可看;真实 CLI 2.1.319 在 stdin 收 stream-json 时同样支持(proof/resident-partial-messages-probe.txt)
    "--include-partial-messages",
    ...(l.resume ? ["--resume", l.sessionId] : ["--session-id", l.sessionId]),
    ...(l.model ? ["--model", l.model as string] : []),
    ...(l.effort ? ["--effort", l.effort as string] : []),
    "--bare",
    // --bare 下 skill 只从 --plugin-dir 加载:只给联系人勾选的那些(AC-29,V-02 实测)
    ...pluginDirs.flatMap((d) => ["--plugin-dir", d]),
    "--mcp-config", mcpConfigPath, "--strict-mcp-config",
    "--tools", brief.tools.join(","),
    "--allowedTools", allowedTools(brief, l.mcpServers as readonly string[] | undefined).join(","),
    "--permission-mode", "dontAsk",
    "--append-system-prompt", SYSTEM_PROMPT,
  ]);
}

interface Proc {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  readonly exited: Promise<void>;
  isExited: boolean;
  /** 这个进程是不是接回旧会话起的(--resume) */
  readonly resumed: boolean;
  /** 这个进程已经报过 started */
  started: boolean;
  /** 这个进程收到过第一个 init */
  sawInit: boolean;
  reaping: boolean;
  /** 宿主要它退出(换模型兜底重启、空闲回收、停止):退出不算这一轮失败 */
  expectedExit: boolean;
  stderr: string;
  readonly parse: (line: string) => ReturnType<ReturnType<typeof streamParser>>;
  /** 停止(或停止确认结束它)时按进程表记下的后代与同组成员(AC-23);[] 是还没记,null 是记的时候读不到进程表 */
  tree: readonly ProcRow[] | null;
}

interface Turn {
  readonly events: ComputeEvent[];
  readonly done: Promise<void>;
  readonly finish: () => void;
  finished: boolean;
  /** 这一轮开始时会话的当前模型(以 init 为准) */
  model: string | null;
  blocked: boolean;
  halted: boolean;
  readonly violations: string[];
  reportedFailure: string | undefined;
  kind: "completed" | "failed" | "blocked" | "stopped" | null;
}

interface State {
  readonly id: string;
  readonly brief: Brief;
  readonly cwd: string;
  readonly sessionId: string;
  /** 勾选能力(AC-29):每个进程(含恢复、兜底重启)都按它起 */
  readonly iso: Isolation;
  proc: Proc | null;
  /** 最近一次起的进程(退出后仍留着,停止确认要它的 pid 与停止时记下的后代) */
  lastProc: Proc | null;
  /** harness 回报的会话当前实际模型;null 表示不明 */
  model: string | null;
  effort: string | undefined;
  turn: Turn | null;
  stopped: boolean;
  /** 一个 resume 已认领续接(可能在等这一轮结束、或在切换模型):同一时刻只受理一个 */
  resuming: boolean;
  readonly controls: Map<string, (r: ControlReply) => void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  constraintVer: unknown;
  openQuestions: readonly string[];
  doneSideEffects: string[];
  readonly rejected: RejectedReport[];
  unresolved: RejectedReport[];
}

type ControlReply = { readonly ok: true; readonly response: Record<string, unknown> } | { readonly ok: false; readonly code: string | undefined; readonly error: string | undefined; readonly timeout?: true; readonly exited?: true };
/** CLI 回包里的 error_code/error 是外部 JSON:只取字符串,其余当缺省(不做隐式转换) */
const strOrUndef = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function eventHub() {
  const log: ComputeEvent[] = [];
  let wake: (() => void)[] = [];
  return {
    push(e: ComputeEvent) {
      log.push(e);
      const w = wake;
      wake = [];
      for (const f of w) f();
    },
    async *iterate(): AsyncGenerator<ComputeEvent> {
      let i = 0;
      for (;;) {
        while (i < log.length) yield log[i++]!;
        await new Promise<void>((r) => wake.push(r));
      }
    },
  };
}

const eventCopy = (e: ComputeEvent): ComputeEvent => {
  const out: Record<string, unknown> = { ...e };
  for (const [k, v] of Object.entries(out)) if (Array.isArray(v)) out[k] = [...v];
  return out as ComputeEvent;
};

/** result 帧里这一轮实际用过的模型:先取 model_usage_since_last_result(每轮),没有再退回 modelUsage(会话累计) */
export function turnModels(resultInput: Record<string, unknown>): readonly string[] {
  // 经包根导出,是外部入口(R6-01):先过纯数据合同,之后只读冻结副本
  const p = plainData(resultInput, "result");
  if (!p.ok || !isPlainRecord(p.value)) throw new TypeError(`turnModels 的 result 必须是纯数据对象${p.ok ? "" : `:${p.path} ${p.why}`}`);
  const result = p.value;
  const pick = (x: unknown) => (isPlainRecord(x) ? Object.keys(x) : null);
  return Object.freeze([...(pick(result.model_usage_since_last_result) ?? pick(result.modelUsage) ?? [])]);
}
/** 适配器内部用:CLI 的 result 帧形状异常(嵌套过深等)时这一轮实际模型记为空,不让这一轮因为用量字段失败 */
const turnModelsOf = (m: Record<string, unknown>): readonly string[] => {
  try {
    return turnModels({ model_usage_since_last_result: m.model_usage_since_last_result, modelUsage: m.modelUsage });
  } catch {
    return Object.freeze([]);
  }
};

export function createResidentComputeAdapter(options: ResidentAdapterOptions = {}): ComputeAdapter {
  const cfg = residentConfig(options);
  const hub = eventHub();
  const acts = activityHub();
  const computes = new Map<string, State>();
  // isolation:收专属配置目录与勾选的 skill/MCP(宿主据此才把勾选能力交给常驻适配器,AC-29)
  const caps = Object.freeze({ inSessionModelSwitch: cfg.inSessionModelSwitch, isolation: true });

  function emit(st: State, e: ComputeEvent) {
    const snap = freezeDeep(eventCopy(e));
    st.turn?.events.push(snap);
    hub.push(snap);
  }

  function reap(proc: Proc) {
    if (proc.reaping) return;
    proc.reaping = true;
    const p = proc.child;
    if (p.exitCode !== null || p.signalCode !== null) return;
    try { p.kill("SIGTERM"); } catch { /* 已退出 */ }
    const ms = resolveReapForceMs(cfg.reapForceMs, process.env.MIRASIM_REAP_FORCE_MS);
    const timer = setTimeout(() => signalGroup(proc.pid, "SIGKILL"), ms);
    timer.unref();
    p.once("exit", () => clearTimeout(timer));
  }

  /** 宿主要求进程退出(兜底重启、空闲回收):先关 stdin 让 CLI 自己收尾,3 秒没退再按停止语义回收;等主进程退出 */
  async function endProc(st: State) {
    const proc = st.proc;
    if (!proc) return;
    proc.expectedExit = true;
    try { proc.child.stdin?.end(); } catch { /* 已关 */ }
    const t = setTimeout(() => reap(proc), 3000);
    await proc.exited;
    clearTimeout(t);
    if (st.proc === proc) st.proc = null;
  }

  function violate(st: State, msg: string) {
    const turn = st.turn;
    if (turn && !turn.finished) {
      turn.violations.push(msg);
      if (turn.halted) return;
      turn.halted = true;
    }
    if (st.proc) reap(st.proc);
  }

  function endTurn(st: State, turn: Turn) {
    if (turn.finished) return;
    turn.finished = true;
    turn.finish();
    if (cfg.idleReclaimMs !== undefined && !st.stopped && st.proc) {
      const proc = st.proc;
      st.idleTimer = setTimeout(() => {
        st.idleTimer = null;
        if (st.proc === proc && st.turn?.finished && !st.resuming) void endProc(st);
      }, cfg.idleReclaimMs);
      st.idleTimer.unref();
    }
  }

  function finishTurn(st: State, turn: Turn, out: { readonly success: boolean; readonly text: string; readonly models: readonly string[] } | { readonly exitReason: string }) {
    if (turn.finished) return;
    const models = "models" in out ? out.models : [];
    const base = { computeId: st.id, ...(turn.model !== null ? { model: turn.model } : {}), models };
    const fail = (reason: string) => {
      turn.kind = "failed";
      emit(st, { ...base, kind: "failed", reason, code: null, signal: null, violations: [...turn.violations] });
    };
    if (turn.violations.length) fail(turn.violations[0]!);
    else if (turn.blocked) turn.kind = "blocked";
    else if ("exitReason" in out) fail(out.exitReason);
    else if (!out.success) fail(out.text ? `CLI 报告执行出错:${out.text}` : "CLI 报告执行出错");
    else if (turn.reportedFailure !== undefined) fail(`Compute 汇报放弃:${turn.reportedFailure}`);
    else if (st.unresolved.length) fail(`汇报被拒收且没有合规重报:${st.unresolved.map((u) => `${typeof u.kind === "string" ? u.kind : "(非字符串)"}:${u.reason}`).join(";")}`);
    else {
      turn.kind = "completed";
      emit(st, { ...base, kind: "completed", result: out.text });
    }
    endTurn(st, turn);
  }

  function absorb(st: State, turn: Turn, r: AcceptedReport) {
    if (r.constraintVer !== undefined) st.constraintVer = r.constraintVer;
    if (r.openQuestions !== undefined) st.openQuestions = Object.freeze([...r.openQuestions]);
    if (r.doneSideEffects !== undefined) for (const x of r.doneSideEffects) if (!st.doneSideEffects.includes(x)) st.doneSideEffects.push(x);
    if (r.kind === "blocked" || r.kind === "failed") st.unresolved = st.unresolved.filter((u) => u.kind !== r.kind);
    if (r.kind === "milestone" && r.stage !== undefined) emit(st, { computeId: st.id, kind: "milestone", stage: r.stage, summary: r.summary });
    if (r.kind === "failed") turn.reportedFailure = r.summary;
    if (r.kind === "blocked" && r.needs !== undefined && !turn.blocked) {
      // 常驻模式:受理 blocked 后这一轮以受阻结束,进程照常等 stdin,宿主 resume 时往同一进程写回答
      turn.blocked = true;
      emit(st, { computeId: st.id, kind: "blocked", needs: r.needs, summary: r.summary });
    }
  }

  function onControlRequest(st: State, m: Record<string, unknown>) {
    // CLI 向宿主发的控制请求(本适配器以 dontAsk 运行,不应出现):一律回 error,避免 CLI 一直等
    const rid = m.request_id;
    if (typeof rid !== "string" || !st.proc) return;
    write(st.proc, { type: "control_response", response: { subtype: "error", request_id: rid, error: "宿主不处理这个控制请求" } });
  }

  function onLine(st: State, proc: Proc, line: string) {
    if (!line.trim()) return;
    let m: Record<string, unknown> | undefined;
    try { const j = JSON.parse(line); m = isPlainRecord(j) ? (j as Record<string, unknown>) : undefined; } catch { m = undefined; }
    if (m?.type === "control_response") {
      const r = isPlainRecord(m.response) ? (m.response as Record<string, unknown>) : undefined;
      const rid = r?.request_id;
      const waiter = typeof rid === "string" ? st.controls.get(rid) : undefined;
      if (!r || !waiter || typeof rid !== "string") return;
      st.controls.delete(rid);
      if (r.subtype === "success") waiter({ ok: true, response: isPlainRecord(r.response) ? (r.response as Record<string, unknown>) : {} });
      else waiter({ ok: false, code: strOrUndef(r.error_code), error: strOrUndef(r.error) });
      return;
    }
    if (m?.type === "control_request") { onControlRequest(st, m); return; }
    // set_model 等本地命令的回显(isReplay 的 user 帧)不属于任何一轮
    if (m?.type === "user" && m.isReplay === true) return;
    const turn = st.turn;
    if (turn?.halted) return;
    // 这个进程的第一个 init 之前只放行真实 CLI 会输出的 system 帧(R3-03)
    if (!proc.sawInit) {
      const pre = preInitFrame(line);
      if (pre.kind === "allowed") return;
      if (pre.kind === "rejected") { violate(st, `CLI 在 init 之前输出了未认可的内容:${pre.reason}`); return; }
    }
    for (const s of proc.parse(line)) {
      if (turn?.halted) return;
      if (s.type === "bad-init") { violate(st, `CLI 的 init 无法核验:${s.reason}`); return; }
      if (s.type === "init") {
        // 常驻模式下每轮都有一个 init:会话 id 必须一直是这个 Compute 的,工具清单不能越出 brief
        if (s.sessionId !== st.sessionId) { violate(st, `CLI 的会话 id 变成了 ${s.sessionId},应为 ${st.sessionId}`); return; }
        // 勾选能力(AC-29,isolation.ts):工具不越出 brief 与勾选的 MCP、只许 host 与勾选的 MCP、勾选的都连上
        const iso = checkInitIsolation(st.brief, st.iso, s.tools, line);
        if (!iso.ok) { violate(st, iso.reason); return; }
        proc.sawInit = true;
        const model = typeof m?.model === "string" && m.model ? m.model : null;
        if (model !== null) st.model = model;
        if (turn && !turn.finished) turn.model = st.model;
        if (!proc.started) {
          proc.started = true;
          emit(st, { computeId: st.id, kind: "started", sessionId: st.sessionId, resumed: proc.resumed, ...(st.model !== null ? { model: st.model } : {}), ...(proc.pid !== undefined ? { pid: proc.pid } : {}), loaded: iso.loaded });
        }
        continue;
      }
      if (!turn || turn.finished) continue;
      if (s.type === "report") absorb(st, turn, s.report);
      else if (s.type === "invalid-report" || s.type === "rejected-report") {
        const reason = s.type === "invalid-report" ? s.errors.join(";") : s.reason;
        const rec = freezeDeep({ kind: structuredClone(s.kind), reason });
        st.rejected.push(rec);
        if (s.kind === "blocked" || s.kind === "failed") st.unresolved = [...st.unresolved, rec];
      } else if (s.type === "result") finishTurn(st, turn, { success: s.success, text: s.text, models: m ? turnModelsOf(m) : [] });
    }
  }

  function write(proc: Proc, obj: unknown): boolean {
    const stdin = proc.child.stdin;
    if (!stdin || stdin.destroyed || proc.isExited) return false;
    try { stdin.write(`${JSON.stringify(obj)}\n`); return true; } catch { return false; }
  }

  function launch(st: State, resume: boolean, model: string | undefined, effort: string | undefined): Proc {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g-group-ccr-"));
    const removeDir = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉不影响 */ } };
    const mcpConfig = path.join(dir, "mcp.json");
    let child: ChildProcess;
    try {
      fs.writeFileSync(mcpConfig, JSON.stringify(mcpConfigFor(st.iso, cfg.server)));
      const launchArgs = { sessionId: st.sessionId, resume, ...(model ? { model } : {}), ...(effort ? { effort } : {}), pluginDirs: [...st.iso.pluginDirs], mcpServers: Object.keys(st.iso.mcpServers) };
      const args = [...(cfg.runner.args ?? []), ...residentArgs(st.brief, mcpConfig, launchArgs)];
      child = spawnChild(cfg.runner.command, args, { cwd: st.cwd, env: cliEnv(st.brief, st.id, cfg.hostEnv, st.iso.configDir), stdio: ["pipe", "pipe", "pipe"], detached: !IS_WINDOWS });
    } catch (err) {
      removeDir();
      throw err;
    }
    let markExited: () => void = () => {};
    const exited = new Promise<void>((r) => { markExited = r; });
    const parse = streamParser();
    const proc: Proc = { child, pid: child.pid, exited, isExited: false, resumed: resume, started: false, sawInit: false, reaping: false, expectedExit: false, stderr: "", parse, tree: [] };
    st.proc = proc;
    st.lastProc = proc;
    // 启动参数里的模型就是会话当前模型,直到 init 或 set_model 回包更正
    if (model) st.model = model;
    if (effort) st.effort = effort;
    child.stdin?.on("error", () => { /* 进程退出时写 stdin 会 EPIPE,交给 exit 处理 */ });
    child.stderr?.on("data", (d: Buffer) => { proc.stderr = (proc.stderr + d.toString("utf8")).slice(-2000); });
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      try {
        onLine(st, proc, line);
      } catch (err) {
        violate(st, `处理 CLI 输出时出错:${errorText(err)}`);
      }
      // 活动(卡死检测用,D26 第 8.3 节):这个进程的 init 核验通过、这一轮在跑且没被判违规时才推;解析失败不影响语义事件
      const turn = st.turn;
      if (proc.sawInit && st.proc === proc && turn && !turn.finished && !turn.halted) {
        try {
          for (const a of activityOf(line)) acts.push(Object.freeze({ computeId: st.id, ...a }) as ComputeActivity);
        } catch { /* 活动只是计时依据 */ }
      }
    });
    const closed = new Promise<void>((r) => rl.on("close", () => r()));
    const onExit = (code: number | null, signal: string | null) => {
      void (async () => {
        await Promise.race([closed, delay(2000)]);
        proc.isExited = true;
        if (st.proc === proc) st.proc = null;
        removeDir();
        // 还在等回包的控制请求:进程没了,按切换失败处理
        for (const [rid, w] of [...st.controls]) { st.controls.delete(rid); w({ ok: false, code: "exited", error: "CLI 进程已退出", exited: true }); }
        const turn = st.turn;
        if (turn && !turn.finished && !st.stopped) {
          const why = signal !== null ? `进程被信号 ${signal} 结束` : `进程以 ${code} 退出`;
          const tail = proc.stderr.trim().split("\n").slice(-3).join(" | ");
          if (!proc.sawInit && turn.violations.length === 0) turn.violations.push("CLI 没有输出可校验的 init");
          finishTurn(st, turn, { exitReason: tail ? `${why}:${tail}` : why });
        }
        markExited();
      })();
    };
    child.on("exit", onExit);
    child.on("error", (err) => { proc.stderr = `${proc.stderr}${err.message}`; if (child.exitCode === null && child.signalCode === null) onExit(null, null); });
    return proc;
  }

  function control(st: State, request: Record<string, unknown>): Promise<ControlReply> {
    const proc = st.proc;
    if (!proc) return Promise.resolve({ ok: false, code: "exited", error: "CLI 进程不在", exited: true });
    const rid = `g-group-${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (st.controls.delete(rid)) resolve({ ok: false, code: "timeout", error: `${cfg.switchTimeoutMs}ms 内没有回包`, timeout: true }); }, cfg.switchTimeoutMs);
      st.controls.set(rid, (r) => { clearTimeout(timer); resolve(r); });
      if (!write(proc, { type: "control_request", request_id: rid, request })) {
        clearTimeout(timer);
        st.controls.delete(rid);
        resolve({ ok: false, code: "exited", error: "写不进 CLI 的 stdin", exited: true });
      }
    });
  }

  function startTurn(st: State, text: string, priority?: "now") {
    let finish: () => void = () => {};
    const done = new Promise<void>((r) => { finish = r; });
    const turn: Turn = { events: [], done, finish: () => finish(), finished: false, model: st.model, blocked: false, halted: false, violations: [], reportedFailure: undefined, kind: null };
    st.turn = turn;
    if (st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = null; }
    const proc = st.proc;
    if (!proc || !write(proc, { type: "user", message: { role: "user", content: text }, ...(priority ? { priority } : {}) })) {
      finishTurn(st, turn, { exitReason: "CLI 进程不在,输入没有写进去" });
    }
  }

  /** 确保有活着的进程:空闲回收、停止确认结束或崩溃后,用同一会话 id、带这一轮的生效模型恢复。
   *  正在被结束的进程(停止确认、空闲回收)不再往里写输入:等它退出再恢复 */
  async function ensureProc(st: State, want: TurnModel | undefined) {
    if (st.proc && !st.proc.isExited && st.proc.expectedExit) await st.proc.exited;
    if (st.proc && !st.proc.isExited) return;
    launch(st, true, want?.model ?? st.model ?? undefined, want?.effort ?? st.effort);
  }

  /** 按计划在轮边界切换,成功后写入这一轮输入 */
  async function runTurn(st: State, text: string, want: TurnModel | undefined): Promise<{ readonly ok: true } | Refusal> {
    await ensureProc(st, want);
    if (st.stopped) return refuse("这个 Compute 已被停止");
    const current: SessionModel = { model: st.model, ...(st.effort !== undefined ? { effort: st.effort } : {}) };
    const steps = want === undefined && current.model === null ? [{ kind: "send" as const, model: "" }] : planTurn(current, want, { inSessionModelSwitch: cfg.inSessionModelSwitch, inSessionEffort: cfg.inSessionEffort });
    for (const step of steps) {
      if (st.stopped) return refuse("这个 Compute 已被停止");
      if (step.kind === "set-model") {
        const r = await control(st, { subtype: "set_model", model: step.model });
        if (r.ok) {
          st.model = typeof r.response.model === "string" && r.response.model ? r.response.model : step.model;
          continue;
        }
        if (!r.timeout && !r.exited && switchRefusalKind(r.code, r.error) === "unavailable") {
          // 切换请求本身不可用:兜底重启并接回同一会话
          await endProc(st);
          if (st.stopped) return refuse("这个 Compute 已被停止");
          launch(st, true, step.model, want?.effort ?? st.effort);
          continue;
        }
        if (r.timeout) st.model = null;
        return switchFailed(`换到模型 ${step.model} 失败:${r.error ?? "harness 拒绝"}${r.code !== undefined ? `(${r.code})` : ""};这一轮没有发出`);
      }
      if (step.kind === "set-effort") {
        const r = await control(st, { subtype: "apply_flag_settings", settings: { effortLevel: step.effort } });
        if (r.ok) { st.effort = step.effort; continue; }
        if (!r.timeout && !r.exited && switchRefusalKind(r.code, r.error) === "unavailable") {
          await endProc(st);
          if (st.stopped) return refuse("这个 Compute 已被停止");
          launch(st, true, st.model ?? want?.model, step.effort);
          continue;
        }
        return switchFailed(`改推理强度为 ${step.effort} 失败:${r.error ?? "harness 拒绝"};这一轮没有发出`);
      }
      if (step.kind === "restart") {
        await endProc(st);
        if (st.stopped) return refuse("这个 Compute 已被停止");
        launch(st, true, step.model, step.effort);
        continue;
      }
      startTurn(st, text);
    }
    return { ok: true };
  }

  return {
    capabilities: caps,

    async spawn(brief: unknown, opts?: unknown) {
      const b = checkBrief(brief);
      if (!b.ok) return b;
      if (b.brief.placement !== "local") return refuse(`本适配器只在本机运行,不支持 ${b.brief.placement}`);
      const o = spawnOptions(opts);
      if (!o.ok) return o;
      const id = `ccr-${crypto.randomUUID()}`;
      // 勾选 skill(AC-29):--bare 下没有 Skill 工具,在首个提示里列出可用 skill 与 SKILL.md 路径
      const { prompt, sections } = promptWithSkills(b.brief, o.handoff, o.iso.pluginDirs);
      const st: State = {
        id, brief: b.brief, cwd: o.cwd ?? process.cwd(), sessionId: crypto.randomUUID(), iso: o.iso, proc: null, lastProc: null, model: null, effort: undefined, turn: null,
        stopped: false, resuming: false, controls: new Map(), idleTimer: null,
        constraintVer: o.handoff?.constraintVer, openQuestions: o.handoff?.openQuestions ?? [], doneSideEffects: [...(o.handoff?.doneSideEffects ?? [])], rejected: [], unresolved: [],
      };
      computes.set(id, st);
      const manifest: Manifest = Object.freeze({
        computeId: id, sections: Object.freeze(sections), allowedTools: Object.freeze([...allowedTools(b.brief, Object.keys(o.iso.mcpServers))]), credentialRefs: b.brief.credentialRefs, placement: b.brief.placement,
        mcpServers: Object.freeze(Object.keys(o.iso.mcpServers)), pluginDirs: Object.freeze([...o.iso.pluginDirs]), configDir: o.iso.configDir ?? null,
      });
      launch(st, false, o.model, o.effort);
      startTurn(st, prompt);
      return { ok: true, computeId: id, manifest };
    },

    async resume(computeId: string, text: string, turn?: TurnModel) {
      if (typeof computeId !== "string" || typeof text !== "string") return refuse("computeId 与续接内容必须是字符串");
      const st = computes.get(computeId);
      if (!st) return refuse(`未知的 Compute ${computeId}`);
      if (!text.trim()) return refuse("续接的内容不能为空");
      let want: TurnModel | undefined;
      try { want = checkTurnModel(turn); } catch (err) { return refuse(errorText(err)); }
      if (st.stopped) return refuse("这个 Compute 已被停止");
      // 同一时刻只受理一个续接(R7-01 的同一规则):认领在第一个 await 之前完成
      if (st.resuming) return refuse("这个 Compute 正在续接,同一时刻只受理一个续接");
      st.resuming = true;
      try {
        // 在途这一轮不打断:等它的 result,切换请求在这之后、下一条输入之前才发出(D27 第 4 节第 3 条)
        if (st.turn && !st.turn.finished) await st.turn.done;
        if (st.stopped) return refuse("续接还没开始时这个 Compute 已被停止,这次续接作废");
        st.unresolved = [];
        return await runTurn(st, text, want);
      } finally {
        st.resuming = false;
      }
    },

    async steer(computeId: string, text: string) {
      if (typeof computeId !== "string" || typeof text !== "string") return refuse("computeId 与插话内容必须是字符串");
      const st = computes.get(computeId);
      if (!st) return refuse(`未知的 Compute ${computeId}`);
      if (!text.trim()) return refuse("插话的内容不能为空");
      if (st.stopped) return refuse("这个 Compute 已被停止");
      if (!st.turn || st.turn.finished || !st.proc) return refuse("没有在跑的一轮可以插话,请用 resume 开下一轮");
      // 插话进当前这一轮,用当前模型,不发任何切换请求
      return write(st.proc, { type: "user", message: { role: "user", content: text }, priority: "now" }) ? { ok: true } : refuse("写不进 CLI 的 stdin");
    },

    async stop(computeId: string) {
      if (typeof computeId !== "string") return refuse("computeId 必须是字符串");
      const st = computes.get(computeId);
      if (!st) return refuse(`未知的 Compute ${computeId}`);
      if (st.stopped) return refuse(`Compute ${computeId} 已经停止`);
      st.stopped = true;
      if (st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = null; }
      const turn = st.turn;
      const violations = turn ? [...turn.violations] : [];
      if (turn && !turn.finished) turn.halted = true;
      if (st.proc) {
        const p = st.proc;
        // 停止确认要用(AC-23):发信号之前记下主进程的后代与同组成员,主进程退出后它们会被过继,事后按父子链就找不到了
        if (!IS_WINDOWS && p.pid !== undefined && !p.isExited) p.tree = treeNow(p.pid);
        p.expectedExit = true;
        reap(p);
      }
      if (!turn || turn.finished) {
        // 空闲时停止:给这次停止单独记一轮,stopped 落在它下面
        let finish: () => void = () => {};
        const done = new Promise<void>((r) => { finish = r; });
        st.turn = { events: [], done, finish: () => finish(), finished: false, model: st.model, blocked: false, halted: true, violations, reportedFailure: undefined, kind: null };
      }
      const t = st.turn!;
      t.kind = "stopped";
      emit(st, { computeId: st.id, kind: "stopped", code: null, signal: null, scope: "main-then-group", violations });
      endTurn(st, t);
      return { ok: true };
    },

    events: () => hub.iterate(),

    activity: () => acts.iterate(),

    async quiesce(computeId: string, timeoutMs = 5000): Promise<QuiesceResult> {
      if (typeof computeId !== "string") return { ok: false, reason: "computeId 必须是字符串", remaining: [] };
      if (typeof timeoutMs !== "number" || !(timeoutMs >= 0)) return { ok: false, reason: "timeoutMs 必须是非负数", remaining: [] };
      const st = computes.get(computeId);
      if (!st) return { ok: false, reason: `未知的 Compute ${computeId}`, remaining: [] };
      const t = st.turn;
      // 这一轮在跑,或停在受阻(常驻进程照常等回答)且没被停止:不做,先停止
      if (!t?.finished || (t.kind === "blocked" && !st.stopped)) return { ok: false, reason: "这一轮还没结束(运行中或停在受阻),先停止", remaining: [] };
      const proc = st.lastProc;
      if (!proc) return { ok: true, killed: 0 };
      const pid = proc.pid;
      if (!proc.isExited) {
        // 这一轮已失败或完成、常驻进程还活着:确认静止就要先结束它(下一轮用同一会话 id 恢复);停止时已记下后代的不再重记
        if (!IS_WINDOWS && pid !== undefined && proc.tree !== null && proc.tree.length === 0) proc.tree = treeNow(pid);
        if (!proc.expectedExit) {
          proc.expectedExit = true;
          reap(proc);
        }
      }
      // 主进程退出:reap 保证(reapForceMs 后组 SIGKILL);这里再给 timeoutMs 的余量
      const limit = resolveReapForceMs(cfg.reapForceMs, process.env.MIRASIM_REAP_FORCE_MS) + timeoutMs;
      let timer: NodeJS.Timeout | undefined;
      const exited = proc.isExited || (await Promise.race([proc.exited.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), limit); timer.unref(); })]));
      clearTimeout(timer);
      if (!exited) return { ok: false, reason: "CLI 主进程没有退出", remaining: pid === undefined ? [] : [pid] };
      if (IS_WINDOWS || pid === undefined) return { ok: true, killed: 0 };
      // 主进程退出后:停止时记下的后代 + 此刻还在同组的成员,还活着的全部 SIGKILL,轮询到都退出(与一次性适配器同一套)
      return confirmStopped(pid, proc.tree, timeoutMs);
    },

    async settled(computeId: string) {
      if (typeof computeId !== "string") return [];
      const turn = computes.get(computeId)?.turn;
      if (!turn) return [];
      await turn.done;
      return Object.freeze([...turn.events]);
    },

    rejectedReports(computeId: string) {
      if (typeof computeId !== "string") return Object.freeze([]);
      return Object.freeze([...(computes.get(computeId)?.rejected ?? [])]);
    },

    snapshot(computeId: string) {
      if (typeof computeId !== "string") return refuse("computeId 必须是字符串");
      const st = computes.get(computeId);
      if (!st) return refuse(`未知的 Compute ${computeId}`);
      const t = st.turn;
      const terminal = t?.finished && (t.kind === "stopped" || t.kind === "completed" || t.kind === "failed");
      // 常驻进程还活着就不算静止:只在这一轮终态且 CLI 主进程已退出(停止或空闲回收)之后给交接快照
      if (!terminal || (st.proc !== null && !st.proc.isExited)) return refuse("not-quiescent");
      return checkSnapshot({ constraintVer: st.constraintVer, openQuestions: [...st.openQuestions], doneSideEffects: [...st.doneSideEffects] });
    },
  };
}
