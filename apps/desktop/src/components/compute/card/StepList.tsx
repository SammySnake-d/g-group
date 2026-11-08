import { Check, Circle, X } from 'lucide-react'
import type { BackgroundJob } from '@g-group/ui-core'
import type { StepState } from '@/data'
import { cn } from '@/lib/utils'
import { COPY, JOB_STATE } from '../constants'
import { StatusDot } from '../StatusChip'

/* 卡片展开后的次要信息：步骤与后台任务。安静——小字、无框、不编号，状态靠图标形状 + 文字颜色一起表达。 */

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done') return <Check aria-hidden className="size-3.5 shrink-0 text-fg-3" strokeWidth={2.5} />
  if (state === 'now') return <span className="spin-ring" aria-hidden />
  if (state === 'fail') return <X aria-hidden className="size-3.5 shrink-0 text-err" strokeWidth={2.5} />
  return <Circle aria-hidden className="size-3 shrink-0 text-fg-3/60" strokeWidth={2} />
}

const INK: Record<StepState, string> = { done: 'text-fg-2', now: 'font-medium text-fg', todo: 'text-fg-3', fail: 'text-err' }

export function StepList({ steps }: { steps: { text: string; state: StepState }[] }) {
  if (!steps.length) return null
  return (
    <ol aria-label={COPY.steps} className="space-y-0.5" data-testid="compute-card-steps">
      {steps.map((s, i) => (
        <li key={i} className="flex min-w-0 items-center gap-2 text-[12.5px] leading-6" data-state={s.state}>
          <span className="grid size-3.5 shrink-0 place-items-center"><StepIcon state={s.state} /></span>
          <span className={cn('min-w-0 truncate', INK[s.state])}>{s.text}</span>
        </li>
      ))}
    </ol>
  )
}

/** stopping:Compute 正在停止,还在跑的程序显示「正在关」,确认退出后由后端改成「已收掉」 */
export function BackgroundJobs({ jobs, stopping = false }: { jobs: BackgroundJob[]; stopping?: boolean }) {
  if (!jobs.length) return null
  return (
    <div className="space-y-0.5" data-testid="compute-card-background">
      <div className="text-[11px] text-fg-3">{COPY.background}</div>
      {jobs.map((j) => {
        const s = stopping && j.state === 'running' ? { label: COPY.jobStopping, tone: 'neutral' as const } : JOB_STATE[j.state]
        return (
          <div key={j.id} className="flex min-w-0 items-center gap-2 text-[12px]">
            <StatusDot tone={s.tone} live={j.state === 'running'} />
            <span className="min-w-0 flex-1 truncate font-code text-[11.5px] text-fg-2">{j.command}</span>
            <span className={cn('shrink-0 text-[11.5px]', s.tone === 'run' ? 'text-run' : s.tone === 'err' ? 'text-err' : 'text-fg-3')}>{s.label}</span>
          </div>
        )
      })}
    </div>
  )
}
