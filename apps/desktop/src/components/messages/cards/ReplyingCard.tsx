/* “正在回复”卡:取代头像呼吸灯(#1412)。写明在回哪几条、在想 / 在写、几分钟;可展开步骤,再往下看完整过程 */
import { useEffect, useState } from 'react'
import * as Collapsible from '@animate-ui/react/primitives/radix-ui/collapsible'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { Chip } from '@/components/ui/chip'
import { Pressable, TextLink } from '../Pressable'
import type { MsgOf } from '../types'

/** 已经忙了多久:每秒走一次(连上后端时从宿主推「开始想」那一刻算起,不编) */
function useElapsed(since: number | undefined): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === undefined) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [since])
  if (since === undefined) return null
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分`
}

export function ReplyingCard({ m }: { m: MsgOf<'replying'> }) {
  const { openContact, active } = useApp()
  const [open, setOpen] = useState(false)
  const elapsed = useElapsed(m.since)
  const p = people[m.from]
  /* 没有步骤可展开(连上后端时宿主只报在看 / 在想 / 在写):只写这一行,不放展开箭头 */
  if (!m.steps.length) return (
    <div className="mt-3 flex items-start gap-2.5" data-testid={`replying-${m.from}`} data-msg={m.id} data-activity={m.phase}>
      <Avatar id={m.from} size={32} mood="thinking" />
      <div className="min-w-0 max-w-[min(560px,78%)]">
        <div className="mb-1 flex items-center gap-1.5 text-[12.5px]"><span className="font-semibold">{p?.name}</span><Chip size="xs" className="font-normal text-fg-3">助手</Chip><span className="text-run">正在回复</span></div>
        <div className="rounded-[14px] border border-line bg-bubble px-3 py-2">
          {m.quotes.map((q) => <div key={q.msgId} className="mb-1 truncate border-l border-fg-3/50 pl-2 text-[12.5px] text-fg-2"><span className="font-medium text-fg">{people[q.from]?.name ?? '你'}</span> {q.text}</div>)}
          <div data-testid={`replying-phase-${m.from}`} className="flex items-center gap-1.5 text-[12.5px] text-fg-2"><span className="spin-ring" />{m.phase}{elapsed && <> · <span className="tabular-nums">{elapsed}</span></>}</div>
          <div className="shimmer mt-1.5 h-2 w-2/3 rounded-full" />
        </div>
      </div>
    </div>
  )
  return (
    <div className="mt-3 flex items-start gap-2.5" data-testid={`replying-${m.from}`} data-msg={m.id}>
      <Avatar id={m.from} size={32} mood="thinking" />
      <div className="min-w-0 max-w-[min(560px,78%)]">
        <div className="mb-1 flex items-center gap-1.5 text-[12.5px]"><span className="font-semibold">{p.name}</span><Chip size="xs" className="font-normal text-fg-3">助手</Chip><span className="text-run">正在回复</span></div>
        <div className="rounded-[14px] border border-line bg-bubble px-3 py-2">
          {m.quotes.map((q) => <div key={q.msgId} className="mb-1 truncate border-l border-fg-3/50 pl-2 text-[12.5px] text-fg-2"><span className="font-medium text-fg">{people[q.from]?.name ?? '你'}</span> {q.text}</div>)}
          <Collapsible.Root open={open} onOpenChange={setOpen}>
            <Collapsible.Trigger asChild>
              <Pressable data-testid={`replying-toggle-${m.from}`} className="gap-1.5 text-[12.5px] text-fg-2 hover:text-fg">
                <span className="spin-ring" />{m.phase} · <span className="tabular-nums">{m.mins}</span> 分<ChevronRight className={cn('h-3.5 w-3.5 transition-transform duration-base ease-out', open && 'rotate-90')} />
              </Pressable>
            </Collapsible.Trigger>
            <Collapsible.Content>
              <ol className="mt-1.5 space-y-0.5 pl-5 text-[12.5px] text-fg-2">{m.steps.map((s, i) => <li key={i} className="list-decimal">{s}</li>)}</ol>
              <TextLink data-testid={`replying-process-${m.from}`} onClick={() => openContact(m.from, active, 'process')} className="mt-1.5 text-[12.5px] font-medium">看完整过程 ›</TextLink>
            </Collapsible.Content>
          </Collapsible.Root>
          {!open && <div className="shimmer mt-1.5 h-2 w-2/3 rounded-full" />}
        </div>
      </div>
    </div>
  )
}
