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
  /** 原始记录；还没拿到时传 null */
  transcript: HarnessTranscript | null
  /** 派活所在的群/私聊名，面包屑第一项 */
  sourceTitle: string
  /** 派活在私聊里 */
  dm?: boolean
  /** 计算在跑会话的用时；不传取当前时间 */
  now?: number
  onBack?: () => void
  onClose?: () => void
  /** 面包屑点群名：跳到派活的原消息 */
  onJumpSource?: () => void
  /** 只读条「回群里 @XX」 */
  onTalk?: () => void
  /** 打开时把焦点移进窗口（Esc 就能关）；挂在分屏页签里切换时不要抢焦点 */
  autoFocus?: boolean
  /** 嵌进已有标题与只读条的容器（分屏里 Compute 视图的「会话」页签）：不画自己的顶栏和只读条，只留对话流和状态行 */
  embedded?: boolean
  /** 记录还在取(连上后端时点开的那一下):先空着,不说「还没开工」 */
  loading?: boolean
  className?: string
}

export function HarnessSession({ compute: c, transcript, sourceTitle, dm = false, now, onBack, onClose, onJumpSource, onTalk, autoFocus = false, embedded = false, loading = false, className }: HarnessSessionProps) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true })
  }, [autoFocus])
  const owner = people[c.owner]?.name ?? c.owner
  const state = computeState(c)
  /* 停下或出错了：记录里还标着在跑的调用其实被中断了（后端接上后由事件本身更新，这里兜底） */
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
        calls={view?.work.calls ?? 0}
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
