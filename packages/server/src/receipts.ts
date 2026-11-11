// 已读回执判定(AC-46:U35/U70、D09.3;#30/#732/#2862/#3035)。纯函数,只判位置,不碰模型:
//   - 位置只由宿主推进:模型的文字、工具调用、表情都改不了它(AC-46 ②);
//   - 只进队列不算已读:消息写进账本、在未读区间里,或者联系人还在跑上一轮,回执仍旧未读(AC-46 ③);
//   - 接走即已读:宿主开始这一轮时推进到这条(AC-46 ④);推进只增不减——接走后这一轮失败也不回退,
//     且不越过会话当前最后一条;read_seq 只用于显示,processed_seq 照旧在落盘后才推进,任何时刻 read_seq ≥ processed_seq;
//   - 读到时间取位置第一次越过这条消息的时刻,不是最后一次(AC-46 ②)。
// 状态真源是 gg_read(每成员每会话一行,只追加);这里只做推进与取值判定,不读写表。

/** 一行已读记录(uptoSeq = 当时推进到的位置,at = 那一刻)。 */
export interface ReadMark {
  readonly uptoSeq: number;
  readonly at: string;
}

/**
 * 推进已读位置:只增不减,也不越过会话当前最后一条;不需要推进(没有前进)返回 null。
 * 回退、重复推进同一条、越过账本末尾都返回 null,由调用方跳过写库。
 */
export function nextReadSeq(cur: number, seq: number, lastSeq: number): number | null {
  // 不越过账本末尾(seq 可能来自还没落盘的乐观位置);只增不减:更早的位置再报一次(重放、乱序回执)什么都不做
  const upto = Math.min(seq, lastSeq);
  return upto > cur ? upto : null;
}

/**
 * 某条消息的读到时间 = 已读位置**第一次**越过它的时刻;从没越过(仍在未读区间里)返回 null。
 * 传进来的 marks 必须是同一成员的记录;同一位置推进过多次时取最早的时刻。
 */
export function readTimeOf(marks: readonly ReadMark[], seq: number): string | null {
  let first: string | null = null;
  for (const m of marks) {
    if (m.uptoSeq < seq) continue;
    if (first === null || m.at < first) first = m.at;
  }
  return first;
}
