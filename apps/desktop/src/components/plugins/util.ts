import { people, type Conversation } from '@/data'
import type { Section } from '@/ctx'

export const convName = (convs: Pick<Conversation, 'id' | 'kind' | 'title'>[], id: string) => {
  const c = convs.find((x) => x.id === id)
  return c ? (c.kind === 'group' ? c.title : `与 ${c.title} 私聊`) : id
}

export const assistants = () => Object.values(people).filter((x) => !x.human && x.id !== 'helper')

export const personName = (id: string) => people[id]?.name ?? id

export const groupsFirst = <T extends { kind: string }>(a: T, b: T) => (a.kind === b.kind ? 0 : a.kind === 'group' ? -1 : 1)

const intent: { detail: string | null } = { detail: null }
export function openPluginDetail(setSection: (s: Section) => void, id: string) {
  intent.detail = id
  setSection('plugins')
}
export function takeDetailIntent() {
  const d = intent.detail
  intent.detail = null
  return d
}

export const toggleIn = (set: Set<string>, k: string) => {
  const n = new Set(set)
  if (n.has(k)) n.delete(k)
  else n.add(k)
  return n
}
