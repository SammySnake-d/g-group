// G6 评分:只读原始记录与题集,按方案 §9 分开算各项;分母一律按题集计划数,失败、超时、解析失败、配置不足的运行留在分母里。
// 红提交空壳:签名在、返回假值(undefined),实现见下一个提交。
// 不设阈值、不给「通过」结论;同组同模型的多次运行直接累加分子分母。
import { blockText, inboundLines } from "./capture.ts";
import { stepTexts } from "./fixture.ts";
import type { CallClass, CallRecord, FailureTally, FixtureItem, FixtureProbe, FixtureSet, MemoryRecord, Metrics, RawRecord, Ratio, ReplyRecord } from "./types.ts";

/** 宿主预取旧消息时给的标注(方案 §6「旧消息,供参考,不是新要求」,G4 PREFETCH_REF);第 5 块出现它才算本轮有预取。 */
export const PREFETCH_MARK = "供参考,不是新要求";

const re = (src: string) => undefined as never;
const add = (a: Ratio, n: number, d: number): Ratio => undefined as never;

/** 最近秩百分位;空数组返回 null。 */
export function percentile(xs: readonly number[], p: number): number | null { return undefined as never; }

/** 一句回复算不算答对:expect 命中(null 只要求有回复)且 reject 不命中。 */
export function answerOk(p: Pick<FixtureProbe, "expect" | "reject">, text: string): boolean { return undefined as never; }

/** 这道追问由谁回答:send 里 @ 了谁就是谁,否则是会话里的全部联系人。 */
export function answerers(item: FixtureItem, p: FixtureProbe): string[] { return undefined as never; }

/** 追问的时间窗:问题发出 → 下一步开始(最后一步到运行结束)。问题没发出去返回 null。 */
export function probeWindow(rec: RawRecord, p: FixtureProbe): { from: number; to: number } | null { return undefined as never; }

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
export function probeOutcome(item: FixtureItem, rec: RawRecord, p: FixtureProbe): ProbeOutcome { return undefined as never; }

/** 题集里每位联系人该检查的用户消息(撤回的不算);按计划数,与运行成败无关。 */
export function plannedMessages(set: FixtureSet, item: FixtureItem): { contact: string; step: number; index: number; text: string }[] { return undefined as never; }
/** 编辑后的原文也算这条消息(检查材料里是最新文字)。 */
const editedTexts = (item: FixtureItem, step: number, index: number): string[] => undefined as never;

/** 一条消息有没有进过这位联系人一次成功的检查(runner 自己判定调用成败,不信宿主自报)。 */
export function coveredBy(calls: readonly CallRecord[], contact: string, texts: readonly string[]): boolean { return undefined as never; }

const active = (ms: readonly MemoryRecord[] | undefined) => undefined as never;
const hits = (m: MemoryRecord, src: string) => undefined as never;
const isGlobal = (m: MemoryRecord) => undefined as never;

const ZERO_FAIL: FailureTally = { timeout: 0, parseFailure: 0, configInsufficient: 0, httpError: 0, networkError: 0, empty: 0, injected: 0, runErrors: 0, stepTimeouts: 0 };
const CLASSES: readonly CallClass[] = ["round", "check", "compact", "refine", "background"];

/** 同组同模型的全部运行汇成一份指标。records 里每份都必须对应题集里的一道题。 */
export function scoreRecords(set: FixtureSet, records: readonly RawRecord[]): Metrics { return undefined as never; }
