import { people, presetOf, type Conversation, type PersonId, type PlaybookItem } from '@/data'
import type { Persona } from '@/api/wire/clone'
import { CLONE_LIVE, type Item } from './constants'

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

/** 每位联系人的预设读到哪一步了(没有 = 还在读) */
export type Personas = Partial<Record<PersonId, Persona>>

const personaText = (p: Persona | undefined) =>
  !p ? CLONE_LIVE.personaLoading : p.state === 'error' ? CLONE_LIVE.personaFailed(p.reason) : p.text.trim() || CLONE_LIVE.personaEmpty

/* 连着后端时要带走的条目:成员的预设读后端(只读,跟着联系人本人走);群规 = 这个群现在有效的每一条公告(conv.notices,不是旧字段 notice),
   一条公告一项、按发布先后排(conv.notices 新的在前,这里倒过来),新群里就按这个顺序逐条发布。协作手册以后再定,不列。纯函数。 */
export function cloneItemsLive(g: Conversation | undefined, members: PersonId[], personas: Personas): Item[] {
  const memberItems: Item[] = members.filter((m) => people[m] && !people[m].human).map((m) => {
    const tools = (people[m].tools ?? []).filter((t) => t.on).map((t) => t.name)
    return { id: `mem-${m}`, group: 'member', who: m, readonly: true, text: `${personaText(personas[m])}${tools.length ? `　技能：${tools.join('、')}` : ''}`, src: CLONE_LIVE.personaSrc }
  })
  const ruleItems: Item[] = [...(g?.notices ?? [])].reverse().map((n) => ({ id: `rule-${n.id}`, group: 'rule', text: n.text, src: ['群公告', n.by, n.at].filter(Boolean).join(' · ') }))
  return [...memberItems, ...ruleItems]
}
