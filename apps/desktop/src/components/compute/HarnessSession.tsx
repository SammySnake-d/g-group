import { useEffect, useMemo, useRef } from 'react'
import { SquareTerminal } from 'lucide-react'
import { changedFiles, collectDeliverables, formatDuration, groupTranscript, interruptRunning, sessionElapsedMs, summarizeWork, type HarnessTranscript } from '@g-group/ui-core'
import { EmptyState } from '@/components/ui/section'
import { people, type Compute } from '@/data'
import { cn } from '@/lib/utils'
import { COPY, HARNESS_LABEL } from './constants'
import { computeState } from './StatusChip'
import { Deliverables } from './session/Deliverables'
import { SessionFooter } from './session/SessionFooter'
import { SessionHeader, type Crumb } from './session/SessionHeader'
import { Transcript } from './session/Transcript'

/* harness 会话窗口（只读，#1005）：点「打开会话」直接进到这个 Compute 背后 Claude Code / Codex 的原始对话。
   样式与交互照 mirasim 的会话窗口；和 mirasim 不同的是底部没有输入框——Compute 只读，要改要求去群里找派它的联系人。
   铺满父容器（分屏页签、浮层都能直接挂），自己不决定宽度。 */

export interface HarnessSessionProps {
  compute: Compute
  transcript: HarnessTranscript | null
  sourceTitle: string
  dm?: boolean
  now?: number
  onBack?: () => void
  onClose?: () => void
  onJumpSource?: () => void
  onTalk?: () => void
  autoFocus?: boolean
  /** 嵌进已有标题与只读条的容器（分屏里 Compute 视图的「会话」页签）：不画自己的顶栏和只读条，只留对话流和状态行 */
  embedded?: boolean
  loading?: boolean
  /** 记录里没有工具调用(连上后端时合同只有语义进度):状态行不写调用数,不拿 0 冒充 */
  noCalls?: boolean
  className?: string
}

export function HarnessSession({ compute: c, transcript, sourceTitle, dm = false, now, onBack, onClose, onJumpSource, onTalk, autoFocus = false, embedded = false, loading = false, noCalls = false, className }: HarnessSessionProps) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true })
  }, [autoFocus])
  const owner = people[c.owner]?.name ?? c.owner
  const state = computeState(c)
  const settled = c.status === 'stopped' || c.status === 'error'
  const raw = transcript?.events
  const events = useMemo(() => (raw && settled ? interruptRunning(raw, COPY.interrupted) : raw), [raw, settled])
  const view = useMemo(() => (events ? { blocks: groupTranscript(events), work: summarizeWork(events), deliverables: collectDeliverables(events), changes: changedFiles(events) } : null), [events])
  const crumbs: Crumb[] = [{ label: sourceTitle, ...(onJumpSource ? { onClick: onJumpSource } : {}) }, { label: owner }, { label: c.short ?? c.title }]
  const harness = transcript ? HARNESS_LABEL[transcript.meta.harness] : c.harness
  return (
    <section
      ref={ref}
      tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape' && onClose && !e.defaultPrevented) { e.preventDefault(); onClose() } }}
      className={cn('flex h-full min-h-0 min-w-0 flex-col bg-bg outline-none', className)}
      aria-label={`${harness} ${COPY.sessionTag}`}
      data-testid="harness-session"
      data-compute={c.id}
    >
      {!embedded && <SessionHeader harness={harness} title={c.title} state={state} crumbs={crumbs} {...(onBack ? { onBack } : {})} {...(onClose ? { onClose } : {})} />}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="session-body">
        {transcript && view ? (
          <div className="mx-auto w-full max-w-[760px] space-y-4 px-4 pb-4 pt-4">
            {transcript.hasEarlier && <div className="text-center text-[11.5px] text-fg-3">{COPY.earlier}</div>}
            <Transcript blocks={view.blocks} ownerName={owner} />
            <Deliverables items={view.deliverables} changes={view.changes} />
          </div>
        ) : loading ? (
          <div className="py-16" aria-busy="true" data-testid="session-loading" />
        ) : (
          <EmptyState icon={<SquareTerminal />} title={COPY.noTranscript} hint={COPY.noTranscriptHint} className="py-16" />
        )}
      </div>
      <SessionFooter
        state={state}
        elapsed={transcript ? formatDuration(sessionElapsedMs(transcript.meta, now ?? Date.now())) : c.elapsed}
        turns={transcript?.meta.turns ?? 1}
        {...(noCalls ? {} : { calls: view?.work.calls ?? 0 })}
        agents={view?.work.agents ?? 0}
        background={settled ? 0 : transcript?.meta.background.filter((j) => j.state === 'running').length ?? 0}
        owner={owner}
        dm={dm}
        readonly={!embedded}
        {...(onTalk ? { onTalk } : {})}
      />
    </section>
  )
}
