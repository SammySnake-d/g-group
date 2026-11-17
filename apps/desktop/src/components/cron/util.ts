/* 定时模块里几处共用的小工具 */
import { people, type Conversation, type PersonId } from '@/data'

/** 会话显示名:私聊写「与 X 私聊」 */
export const convName = (c?: Conversation, id?: string) => (c ? (c.kind === 'dm' ? `与 ${c.title} 私聊` : c.title) : id ?? '')

/** 能被叫醒的助手:不是真人,也不是 Helper */
export const isBot = (p: PersonId) => !!people[p] && !people[p].human && p !== 'helper'

/** 光标落在表达式第几段(0 起);不在任何一段上返回 null */
export function tokenAt(expr: string, pos: number | null): number | null {
  if (pos === null) return null
  let i = 0
  for (const m of expr.matchAll(/\S+/g)) {
    const start = m.index ?? 0
    if (pos >= start && pos <= start + m[0].length) return i
    i++
  }
  return null
}
