import { people, type Compute, type Conversation, type ListItem, type Pending } from '@/data'

/** 这个会话里「等你」的事,每件落在一条消息上(刻度就画在那条消息的位置) */
export interface WaitItem { msgId: string; kind: 'ask' | 'accept' | 'error'; label: string }

const name = (id: string) => people[id]?.name ?? id

/* 只收真的在等你的:要你选 / 要你同意 / 做完等你验收 / 出错等你决定。已读、表情、普通 @ 不算 */
export function waitingIn(conv: Conversation, pending: Pending[], checklist: ListItem[], computes: Record<string, Compute>): WaitItem[] {
  const out: WaitItem[] = []
  const msgOfCompute = (cid: string) => {
    const c = computes[cid]
    if (c?.reportMsg) return c.reportMsg
    const m = conv.messages.find((x) => x.k === 'compute' && x.computeId === cid)
    return m && 'id' in m ? m.id : undefined
  }
  for (const p of pending) {
    if (p.conv !== conv.id) continue
    if (p.kind === 'choice' && !p.stale) out.push({ msgId: p.ask, kind: 'ask', label: `${name(p.from)} 在等你选：${p.title}` })
    if (p.kind === 'proposal' && p.ask) out.push({ msgId: p.ask, kind: 'ask', label: `${name(p.from)} 等你同意：${p.title}` })
    if (p.kind === 'accept') { const id = p.ask ?? msgOfCompute(p.computeId); if (id) out.push({ msgId: id, kind: 'accept', label: `${name(p.from)} 做完了，等你验收：${computes[p.computeId]?.title ?? ''}` }) }
    if (p.kind === 'error') { const id = msgOfCompute(p.computeId); if (id) out.push({ msgId: id, kind: 'error', label: `${name(p.from)} 遇到问题：${computes[p.computeId]?.title ?? ''}` }) }
  }
  for (const t of checklist) {
    if (t.conv !== conv.id || t.status !== '待验收') continue
    const c = t.attempts.map((a) => computes[a]).find((x) => x?.reportMsg)
    if (c?.reportMsg && !out.some((o) => o.msgId === c.reportMsg)) out.push({ msgId: c.reportMsg, kind: 'accept', label: `${name(c.owner)} 做完了，等你验收：${t.text}` })
  }
  const order = new Map(conv.messages.map((m, i) => ['id' in m ? m.id : '', i]))
  return out.filter((o) => order.has(o.msgId)).sort((a, b) => order.get(a.msgId)! - order.get(b.msgId)!)
}
