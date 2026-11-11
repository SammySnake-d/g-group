// 任务接线:tasks.list 全量读 → Compute 切片;task.updated 整条换(按 stateVer 只进不退),compute.progress 追加一条过程。
// 一件派给联系人的任务在界面上就是一个 Compute(id = 任务 id,聊天里的任务卡指向它)。
// 合同里没有的不编:步骤计划、改动文件、检查、检查点、花费都留空(花费显示「—」);用时只在 Compute 跑完、有起止时间时才算。
import { formatDuration } from '@g-group/ui-core'
import type { ComputeProgress, TaskStateName, TaskView } from '@g-group/api-contract'
import type { ActKind, Activity, CStatus, Compute } from '@/data'
import { msgId } from './messages'
import { clockOf, defineWiring, read } from './types'

const HARNESS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }
const PLACEMENT: Record<TaskView['computeRuns'][number]['placement'], string> = { local: '本机', byom_daemon: '自带机器', cloud_sandbox: '云端' }
/** 停下后的说明:宿主确认它启动的程序都退出了才到「已取消」(AC-23),只保证到它启动的程序(v3.20 已定 16) */
export const STOPPED_PHASE = '已停止 · 算力已归还（只保证到它启动的程序）'
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

/** Compute 那一行的阶段:宿主的任务状态说了算,不搬 Compute 自己的原话(它不在聊天里说话,原话在点开后的过程里)。
 *  h = 执行它的 harness(Claude Code / Codex),写在阶段前面,一眼看出活是 Compute 在干 */
function phaseOf(t: TaskView, last: ComputeProgress | undefined, h: string): string {
  switch (t.state) {
    case 'T1_Open': case 'T2_Claimed': return t.waitingFor ?? '等着开工'
    case 'T3_Running': return t.waitingFor ?? `${h} ${last?.kind === 'milestone' && last.stage ? last.stage : '在做'}`
    case 'T4b_BlockedOnHuman': return t.pendingQuestion?.text ?? `${h} 卡住了，等你回答`
    case 'T5_InReview': return t.reviews?.some((r) => r.status === 'running') ? `${h} 做完了，在复核` : `${h} 做完了，等你确认`
    case 'T7_Delivering': return `${h} 做完了，在交付`
    case 'T8a_Delivered': return `${h} 做完了，等你确认`
    case 'T8_Accepted': return `${h} 做完了，你已验收`
    case 'T9_StopRequested': return t.waitingFor ?? '正在停止…等它启动的程序都退出，之前不归还算力'
    case 'T10_Cancelled': return t.computeRuns.length ? STOPPED_PHASE : '已取消'
    case 'T11_Failed': return `${h} 没做成`
  }
}

/** 任务卡在只有人能过的一步(Compute 报受阻,宿主让联系人 @你,AC-44):不是联系人转来的授权提问。
 *  你点过「我来处理」(本地记的 taken)在同一个问题上保留 */
function humanStep(t: TaskView, prev?: Compute): Compute['needsHuman'] {
  const q = t.state === 'T4b_BlockedOnHuman' ? t.pendingQuestion : null
  if (!q || t.authorizations?.some((a) => a.qId === q.qId && a.state === 'pending')) return undefined
  return { what: q.text || '这一步得你来', qid: q.qId, ...(prev?.needsHuman?.qid === q.qId && prev.needsHuman.taken ? { taken: true } : {}) }
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
  const human = humanStep(t, prev)
  /* 卡在要你来的那一步:Compute 还占着,那一行换成「要你来」(和原型一样仍算在跑) */
  const status = human ? 'running' : STATUS[t.state]
  const ended = first && last?.endedAt ? Date.parse(last.endedAt) - Date.parse(first.startedAt) : NaN
  const harness = last ? (HARNESS[last.harness] ?? last.harness) : '—'
  const elapsed = Number.isFinite(ended) && ended >= 0 ? formatDuration(ended) : '—'
  const phase = phaseOf(t, latest, harness === '—' ? 'Compute' : harness)
  return {
    id: t.id, title: t.title, owner: t.ownerContactId, conv: t.roomId, askMsg: msgId(t.roomId, t.sourceSeq),
    /* 交付消息(AC-56 普通消息):做完的 Compute 挂在它下面(#1790 消息优先) */
    ...(t.deliveredSeq != null ? { reportMsg: msgId(t.roomId, t.deliveredSeq) } : {}),
    ...(last ? { placement: PLACEMENT[last.placement] } : {}),
    ...(human ? { needsHuman: human } : {}),
    status, phase, elapsed,
    cost: '—',
    model: last?.model ?? t.modelSnapshot?.model ?? '—',
    harness,
    steps: [], activity: mergeActs(prev?.activity ?? [], progress.map(actOf)), files: [], checks: [], checkpoints: [],
    /* 做完了:那一行写「Claude Code 做完了，等你确认 · 18 秒」,Compute 的原话(done.summary)只在过程里 */
    ...(status === 'done' && done ? { result: elapsed === '—' ? phase : `${phase} · ${elapsed}` } : {}),
    /* 失败了(出了原位失败卡、任务还在等你选,或已经没做成):那一行写失败原因 */
    ...((status === 'error' || latest?.kind === 'failed') && failed ? { error: failed.summary } : {}),
    ...(t.state === 'T9_StopRequested' ? { stopping: true } : {}),
    /* 借的是本群临时槽位(U09):群资料「临时算力」页按它列借出 */
    ...(t.slot?.scope === 'group' ? { pool: 'group' as const } : {}),
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
      w.get().putCompute({ ...c, activity: mergeActs(c.activity, [actOf(ev.progress)]), ...(c.status === 'running' && ev.progress.kind === 'milestone' && ev.progress.stage ? { phase: `${c.harness === '—' ? 'Compute' : c.harness} ${ev.progress.stage}` } : {}) })
    },
  },
})
