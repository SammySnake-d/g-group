// G6 的录制层:包住进程内 fetch,把每次 Anthropic Messages 调用(含 SDK 自己的重试)记成一条 CallRecord;
// 红提交空壳:签名在、返回假值(undefined),实现见下一个提交。
// 按题集注入故障(不发上游、不花钱)。只记请求体与响应,不记请求头,密钥不进记录。
// 不改被测提交的代码:driver 在被测工作树里把 globalThis.fetch 换成它,宿主自己的装配(start.ts)照常建联系人脑子与压缩器。
import type { CallClass, CallOutcome, CallRecord, FaultKind, FixtureFault, Usage } from "./types.ts";

export interface ParsedRequest {
  readonly model: string | null;
  readonly maxTokens: number | null;
  readonly hasTools: boolean;
  readonly system: string;
  readonly request: string;
}
/** 工具结果的正文:字符串或文字块数组(不再往下嵌套) */
const plain = (c: unknown) => undefined as never;
const textOf = (c: unknown) => { return undefined as never; };

export function parseRequest(body: string): ParsedRequest { return undefined as never; }

const HEAD = /^#(\d+) · (\S+) · .*?\((user|contact|helper|system):[^)]*\)/;
export interface InboundLine {
  readonly roomId: string;
  readonly seq: number;
  readonly kind: string;
  readonly text: string;
}
/** 从第 4 块或检查材料里读出逐条消息(内核 renderInboundText 的呈现:头一行 `#seq · 会话 · 名字(种类:id) · 时间`,下面是原文)。 */
export function inboundLines(text: string): InboundLine[] { return undefined as never; }

/** 取 `<block n="N">` 的正文(宿主五块的呈现);没有这块返回空串。 */
export const blockText = (request: string, n: number) => undefined as never;

/** 调用归类:带工具的是联系人一轮;不带工具的按说明文字分检查(要 memories JSON)/补写笔记/其余后台。 */
export function classifyCall(r: Pick<ParsedRequest, "hasTools" | "system">): CallClass { return undefined as never; }

export interface ParsedReply {
  readonly stopReason: string | null;
  readonly usage: Usage;
  readonly text: string;
  readonly tools: { readonly name: string; readonly input: unknown }[];
  readonly error: string | null;
}
const ZERO: Usage = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** 解析 Anthropic Messages 的流式(SSE)或一次性 JSON 回复;解析不了的部分留空,不抛错。 */
export function parseReply(raw: string): ParsedReply { return undefined as never; }

/** 检查调用的输出能不能当成一次完整检查:必须是带 memories 数组的 JSON 对象。 */
export function checkOutputParses(text: string): boolean { return undefined as never; }

/** runner 自己对一次调用结果的判定(不信被测宿主的自报)。 */
export function judgeCall(cls: CallClass, status: number, r: ParsedReply): CallOutcome { return undefined as never; }

/** 组一份 Anthropic SSE 回复(规则替身与故障注入共用)。 */
export function sseMessage(o: { model: string; blocks: readonly ({ type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown })[]; stopReason: string; usage: Usage }) { return undefined as never; }
export const sseResponse = (body: string, status = 200): Response => undefined as never;

/** 注入的故障回复。network 不给回复,直接按传输失败抛错。截断的文字按调用类区分(检查是半个 JSON,补写是半份笔记)。 */
export function faultResponse(kind: FaultKind, model: string, cls: CallClass): Response { return undefined as never; }

export interface Recorder {
  readonly fetch: typeof globalThis.fetch;
  /** 等所有在途调用的响应读完并落进记录。 */
  flush(): Promise<void>;
  readonly calls: CallRecord[];
}

/**
 * 录制并按需注入故障的 fetch。只处理 /v1/messages,其余原样转发。
 * contactOf 用请求文字把调用归到题集里的联系人(人设 marker);timeoutMs 是 runner 给单次调用的上限,到点按 timeout 记。
 */
export function recordingFetch(o: { upstream: typeof globalThis.fetch; contactOf: (text: string) => string | null; faults: readonly FixtureFault[]; timeoutMs?: number; now?: () => number }): Recorder { return undefined as never; }
