import { people, presetOf, type Conversation, type PersonId, type PlaybookItem } from '@/data'
import type { Item } from './constants'

/* 要带走的条目:成员的设定、群公告拆成的群规、协作手册按范围分到配合方式 / 经验 / 只在本项目用。纯函数。 */
export function cloneItems(g: Conversation | undefined, playbook: PlaybookItem[], members: PersonId[]): Item[] {
  const ruleItems: Item[] = (g?.notice ?? '').split(/[\n。；]/).map((s) => s.trim()).filter(Boolean).map((s, i) => ({ id: `rule-${i}`, group: 'rule', text: s, src: g?.noticeBy ? `群公告 · ${g.noticeBy}` : '群公告' }))
  const pbItems: Item[] = playbook.map((p) => ({
    id: p.id,
    group: p.scope === 'project' ? 'local' : p.kind === '分工' || p.kind === '交接' ? 'flow' : 'lesson',
    text: p.text,
    src: `来自 ${p.src}`,
  }))
  const memberItems: Item[] = members.filter((m) => !people[m]?.human).map((m) => {
    const tools = (people[m].tools ?? []).filter((t) => t.on).map((t) => t.name)
    return { id: `mem-${m}`, group: 'member', who: m, text: `${presetOf[m] ?? people[m].role}${tools.length ? `　技能：${tools.join('、')}` : ''}`, src: `${people[m].name} 的设定` }
  })
  return [...memberItems, ...ruleItems, ...pbItems]
}
