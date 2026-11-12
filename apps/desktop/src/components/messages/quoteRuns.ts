/* 同一个人连着说的几句引用了同一条:引用块只画一次(真实模型走查:联系人「接了任务」「收到,我这就去」「做完了」各带一遍同一条引用,很占地方)。
   判定:往上看同一个人连着说的这一串(别人一插话、出现日期或灰字行就算断开;它自己派出的 Compute 行不算断),
   里面已经有一句的引用和这一句完全一样(条数、序号、哪条是主回复都相同)——这一句就不重复画。
   只改界面怎么画,不动宿主每条回复上的 replyToSeq;右键回复、跳到原消息这些照旧。 */
import type { Msg } from '@/data'
import type { Bodied } from './types'

/** 一条消息的引用签名;没有引用是空串,不是说的话(Compute 行等)是 null */
const sig = (m: Msg): string | null => (m.k === 'text' ? (m.quotes ?? []).map((q) => `${q.msgId}${q.reply ? '!' : ''}`).join('|') : null)

/** 这一条的引用,同一个人这一串里前面已经画过了 */
export function repeatsPrevQuote(msgs: readonly Msg[], i: number, m: Bodied): boolean {
  const mine = sig(m)
  if (!mine) return false
  for (let j = i - 1; j >= 0; j--) {
    const x = msgs[j]
    if (!x || !('from' in x) || x.from !== m.from) return false
    if (sig(x) === mine) return true
  }
  return false
}
