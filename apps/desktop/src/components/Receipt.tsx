/* 已读回执（AC-46 / D09.3 / F04，用户 #2862 #2891）：照 mirasim 0.0.774 的 bnt / wnt / mne / MI。
   - 只挂在你自己发的消息上；全读 = 绿对勾，没读全 = 按比例填充的小饼；
   - 点开「已读情况」：已读 N / 未读 N 两页签，被 @ 的人带 @ 标排前；
   - 正文 @名字 后一个 5px 小点。
   和 mirasim 不同的一处：群里的联系人全部进名单（mirasim 群聊名单只算人，照搬就看不出联系人读没读）。
   已读位置只由宿主推进（联系人这一轮回复落盘时），表情和模型说的「收到」都改不了它。 */
import { useState } from 'react'
import { people, type Conversation, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { broken } from '@/mut'
import { cn } from '@/lib/utils'
import { Avatar } from './Avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type Row = { id: PersonId; at?: string; called: boolean }
export type Receipt = { read: Row[]; unread: Row[]; dm: boolean }

const idsOf = (c: Conversation) => c.messages.filter((m) => 'id' in m).map((m) => (m as { id: string }).id)

/** 名单 = 会话成员 − 发送人。读到 = 这个人的已读位置 ≥ 这条消息；读到时间 = 位置第一次越过它的时刻 */
export function receiptOf(c: Conversation, msgId: string, from: PersonId, text: string, reactions?: Record<string, PersonId[]>): Receipt | null {
  const ids = idsOf(c)
  const seq = ids.indexOf(msgId)
  if (seq < 0) return null
  /* 坏实现（埋雷 AC-46-1）：照搬 mirasim 群聊，名单只算人，把联系人滤掉 */
  const audience = c.members.filter((p) => p !== from && (!broken('AC-46-1') || c.kind === 'dm' || people[p]?.human))
  const called = (p: PersonId) => text.includes('@' + people[p]?.name)
  const read: Row[] = [], unread: Row[] = []
  for (const p of audience) {
    const marks = c.reads?.[p] ?? []
    let at = marks.find((r) => ids.indexOf(r.upto) >= seq)?.at
    /* 坏实现（埋雷 AC-46-3）：联系人点了表情就当它读了 */
    if (!at && broken('AC-46-3') && reactions && Object.values(reactions).some((w) => w.includes(p))) at = '—'
    ;(at ? read : unread).push({ id: p, at, called: called(p) })
  }
  const first = (a: Row, b: Row) => Number(b.called) - Number(a.called)
  return { read: read.sort(first), unread: unread.sort(first), dm: c.kind === 'dm' }
}

/** mne：全读 = 淡绿底 + 绿对勾；否则灰圈 + 按已读比例填充的扇形 */
export function ReceiptGlyph({ fraction, size = 14 }: { fraction: number; size?: number }) {
  if (fraction >= 1) return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <circle cx="8" cy="8" r="7.2" fill="hsl(var(--ok) / 0.2)" />
      <path d="M4.8 8.3 7 10.4l4.3-4.6" fill="none" stroke="hsl(var(--ok))" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  const f = Math.max(0, fraction), r = 4.7, a = f * 2 * Math.PI
  const x = 8 + r * Math.sin(a), y = 8 - r * Math.cos(a)
  const d = f > 0 ? `M8 8 L8 ${8 - r} A${r} ${r} 0 ${a > Math.PI ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z` : null
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="hsl(var(--fg3) / 0.7)" strokeWidth="1.5" />
      {d && <path d={d} fill="hsl(var(--ok))" />}
    </svg>
  )
}

/** MI：已读情况浮层 */
function ReceiptList({ rc, msgId }: { rc: Receipt; msgId: string }) {
  const [tab, setTab] = useState<'read' | 'unread'>('read')
  const list = tab === 'read' ? rc.read : rc.unread
  return (
    <div className="flex flex-col" data-testid={`receipts-${msgId}`} data-tab={tab}>
      <div className="px-3 pb-1.5 pt-3 text-[12px] font-medium text-fg-3">已读情况</div>
      <div className="mx-3 mb-1.5 grid grid-cols-2 rounded-lg bg-hover p-0.5 text-[12.5px]" role="tablist">
        {(['read', 'unread'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} data-testid={`receipts-tab-${k}`} onClick={() => setTab(k)}
            className={cn('h-7 rounded-md transition', tab === k ? 'bg-elev font-medium text-fg shadow-sm' : 'text-fg-2 hover:text-fg')}>
            {k === 'read' ? '已读' : '未读'} {k === 'read' ? rc.read.length : rc.unread.length}
          </button>
        ))}
      </div>
      <div className="max-h-[248px] overflow-y-auto px-1 pb-1.5 scroll-thin">
        {!list.length && <div className="px-2 py-1.5 text-[12.5px] text-fg-3" data-testid="receipts-empty">{tab === 'read' ? '还没有人读到' : '所有人都读了'}</div>}
        {list.map((r) => (
          <div key={r.id} className="flex h-8 items-center gap-2 rounded-md px-2" data-testid={`receipt-person-${r.id}`} data-called={r.called ? '1' : undefined}>
            <Avatar id={r.id} size={22} status={false} mood="idle" />
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="min-w-0 truncate text-[13px] text-fg-2">{r.id === 'me' ? '你' : people[r.id]?.name}</span>
              {r.called && <span role="img" aria-label="被@的人" className="shrink-0 rounded-[4px] bg-hover px-1 font-mono text-[11px] leading-4 text-fg-3">@</span>}
            </span>
            {r.at && <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-3">{r.at === '—' ? '已读' : `${r.at} 读到`}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

function useReceipt(msgId: string) {
  const { convs, active, reactions } = useApp()
  const c = convs.find((x) => x.id === active)
  const m = c?.messages.find((x) => 'id' in x && x.id === msgId) as { from: PersonId; text?: string } | undefined
  return c && m ? receiptOf(c, msgId, m.from, m.text ?? '', reactions[msgId]) : null
}

/** bnt：回执按钮，挂在你发的消息气泡外侧 */
export function ReceiptButton({ msgId }: { msgId: string }) {
  const rc = useReceipt(msgId)
  const [open, setOpen] = useState(false)
  if (!rc) return null
  const n = rc.read.length + rc.unread.length
  const tip = !rc.unread.length ? '已读' : rc.dm && n <= 1 ? '未读' : `${rc.unread.length} 人未读`
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={250} open={open ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button type="button" data-testid={`receipt-${msgId}`} data-read={rc.read.length} data-unread={rc.unread.length}
              aria-label={`已读 ${rc.read.length} 人，未读 ${rc.unread.length} 人`} onClick={(e) => e.stopPropagation()}
              className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full transition-opacity hover:opacity-75">
              <ReceiptGlyph fraction={n ? rc.read.length / n : 1} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent data-testid={`receipt-tip-${msgId}`} className="rounded-lg border-0 bg-fg px-2 py-1 text-xs text-bg">{tip}</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="end" className="w-[300px] rounded-xl border-line bg-elev p-0 shadow-elev" onClick={(e) => e.stopPropagation()}>
        <ReceiptList rc={rc} msgId={msgId} />
      </PopoverContent>
    </Popover>
  )
}

/** wnt：正文里 @名字 后面的小点。读了 = 实心绿点，没读 = 空心灰圈；点开同一个浮层 */
export function MentionDot({ msgId, who }: { msgId: string; who: PersonId }) {
  const rc = useReceipt(msgId)
  const [open, setOpen] = useState(false)
  if (!rc) return null
  const read = rc.read.some((r) => r.id === who)
  if (!read && !rc.unread.some((r) => r.id === who)) return null
  const name = people[who]?.name
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={250} open={open ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button type="button" data-testid={`mention-dot-${msgId}-${who}`} data-read={read ? 'read' : 'unread'} aria-label={`${name} ${read ? '已读' : '未读'}`}
              onClick={(e) => e.stopPropagation()} className="relative mx-[3px] inline-grid h-[5px] w-[5px] -translate-y-[2px] align-middle before:absolute before:-inset-[6px] before:content-['']">
              <span className={cn('h-[5px] w-[5px] rounded-full', read ? 'bg-ok ring-1 ring-me-fg/90' : 'border border-current opacity-70')} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent className="rounded-lg border-0 bg-fg px-2 py-1 text-xs text-bg">{name} {read ? '已读' : '未读'}</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="start" className="w-[300px] rounded-xl border-line bg-elev p-0 shadow-elev" onClick={(e) => e.stopPropagation()}>
        <ReceiptList rc={rc} msgId={msgId} />
      </PopoverContent>
    </Popover>
  )
}
