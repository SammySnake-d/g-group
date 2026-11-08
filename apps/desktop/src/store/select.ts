// 由状态现算的派生值(选择器):不存副本,改了哪里各个视角立刻一致。
import { people, type Conversation, type Msg } from '@/data'
import type { AppState } from './state'

/** 当前会话;被删/退出后回落到第一个 */
export const activeConv = (s: Pick<AppState, 'convs' | 'active'>): Conversation => s.convs.find((c) => c.id === s.active) ?? s.convs[0]

/** 当前会话的草稿(坏实现 AC-24:切会话草稿丢了) */
export const draftOf = (s: Pick<AppState, 'drafts' | 'active'>, broken24: boolean) => (broken24 ? '' : (s.drafts[s.active] ?? ''))

/** 左侧导航的角标:等你处理 / 出错 / 在跑 */
export const totals = (s: Pick<AppState, 'pending' | 'computes'>) => ({
  wait: s.pending.filter((p) => p.kind !== 'error').length,
  err: s.pending.filter((p) => p.kind === 'error').length,
  run: Object.values(s.computes).filter((c) => c.status === 'running').length,
})

export type ConvTone = 'run' | 'warm' | 'err' | 'draft' | 'none'
/** 会话列表第二行:正在输入 > 等你 > 出错 > 在做 > 草稿 > 最后一条 */
export function convState(c: Conversation, s: Pick<AppState, 'pending' | 'computes' | 'typing' | 'drafts' | 'active'>): { tone: ConvTone; text: string; count: number } {
  const pend = s.pending.filter((p) => p.conv === c.id)
  const cs = Object.values(s.computes).filter((x) => x.conv === c.id)
  const err = pend.find((p) => p.kind === 'error')
  const wait = pend.filter((p) => p.kind !== 'error' && !(p.kind === 'choice' && p.stale))
  const typing = s.typing[c.id]
  if (typing && c.id !== s.active) return { tone: 'run', text: `${people[typing].name} 正在输入…`, count: 0 }
  if (wait.length) {
    const p = wait[0]
    const text = p.kind === 'choice' ? `${people[p.from].name} 在等你：${p.title}` : `${people[p.from].name} 做完了，在等你回复`
    return { tone: 'warm', text, count: pend.length }
  }
  if (err) return { tone: 'err', text: `${people[err.from].name} 遇到问题：${s.computes[(err as { computeId: string }).computeId].title}`, count: 1 }
  const run = cs.find((x) => x.status === 'running')
  if (run) return { tone: 'run', text: `${people[run.owner].name} 正在做：${run.title}`, count: 0 }
  const d = s.drafts[c.id]
  if (d && c.id !== s.active) return { tone: 'draft', text: d, count: 0 }
  const last = [...c.messages].reverse().find((m) => m.k === 'text' || m.k === 'sys') as Extract<Msg, { k: 'text' | 'sys' }> | undefined
  if (!last) return { tone: 'none', text: '', count: 0 }
  if (last.k === 'sys') return { tone: 'none', text: last.text, count: 0 }
  const who = last.from === 'me' ? '你：' : c.kind === 'group' ? people[last.from].name + '：' : ''
  return { tone: 'none', text: who + last.text, count: 0 }
}

/** 在「打开时的未读数」那条别人的消息前插一条「以下是新消息」分隔线(#1240) */
export function withUnreadDivider(c: Conversation, n?: number): Msg[] {
  if (!n) return c.messages
  const idx: number[] = []
  c.messages.forEach((m, i) => { if (m.k === 'text' && m.from !== 'me') idx.push(i) })
  const at = idx[Math.max(0, idx.length - n)]
  if (at === undefined) return c.messages
  return [...c.messages.slice(0, at), { k: 'sys', id: 'new-divider', text: '—— 以下是新消息 ——' } as Msg, ...c.messages.slice(at)]
}
