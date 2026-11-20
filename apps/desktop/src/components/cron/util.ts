import { people, type Conversation, type PersonId } from '@/data'

export const convName = (c?: Conversation, id?: string) => (c ? (c.kind === 'dm' ? `与 ${c.title} 私聊` : c.title) : id ?? '')

export const isBot = (p: PersonId) => !!people[p] && !people[p].human && p !== 'helper'

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
