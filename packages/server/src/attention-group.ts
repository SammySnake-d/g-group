// 群里一条消息怎样进每位联系人的注意循环(AC-31:US11、D15.1、D19.2;#712–#731/#765/#770/#781):
//   - 调度只看元数据(@、私聊、回复对象),不读正文,更不前置过滤(AC-31 ①):没被 @、群里已经有别人主答,
//     这条消息照样进每个在途联系人的注意循环,由它自己判断跟自己有没有关系(像真人群聊);
//   - 没被 @ 的攒批跑(urgency=batch,最迟 maxDeferMs 必跑,不饥饿);被 @ / 私聊里的用户消息立刻跑(now);
//   - 发送前撤销竞态(AC-31 ④):真正上屏前检出「本轮开始之后又有用户新消息」就放弃这一轮的草稿重跑,
//     旧汇报一条都不发,也绝不未处理用户控制消息就推游标。
// 纯函数:计时器、循环与落盘在 host.ts 与 kernel 的注意循环里。
import type { Urgency } from "@g-group/kernel";

/**
 * 一条新消息对某位成员联系人的紧急度(AC-31 ①②)。null = 不送达——只有「它自己发的」和「正在移出这个群」
 * 两种情况会被 before-call 过滤掉,不进这个函数;除此之外一律送达。
 * direct:这条消息直接指向它(私聊、@ 了它、或回复它的消息)。
 * fromUser:发送人是用户本人(用户消息立刻跑,联系人消息攒批)。
 */
export function memberUrgency(o: { readonly direct: boolean; readonly fromUser: boolean }): Urgency | null {
  // 没被 @、群里已有别人主答,一律照送(攒批跑);用户本人直接指向它的立刻跑
  return o.direct && o.fromUser ? "now" : "batch";
}

/**
 * 本轮开始之后新到的用户消息序号(AC-31 ④):有它就不能把这一轮的结果上屏。
 * 只认用户本人发的事件(含编辑、撤回:那也是用户的新要求),按序号升序。
 */
export function newerUserSeqs(events: readonly { readonly seq: number; readonly sender: { readonly kind: string } }[], sinceSeq: number): number[] {
  return events.filter((e) => e.seq > sinceSeq && e.sender.kind === "user").map((e) => e.seq);
}
