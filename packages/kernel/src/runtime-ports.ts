//   - Inbound:进入某位联系人注意循环的一切输入(群/私聊消息、所属 Compute 语义事件、定时触发),D15.1「唯一消息入口」;
//   - RoundRequest:每轮发给联系人模型的五块重拼结果(需求文档 D06 第 2 小节:固定前缀 / 承诺账本 / 状态笔记 / 新消息 / 指针与按需换入);
//   - MindAction:模型能提出的动作。动作由宿主校验、分配 action_id、落盘后才执行,模型不能直接发消息或起进程。
// 分工(D06 §2「代码与模型的分工」):代码负责拼装、校验、按 seq 幂等落盘、推进游标;模型只负责判断、提出承诺与写状态笔记。

import type { UsageSink } from "./model-usage.ts";

export type InboundSenderKind = "user" | "contact" | "helper" | "system";
export interface InboundSender {
  readonly kind: InboundSenderKind;
  readonly id: string;
  readonly name: string;
}

export interface InboundMessage {
  readonly kind: "message";
  readonly roomId: string;
  readonly seq: number;
  readonly sender: InboundSender;
  readonly text: string;
  readonly replyToSeq: number | null;
  readonly quotedSeqs: readonly number[];
  readonly mentions: readonly string[];
  readonly command: { readonly name: string; readonly args: unknown } | null;
  readonly at: string;
}
/** stalled:宿主判定这个 Compute 停滞(整轮卡死判失败,或宿主重启后成了孤儿),发给负责联系人报卡点(AC-14、D26 第 8.3 节) */
export type ComputeSignal = "started" | "milestone" | "blocked" | "completed" | "failed" | "stopped" | "stalled";
export interface InboundCompute {
  readonly kind: "compute";
  readonly roomId: string;
  readonly taskId: string;
  readonly computeId: string;
  readonly signal: ComputeSignal;
  readonly summary: string;
  readonly at: string;
}
export interface InboundSchedule {
  readonly kind: "schedule";
  readonly roomId: string;
  readonly scheduleId: string;
  readonly prompt: string;
  readonly at: string;
}
export interface InboundClaimConflict {
  readonly kind: "claim-conflict";
  readonly roomId: string;
  readonly taskId: string;
  readonly summary: string;
  readonly at: string;
}
export type Inbound = InboundMessage | InboundCompute | InboundSchedule | InboundClaimConflict;

/** 五块重拼:块号固定 1–5,块内按 parts 顺序。cacheBreakpoint 标在第 1 块末尾(前缀稳定,AC-39①)。 */
export type BlockNo = 1 | 2 | 3 | 4 | 5;
export const BLOCK_LABELS: Readonly<Record<BlockNo, string>> = Object.freeze({
  1: "固定前缀",
  2: "承诺账本",
  3: "状态笔记",
  4: "新消息",
  5: "指针与按需换入",
});
export interface RoundBlock {
  readonly block: BlockNo;
  readonly label: string;
  readonly text: string;
  readonly cacheBreakpoint: boolean;
}
export interface RoundRequest {
  readonly blocks: readonly RoundBlock[];
  readonly basedOnSeq: Readonly<Record<string, number>>;
}

export interface ContactProfile {
  readonly id: string;
  readonly name: string;
  readonly speakingModel: string;
  readonly persona: string;
}

export interface RoundInput {
  readonly contact: ContactProfile;
  readonly request: RoundRequest;
  readonly fresh: readonly Inbound[];
}

/**
 * 模型提出的动作。宿主逐条校验(会话是否可见、任务是否属于该联系人、seq 是否在本轮输入里),不合规的整条拒收并记录原因。
 * reply:在会话里发言(只有联系人能对外说话,Compute 不直接发言,AC-03);
 * dispatch:按四判据开 Compute 干活(AC-33),宿主建任务(T1→T2→T3)并起 Compute;
 * commit:登记承诺(AC-40②),text 必须是来源消息或本轮 reply 的原文子串;
 * forward:把用户追加的要求/回答转给在途 Compute(resume);
 * deliver:交付任务结果(T7→T8a 待确认,AC-28);
 * stop:请求停止任务的 Compute;
 * claim_task:认领一个本群已有的待认领任务并在群里发出接单话;release_task:放弃自己名下的认领并把任务退回待认领;
 * rerun:重跑运行台账里失败 / 中断 / 没跑完的单元(progress_rerun,D26 第 5 节)。basisSeq 是本轮里明确要求重跑的那条消息;
 *   不给就是自己决定的自动重跑(只能重跑自己名下的,有次数上限),别人名下的必须给 basisSeq,宿主在群里留记录。
 */
export type MindAction =
  | { readonly kind: "reply"; readonly roomId: string; readonly text: string; readonly replyToSeq: number | null }
  | { readonly kind: "claim"; readonly taskId: string; readonly expectedRevision: number; readonly text: string }
  | { readonly kind: "release"; readonly taskId: string; readonly expectedRevision: number; readonly text: string }
  | { readonly kind: "dispatch"; readonly roomId: string; readonly sourceSeq: number; readonly title: string; readonly task: string }
  | { readonly kind: "commit"; readonly roomId: string; readonly sourceSeq: number; readonly text: string; readonly taskId: string | null }
  // sourceSeq:这段转交来自任务所在会话里哪条用户消息;给了就是用户中途改条件(E3),宿主据此原位升版并登记关联边(AC-45/AC-16)
  | { readonly kind: "forward"; readonly taskId: string; readonly text: string; readonly sourceSeq?: number }
  | { readonly kind: "deliver"; readonly taskId: string; readonly text: string }
  | { readonly kind: "stop"; readonly taskId: string }
  // 用户对交付的普通回复(通过 / 要改)由联系人转成验收结论(AC-28/AC-56);来源必须是提出者本人在交付之后的直接消息,宿主核对
  | { readonly kind: "verdict"; readonly taskId: string; readonly sourceSeq: number; readonly verdict: "accept" | "revise"; readonly feedback: string | null }
  | {
      readonly kind: "remember";
      readonly roomId: string;
      readonly sourceSeq: number | null;
      readonly title: string;
      readonly text: string;
      readonly anchors: readonly string[];
      readonly quote: string | null;
      readonly relation: "change" | "refine" | "conflict" | null;
      readonly target: string | null;
    }
  | { readonly kind: "memory-use"; readonly id: string; readonly good: boolean; readonly note: string | null }
  | { readonly kind: "rerun"; readonly runId: string; readonly roomId: string; readonly basisSeq: number | null };
export type MindActionKind = MindAction["kind"];
export const MIND_ACTION_KINDS: readonly MindActionKind[] = Object.freeze(["reply", "claim", "release", "dispatch", "commit", "forward", "deliver", "stop", "verdict", "remember", "memory-use", "rerun"]);

export interface RoundOutput {
  readonly actions: readonly MindAction[];
  /** 新状态笔记(第 3 块);null 表示不变。 */
  readonly stateNote: string | null;
}

export type HistoryQuery =
  | { readonly kind: "search"; readonly query: string; readonly roomId: string | null; readonly limit: number | null }
  | { readonly kind: "read"; readonly roomId: string; readonly seq: number; readonly before: number | null; readonly after: number | null };

export interface LinkedQuery {
  readonly roomId: string;
  readonly linkedRoomId: string | null;
  readonly query: string | null;
  readonly beforeSeq: number | null;
  readonly limit: number | null;
}

export interface RoundTools {
  readTask?(id: string): Promise<string | null>;
  readLinked?(q: LinkedQuery): Promise<string | null>;
  /** 按 id 读一条记忆全文(含状态与关系);没有这条或无权读返回 null */
  readMemory(id: string): Promise<string | null>;
  /** 引用链往上读一级(D24 read_quote_parent):这条消息直接引用的那几条;会话不可读返回 null */
  readQuoteParent?(roomId: string, seq: number): Promise<string | null>;
  /** 运行台账查一个单元(D26 第 4 节 progress_get):状态、原因类别、子单元与最近事件(条数有界);roomId 是在哪个会话里查,决定可见范围;看不到或没有返回 null */
  queryHistory?(q: HistoryQuery): Promise<string | null>;
  progressGet?(id: string, roomId: string): Promise<string | null>;
}

export interface ContactMind {
  round(input: RoundInput, signal: AbortSignal, tools?: RoundTools, usage?: UsageSink): Promise<RoundOutput>;
}

/**
 * 状态笔记的写法(D06 第 2 小节第 3 块,借 NVIDIA 附录 A;D25 第 8 节交接笔记同构)。
 * 联系人每轮结束前按它写;宿主替联系人压缩时也交给压缩器照它写。只写下一轮继续要用的事实,不复述过程。
 */
export const STATE_NOTE_GUIDE: string = [
  "状态笔记是下一轮你唯一能看到的工作记忆(另有承诺账本原文与新消息);按下面五项写,只写之后还要用的事实,不复述过程:",
  "1 在做什么:对方还没了结的每条要求,连同它依赖的对象、数值、条件原文要点(如要排序的词、改过的时间),标来源 #seq;",
  "2 下一步;",
  "3 完成判据;",
  "4 相关指针:#seq、任务号、文件路径;",
  "5 走不通的路。",
  "被后来的消息改掉的条件只留新的,写明「#x 改了 #y」。",
].join("\n");

export type CompactKind = "round-note" | "shrink";
/**
 * 一次状态笔记压缩(D06 第 2 小节、D25 第 8 节;AC-32 ③)。
 * 必须用 contact.speakingModel 发起独立、无状态的一次调用:不进联系人会话、不带工具、不改第 1 块前缀;
 * 失败就抛错,宿主保留旧笔记,不换别的模型或厂商重试。
 */
export interface CompactRequest {
  readonly contact: ContactProfile;
  readonly kind: CompactKind;
  /** 旧状态笔记;没有为 null */
  readonly previous: string | null;
  readonly material: string;
  readonly maxBytes: number | null;
}
/** 压缩时顺手检查出的一条记忆点(按该联系人的职责写它自己的),由宿主按 D25 写入判关系落地 */
export interface CompactMemory {
  readonly roomId?: string;
  readonly sourceSeq?: number;
  readonly evidence?: string;
  readonly kind?: "preference" | "fact" | "decision" | "outcome";
  readonly title: string;
  readonly text: string;
  readonly anchors: readonly string[];
  readonly relation: "change" | "refine" | "conflict" | null;
  readonly target: string | null;
}
/**
 * 每轮结束、原文移出窗口前由宿主固定发起的一次检查(用户 #1196,协调 #1250):同一次调用里写状态笔记(模型已写就不覆盖)、
 * 检查「有没有值得记的」、最多给一条「建议改人格」(人格本身不改)。用联系人自己的说话模型,独立无状态调用。
 */
export interface ReflectRequest extends CompactRequest {
  readonly sources?: readonly ReflectSource[];
  readonly neighbors: readonly { readonly id: string; readonly title: string; readonly body: string }[];
  /** 模型本轮自己写的状态笔记;不为 null 时检查不得覆盖它 */
  readonly noteWritten: string | null;
}
export interface ReflectResult {
  readonly note: string | null;
  readonly memories: readonly CompactMemory[];
  readonly personaSuggestion: string | null;
}
export interface ContactCompactor {
  readonly model?: string;
  compact(req: CompactRequest, signal: AbortSignal, usage?: UsageSink): Promise<string>;
  reflect?(req: ReflectRequest, signal: AbortSignal, usage?: UsageSink): Promise<ReflectResult>;
}

export interface ReflectSource { readonly roomId: string; readonly seq: number; readonly revision: number; readonly senderKind: InboundSenderKind; readonly senderId: string; readonly text: string; readonly verifiedOutcome: boolean; }
