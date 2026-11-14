import { Chip } from '@/components/ui/chip'
import { cn } from '@/lib/utils'
import type { Compute } from '@/data'
import { idleMinOf } from './idle'
import { COPY, STATUS, type Tone } from './constants'

/* 状态 = Chip 小标签 + 状态点。颜色不单独表达含义，永远带文字；在跑的点用全局的 pulse-dot（减弱动效时不闪）。 */

export interface ComputeState { key: string; label: string; tone: Tone }

/** AC-14 停滞阈值：在跑但这么多分钟没动静，换成黄色并写明卡在哪 */
export const STALL_MIN = 10

export function computeState(c: Compute, now = Date.now()): ComputeState {
  if (c.status === 'running' && c.stopping) return { key: 'stopping', label: COPY.stopping, tone: 'neutral' }
  if (c.status === 'running' && c.needsHuman) return c.needsHuman.taken ? { key: 'human-taken', label: COPY.humanTaken, tone: 'warm' } : { key: 'human', label: COPY.needsHuman, tone: 'warm' }
  const idle = idleMinOf(c, now) ?? 0
  if (c.status === 'running' && idle >= STALL_MIN) return { key: 'stalled', label: COPY.stalled(idle), tone: 'warm' }
  return { key: c.status, ...STATUS[c.status] }
}

const DOT: Record<Tone, string> = { neutral: 'bg-fg-3', run: 'bg-run', warm: 'bg-warm-dot', err: 'bg-err', ok: 'bg-ok' }

export function StatusDot({ tone, live, className }: { tone: Tone; live?: boolean; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full', DOT[tone], live && 'pulse-dot', className)} />
}

export function StatusChip({ state, className, testId = 'compute-status' }: { state: ComputeState; className?: string; testId?: string }) {
  return (
    <Chip tone={state.tone} size="sm" data-testid={testId} data-state={state.key} className={cn('gap-1.5', className)}>
      <StatusDot tone={state.tone} live={state.key === 'running'} />
      {state.label}
    </Chip>
  )
}
