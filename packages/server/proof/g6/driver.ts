import { speakingEnv } from "./manifest.ts";
// G6 driver:在被测提交的工作树里跑一道题,产出一份原始记录(RawRecord)。G6 是本项目的验证工具(开发纪律),不进产品功能,
// 不给产品加开关或界面(需求文档 §2.0 v3.28)。runner 把整个 proof/g6/ 目录叠到被测工作树的同一位置再执行它,
// 所以下面的 ../../src/start.ts 解析到的是被测提交自己的装配入口——
// 联系人脑子与后台压缩器由被测提交按各自联系人的同模配置建(start.ts),driver 不另建、不改它们的参数。
// 模型流量只经 globalThis.fetch:规则替身模式下由进程内替身应答(不联网);真实模式转发到环境变量里的网关,只录请求体与响应。
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../../src/start.ts";
import { recordingFetch } from "./capture.ts";
import { stepTexts } from "./fixture.ts";
import { createStandin } from "./standin.ts";
import type { FixtureItem, FixtureSet, HostPatch, MemoryRecord, MessageOp, RawRecord, ReplyRecord, RunStatus, SentMessage, StepRecord } from "./types.ts";

export interface DriveOptions {
  readonly set: FixtureSet;
  readonly item: FixtureItem;
  readonly group: string;
  readonly commit: string;
  readonly rep: number;
  readonly mode: "standin" | "real";
  readonly model: string;
  /** 真实模式的网关环境(ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY);替身模式忽略。 */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly dataDir: string;
  readonly fingerprint: string;
  readonly reuseKey: string;
  readonly stepTimeoutMs: number;
  readonly callTimeoutMs: number;
  /** 宿主空闲后再等多久确认真的安静(真实模型 400ms 左右,替身可更短) */
  readonly quietMs: number;
  /** 全部步骤做完后留给后台工作(补查、精筛)的时间 */
  readonly settleMs: number;
  /** 本组的宿主选项覆盖(start.ts 不暴露的宿主已有选项,如 G4 预取开关、G5 精筛安静期);null 不改 */
  readonly hostPatch?: HostPatch | null;
  /** 一次只放一个模型调用到上游 */
  readonly serial?: boolean;
}

const RUNNING = new Set(["T1_Open", "T2_Claimed", "T3_Running"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 替身模式给宿主的网关环境:中性占位,不含任何凭据。 */
export const STANDIN_ENV: Readonly<Record<string, string>> = Object.freeze({ ANTHROPIC_BASE_URL: "http://g6-standin.invalid", ANTHROPIC_AUTH_TOKEN: "NEUTRAL_FIXTURE_NO_CREDENTIALS" });

/** 把一次调用归到题里的联系人:先认人设 marker;补写笔记的请求不带人设,题里只有一位联系人时就是它,否则记不明(null)。 */
export function contactOf(item: FixtureItem, text: string): string | null {
  const hit = item.contacts.filter((c) => text.includes(c.marker));
  if (hit.length === 1) return hit[0]!.key;
  return hit.length === 0 && item.contacts.length === 1 ? item.contacts[0]!.key : null;
}

/**
 * 组级宿主选项覆盖:被测提交的 start.ts 不暴露这些选项,runner 在宿主建好、还没有任何一轮之前并进宿主的选项对象与 G5 精筛参数。
 * 返回实际落到的字段与被测提交里不存在的字段(不存在就不改、如实记下)。
 */
export function applyHostPatch(host: object, patch: HostPatch | null | undefined): { applied: string[]; missing: string[] } {
  const applied: string[] = [];
  const missing: string[] = [];
  if (!patch) return { applied, missing };
  const h = host as Record<string, unknown>;
  const merge = (field: string, label: string, add: Readonly<Record<string, unknown>> | undefined) => {
    if (!add) return;
    const keys = Object.keys(add).map((k) => `${label}.${k}`);
    const cur = h[field];
    if (cur !== null && typeof cur === "object") {
      h[field] = { ...(cur as object), ...add };
      applied.push(...keys);
    } else missing.push(...keys);
  };
  merge("opts", "opts", patch.opts);
  merge("finePolicy", "fineScreen", patch.fineScreen);
  return { applied, missing };
}

/** 宿主要的网关环境;缺项返回 null(记 config_insufficient,不跑)。 */
export function gatewayEnv(o: Pick<DriveOptions, "mode" | "model" | "env">): Record<string, string> | null {
  if (o.mode === "standin") return { ...STANDIN_ENV, ANTHROPIC_DEFAULT_SONNET_MODEL: o.model };
  const base = o.env.ANTHROPIC_BASE_URL;
  const token = o.env.ANTHROPIC_AUTH_TOKEN;
  const key = o.env.ANTHROPIC_API_KEY;
  if (!base || (!token && !key) || !o.model) return null;
  return { ...speakingEnv(o.env), ANTHROPIC_BASE_URL: base, ...(token ? { ANTHROPIC_AUTH_TOKEN: token } : {}), ...(key ? { ANTHROPIC_API_KEY: key } : {}), ANTHROPIC_DEFAULT_SONNET_MODEL: o.model };
}

export async function driveItem(o: DriveOptions): Promise<RawRecord> {
  const startedAt = Date.now();
  const { item } = o;
  const base = { schema: "g6-raw/v1" as const, runId: `${o.group}/${o.model}/${item.id}/${o.rep}`, group: o.group, commit: o.commit, mode: o.mode, model: o.model, item: item.id, rep: o.rep, fingerprint: o.fingerprint, reuseKey: o.reuseKey, startedAt };
  const empty = { roomIds: {}, contactIds: {}, steps: [], sent: [], ops: [], replies: [], memories: {}, notes: {}, reports: [], hostDebt: null, hostPatch: null, calls: [] };
  const env = gatewayEnv(o);
  if (!env) return { ...base, ...empty, endedAt: Date.now(), status: "config_insufficient", error: "缺网关环境(ANTHROPIC_BASE_URL 与 ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY)或模型" };

  const original = globalThis.fetch;
  const rec = recordingFetch({
    upstream: o.mode === "standin" ? createStandin(item) : original,
    contactOf: (t) => contactOf(item, t),
    faults: item.faults,
    timeoutMs: o.callTimeoutMs,
    serial: o.serial === true,
  });
  const reports: { what: string; at: number; detail: string }[] = [];
  const steps: StepRecord[] = [];
  const sent: SentMessage[] = [];
  const ops: MessageOp[] = [];
  const replies: ReplyRecord[] = [];
  const roomIds: Record<string, string> = {};
  const contactIds: Record<string, string> = {};
  const memories: Record<string, MemoryRecord[]> = {};
  const notes: Record<string, string | null> = {};
  let hostDebt: Record<string, { counts: Record<string, number>; refs: { roomId: string; seq: number; state: string }[] }> | null = null;
  let hostPatch: { applied: string[]; missing: string[] } | null = null;
  let status: RunStatus = "ok";
  let error: string | null = null;
  mkdirSync(o.dataDir, { recursive: true });
  globalThis.fetch = rec.fetch;
  let started: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    started = await startServer({ dataDir: o.dataDir, mind: "pi", compute: "fake", env, onReport: (what, detail) => reports.push({ what, at: Date.now(), detail: JSON.stringify(detail ?? null).slice(0, 400) }) });
    const host = started.host;
    if (o.hostPatch) hostPatch = applyHostPatch(host, o.hostPatch);
    for (const c of item.contacts) contactIds[c.key] = host.createContact({ name: c.name, persona: c.persona }).id;
    const keyOfContact = new Map(Object.entries(contactIds).map(([k, v]) => [v, k]));
    for (const r of item.rooms) {
      const room = r.kind === "dm" ? host.openDm(contactIds[r.contacts[0]!]!) : host.createGroup(r.title ?? r.key, r.contacts.map((k) => ({ kind: "contact" as const, id: contactIds[k]! })));
      roomIds[r.key] = room.id;
    }
    const keyOfRoom = new Map(Object.entries(roomIds).map(([k, v]) => [v, k]));
    host.bus.subscribe((e) => {
      if (e.type === "message.appended" && e.message.sender.kind === "contact") replies.push({ room: keyOfRoom.get(e.message.roomId) ?? e.message.roomId, seq: e.message.seq, contact: keyOfContact.get(e.message.sender.id) ?? e.message.sender.id, text: e.message.text, at: Date.now() });
    });
    const settle = async (): Promise<boolean> => {
      const deadline = Date.now() + o.stepTimeoutMs;
      for (;;) {
        await Promise.race([host.idle(), sleep(o.quietMs)]);
        await sleep(o.quietMs);
        if (!host.loop.busy() && !host.listTasks({}).some((t) => RUNNING.has(t.state))) return false;
        if (Date.now() > deadline) return true;
      }
    };
    let order = 0;
    const post = (step: number, index: number, roomKey: string, text: string, to: readonly string[] | undefined) => {
      const m = host.send({ roomId: roomIds[roomKey]!, clientActionId: `g6-${step}-${index}`, text, mentions: (to ?? []).map((k) => ({ id: contactIds[k]!, source: "manual" as const })) });
      const at = Date.now();
      sent.push({ step, index, room: roomKey, roomId: m.roomId, seq: m.seq, text, at });
      ops.push({ order: ++order, op: "send", room: roomKey, seq: m.seq, step, at });
    };
    for (const [i, s] of item.steps.entries()) {
      const startedStep = Date.now();
      let timedOut = false;
      if (s.op === "send" || s.op === "batch") {
        for (const [j, t] of stepTexts(o.set, item, i).entries()) post(i, j, s.room, t, s.to);
        timedOut = await settle();
      } else if (s.op === "filler") {
        for (const [j, t] of stepTexts(o.set, item, i).entries()) {
          post(i, j, s.room, t, s.to);
          timedOut = (await settle()) || timedOut;
        }
      } else {
        const target = sent.find((m) => m.step === s.step && m.index === (s.index ?? 0));
        if (!target) throw new Error(`第 ${i} 步找不到第 ${s.step} 步发出的消息`);
        if (s.op === "edit") host.editMessage(target.roomId, target.seq, s.text);
        else host.retractMessage(target.roomId, target.seq);
        ops.push({ order: ++order, op: s.op, room: s.room, seq: target.seq, step: i, at: Date.now() });
        timedOut = await settle();
      }
      steps.push({ step: i, op: s.op, startedAt: startedStep, settledAt: Date.now(), timedOut });
      if (timedOut) status = "timeout";
    }
    if (o.settleMs > 0) {
      await sleep(o.settleMs);
      if (await settle()) status = "timeout";
    }
    for (const c of item.contacts) {
      const id = contactIds[c.key]!;
      memories[c.key] = host.listMemories(id).map((e) => ({ id: e.id, status: e.status, title: e.title, body: e.body, anchors: [...e.anchors], source: e.source ? { roomId: e.source.roomId, seq: e.source.seq } : null, createdAt: Number.isFinite(Date.parse(e.createdAt)) ? Date.parse(e.createdAt) : null }));
      notes[c.key] = host.stateNote(id);
    }
    // 宿主自报的检查欠账:有 G1 覆盖台账接口才读(各状态计数),没有就留 null,不猜
    const cov = (host as unknown as { memoryCoverage?: { list?: (contactId?: string) => { state: string; sources?: readonly { roomId: string; seq: number }[] }[] } }).memoryCoverage;
    if (typeof cov?.list === "function") {
      hostDebt = {};
      for (const c of item.contacts) {
        const tally: Record<string, number> = {};
        const refs: { roomId: string; seq: number; state: string }[] = [];
        for (const w of cov.list(contactIds[c.key]!)) {
          tally[w.state] = (tally[w.state] ?? 0) + 1;
          if (w.state !== "ok") for (const r of w.sources ?? []) refs.push({ roomId: r.roomId, seq: r.seq, state: w.state });
        }
        hostDebt[c.key] = { counts: tally, refs };
      }
    }
  } catch (e) {
    status = "error";
    error = e instanceof Error ? e.message : String(e);
  } finally {
    try {
      await rec.flush();
      await started?.close();
    } finally {
      globalThis.fetch = original;
    }
  }
  return { ...base, endedAt: Date.now(), status, error, roomIds, contactIds, steps, sent, ops, replies, memories, notes, reports, hostDebt, hostPatch, calls: [...rec.calls].sort((a, b) => a.n - b.n) };
}

/** 命令行:node driver.ts <job.json> <out.json>。job 里不放凭据;真实模式的网关从本进程环境变量取。 */
async function main(argv: readonly string[]) {
  const [jobFile, outFile] = argv;
  if (!jobFile || !outFile) throw new Error("用法:driver.ts <job.json> <out.json>");
  const job = JSON.parse(readFileSync(jobFile, "utf8")) as Omit<DriveOptions, "env" | "set" | "item"> & { fixtureFile: string; itemId: string };
  const set = JSON.parse(readFileSync(job.fixtureFile, "utf8")) as FixtureSet;
  const item = set.items.find((x) => x.id === job.itemId);
  if (!item) throw new Error(`题集里没有 ${job.itemId}`);
  const rec = await driveItem({ ...job, set, item, env: process.env });
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(rec));
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (e) => {
      console.error(e instanceof Error ? e.stack : e);
      process.exit(1);
    },
  );
}
