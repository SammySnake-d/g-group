// 任务接线:tasks.list 全量读 → Compute 切片;task.updated 整条换(按 stateVer 只进不退),compute.progress 追加一条过程。
// 一件派给联系人的任务在界面上就是一个 Compute(id = 任务 id,聊天里的任务卡指向它)。
// 合同里没有的不编:步骤计划、改动文件、检查、检查点、花费都留空(花费显示「—」);用时只在 Compute 跑完、有起止时间时才算。
import { formatDuration } from '@g-group/ui-core'
import type { ComputeProgress, TaskStateName, TaskView } from '@g-group/api-contract'
import type { ActKind, Activity, CStatus, Compute } from '@/data'
import { msgId } from './messages'
import { clockOf, defineWiring, read } from './types'

const HARNESS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }
const ACT_KIND: Record<ComputeProgress['kind'], ActKind> = { started: 'sub', milestone: 'report', blocked: 'ask', completed: 'report', failed: 'error', stopped: 'user' }
const STATUS: Record<TaskStateName, CStatus> = {
  T1_Open: 'running', T2_Claimed: 'running', T3_Running: 'running', T4b_BlockedOnHuman: 'waiting',
  T5_InReview: 'done', T7_Delivering: 'done', T8a_Delivered: 'done', T8_Accepted: 'done',
  T9_StopRequested: 'running', T10_Cancelled: 'stopped', T11_Failed: 'error',
}

/** 一条进度事件的一句话:里程碑带上阶段名,其余就是宿主给的摘要 */
const lineOf = (p: ComputeProgress) => (p.kind === 'milestone' && p.stage ? `${p.stage} · ${p.summary}` : p.summary)

/** 进度事件 → 过程里的一条。id 以发生时刻开头,按 id 排序就是时间顺序;同一事件(列表里的和推来的)id 相同,不重复 */
export const actOf = (p: ComputeProgress): Activity => ({ id: `${p.at}|${p.computeId}|${p.kind}`, step: 0, kind: ACT_KIND[p.kind], title: lineOf(p), at: clockOf(p.at) })

export function mergeActs(cur: readonly Activity[], add: readonly Activity[]): Activity[] {
  const all = new Map(cur.map((a) => [a.id, a]))
  for (const a of add) all.set(a.id, a)
  return [...all.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function phaseOf(t: TaskView, last: ComputeProgress | undefined): string {
  switch (t.state) {
    case 'T1_Open': case 'T2_Claimed': return t.waitingFor ?? '等着开工'
    case 'T3_Running': return t.waitingFor ?? (last ? lineOf(last) : '在做')
    case 'T4b_BlockedOnHuman': return t.pendingQuestion?.text ?? '等你回答'
    case 'T5_InReview': return t.reviews?.some((r) => r.status === 'running') ? '在复核' : '做完了，等你确认'
    case 'T7_Delivering': return '在交付'
    case 'T8a_Delivered': return '交付了，等你确认'
    case 'T8_Accepted': return '你已验收'
    case 'T9_StopRequested': return t.waitingFor ?? '正在停止'
    case 'T10_Cancelled': return '已取消'
    case 'T11_Failed': return last?.kind === 'failed' ? last.summary : '没做成'
  }
}

/** 合同的任务 → 界面的 Compute。没派给联系人的任务(清单里待认领的)不是 Compute,返回 null。
 *  prev:界面里已有的这一件,推来的进度事件可能比任务里的「最近若干条」更全,合并不丢 */
export function toCompute(t: TaskView, prev?: Compute): Compute | null {
  if (!t.ownerContactId) return null
  const runs = t.computeRuns
  const first = runs[0], last = runs[runs.length - 1]
  const progress = [...t.recentProgress].sort((a, b) => a.at.localeCompare(b.at))
  const latest = progress[progress.length - 1]
  const done = [...progress].reverse().find((p) => p.kind === 'completed')
  const failed = [...progress].reverse().find((p) => p.kind === 'failed')
  const status = STATUS[t.state]
  const ended = first && last?.endedAt ? Date.parse(last.endedAt) - Date.parse(first.startedAt) : NaN
  return {
    id: t.id, title: t.title, owner: t.ownerContactId, conv: t.roomId, askMsg: msgId(t.roomId, t.sourceSeq),
    status, phase: phaseOf(t, latest),
    elapsed: Number.isFinite(ended) && ended >= 0 ? formatDuration(ended) : '—',
    cost: '—',
    model: last?.model ?? t.modelSnapshot?.model ?? '—',
    harness: last ? (HARNESS[last.harness] ?? last.harness) : '—',
    steps: [], activity: mergeActs(prev?.activity ?? [], progress.map(actOf)), files: [], checks: [], checkpoints: [],
    ...(status === 'done' && done ? { result: done.summary } : {}),
    ...(status === 'error' && failed ? { error: failed.summary } : {}),
    ...(t.state === 'T9_StopRequested' ? { stopping: true } : {}),
  }
}

/** 每件任务见过的最新文档版本(合同 stateVer):旧版本晚到也不覆盖新的 */
const seen = new Map<string, number>()
const fresh = (t: TaskView) => {
  const v = t.stateVer ?? 0
  if (v < (seen.get(t.id) ?? 0)) return false
  seen.set(t.id, v)
  return true
}

export const tasksWiring = defineWiring({
  entity: '任务',
  load: async (w) => {
    const { tasks } = await read(w, 'tasks.list', { limit: 500 })
    const cur = w.get().computes
    w.get().setComputes(tasks.flatMap((t) => { fresh(t); return toCompute(t, cur[t.id]) ?? [] }))
  },
  on: {
    'task.updated': (ev, w) => {
      if (!fresh(ev.task)) return
      const c = toCompute(ev.task, w.get().computes[ev.task.id])
      if (c) w.get().putCompute(c)
    },
    'compute.progress': (ev, w) => {
      const c = w.get().computes[ev.progress.taskId]
      if (!c) return
      w.get().putCompute({ ...c, activity: mergeActs(c.activity, [actOf(ev.progress)]), ...(c.status === 'running' ? { phase: lineOf(ev.progress) } : {}) })
    },
  },
})
