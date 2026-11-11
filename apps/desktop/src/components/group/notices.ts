/* 群公告的读法:旧数据只有一条 notice 时也当成列表;每条公告各助手装配到了哪一版。 */
import { people, type Conversation, type Notice, type PersonId } from '@/data'

export const noticesOf = (conv: Conversation): Notice[] =>
  conv.notices ?? (conv.notice ? [{ id: 'n0', text: conv.notice, by: conv.noticeBy ?? '', at: '', ver: 1, top: true }] : [])

export const botsOf = (conv: Conversation): PersonId[] => conv.members.filter((m) => !people[m]?.human)

/** 每位助手对这条公告:装配到的版本、是不是当前版本 */
export const loadedOf = (conv: Conversation, n: Pick<Notice, 'id' | 'ver'>) =>
  botsOf(conv).map((b) => { const v = conv.loaded?.[b]?.[n.id]; return { b, v, ok: v === n.ver } })

/** 「2/3」:多少位助手已装配当前版本 */
export const loadedRatio = (conv: Conversation, n: Pick<Notice, 'id' | 'ver'>) => {
  const L = loadedOf(conv, n)
  return { ok: L.filter((x) => x.ok).length, all: L.length }
}
