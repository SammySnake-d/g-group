/* 插件界面共用的小工具:会话的叫法、能调用插件的助手、从别处点进详情页的意图。 */
import { people, type Conversation } from '@/data'
import type { Section } from '@/ctx'

export const convName = (convs: Pick<Conversation, 'id' | 'kind' | 'title'>[], id: string) => {
  const c = convs.find((x) => x.id === id)
  return c ? (c.kind === 'group' ? c.title : `与 ${c.title} 私聊`) : id
}

/** 能调用插件的:助手(不含真人和 Helper) */
export const assistants = () => Object.values(people).filter((x) => !x.human && x.id !== 'helper')

export const personName = (id: string) => people[id]?.name ?? id

/** 群聊在前、私聊在后 */
export const groupsFirst = <T extends { kind: string }>(a: T, b: T) => (a.kind === b.kind ? 0 : a.kind === 'group' ? -1 : 1)

/** 从别处（群资料·插件）点进来时要打开的详情 */
const intent: { detail: string | null } = { detail: null }
export function openPluginDetail(setSection: (s: Section) => void, id: string) {
  intent.detail = id
  setSection('plugins')
}
/** 插件中心挂载时取走一次 */
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
