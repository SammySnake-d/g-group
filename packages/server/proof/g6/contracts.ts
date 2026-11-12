// G6 确定性合同:不看模型答得好不好,只看宿主的确定性行为有没有守住。逐份运行判,同组同模型汇总时一条失败就是失败,
// 报告里与效果指标分开列,不能用平均收益抵消(方案 §9、v0.2 §8「确定性反例先全过」)。
import { blockText, inboundLines } from "./capture.ts";
import { PREFETCH_MARK } from "./score.ts";
import type { CallOutcome, CallRecord, ContractResult, FixtureItem, RawRecord } from "./types.ts";

const result = (id: string, title: string, checked: number, violations: string[], applies = true): ContractResult => ({
  id,
  title,
  verdict: !applies || checked === 0 ? "n/a" : violations.length ? "fail" : "pass",
  checked,
  violations,
});
const OUTCOMES: ReadonlySet<CallOutcome> = new Set(["ok", "timeout", "network_error", "http_error", "truncated", "parse_failure", "empty"]);

/**
 * K1 要扫的文字。exceptNote 时只扫宿主装配的部分:对话轮看第 1、4、5 块(不看第 3 块笔记和模型自己的工具调用回显),
 * 后台调用只看「本轮新输入(原文)」那一段;否则扫整份请求。
 */
export function scanText(c: Pick<CallRecord, "cls" | "system" | "request">, exceptNote: boolean): string {
  if (!exceptNote) return `${c.system}\n${c.request}`;
  if (c.cls === "round") return `${c.system}\n${blockText(c.request, 4)}\n${blockText(c.request, 5)}`;
  const a = c.request.indexOf("[本轮新输入(原文)]");
  if (a < 0) return "";
  const b = c.request.indexOf("[联系人本轮动作]", a);
  return c.request.slice(a, b < 0 ? undefined : b);
}

/** 这段文字落在请求的哪个部分(定位用;五块的块号,或说明是哪一类请求)。 */
export function whereInRequest(c: Pick<CallRecord, "cls" | "system" | "request">, text: string): string {
  if (c.cls !== "round") {
    const a = c.request.indexOf("[本轮新输入(原文)]");
    return a >= 0 && c.request.slice(a).includes(text) ? "检查材料的本轮新输入" : c.system.includes(text) ? "检查说明" : "检查请求其余部分";
  }
  for (const n of [1, 2, 3, 4, 5]) if (blockText(c.request, n).includes(text)) return `第 ${n} 块`;
  return c.system.includes(text) ? "固定前缀(system)" : "本轮工具往返";
}

/** K1 撤回、编辑前旧文、别的会话的原文:在指定那步之后不得出现在这位联系人的任何模型请求里。 */
export function forbiddenText(item: FixtureItem, rec: RawRecord): ContractResult {
  const v: string[] = [];
  let checked = 0;
  for (const f of item.forbidden) {
    const t0 = f.afterStep < 0 ? 0 : (rec.ops.find((o) => o.step === f.afterStep)?.at ?? rec.steps.find((s) => s.step === f.afterStep)?.startedAt ?? Number.POSITIVE_INFINITY);
    for (const c of rec.calls) {
      if (c.contact !== f.contact || c.at < t0) continue;
      checked++;
      const seen = scanText(c, f.exceptNote === true);
      if (seen.includes(f.text)) v.push(`调用 ${c.n}(${c.cls},${whereInRequest(c, f.text)}):${f.why}`);
    }
  }
  return result("K1", "撤回/编辑前/越权原文不进请求", checked, v, item.forbidden.length > 0);
}

/** K2 第 1 块(固定前缀)在同一联系人的各轮之间不变:预取和记忆变化只能进第 5 块。 */
export function prefixStable(rec: RawRecord): ContractResult {
  const v: string[] = [];
  let checked = 0;
  const seen = new Map<string, string>();
  for (const c of rec.calls) {
    if (c.cls !== "round" || c.contact === null) continue;
    checked++;
    const first = seen.get(c.contact);
    if (first === undefined) seen.set(c.contact, c.system);
    else if (first !== c.system) v.push(`调用 ${c.n}:联系人 ${c.contact} 的固定前缀与本次运行第一轮不同`);
  }
  return result("K2", "固定前缀各轮不变", checked, v);
}

/** K3 对话与全部后台调用都用这位联系人的说话模型(同模),不静默换模型。 */
export function sameModel(rec: RawRecord): ContractResult {
  const v: string[] = [];
  let checked = 0;
  for (const c of rec.calls) {
    if (c.model === null) continue;
    checked++;
    if (c.model !== rec.model) v.push(`调用 ${c.n}(${c.cls})用了 ${c.model},应为 ${rec.model}`);
  }
  return result("K3", "对话与后台同模", checked, v);
}

/** K4 截断的输出不当成功:它的文字不得成为之后的状态笔记(第 3 块或最终笔记)。 */
export function truncationNotSuccess(rec: RawRecord): ContractResult {
  const v: string[] = [];
  const cut = rec.calls.filter((c) => c.outcome === "truncated" && c.cls !== "round" && c.text.trim().length >= 8);
  for (const c of cut) {
    const needle = c.text.trim().slice(0, 120);
    const later = rec.calls.find((x) => x.cls === "round" && x.n > c.n && x.contact === c.contact && blockText(x.request, 3).includes(needle));
    if (later) v.push(`调用 ${c.n} 截断的输出成了调用 ${later.n} 的状态笔记`);
    const note = c.contact === null ? null : rec.notes[c.contact];
    if (note?.includes(needle)) v.push(`调用 ${c.n} 截断的输出成了最终状态笔记`);
  }
  return result("K4", "截断输出不当成功", cut.length, v);
}

/**
 * K5 失败的检查不许静默清账:一次检查失败(超时、截断、解析失败、报错),它材料里的用户消息要么之后被同一联系人成功检查过,
 * 要么被宿主记成欠账(覆盖台账里非 ok 的工作,来源含这条)。两者都没有才算未守住。
 * 只要求「欠账在、重试排上」,不要求在这次运行内就补完:补查的重试时机由宿主的重试策略定(backoff),短运行里排到运行之后是正常的。
 */
export function failedCheckRecovered(rec: RawRecord): ContractResult {
  const v: string[] = [];
  const failed = rec.calls.filter((c) => c.cls === "check" && c.outcome !== "ok");
  for (const c of failed) {
    const users = inboundLines(c.request).filter((l) => l.kind === "user");
    for (const u of users) {
      const ok = rec.calls.some((x) => x.cls === "check" && x.contact === c.contact && x.n > c.n && x.outcome === "ok" && inboundLines(x.request).some((l) => l.text === u.text));
      const debt = c.contact === null ? [] : (rec.hostDebt?.[c.contact]?.refs ?? []).filter((r) => r.roomId === u.roomId && r.seq === u.seq);
      if (!ok && !debt.length) v.push(`调用 ${c.n}(${c.outcome})里的 ${u.roomId} #${u.seq} 之后既没有再被检查成功,也没有留下欠账记录`);
    }
  }
  return result("K5", "失败的检查之后补查成功或留下欠账", failed.length, v);
}

/** K6 预取的旧消息不进固定前缀(第 1 块)。本次运行没出现预取标注时不适用。 */
export function prefetchNotInPrefix(rec: RawRecord): ContractResult {
  const v: string[] = [];
  const rounds = rec.calls.filter((c) => c.cls === "round");
  const any = rounds.some((c) => c.system.includes(PREFETCH_MARK) || blockText(c.request, 5).includes(PREFETCH_MARK));
  for (const c of rounds) if (c.system.includes(PREFETCH_MARK)) v.push(`调用 ${c.n}:预取标注出现在固定前缀里`);
  return result("K6", "预取旧消息不进固定前缀", rounds.length, v, any);
}

/** K7 记账完整(runner 自查):每次调用都有判定和非负用量,运行状态在枚举内——失败才不会从分母里漏掉。 */
export function accounting(rec: RawRecord): ContractResult {
  const v: string[] = [];
  if (!["ok", "error", "timeout", "config_insufficient"].includes(rec.status)) v.push(`运行状态 ${rec.status} 不在枚举内`);
  for (const c of rec.calls) {
    if (!OUTCOMES.has(c.outcome)) v.push(`调用 ${c.n} 的判定 ${c.outcome} 不在枚举内`);
    const u = c.usage;
    if (![u.input, u.output, u.cacheRead, u.cacheWrite, c.ms].every((x) => Number.isFinite(x) && x >= 0)) v.push(`调用 ${c.n} 的用量或耗时不是非负数`);
  }
  return result("K7", "调用与运行记账完整", rec.calls.length + 1, v);
}

export function checkRecord(item: FixtureItem, rec: RawRecord): ContractResult[] {
  return [forbiddenText(item, rec), prefixStable(rec), sameModel(rec), truncationNotSuccess(rec), failedCheckRecovered(rec), prefetchNotInPrefix(rec), accounting(rec)];
}

/** 同组同模型汇总:任一运行失败即失败;全部不适用才不适用。违例前面带运行号,最多留 limit 条。 */
export function mergeContracts(runs: readonly { readonly runId: string; readonly results: readonly ContractResult[] }[], limit = 20): ContractResult[] {
  const ids = [...new Set(runs.flatMap((r) => r.results.map((x) => x.id)))];
  return ids.map((id) => {
    const all = runs.flatMap((r) => r.results.filter((x) => x.id === id).map((x) => ({ runId: r.runId, x })));
    const violations = all.flatMap(({ runId, x }) => x.violations.map((s) => `${runId}:${s}`));
    const verdict = all.some(({ x }) => x.verdict === "fail") ? "fail" : all.some(({ x }) => x.verdict === "pass") ? "pass" : "n/a";
    const kept = violations.length > limit ? [...violations.slice(0, limit), `……另有 ${violations.length - limit} 条`] : violations;
    return { id, title: all[0]?.x.title ?? id, verdict, checked: all.reduce((s, { x }) => s + x.checked, 0), violations: kept };
  });
}
