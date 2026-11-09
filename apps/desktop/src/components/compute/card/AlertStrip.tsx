import { Hand, PauseCircle, RotateCw, Square, TriangleAlert, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Compute } from '@/data'
import { cn } from '@/lib/utils'
import { COPY } from '../constants'
import type { ComputeState } from '../StatusChip'

/* 失败/卡住/要你来：卡片头部下面一条细线提示条（#1005：不再是红底套红框）。
   一根 1px 细线 + 图标 + 一句原因，原地给能做的事（AC-36：重试 / 换个模型 / 跳过），常用的「重试」离指针最近、命中区 ≥28px。 */

export interface CardActions { retry?: () => void; switchModel?: () => void; skip?: () => void }

interface Alert { icon: LucideIcon; tone: 'err' | 'warm' | 'neutral'; title: string; detail?: string }

function alertOf(c: Compute, state: ComputeState): Alert | null {
  if (c.status === 'error') {
    const step = c.steps.find((s) => s.state === 'fail')?.text
    return { icon: TriangleAlert, tone: 'err', title: step ? COPY.stepFailed(step) : state.label, ...(c.error ? { detail: c.error } : {}) }
  }
  if (state.key === 'stalled') {
    const step = c.steps.find((s) => s.state === 'now')?.text
    return { icon: PauseCircle, tone: 'warm', title: state.label, ...(step ? { detail: COPY.stuckAt(step) } : {}) }
  }
  if (state.key === 'human' && c.needsHuman) return { icon: Hand, tone: 'warm', title: COPY.needsHuman, detail: c.needsHuman.what }
  if (state.key === 'stopping') return { icon: Square, tone: 'neutral', title: COPY.stopping, detail: COPY.stoppingHint }
  if (c.status === 'stopped') return { icon: Square, tone: 'neutral', title: COPY.stopped, detail: COPY.stoppedScope }
  return null
}

const LINE = { err: 'border-err/30', warm: 'border-warm/30', neutral: 'border-line' }
const INK = { err: 'text-err', warm: 'text-warm', neutral: 'text-fg-2' }

export function AlertStrip({ compute, state, actions }: { compute: Compute; state: ComputeState; actions?: CardActions }) {
  const a = alertOf(compute, state)
  if (!a) return null
  const showActions = compute.status === 'error' && actions
  return (
    <div role="alert" className={cn('flex min-w-0 items-center gap-2 border-t px-3.5 py-2', LINE[a.tone])} data-testid="compute-card-alert" data-tone={a.tone}>
      <a.icon aria-hidden className={cn('size-3.5 shrink-0', INK[a.tone], a.icon === Square && 'size-3 fill-current', state.key === 'stopping' && 'pulse-dot')} strokeWidth={2.25} />
      <div className="min-w-0 flex-1 text-[12.5px] leading-5">
        <span className={cn('font-medium', INK[a.tone])}>{a.title}</span>
        {a.detail && <span className="text-fg-2"> · {a.detail}</span>}
      </div>
      {showActions && (
        <div className="flex shrink-0 items-center gap-0.5">
          {actions.skip && <Button variant="ghost" size="xs" onClick={actions.skip} data-testid="compute-card-skip">{COPY.skip}</Button>}
          {actions.switchModel && <Button variant="ghost" size="xs" onClick={actions.switchModel} data-testid="compute-card-switch">{COPY.switchModel}</Button>}
          {actions.retry && (
            <Button variant="outline" size="xs" onClick={actions.retry} className="text-err" data-testid="compute-card-retry">
              <RotateCw />
              {COPY.retry}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
