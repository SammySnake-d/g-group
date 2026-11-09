import { CircleAlert, Info, RotateCw, type LucideIcon } from 'lucide-react'
import type { NoticeEvent, PromptEvent, TranscriptBlock } from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { COPY } from '../constants'
import { AgentGroup } from './AgentGroup'
import { Prose } from './Prose'
import { ToolGroup } from './ToolGroup'

/* 原始对话流：派活 → harness 的话 → 工具调用组 → 子代理 → 系统提示，按事件顺序排。
   段与段之间的距离比段内大（先紧后松）；工具组和子代理紧跟在它们前面那句话下面。 */

function PromptBlock({ event, ownerName }: { event: PromptEvent; ownerName: string }) {
  return (
    <div className="ml-auto max-w-[92%] space-y-1" data-testid="session-prompt">
      <div className="text-right text-[11px] text-fg-3">{COPY.dispatched(ownerName)}</div>
      <div className="whitespace-pre-wrap rounded-2xl rounded-tr-md bg-bubble px-3.5 py-2.5 text-[13.5px] leading-[1.65] text-fg">{event.text}</div>
    </div>
  )
}

const NOTICE: Record<NoticeEvent['level'], { icon: LucideIcon; className: string }> = {
  error: { icon: CircleAlert, className: 'text-err' },
  warn: { icon: RotateCw, className: 'text-warm' },
  info: { icon: Info, className: 'text-fg-3' },
}

/** 系统提示：接口报错、自动重试。失败与重试在这里用颜色和图标一起标出，不靠颜色单独表达 */
function NoticeRow({ event }: { event: NoticeEvent }) {
  const n = NOTICE[event.level]
  return (
    <div className={cn('flex min-w-0 items-start gap-1.5 text-[12px] leading-5', n.className)} data-testid="session-notice" data-level={event.level}>
      <n.icon aria-hidden className="mt-[3px] size-3.5 shrink-0" />
      <span className="min-w-0">{event.text}</span>
    </div>
  )
}

/** 相邻两块之间的距离：话和它后面的工具/子代理贴近，别的拉开 */
function gapBefore(prev: TranscriptBlock | undefined, cur: TranscriptBlock) {
  if (!prev) return ''
  if ((cur.type === 'tools' || cur.type === 'agents' || cur.type === 'notice') && prev.type !== 'prompt') return 'mt-1.5'
  return 'mt-4'
}

export function Transcript({ blocks, ownerName }: { blocks: TranscriptBlock[]; ownerName: string }) {
  return (
    <div className="min-w-0" data-testid="session-transcript">
      {blocks.map((b, i) => (
        <div key={b.key} className={gapBefore(blocks[i - 1], b)}>
          {b.type === 'prompt' ? <PromptBlock event={b.event} ownerName={ownerName} />
            : b.type === 'text' ? <Prose text={b.event.text} />
            : b.type === 'notice' ? <NoticeRow event={b.event} />
            : b.type === 'tools' ? <ToolGroup block={b} />
            : <AgentGroup block={b} />}
        </div>
      ))}
    </div>
  )
}
