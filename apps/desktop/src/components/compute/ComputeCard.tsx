import { useMemo, useState } from 'react'
import * as Disclosure from '@animate-ui/react/primitives/radix-ui/collapsible'
import { Zap } from 'lucide-react'
import { formatDuration, sessionElapsedMs, summarizeWork, type HarnessTranscript } from '@g-group/ui-core'
import { Button } from '@/components/ui/button'
import { Surface } from '@/components/ui/surface'
import type { Compute } from '@/data'
import { cn } from '@/lib/utils'
import { COPY, HARNESS_LABEL, workLine } from './constants'
import { Caret, Facts } from './parts'
import { AlertStrip, type CardActions } from './card/AlertStrip'
import { BackgroundJobs, StepList } from './card/StepList'
import { computeState, StatusChip } from './StatusChip'

/* Compute 卡（#1005 重做）：一张细边纸面卡，不套卡、不铺红底。
   头部整行是折叠开关（标题、状态标签、harness 与当前阶段），末端是「打开会话」——指针读完标题自然落到这里(#1032);
   出错/卡住/要你来时，头部下面一条细线提示条，带原地能做的事；
   展开后是安静的次要信息：做了什么、步骤、后台任务、轮次与模型。 */

export interface ComputeCardProps {
  compute: Compute
  /** harness 原始记录：有了才显示「改了 N 个文件，执行了 N 条命令」、后台任务和轮次 */
  transcript?: HarnessTranscript | null
  /** 不传：在跑/出错/等你时展开，做完和停下时收起 */
  defaultOpen?: boolean
  onOpenSession?: () => void
  actions?: CardActions
  now?: number
  className?: string
}

const wantsAttention = (c: Compute) => c.status === 'running' || c.status === 'error' || c.status === 'waiting'

export function ComputeCard({ compute: c, transcript, defaultOpen, onOpenSession, actions, now, className }: ComputeCardProps) {
  const [open, setOpen] = useState(defaultOpen ?? wantsAttention(c))
  const state = computeState(c)
  const halt = state.key === 'stopping' ? 'stopping' : c.status === 'stopped' || c.status === 'error' ? 'stopped' : undefined
  const done = c.steps.filter((s) => s.state === 'done').length
  const work = useMemo(() => (transcript ? summarizeWork(transcript.events) : null), [transcript])
  const harness = transcript ? HARNESS_LABEL[transcript.meta.harness] : c.harness
  /* 出错或停下:写停在第几步(原因在提示条里,不重复);做完:写结果;在跑:写当前阶段 */
  const haltAt = c.steps.findIndex((s) => s.state === (c.status === 'error' ? 'fail' : 'now'))
  const halted = c.status === 'error' || c.status === 'stopped'
  /* 停止中:阶段说明就在提示条里,头部不重复 */
  const where = state.key === 'stopping' ? '' : c.status === 'done' ? c.result ?? state.label : halted ? (haltAt >= 0 ? COPY.stoppedAt(haltAt + 1, c.steps.length) : state.label) : c.phase
  const meta = [
    { key: 'harness', text: harness, className: 'text-fg-2' },
    ...(c.status === 'running' && c.steps.length ? [{ key: 'step', text: COPY.step(Math.min(done + 1, c.steps.length), c.steps.length) }] : []),
  ]
  const elapsed = transcript ? formatDuration(sessionElapsedMs(transcript.meta, now ?? Date.now())) : c.elapsed
  const foot = [
    ...(transcript ? [{ key: 'turns', text: COPY.turns(transcript.meta.turns) }] : []),
    { key: 'model', text: transcript?.meta.model ?? c.model },
    { key: 'time', text: elapsed },
  ]
  return (
    <Surface elevation="flat" radius="lg" className={cn('w-full max-w-[560px] overflow-hidden', className)} data-testid={`compute-card-${c.id}`} data-state={state.key}>
      <Disclosure.Root open={open} onOpenChange={setOpen}>
        <div className="flex min-w-0 items-start gap-1 py-1.5 pl-1.5 pr-2">
          <Disclosure.Trigger className="group/disc flex min-w-0 flex-1 items-start gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors duration-fast ease-out hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60" data-testid="compute-card-toggle">
            <Caret className="mt-[5px]" />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-[13.5px] font-semibold tracking-[-0.005em] text-fg" data-testid="compute-card-title">{c.title}</span>
                <StatusChip state={state} />
              </span>
              <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-fg-3">
                <Facts items={meta} mono={false} className="text-[12px]" />
                {where && <span aria-hidden className="text-fg-3/50">·</span>}
                {where && <span className="min-w-0 truncate" data-testid="compute-card-phase">{where}</span>}
              </span>
            </span>
          </Disclosure.Trigger>
          {onOpenSession && (
            <Button variant="ghost" size="xs" onClick={onOpenSession} className="mt-0.5 text-fg-2" data-testid="compute-card-open-session">
              <Zap />
              {COPY.openSession}
            </Button>
          )}
        </div>
        <AlertStrip compute={c} state={state} {...(actions ? { actions } : {})} />
        <Disclosure.Content>
          <div className="space-y-2.5 border-t border-line px-4 pb-3 pt-2.5" data-testid="compute-card-body">
            {work && <p className="text-[12.5px] text-fg-2" data-testid="compute-card-work">{workLine(work)}</p>}
            <StepList steps={c.steps} />
            {transcript && <BackgroundJobs jobs={transcript.meta.background} {...(halt ? { halt } : {})} />}
            <Facts items={foot} mono={false} className="block text-[11.5px]" />
          </div>
        </Disclosure.Content>
      </Disclosure.Root>
    </Surface>
  )
}
