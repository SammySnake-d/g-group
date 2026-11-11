// G6 确定性合同:不看模型答得好不好,只看宿主的确定性行为有没有守住。逐份运行判,同组同模型汇总时一条失败就是失败,
// 红提交空壳:签名在、返回假值(undefined),实现见下一个提交。
// 报告里与效果指标分开列,不能用平均收益抵消(方案 §9、v0.2 §8「确定性反例先全过」)。
import { blockText, inboundLines } from "./capture.ts";
import { PREFETCH_MARK } from "./score.ts";
import type { CallOutcome, CallRecord, ContractResult, FixtureItem, RawRecord } from "./types.ts";

const result = (id: string, title: string, checked: number, violations: string[], applies = true): ContractResult => undefined as never;
const OUTCOMES: ReadonlySet<CallOutcome> = new Set(["ok", "timeout", "network_error", "http_error", "truncated", "parse_failure", "empty"]);

/**
 * K1 要扫的文字。exceptNote 时只扫宿主装配的部分:对话轮看第 1、4、5 块(不看第 3 块笔记和模型自己的工具调用回显),
 * 后台调用只看「本轮新输入(原文)」那一段;否则扫整份请求。
 */
export function scanText(c: Pick<CallRecord, "cls" | "system" | "request">, exceptNote: boolean): string { return undefined as never; }

/** K1 撤回、编辑前旧文、别的会话的原文:在指定那步之后不得出现在这位联系人的任何模型请求里。 */
export function forbiddenText(item: FixtureItem, rec: RawRecord): ContractResult { return undefined as never; }

/** K2 第 1 块(固定前缀)在同一联系人的各轮之间不变:预取和记忆变化只能进第 5 块。 */
export function prefixStable(rec: RawRecord): ContractResult { return undefined as never; }

/** K3 对话与全部后台调用都用这位联系人的说话模型(同模),不静默换模型。 */
export function sameModel(rec: RawRecord): ContractResult { return undefined as never; }

/** K4 截断的输出不当成功:它的文字不得成为之后的状态笔记(第 3 块或最终笔记)。 */
export function truncationNotSuccess(rec: RawRecord): ContractResult { return undefined as never; }

/** K5 失败的检查要补:一次检查失败(超时、截断、解析失败、报错),它材料里的用户消息之后必须进过同一联系人的一次成功检查。 */
export function failedCheckRecovered(rec: RawRecord): ContractResult { return undefined as never; }

/** K6 预取的旧消息不进固定前缀(第 1 块)。本次运行没出现预取标注时不适用。 */
export function prefetchNotInPrefix(rec: RawRecord): ContractResult { return undefined as never; }

/** K7 记账完整(runner 自查):每次调用都有判定和非负用量,运行状态在枚举内——失败才不会从分母里漏掉。 */
export function accounting(rec: RawRecord): ContractResult { return undefined as never; }

export function checkRecord(item: FixtureItem, rec: RawRecord): ContractResult[] { return undefined as never; }

/** 同组同模型汇总:任一运行失败即失败;全部不适用才不适用。违例前面带运行号,最多留 limit 条。 */
export function mergeContracts(runs: readonly { readonly runId: string; readonly results: readonly ContractResult[] }[], limit = 20): ContractResult[] { return undefined as never; }
