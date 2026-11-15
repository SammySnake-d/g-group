/* 消息流的编排规则(纯函数,不碰界面):哪些 Compute 折成汇报消息下的灰字,哪几条合并在同一个头像下 */
import type { Compute, Msg } from '@/data'
import type { Bodied } from './types'

/** #1790 消息优先:Compute 已经有汇报消息时,不单独占一行,而是挂在汇报消息最下面;还没汇报(在跑/出错)才单独一行。
 *  返回去掉被折叠 Compute 行的消息流,以及「汇报消息 id → 挂在它下面的 Compute id」 */
export function foldComputeTrails(msgs: Msg[], computes: Record<string, Compute>) {
  const ids = new Set(msgs.map((x) => ('id' in x ? x.id : '')))
  const trailOf: Record<string, string> = {}
  for (const c of Object.values(computes)) if (c.reportMsg && ids.has(c.reportMsg)) trailOf[c.reportMsg] = c.id
  const folded = new Set(Object.values(trailOf))
  return { list: msgs.filter((x) => !(x.k === 'compute' && folded.has(x.computeId))), trailOf }
}

const mins = (t?: string) => (t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : NaN)

/** #1796 合并还是拆开:同一个人、同一件事、5 分钟内连着说 → 合并在一个头像下(间距 2px)。
 *  以下任一成立就拆开,重新露出名字和时间(间距 16px):带引用;上一条是一个回合的结尾(挂着要你回答的选项或做完的过程);隔了 5 分钟以上 */
export function continuesPrev(prev: Msg | undefined, m: Bodied, endsTurn: (x: Msg) => boolean, sameQuote = false) {
  /* 联系人「接了任务」那句(带着引用)和它派出的 Compute 行是同一条记录拆出来的两样:Compute 行始终挂在那句下面 */
  if (prev && m.k === 'compute' && 'id' in prev && m.id === `${prev.id}~c`) return true
  return !!prev && 'from' in prev && prev.from === m.from
    && (sameQuote || (!(prev.k === 'text' && prev.quotes?.length) && !(m.k === 'text' && m.quotes?.length)))
    && !endsTurn(prev) && !(prev.k === 'text' && m.k === 'text' && mins(m.at) - mins(prev.at) > 5)
}
