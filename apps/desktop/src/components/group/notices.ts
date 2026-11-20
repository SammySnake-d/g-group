import { people, type Conversation, type Notice, type PersonId } from '@/data'

export const noticesOf = (conv: Conversation): Notice[] =>
  conv.notices ?? (conv.notice ? [{ id: 'n0', text: conv.notice, by: conv.noticeBy ?? '', at: '', ver: 1, top: true }] : [])

export const botsOf = (conv: Conversation): PersonId[] => conv.members.filter((m) => !people[m]?.human)

export const loadedOf = (conv: Conversation, n: Pick<Notice, 'id' | 'ver'>) =>
  botsOf(conv).map((b) => { const v = conv.loaded?.[b]?.[n.id]; return { b, v, ok: v === n.ver } })

export const loadedRatio = (conv: Conversation, n: Pick<Notice, 'id' | 'ver'>) => {
  const L = loadedOf(conv, n)
  return { ok: L.filter((x) => x.ok).length, all: L.length }
}
