// 「会话」页签在连上后端时读的记录:按合同里真有的东西拼出这个 Compute 的对话——
//   联系人交给它的那段话(派活卡上的 brief)、它自己报的每一步(tasks.progress 全量)、受阻 / 失败 / 停下的提示、
//   运行台账里它这次会话的轮次、后台任务、子代理和卡死判定、重跑(runs.get),以及本轮交付(任务工件)。
// 合同里没有 harness 工具调用级的原始记录,这里不编工具调用;Compute 的原话只在这里和「过程」里,不进聊天(AC-03)。
import type { ComputeProgress, RunEventView, RunView, TaskView } from '@g-group/api-contract'
import type { AgentEvent, BackgroundJob, HarnessId, HarnessTranscript, TranscriptEvent } from '@g-group/ui-core'

export interface SessionFacts {
  task: TaskView
  /** tasks.progress 读到的全部进度(按时间) */
  progress: readonly ComputeProgress[]
  /** 还有更早的进度没取 */
  hasEarlier: boolean
  /** 联系人交给 Compute 的那段话;读不到就用任务标题 */
  brief: string
  /** 派它的联系人名 */
  owner: string
  /** 台账里这件事最近一次的 Compute 会话 */
  session?: { run: RunView; children: readonly RunView[]; events: readonly RunEventView[] }
}

const AGENT_STATUS: Record<RunView['status'], AgentEvent['status']> = { queued: 'running', running: 'running', waiting_user: 'running', done: 'done', failed: 'failed', interrupted: 'failed', orphaned: 'failed' }
const JOB_STATUS: Record<RunView['status'], BackgroundJob['state']> = { queued: 'running', running: 'running', waiting_user: 'running', done: 'done', failed: 'failed', interrupted: 'killed', orphaned: 'killed' }

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type Draft = { at: string; e: DistOmit<TranscriptEvent, 'seq' | 'id'> & { id?: string } }

/** 进度事件 → 对话里的一条:它报的进展、做完的结论算它说的话;受阻、失败、停下是系统提示 */
function fromProgress(p: ComputeProgress): Draft['e'] {
  switch (p.kind) {
    case 'milestone': return { kind: 'text', at: p.at, text: p.stage ? `${p.stage} · ${p.summary}` : p.summary }
    case 'completed': return { kind: 'text', at: p.at, text: p.summary }
    case 'started': return { kind: 'notice', at: p.at, level: 'info', text: p.summary || '开始干活' }
    case 'blocked': return { kind: 'notice', at: p.at, level: 'warn', text: p.summary }
    case 'failed': return { kind: 'notice', at: p.at, level: 'error', text: p.summary }
    case 'stopped': return { kind: 'notice', at: p.at, level: 'info', text: p.summary || '已停下' }
  }
}

/** 台账事件里值得给人看的:卡死判定、重跑 */
function fromRunEvent(e: RunEventView): Draft['e'] | null {
  if (e.kind === 'stall-judged') return { kind: 'notice', at: e.at, level: 'warn', text: '这一轮卡住没有进展，已判失败' }
  if (e.kind === 'rerun') {
    const n = (e.detail as { attempt?: unknown } | null)?.attempt
    return { kind: 'notice', at: e.at, level: 'info', text: typeof n === 'number' ? `按台账重跑了一次（第 ${n} 次）` : '按台账重跑了一次' }
  }
  return null
}

/** 拼出对话记录;还没起过 Compute(排队等槽位)就是 null */
export function liveTranscript(f: SessionFacts): HarnessTranscript | null {
  const runs = f.task.computeRuns
  const first = runs[0], last = runs[runs.length - 1]
  if (!first || !last) return null
  const kids = f.session?.children ?? []
  const drafts: Draft[] = [
    { at: first.startedAt, e: { kind: 'prompt', at: first.startedAt, from: f.owner, text: f.brief } },
    ...f.progress.map((p) => ({ at: p.at, e: fromProgress(p) })),
    ...kids.filter((r) => r.layer === 'subagent').map((r): Draft => ({ at: r.startedAt, e: { kind: 'agent', id: r.id, at: r.startedAt, label: r.text, brief: '', status: AGENT_STATUS[r.status], calls: 0, durationMs: r.durationMs } })),
    ...(f.session?.events ?? []).flatMap((x) => { const e = fromRunEvent(x); return e ? [{ at: x.at, e }] : [] }),
    ...f.task.artifacts.map((a): Draft => ({ at: last.endedAt ?? f.task.updatedAt, e: { kind: 'deliverable', id: a.ref, at: last.endedAt ?? f.task.updatedAt, name: a.kind === 'text' ? '结果' : a.name, type: a.kind, ref: a.ref } })),
  ]
  /* 按发生先后排(同一时刻保持拼进来的顺序),再编会话内序号 */
  const events = drafts
    .map((d, i) => ({ d, i, t: Date.parse(d.at) }))
    .sort((a, b) => (a.t - b.t) || (a.i - b.i))
    .map(({ d }, seq) => ({ ...d.e, id: d.e.id ?? `${d.e.kind}-${seq}`, seq }) as TranscriptEvent)
  const turns = kids.filter((r) => r.layer === 'compute-turn').length
    || (f.task.modelAttempts ?? []).filter((a) => a.computeId === last.computeId && a.reason !== 'observed').length
    || 1
  return {
    meta: {
      computeId: last.computeId,
      harness: (last.harness === 'codex' ? 'codex' : 'claude-code') satisfies HarnessId,
      model: last.model,
      nativeSessionId: null,
      startedAt: first.startedAt,
      endedAt: last.endedAt,
      turns,
      background: kids.filter((r) => r.layer === 'background').map((r) => ({ id: r.id, command: r.text, state: JOB_STATUS[r.status] })),
    },
    events,
    hasEarlier: f.hasEarlier,
  }
}
