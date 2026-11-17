import { people, dutyByConv, dutyDefault, type PersonId, type Msg, type Conversation } from '@/data'
import type { CsvCard, GItem, GroupCard, PItem } from './types'
import {
  CSV_ROWS, DEMO_DESIGN_CONV, DEMO_DESIGN_COUNT, DEMO_DESIGN_SUMMARY, GLOBAL_DRAFT_REPLY, GLOBAL_IDLE, GROUP_BG_MSGS, GROUP_DEFAULT_PICKS,
  PANEL_CSV_REPLY, PANEL_GROUP_REPLY, globalNoGroup, globalReading, globalSummaryOther, panelFallback,
} from './constants'

/* Helper 怎么回答:纯函数,只读会话数据、不碰界面状态。id 由调用方给(store.nid)。 */

/** 群里每个助手的分工(本群分工优先,其次默认职位、角色) */
export function dutiesOf(c: Conversation): { id: PersonId; duty: string }[] {
  const by = dutyByConv[c.id] ?? {}
  return c.members.filter((m) => m !== 'me' && !people[m]?.human).map((id) => ({ id, duty: by[id] ?? dutyDefault[id] ?? people[id]?.role ?? '' }))
}

/** 一条消息用一句话描述,给「带哪几条当背景」用 */
export function msgLine(m: Msg): string {
  switch (m.k) {
    case 'text': return `${people[m.from]?.name ?? ''}：${m.text}`
    case 'huddle': return `${m.who.map((w) => people[w].name).join(' 和 ')} 的小范围讨论（${m.items.length} 条）`
    case 'summary': return `${people[m.from].name} 的总结：${m.title}`
    case 'vote': return `${people[m.from].name} 发起的投票：${m.title}`
    default: return ''
  }
}

/** CSV 的每一行按关键词在本群分工里找推荐人 */
export function csvCard(c: Conversation): CsvCard {
  const by = dutyByConv[c.id] ?? {}
  const rows = CSV_ROWS.map(({ text, keys }) => {
    const hit = Object.entries(by).find(([id, d]) => c.members.includes(id) && keys.some((k) => d.includes(k)))
    return hit ? { text, who: hit[0], why: `本群分工：${hit[1]}` } : { text, why: '' }
  })
  return { rows }
}

/** 另开群的确认卡:点了名的人(没点名就用默认两位)、要带的背景、从话里摘出的群名 */
export function groupCard(c: Conversation, ask: string): GroupCard {
  const named = c.members.filter((m) => m !== 'me' && !people[m]?.human && ask.includes(people[m].name))
  const ids: PersonId[] = named.length ? named : GROUP_DEFAULT_PICKS.filter((m) => c.members.includes(m))
  let bg = c.messages.filter((m) => 'id' in m && GROUP_BG_MSGS.includes(m.id)).map((m) => ({ id: (m as { id: string }).id, text: msgLine(m), on: true }))
  if (!bg.length) bg = c.messages.filter((m) => msgLine(m)).slice(-3).map((m) => ({ id: (m as { id: string }).id, text: msgLine(m), on: true }))
  const topic = ask.match(/聊(.+?)$/)?.[1]?.replace(/[，。,.!！?？]/g, '').trim()
  return { title: topic || '新的讨论', picks: Object.fromEntries(ids.map((i) => [i, true])), bg }
}

/** 面板(只读当前聊天)对一句话的回答 */
export function panelAnswer(c: Conversation, ask: string, id: string): PItem {
  if (/另开|拉.*群|新群|建群/.test(ask)) return { id, from: 'helper', text: PANEL_GROUP_REPLY, group: groupCard(c, ask) }
  if (/csv|CSV|表格|清单/.test(ask)) return { id, from: 'helper', text: PANEL_CSV_REPLY, csv: csvCard(c) }
  if (/谁适合|谁来|谁做/.test(ask)) {
    const list = dutiesOf(c)
    const best = list.find((x) => /需求|文档|接入/.test(x.duty))
    const lines = list.map((x) => `· ${people[x.id].name}：${x.duty}`).join('\n')
    return { id, from: 'helper', text: `本群的分工：\n${lines}\n\n${best ? `飞书接入偏需求和方案，按分工 ${people[best.id].name} 最合适。` : '分工里没有正好对上的，可以在群里问谁有空。'}` }
  }
  return { id, from: 'helper', text: panelFallback(c.title) }
}

/* ---------- 全局 Helper:默认什么都不读;读要授权,发要草稿 ---------- */

/** 话里提到的群(长名字优先,避免「群聊」先匹配到短名) */
export const findGroup = (convs: Conversation[], text: string) =>
  [...convs].sort((a, b) => b.title.length - a.title.length).find((c) => c.kind === 'group' && text.includes(c.title))

/** 某个群的总结(演示:只有「前端设计讨论」有完整总结) */
export const summaryOf = (cid: string, title: string, id: string): GItem => ({
  id, from: 'helper', text: cid === DEMO_DESIGN_CONV ? DEMO_DESIGN_SUMMARY : globalSummaryOther(title),
})

/** 全局 Helper 对一句话的回答(不含你自己那条) */
export function globalAnswer(text: string, convs: Conversation[], granted: string[], nid: () => string): GItem {
  const titleOf = (cid: string) => convs.find((c) => c.id === cid)?.title ?? ''
  const target = findGroup(convs, text)
  const sendM = text.match(/^代我在(.+?)(?:里|群里)?说[:：]\s*(.+)$/)
  if (sendM) {
    const c = findGroup(convs, sendM[1])
    if (!c) return { id: nid(), from: 'helper', text: globalNoGroup(sendM[1]) }
    return { id: nid(), from: 'helper', text: GLOBAL_DRAFT_REPLY, draft: { conv: c.id, title: c.title, body: sendM[2] } }
  }
  if (target && /总结|说了什么|聊了什么|读|看看/.test(text)) {
    if (granted.includes(target.id)) return summaryOf(target.id, target.title, nid())
    const n = target.id === DEMO_DESIGN_CONV ? DEMO_DESIGN_COUNT : target.messages.filter((m) => m.k === 'text').length
    return { id: nid(), from: 'helper', text: '', grant: { conv: target.id, title: target.title, n, ask: text } }
  }
  return { id: nid(), from: 'helper', text: granted.length ? globalReading(granted.map(titleOf)) : GLOBAL_IDLE }
}
