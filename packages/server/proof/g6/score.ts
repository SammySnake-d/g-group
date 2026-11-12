// G6 评分:只读原始记录与题集,按方案 §9 分开算各项;分母一律按题集计划数,失败、超时、解析失败、配置不足的运行留在分母里。
// 不设阈值、不给「通过」结论;同组同模型的多次运行直接累加分子分母。
import { blockText, inboundLines } from "./capture.ts";
import { stepTexts } from "./fixture.ts";
import type { CallClass, CallRecord, FailureTally, FixtureItem, FixtureProbe, FixtureSet, MemoryRecord, Metrics, RawRecord, Ratio, ReplyRecord } from "./types.ts";

/** 宿主预取旧消息时给的标注(方案 §6「旧消息,供参考,不是新要求」,G4 PREFETCH_REF);第 5 块出现它才算本轮有预取。 */
export const PREFETCH_MARK = "供参考,不是新要求";

const re = (src: string) => new RegExp(src, "i");
const add = (a: Ratio, n: number, d: number): Ratio => ({ n: a.n + n, d: a.d + d });

/** 最近秩百分位;空数组返回 null。 */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[k]!;
}

/** 一句回复算不算答对:expect 命中(null 只要求有回复)且 reject 不命中。 */
export function answerOk(p: Pick<FixtureProbe, "expect" | "reject">, text: string): boolean {
  if (p.expect !== null && !re(p.expect).test(text)) return false;
  return !(p.reject !== null && re(p.reject).test(text));
}

/** 这道追问由谁回答:send 里 @ 了谁就是谁,否则是会话里的全部联系人。 */
export function answerers(item: FixtureItem, p: FixtureProbe): string[] {
  const s = item.steps[p.step];
  if (s?.op !== "send") return [];
  if (s.to?.length) return [...s.to];
  return [...(item.rooms.find((r) => r.key === s.room)?.contacts ?? [])];
}

/** 追问的时间窗:问题发出 → 下一步开始(最后一步到运行结束)。问题没发出去返回 null。 */
export function probeWindow(rec: RawRecord, p: FixtureProbe): { from: number; to: number } | null {
  const q = rec.sent.find((m) => m.step === p.step);
  if (!q) return null;
  return { from: q.at, to: rec.steps.find((s) => s.step === p.step + 1)?.startedAt ?? rec.endedAt };
}

export interface ProbeOutcome {
  readonly id: string;
  readonly category: FixtureProbe["category"];
  readonly asked: boolean;
  readonly correct: boolean;
  readonly readBack: boolean | null;
  readonly prefetched: boolean;
  readonly misled: boolean | null;
  readonly correctNoReply: boolean;
}
export function probeOutcome(item: FixtureItem, rec: RawRecord, p: FixtureProbe): ProbeOutcome {
  const w = probeWindow(rec, p);
  const who = new Set(answerers(item, p));
  if (!w) return { id: p.id, category: p.category, asked: false, correct: false, readBack: p.needs === null ? null : false, prefetched: false, misled: null, correctNoReply: false };
  const inWin = (at: number) => at >= w.from && at <= w.to;
  const replies: ReplyRecord[] = rec.replies.filter((r) => who.has(r.contact) && inWin(r.at));
  const correct = replies.some((r) => answerOk({ expect: p.expect, reject: null }, r.text)) && !(p.reject !== null && replies.some((r) => re(p.reject!).test(r.text)));
  const calls = rec.calls.filter((c) => c.cls === "round" && c.contact !== null && who.has(c.contact) && inWin(c.at));
  const readBack = p.needs === null ? null : calls.some((c) => `${c.system}\n${c.request}`.includes(p.needs!));
  const prefetched = calls.some((c) => blockText(c.request, 5).includes(PREFETCH_MARK));
  const misled = p.misled === null ? null : replies.some((r) => re(p.misled!).test(r.text));
  const correctNoReply = !correct && calls.some((c) => c.text.trim() !== "" && answerOk(p, c.text));
  return { id: p.id, category: p.category, asked: true, correct, readBack, prefetched, misled, correctNoReply };
}

/** 题集里每位联系人该检查的用户消息(撤回的不算);按计划数,与运行成败无关。 */
export function plannedMessages(set: FixtureSet, item: FixtureItem): { contact: string; step: number; index: number; text: string }[] {
  const retracted = new Set(item.steps.flatMap((s) => (s.op === "retract" ? [`${s.step}:${s.index ?? 0}`] : [])));
  const out: { contact: string; step: number; index: number; text: string }[] = [];
  item.steps.forEach((s, i) => {
    if (s.op !== "send" && s.op !== "batch" && s.op !== "filler") return;
    const contacts = item.rooms.find((r) => r.key === s.room)?.contacts ?? [];
    stepTexts(set, item, i).forEach((text, j) => {
      if (retracted.has(`${i}:${j}`)) return;
      for (const c of contacts) out.push({ contact: c, step: i, index: j, text });
    });
  });
  return out;
}
/** 编辑后的原文也算这条消息(检查材料里是最新文字)。 */
const editedTexts = (item: FixtureItem, step: number, index: number): string[] => item.steps.flatMap((s) => (s.op === "edit" && s.step === step && (s.index ?? 0) === index ? [s.text] : []));

/** 一条消息有没有进过这位联系人一次成功的检查(runner 自己判定调用成败,不信宿主自报)。 */
export function coveredBy(calls: readonly CallRecord[], contact: string, texts: readonly string[]): boolean {
  return calls.some((c) => c.cls === "check" && c.contact === contact && c.outcome === "ok" && texts.some((t) => inboundLines(c.request).some((l) => l.text === t)));
}

const active = (ms: readonly MemoryRecord[] | undefined) => (ms ?? []).filter((m) => m.status === "active");
const hits = (m: MemoryRecord, src: string) => re(src).test(`${m.title}\n${m.body}`);
const isGlobal = (m: MemoryRecord) => m.anchors.includes("global");

const ZERO_FAIL: FailureTally = { timeout: 0, parseFailure: 0, configInsufficient: 0, httpError: 0, networkError: 0, empty: 0, injected: 0, runErrors: 0, stepTimeouts: 0 };
const CLASSES: readonly CallClass[] = ["round", "check", "compact", "refine", "background"];

/** 同组同模型的全部运行汇成一份指标。records 里每份都必须对应题集里的一道题。 */
export function scoreRecords(set: FixtureSet, records: readonly RawRecord[]): Metrics {
  let coverage: Ratio = { n: 0, d: 0 };
  let missed: Ratio = { n: 0, d: 0 };
  let wrong: Ratio = { n: 0, d: 0 };
  let sourceScope: Ratio = { n: 0, d: 0 };
  let readBack: Ratio = { n: 0, d: 0 };
  let follow: Ratio = { n: 0, d: 0 };
  let untagged: Ratio = { n: 0, d: 0 };
  let misled: Ratio = { n: 0, d: 0 };
  let probes: Ratio = { n: 0, d: 0 };
  let correctNoReply = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byClass: { round: 0, check: 0, compact: 0, refine: 0, background: 0 } as Record<CallClass, number> };
  const roundMs: number[] = [];
  const writeMs: number[] = [];
  let historyToolCalls = 0;
  const callMs: number[] = [];
  let backlog = 0;
  let maxAge: number | null = null;
  const f = { ...ZERO_FAIL };
  let calls = 0;
  for (const rec of records) {
    const item = set.items.find((x) => x.id === rec.item);
    if (!item) throw new Error(`题集里没有 ${rec.item}`);
    if (rec.status === "error") f.runErrors++;
    if (rec.status === "config_insufficient") f.configInsufficient++;
    f.stepTimeouts += rec.steps.filter((s) => s.timedOut).length;
    // 覆盖与积压
    for (const m of plannedMessages(set, item)) {
      const texts = [m.text, ...editedTexts(item, m.step, m.index)];
      const ok = coveredBy(rec.calls, m.contact, texts);
      coverage = add(coverage, ok ? 1 : 0, 1);
      const s = rec.sent.find((x) => x.step === m.step && x.index === m.index);
      if (s && !ok) {
        backlog++;
        maxAge = Math.max(maxAge ?? 0, rec.endedAt - s.at);
      }
    }
    // 写入
    for (const e of item.memories.expect) {
      const found = active(rec.memories[e.contact]).filter((m) => hits(m, e.match));
      missed = add(missed, found.length === 0 ? 1 : 0, 1);
      const src = rec.sent.find((x) => x.step === e.sourceStep && x.index === (e.sourceIndex ?? 0));
      const right = found.some((m) => src !== undefined && m.source?.roomId === src.roomId && m.source.seq === src.seq && (e.scope === "any" || (e.scope === "global") === isGlobal(m)));
      sourceScope = add(sourceScope, right ? 1 : 0, 1);
      const written = found.map((m) => m.createdAt).filter((t): t is number => t !== null);
      if (src && written.length) writeMs.push(Math.min(...written) - src.at);
    }
    for (const w of item.memories.forbid) {
      const bad = active(rec.memories[w.contact]).some((m) => hits(m, w.match) && (w.scope === undefined || (w.scope === "global") === isGlobal(m)));
      wrong = add(wrong, bad ? 1 : 0, 1);
    }
    // 追问
    for (const p of item.probes) {
      const o = probeOutcome(item, rec, p);
      probes = add(probes, o.correct ? 1 : 0, 1);
      if (p.needs !== null) {
        readBack = add(readBack, o.readBack ? 1 : 0, 1);
        if (o.readBack) follow = add(follow, o.correct ? 1 : 0, 1);
      }
      if (p.category === "untagged-detail") untagged = add(untagged, o.correct ? 1 : 0, 1);
      if (o.prefetched && o.misled !== null) misled = add(misled, o.misled ? 1 : 0, 1);
      if (o.correctNoReply) correctNoReply++;
    }
    // 调用:token(含维护与重试)、失败分类、延迟
    for (const c of rec.calls) {
      calls++;
      tokens.input += c.usage.input;
      tokens.output += c.usage.output;
      tokens.cacheRead += c.usage.cacheRead;
      tokens.cacheWrite += c.usage.cacheWrite;
      tokens.byClass[c.cls] += c.usage.input + c.usage.output + c.usage.cacheRead + c.usage.cacheWrite;
      if (c.status === 200) callMs.push(c.ms);
      if (c.cls === "round") historyToolCalls += c.tools.filter((t) => t.name === "query_history").length;
      if (c.fault !== null) {
        f.injected++;
        continue;
      }
      if (c.outcome === "timeout") f.timeout++;
      else if (c.outcome === "parse_failure") f.parseFailure++;
      else if (c.outcome === "truncated") f.configInsufficient++;
      else if (c.outcome === "http_error") f.httpError++;
      else if (c.outcome === "network_error") f.networkError++;
      else if (c.outcome === "empty") f.empty++;
    }
    for (const s of rec.sent) {
      const room = item.rooms.find((r) => r.key === s.room);
      const step = item.steps[s.step];
      const to = step && "to" in step && step.to?.length ? step.to : (room?.contacts ?? []);
      const first = rec.replies.find((r) => r.room === s.room && r.at >= s.at && to.includes(r.contact));
      if (first) roundMs.push(first.at - s.at);
    }
  }
  return {
    runs: records.length,
    coverage,
    missedWrites: missed,
    wrongWrites: wrong,
    sourceScope,
    readBack,
    followAfterRead: follow,
    untagged,
    prefetchMisled: misled,
    probes,
    correctNoReply,
    tokens: { input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite, byClass: Object.fromEntries(CLASSES.map((k) => [k, tokens.byClass[k]])) as Record<CallClass, number> },
    calls,
    roundLatencyMs: { p50: percentile(roundMs, 50), p95: percentile(roundMs, 95), n: roundMs.length },
    writeLatencyMs: { p50: percentile(writeMs, 50), p95: percentile(writeMs, 95), n: writeMs.length },
    historyToolCalls,
    callLatencyMs: { p50: percentile(callMs, 50), p95: percentile(callMs, 95), n: callMs.length },
    backlog: { count: backlog, maxAgeMs: maxAge },
    failures: f,
  };
}
