import type { Compute } from '@/data'
import type { Live } from '../Avatar'

/* 工作台头部那一行状态:只从真实事件推出来(和头像上的状态点同一来源 useLive),展示在 Workbench 里画 */
export type WbStatus = { tone: 'err' | 'warm' | 'run' | 'idle'; text: string }

export function workbenchStatus(live: Live, mine: Compute[]): WbStatus {
  if (live === 'error') return { tone: 'err', text: `遇到问题：${mine.find((c) => c.status === 'error')?.title ?? '有一件事出错了'}` }
  if (live === 'waiting') return { tone: 'warm', text: '在等你处理' }
  if (live === 'running') return { tone: 'run', text: `正在做：${mine.find((c) => c.status === 'running')?.title ?? ''}` }
  return { tone: 'idle', text: '空闲' }
}

/** 在做的事走到第几步:有「正在/失败」的那步就算到那步,否则数做完的 */
export function stepOf(c: Compute): number {
  const step = c.steps.findIndex((s) => s.state === 'now' || s.state === 'fail')
  return step < 0 ? c.steps.filter((s) => s.state === 'done').length : step + 1
}
