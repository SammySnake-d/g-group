// 运行台账接线(AC-43,需求 D26):runs.list 全量读 + run.updated 增量,按任务汇总成「台账摘要」写进 Compute 切片的 ledger。
// 进展全景连着后端时读它:真实轮数、上游、失败原因类别与原文、判卡住用的阈值、子代理 / 后台任务——全景和联系人的查询读同一张台账。
// 聊天里那一行 Compute 的状态仍以任务为准(api/wire/tasks);台账只补任务里没有的事实,不改任务状态。
import type { RunView } from '@g-group/api-contract'
import type { ReasonClass, SubKind, UnitState } from '@g-group/ui-core'
import { defineWiring, read } from './types'

export interface LedgerSub {
  id: string; kind: SubKind; title: string; state: UnitState
  reason?: ReasonClass; reasonRaw?: string
  startedAt: number; endedAt?: number; lastProgressAt: number
}
/** 一件任务在台账里的摘要 */
export interface TaskLedger {
  /** 最近一次 Compute 会话的台账状态(排队、没跑完这些任务状态里看不出的,以它为准) */
  status: UnitState
  /** 最近一次 Compute 会话的上游(模型 / 网关) */
  upstream?: string
  reason?: ReasonClass
  /** 原因原文(卡片上悬停可看) */
  reasonRaw?: string
  lastProgressAt: number
  /** 宿主判卡住用的阈值;custom = 按联系人或按上游单独设的 */
  threshold?: { minutes: number; custom: boolean }
  /** Compute 轮次数(这件任务的所有会话合计) */
  turns: number
  subs: LedgerSub[]
}

const SUB_KIND: Partial<Record<RunView['layer'], SubKind>> = { subagent: 'subagent', background: 'job' }
const SUB_TITLE: Record<SubKind, string> = { subagent: '子代理', subchat: '子对话', job: '后台任务' }
const at = (iso: string) => Date.parse(iso)
const failure = (r: RunView) => ({ ...(r.reasonClass ? { reason: r.reasonClass } : {}), ...(r.raw ? { reasonRaw: r.raw } : {}) })

/** 台账单元(全量 + 增量),按 id;摘要从它现算 */
const runs = new Map<string, RunView>()

/** 这件任务的台账摘要;台账里还没有它的 Compute 会话(没开工)返回 null */
export function ledgerOf(taskId: string, all: Iterable<RunView> = runs.values()): TaskLedger | null {
  const mine = [...all].filter((r) => r.taskId === taskId)
  const sessions = mine.filter((r) => r.layer === 'compute-session').sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const s = sessions[sessions.length - 1]
  if (!s) return null
  const subs = mine.flatMap((r): LedgerSub[] => {
    const kind = SUB_KIND[r.layer]
    if (!kind) return []
    /* 合同的台账单元没有标题:写类别,原文(note)有就带上 */
    return [{ id: r.id, kind, title: r.note || SUB_TITLE[kind], state: r.status, ...failure(r), startedAt: at(r.startedAt), ...(r.endedAt ? { endedAt: at(r.endedAt) } : {}), lastProgressAt: at(r.lastProgressAt) }]
  })
  return {
    status: s.status,
    ...(s.upstream ? { upstream: s.upstream } : {}),
    ...failure(s),
    lastProgressAt: Math.max(...mine.map((r) => at(r.lastProgressAt))),
    ...(s.thresholdMs ? { threshold: { minutes: Math.round(s.thresholdMs / 60_000), custom: s.thresholdSource === 'contact' || s.thresholdSource === 'upstream' } } : {}),
    turns: mine.filter((r) => r.layer === 'compute-turn').length,
    subs,
  }
}

export const runsWiring = defineWiring({
  entity: '运行台账',
  load: async (w) => {
    const { runs: list } = await read(w, 'runs.list', { limit: 500 })
    runs.clear()
    for (const r of list) runs.set(r.id, r)
    const tasks = new Set(list.flatMap((r) => (r.taskId ? [r.taskId] : [])))
    w.get().setLedger(Object.fromEntries([...tasks].flatMap((id) => { const l = ledgerOf(id); return l ? [[id, l] as const] : [] })))
  },
  on: {
    'run.updated': (ev, w) => {
      runs.set(ev.run.id, ev.run)
      const id = ev.run.taskId
      const l = id ? ledgerOf(id) : null
      if (id && l) w.get().putLedger(id, l)
    },
  },
})
