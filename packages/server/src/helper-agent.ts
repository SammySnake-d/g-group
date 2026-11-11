// Helper 运行时(U04/U05、U94/D28.1、D07.0、AC-52):Helper 脑子(HelperMind)经 Helper 专属 MCP 调工具,真执行软件操作。
//   - 业务能力只有一份:内核 HELPER_OPS → 本文件 callTool → service.handle(caller=helper)(参数合同、宿主权限、服务层 helperGate 照旧);
//     MCP(进程内内存传输给 pi 运行时、stdio 给外部)、CLI(cli.ts tool / mcp 子命令)、skill(skills/helper/SKILL.md 进系统提示)三者复用它;
//   - 不可逆操作不设代码确认门禁(软提示不做成功能,DM#2565):「先问用户」写在 skill 与工具说明里;
//     按权限不给 Helper 的(以用户身份发言、验收、回答授权,U99/AC-20/AC-28)由服务层拒收;
//   - 三种入口照 routeHelper:全局不带任何聊天(read_room 按需读用户在场的会话);侧栏带当前聊天、回复只进侧栏记录;
//     @Helper 时回复作为 helper 消息回复那条 @ 它的消息。联系人 @Helper 不触发任何操作,只留一条拒收记录;
//   - 每次工具执行记审计表 gg_helper_ops;每次请求带进模型的会话与消息记 gg_helper_context(AC-52 观测点)。
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ApiResult, type HelperContextItem, type HelperEntry, type HelperOpResult, METHODS, type MethodName, type MessageView, checkParams, formatIssues, isMethodName } from "@g-group/api-contract";
import { routeHelper } from "@g-group/domain";
import { HELPER_OPS, type HelperToolResult, type McpServer, createHelperMcpServer, helperExclusion, helperOp, memoryMcpClient } from "@g-group/kernel";
import { HostError, all, one, run } from "./db.ts";
import { HELPER_ID, type HelperDesk, type HelperEntryInput } from "./helper.ts";
import type { Host } from "./host.ts";

/** 调用方:用户本人(缺省),或 Helper(服务层按 HELPER_OPS 与排除清单判定,见 service.ts helperGate)。 */
export type ServiceCaller = { readonly kind: "user" } | { readonly kind: "helper"; readonly entry: HelperEntryInput };
type Handle = (method: string, params: unknown, caller?: ServiceCaller) => Promise<ApiResult<MethodName>>;
export type { HelperContextItem };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS gg_helper_ops (
    id TEXT PRIMARY KEY, at TEXT NOT NULL, ask_id TEXT, entry TEXT NOT NULL, op TEXT NOT NULL,
    args_sha256 TEXT NOT NULL, args_summary TEXT NOT NULL, ok INTEGER NOT NULL, result TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS gg_helper_asks (action_id TEXT PRIMARY KEY, scope TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gg_helper_context (ask_id TEXT NOT NULL, at TEXT NOT NULL, entry TEXT NOT NULL, via TEXT NOT NULL, room_id TEXT NOT NULL, seqs TEXT NOT NULL)`,
];
export interface HelperAskResult {
  reply: string;
  ops: HelperOpResult[];
  context: HelperContextItem[];
}
interface ToolCtx {
  readonly entry: HelperEntryInput;
  readonly scope: string;
  readonly askId: string;
  n: number;
  readonly ops: HelperOpResult[];
  readonly seen: HelperContextItem[];
}

/** 侧栏 / @ 给模型的当前聊天最近几条。 */
export const HELPER_CONTEXT_MESSAGES = 30;
const RESULT_MAX = 8000;
/** Helper 的 skill 文件(只进 Helper 的系统提示,U05)。 */
export const HELPER_SKILL_FILE = fileURLToPath(new URL("../skills/helper/SKILL.md", import.meta.url));
let skillText: string | null = null;
/** Helper 的 skill 原文。 */
export function helperSkill(): string {
  skillText ??= readFileSync(HELPER_SKILL_FILE, "utf8");
  return skillText;
}

const now = () => new Date().toISOString();
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
};
/** 审计里的参数摘要:sha256(操作 + 规范化参数)。 */
export const argsSha256 = (op: string, args: unknown): string => createHash("sha256").update(canonical({ method: op, args })).digest("hex");
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const scopeOf = (e: HelperEntryInput): string => (e.kind === "global" ? "global" : `${e.kind}:${e.roomId}`);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…(已截断,共 ${s.length} 字)` : s);
const needsActionId = (method: string): boolean => isMethodName(method) && "clientActionId" in (METHODS[method].params as unknown as { shape: Record<string, unknown> }).shape;

/** 结果里挑几个识别字段,给操作记录用。 */
function brief(v: unknown): string {
  if (!isRecord(v)) return "";
  const bits: string[] = [];
  for (const k of ["id", "taskId", "title", "name", "state"]) if (typeof v[k] === "string") bits.push(`${k}=${v[k]}`);
  for (const [k, x] of Object.entries(v)) if (Array.isArray(x)) bits.push(`${k} ${x.length} 条`);
  return bits.join(" ").slice(0, 300);
}

const agents = new WeakMap<Host, HelperAgent>();
/** 这个宿主上的 Helper 运行时(createService 建;CLI 的 tool / mcp 子命令用)。 */
export function helperAgentOf(host: Host): HelperAgent | undefined {
  return agents.get(host);
}
/** 等这个宿主上由 @Helper 触发的 Helper 处理全部结束(测试与 CLI 用)。 */
export async function whenHelperIdle(host: Host): Promise<void> {
  await agents.get(host)?.idle();
}

export class HelperAgent {
  private readonly host: Host;
  private readonly desk: HelperDesk;
  private readonly handle: Handle;
  private readonly inflight = new Map<string, Promise<HelperAskResult>>();
  private readonly busy = new Set<Promise<unknown>>();

  constructor(host: Host, desk: HelperDesk, handle: Handle) {
    this.host = host;
    this.desk = desk;
    this.handle = handle;
    for (const sql of SCHEMA) host.db.store.db.exec(sql);
    agents.set(host, this);
    // 聊天里 @Helper:配置了 Helper 脑子才触发(没配置时 @Helper 只是一条普通消息,helper.post 仍可手动回复)
    if (host.helperMind)
      host.bus.subscribe((e) => {
        if (e.type === "message.appended") this.onMessage(e.message);
      });
  }

  async idle(): Promise<void> {
    while (this.busy.size) await Promise.allSettled([...this.busy]);
  }
  private track<T>(p: Promise<T>): Promise<T> {
    this.busy.add(p);
    void p.finally(() => this.busy.delete(p)).catch(() => {});
    return p;
  }

  // ---------------------------------------------------------------- 审计与上下文清单
  private audit(r: { askId: string | null; scope: string; op: string; args: unknown; ok: boolean; result: string }) {
    run(
      this.host.db,
      "INSERT INTO gg_helper_ops (id, at, ask_id, entry, op, args_sha256, args_summary, ok, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      `hop-${randomUUID()}`,
      now(),
      r.askId,
      r.scope,
      r.op,
      argsSha256(r.op, r.args),
      clip(canonical(r.args), 2000),
      r.ok ? 1 : 0,
      clip(r.result, 4000),
    );
  }
  private noteContext(ctx: ToolCtx, item: HelperContextItem) {
    run(this.host.db, "INSERT INTO gg_helper_context (ask_id, at, entry, via, room_id, seqs) VALUES (?, ?, ?, ?, ?, ?)", ctx.askId, now(), ctx.scope, item.via, item.roomId, JSON.stringify(item.seqs));
    ctx.seen.push(item);
  }

  // ---------------------------------------------------------------- @Helper 触发
  private onMessage(m: MessageView) {
    if (m.sender.kind === "helper" || m.sender.kind === "system") return;
    const structured = m.mentions.some((x) => x.id === HELPER_ID);
    if (!structured && !/@helper/i.test(m.text)) return;
    const caller = { kind: m.sender.kind === "user" ? ("user" as const) : ("contact" as const), id: m.sender.id };
    const r = routeHelper({ kind: "mention", conversationId: m.roomId, seq: m.seq }, caller, this.host.userId);
    if (!r.ok) {
      // 联系人 @Helper:不执行任何操作,只留一条拒收记录
      this.audit({ askId: null, scope: `mention:${m.roomId}`, op: "helper.mention", args: { roomId: m.roomId, seq: m.seq, sender: m.sender }, ok: false, result: `拒收:${r.reason}` });
      return;
    }
    if (!structured) return;
    const entry: HelperEntryInput = { kind: "mention", roomId: m.roomId, seq: m.seq };
    const text = m.text.replace(/@helper\s*/gi, "").trim() || m.text;
    const cid = `mention-${m.roomId}-${m.seq}`;
    this.track(
      this.ask(entry, text, cid).catch((err) => {
        try {
          this.desk.post(entry, `Helper 这次没办成:${err instanceof Error ? err.message : String(err)}`, `${cid}-err`);
        } catch {
          /* 会话已不在等:不再补发 */
        }
      }),
    );
  }

  // ---------------------------------------------------------------- 问一次
  ask(entry: HelperEntryInput, text: string, clientActionId: string): Promise<HelperAskResult> {
    const key = `helper-ask:${clientActionId}`;
    const stored = one<{ result: string }>(this.host.db, "SELECT result FROM gg_helper_asks WHERE action_id = ?", key);
    if (stored) return Promise.resolve(JSON.parse(stored.result) as HelperAskResult);
    const live = this.inflight.get(key);
    if (live) return live;
    const p = this.doAsk(entry, text, clientActionId, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async doAsk(entry: HelperEntryInput, text: string, cid: string, key: string): Promise<HelperAskResult> {
    const route = this.desk.route(entry);
    if (entry.kind === "mention") this.desk.askedMessage(entry);
    const model = this.host.settings().defaultSpeakingModel;
    const mind = this.host.helperMind?.(model) ?? null;
    if (!mind) throw new HostError("unavailable", "Helper 没有配置模型运行时(启动时 mind=pi 或 fake)");
    const scope = scopeOf(entry);
    const history = route.becomesMessage ? [] : this.desk.history(entry, 20).map((n) => ({ role: n.role, text: n.text }));
    if (!route.becomesMessage) this.desk.note(entry, "user", text, `${cid}:q`);
    const ctx: ToolCtx = { entry, scope, askId: cid, n: 0, ops: [], seen: [] };
    const cur = this.desk.context(entry, [], HELPER_CONTEXT_MESSAGES);
    for (const r of cur.rooms) this.noteContext(ctx, { roomId: r.roomId, via: "entry", seqs: r.messages.map((m) => m.seq) });
    const context = cur.rooms.map((r) => this.renderRoom(r.roomId, r.messages)).join("\n\n");
    let result: HelperAskResult;
    try {
      const out = await mind.run(
        { model, route: { entry: entry.kind, contextRoomId: route.contextRoomId, replyToSeq: route.replyToSeq }, text, context, history, skill: helperSkill() },
        new AbortController().signal,
        memoryMcpClient(this.mcpFor(ctx)),
      );
      const reply = out.reply.trim() || (ctx.ops.length ? `已处理:${ctx.ops.map((o) => o.summary).join(";")}` : "(Helper 没有给出文字回复)");
      result = { reply, ops: ctx.ops, context: ctx.seen };
    } catch (e) {
      if (e instanceof HostError) throw e;
      // 模型中途失败时,已经执行的操作仍然生效:放进错误详情,前端照实告诉用户做了什么
      throw new HostError("unavailable", `Helper 模型调用失败:${e instanceof Error ? e.message : String(e)}`, { ops: ctx.ops, context: ctx.seen });
    }
    let noteId: string | null = null;
    let messageSeq: number | null = null;
    if (route.becomesMessage) messageSeq = this.desk.post(entry, result.reply, `helper-${cid}`).seq;
    else noteId = this.desk.note(entry, "helper", result.reply, `${cid}:a`).id;
    run(this.host.db, "INSERT OR IGNORE INTO gg_helper_asks (action_id, scope, result, at) VALUES (?, ?, ?, ?)", key, scope, JSON.stringify(result), now());
    this.host.bus.emit({ type: "helper.replied", entry: entry as HelperEntry, reply: result.reply, ops: result.ops, noteId, messageSeq });
    return result;
  }

  private renderRoom(roomId: string, messages: readonly MessageView[]): string {
    const room = this.host.roomView(roomId);
    const contacts = new Map(this.host.listContacts().map((c) => [c.id, c.name]));
    const who = (s: { kind: string; id: string }) => (s.kind === "user" ? "用户" : s.kind === "helper" ? "Helper" : s.kind === "contact" ? (contacts.get(s.id) ?? s.id) : s.kind);
    const members = room.members.map((m) => (m.kind === "user" ? `用户(${m.id})` : `${contacts.get(m.id) ?? m.id}(${m.id})`)).join("、");
    const lines = messages.map((m) => `#${m.seq} ${who(m.sender)}:${m.retracted ? "(已撤回)" : clip(m.text, 2000)}`);
    return [`会话 ${room.id}「${room.title}」(${room.kind}),成员:${members}`, ...lines].join("\n");
  }

  // ---------------------------------------------------------------- 同一业务能力的三个入口
  /** Helper 专属 MCP 服务,工具执行绑定到这一次的入口(进程内给 pi 运行时;stdio 给外部)。 */
  private mcpFor(ctx: ToolCtx): McpServer {
    return createHelperMcpServer({ tools: HELPER_OPS, call: (name, args) => this.callTool(ctx, name, args) });
  }
  /** 给外部(stdio)用的 Helper MCP 服务:入口默认全局,记审计时用 askId 区分。 */
  mcpServer(entry: HelperEntryInput, askId: string): McpServer {
    this.desk.route(entry);
    return this.mcpFor({ entry, scope: scopeOf(entry), askId, n: 0, ops: [], seen: [] });
  }
  /** CLI 调一个 Helper 操作(同一个执行器)。 */
  runTool(entry: HelperEntryInput, name: string, args: unknown, askId: string): Promise<HelperToolResult> {
    this.desk.route(entry);
    return this.callTool({ entry, scope: scopeOf(entry), askId, n: 0, ops: [], seen: [] }, name, args);
  }

  private async callTool(ctx: ToolCtx, name: string, rawArgs: unknown): Promise<HelperToolResult> {
    const op = helperOp(name);
    const n = ++ctx.n;
    const fail = (opName: string, why: string, args: unknown = rawArgs): HelperToolResult => {
      this.audit({ askId: ctx.askId, scope: ctx.scope, op: opName, args, ok: false, result: why });
      ctx.ops.push({ op: opName, ok: false, summary: clip(why, 300) });
      return { ok: false, text: why };
    };
    if (!op) {
      const ex = helperExclusion(name);
      return fail(name, ex ? `${ex.method} 按权限不给 Helper:${ex.reason}` : `没有叫 ${name} 的工具;只能用清单里的工具`);
    }
    if (!isRecord(rawArgs)) return fail(op.method, "参数必须是一个对象");
    const { clientActionId: _drop, ...raw } = rawArgs;
    const withId = needsActionId(op.method) ? { ...raw, clientActionId: `helper-${ctx.askId}-${n}` } : raw;
    const check = checkParams(op.method as MethodName, withId);
    if (!check.ok) return fail(op.method, `参数不合格:${formatIssues(check.issues)}`, raw);
    const { clientActionId: _id, ...args } = check.value as Record<string, unknown>;
    const r = await this.handle(op.method, withId, { kind: "helper", entry: ctx.entry });
    if (!r.ok) return fail(op.method, `${op.label}失败(${r.error.code}):${r.error.message}`, args);
    if (op.name === "read_room") {
      const roomId = args.roomId as string;
      const msgs = (r.value as { messages: MessageView[] }).messages;
      this.noteContext(ctx, { roomId, via: "read_room", seqs: msgs.map((m) => m.seq) });
      this.audit({ askId: ctx.askId, scope: ctx.scope, op: op.method, args, ok: true, result: `读了 ${msgs.length} 条` });
      ctx.ops.push({ op: op.method, ok: true, summary: `${op.label}:${roomId} ${msgs.length} 条` });
      return { ok: true, text: clip(this.renderRoom(roomId, msgs), RESULT_MAX) };
    }
    if (op.method === "search.messages") {
      const byRoom = new Map<string, number[]>();
      for (const h of (r.value as { hits: { roomId: string; seq: number }[] }).hits) byRoom.set(h.roomId, [...(byRoom.get(h.roomId) ?? []), h.seq]);
      for (const [roomId, seqs] of byRoom) this.noteContext(ctx, { roomId, via: "search", seqs });
    }
    const b = brief(r.value);
    this.audit({ askId: ctx.askId, scope: ctx.scope, op: op.method, args, ok: true, result: clip(JSON.stringify(r.value), 4000) });
    ctx.ops.push({ op: op.method, ok: true, summary: `${op.label}${b ? `:${b}` : ""}` });
    return { ok: true, text: clip(JSON.stringify(r.value), RESULT_MAX) };
  }
}

/** 审计表里某次请求的操作(测试与 CLI 读回用)。 */
export function helperOpsOf(host: Host, askId?: string): { askId: string | null; entry: string; op: string; argsSha256: string; ok: boolean; result: string }[] {
  const rows =
    askId === undefined
      ? all<{ ask_id: string | null; entry: string; op: string; args_sha256: string; ok: number; result: string }>(host.db, "SELECT ask_id, entry, op, args_sha256, ok, result FROM gg_helper_ops ORDER BY rowid")
      : all<{ ask_id: string | null; entry: string; op: string; args_sha256: string; ok: number; result: string }>(host.db, "SELECT ask_id, entry, op, args_sha256, ok, result FROM gg_helper_ops WHERE ask_id = ? ORDER BY rowid", askId);
  return rows.map((r) => ({ askId: r.ask_id, entry: r.entry, op: r.op, argsSha256: r.args_sha256, ok: r.ok === 1, result: r.result }));
}
