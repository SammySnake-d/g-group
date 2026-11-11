// G6 规则替身:进程内的 Anthropic Messages 兼容端点,不连模型、不花钱,用来把 runner 自己测透。
// 红提交空壳:签名在、返回假值(undefined),实现见下一个提交。
// 它是「理想读者」:追问时只要宿主把 needs 原文放进了请求就答对,没放就答看不到——所以替身组的读回率测的是宿主装配,
// 不是模型能力。替身结果在报告里单独标「规则替身」,不当模型效果。
import { blockText as block, inboundLines, parseRequest, REFINE_MARK, sseMessage, sseResponse } from "./capture.ts";
import type { FixtureItem, FixtureProbe, Usage } from "./types.ts";

const LONG = /以后|所有|一律|始终|每次/;
const NOT_STATED = /[?？]\s*$|假如|如果|要不要|会怎样|会怎么样/;
const REMEMBER = /以后|所有|一律|始终|每次|记住/;
const est = (s: string) => undefined as never;
const UNSEEN = "我这边看不到之前的内容,能再说一下吗?";

/** 追问的回答:needs 为 null 或已出现在请求里(第 4 块之外)就给题集答案,否则说看不到。 */
export function probeAnswer(p: FixtureProbe, context: string): string { return undefined as never; }

/** 替身一次回复的决定(纯函数,便于单测):返回 SSE 正文。 */
export function standinReply(item: FixtureItem, body: string) { return undefined as never; }

/** 替身端点:只接 POST …/v1/messages,其余 404。 */
export function createStandin(item: FixtureItem): typeof globalThis.fetch { return undefined as never; }
