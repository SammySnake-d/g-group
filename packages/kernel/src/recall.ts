// 被引用消息的确定性 Page-in 规划(需求文档 D06.3 第 2–4 条;验收 AC-06、AC-37 ③)。
// 纯函数:输入本轮要换入的引用清单、联系人可读的会话、被引用消息的最新投影和单轮回读预算,输出逐条召回状态清单。
// 状态只有四种(D06.3 原名):
//   Full               —— 原文全部换入;
//   TruncatedSlice     —— 原文太长,只换入头部切片,带原长与续读游标 nextCursor(显式截断,不是静默);
//   DeletedOrWithdrawn —— 已撤回/删除:只给占位,不带原文、不报原长;
//   AccessDenied       —— 不在本会话(跨会话引用)、联系人不是该会话成员、或本会话里没有这条:机械拒绝,不带原文。
// 预算(D06.3 第 4 条「多条引用的公平预算分配」):先给每条有效引用保底切片 minSliceBytes(原文更短就按原文),
// 再优先补满主回复(primary),剩下的按引用顺序均分(水位法:短的拿够后余量继续分给还没拿够的)。
// 保底切片都装不下时显式失败 over-budget,不悄悄丢掉任何一条。预算单位是 UTF-8 字节,数值待决(需求文档 v3.20 §8.1 待决 13)。
// 输入先过统一的普通数据判定(plain.ts):getter 永不调用,Proxy、类实例、函数一律拒绝;之后只读冻结副本。

export type RecallState = "Full" | "TruncatedSlice" | "DeletedOrWithdrawn" | "AccessDenied";
/** 一条引用:fromRoomId 是发出引用的那条消息所在会话,roomId/seq 是被引用的消息 */
export interface RecallRef {
  readonly fromRoomId: string;
  readonly roomId: string;
  readonly seq: number;
  /** 主回复 reply_to_seq:分预算时优先补满 */
  readonly primary?: boolean;
}
/** 被引用消息的最新投影(按最新编辑版本) */
export interface RecallSource {
  readonly roomId: string;
  readonly seq: number;
  readonly text: string;
  readonly retracted: boolean;
}
export interface RecallPlanInput {
  readonly refs: readonly RecallRef[];
  /** 联系人是成员、可以读的会话 */
  readonly readableRooms: readonly string[];
  readonly sources: readonly RecallSource[];
  /** 单轮回读预算 max_recall(UTF-8 字节) */
  readonly budgetBytes: number;
  /** 每条有效引用的保底切片 min_slice_per_quote(UTF-8 字节) */
  readonly minSliceBytes: number;
}
/** 续读游标:offset 是原文(JS 字符串下标)里还没换入部分的开头,remainingBytes 是剩下的字节数 */
export interface RecallCursor {
  readonly offset: number;
  readonly remainingBytes: number;
}
export interface RecallItem {
  readonly roomId: string;
  readonly seq: number;
  readonly primary: boolean;
  readonly state: RecallState;
  /** Full 为全文,TruncatedSlice 为头部切片,其余为 "" */
  readonly text: string;
  /** text 的 UTF-8 字节数 */
  readonly bytes: number;
  /** 原文 UTF-8 字节数;DeletedOrWithdrawn / AccessDenied 为 null(不泄露原文长度) */
  readonly totalBytes: number | null;
  readonly nextCursor: RecallCursor | null;
}
export type RecallPlanResult =
  | { readonly ok: true; readonly items: readonly RecallItem[]; readonly usedBytes: number; readonly budgetBytes: number }
  | { readonly ok: false; readonly reason: "invalid-input"; readonly detail: string }
  | { readonly ok: false; readonly reason: "over-budget"; readonly need: number; readonly budget: number; readonly quotes: number; readonly detail: string };

/** 引用召回规划(空壳,待实现) */
export function planRecall(_input: RecallPlanInput): RecallPlanResult {
  return { ok: false, reason: "invalid-input", detail: "未实现" };
}
