// 联系人运行时的接缝(ports)。内核只定义形状,不做 I/O:
//   - Inbound:进入某位联系人注意循环的一切输入(群/私聊消息、所属 Compute 语义事件、定时触发),D15.1「唯一消息入口」;
//   - RoundRequest:每轮发给联系人模型的五块重拼结果(需求文档 D06 第 2 小节:固定前缀 / 承诺账本 / 状态笔记 / 新消息 / 指针与按需换入);
//   - ContactMind:联系人「脑子」——吃一轮输入,吐动作。真实实现在 adapter 层(pi-agent-core),测试用确定性假实现;
//   - MindAction:模型能提出的动作。动作由宿主校验、分配 action_id、落盘后才执行,模型不能直接发消息或起进程。
// 分工(D06 §2「代码与模型的分工」):代码负责拼装、校验、按 seq 幂等落盘、推进游标;模型只负责判断、提出承诺与写状态笔记。

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
  /** 正文与回复里 @ 到的成员 id(联系人或用户)。 */
  readonly mentions: readonly string[];
  readonly command: { readonly name: string; readonly args: unknown } | null;
  readonly at: string;
}
export type ComputeSignal = "started" | "milestone" | "blocked" | "completed" | "failed" | "stopped";
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
export type Inbound = InboundMessage | InboundCompute | InboundSchedule;

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
  /** 这一轮装进第 4 块的最大 seq(各会话分开记),即本轮处理到哪里。 */
  readonly basedOnSeq: Readonly<Record<string, number>>;
}

export interface ContactProfile {
  readonly id: string;
  readonly name: string;
  readonly speakingModel: string;
  /** SOUL.md / 人设原文,进第 1 块。 */
  readonly persona: string;
}

export interface RoundInput {
  readonly contact: ContactProfile;
  readonly request: RoundRequest;
  /** 与 request 第 4 块对应的结构化新输入,便于 mind 引用 seq / taskId。 */
  readonly fresh: readonly Inbound[];
}

/**
 * 模型提出的动作。宿主逐条校验(会话是否可见、任务是否属于该联系人、seq 是否在本轮输入里),不合规的整条拒收并记录原因。
 * reply:在会话里发言(只有联系人能对外说话,Compute 不直接发言,AC-03);
 * dispatch:按四判据开 Compute 干活(AC-33),宿主建任务(T1→T2→T3)并起 Compute;
 * commit:登记承诺(AC-40②),text 必须是来源消息或本轮 reply 的原文子串;
 * forward:把用户追加的要求/回答转给在途 Compute(resume);
 * deliver:交付任务结果(T7→T8a 待确认,AC-28);
 * stop:请求停止任务的 Compute。
 */
export type MindAction =
  | { readonly kind: "reply"; readonly roomId: string; readonly text: string; readonly replyToSeq: number | null }
  | { readonly kind: "dispatch"; readonly roomId: string; readonly sourceSeq: number; readonly title: string; readonly task: string }
  | { readonly kind: "commit"; readonly roomId: string; readonly sourceSeq: number; readonly text: string; readonly taskId: string | null }
  | { readonly kind: "forward"; readonly taskId: string; readonly text: string }
  | { readonly kind: "deliver"; readonly taskId: string; readonly text: string }
  | { readonly kind: "stop"; readonly taskId: string };
export type MindActionKind = MindAction["kind"];
export const MIND_ACTION_KINDS: readonly MindActionKind[] = Object.freeze(["reply", "dispatch", "commit", "forward", "deliver", "stop"]);

export interface RoundOutput {
  readonly actions: readonly MindAction[];
  /** 新状态笔记(第 3 块);null 表示不变。 */
  readonly stateNote: string | null;
}

export interface ContactMind {
  /** 跑一轮。signal 触发时应尽快放弃(宿主发现发送前出现更新的用户消息,会中止重跑)。 */
  round(input: RoundInput, signal: AbortSignal): Promise<RoundOutput>;
}
