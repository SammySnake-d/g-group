/** 你对提问的回答:显示成收起的卡片(标题 + 你选的),点开看全部选项。正文仍是普通消息,联系人照常读 */
import { useState } from 'react'
import * as Collapsible from '@animate-ui/react/primitives/radix-ui/collapsible'
import { Check, ChevronDown, ListChecks } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/ctx'
import { Pressable, TextLink } from '../Pressable'
import type { TextMsg } from '../types'

export function AnswerPill({ m }: { m: TextMsg }) {
  const { answers, jump } = useApp()
  const a = m.answerTo ? answers[m.answerTo] : undefined
  const [open, setOpen] = useState(false)
  if (!a) return null
  return (
    <div data-testid={`answer-${m.id}`} data-expanded={open ? '1' : '0'} className="w-[min(420px,100%)] overflow-hidden rounded-2xl border border-mine/25 bg-elev shadow-soft">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger asChild>
          <Pressable className="flex w-full gap-2.5 rounded-none px-3 py-2 hover:bg-hover/50 active:scale-100 active:bg-hover/70">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-mine text-mine-fg"><ListChecks className="h-4 w-4" strokeWidth={1.9} /></span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{a.title}</span>
            <span className="max-w-[45%] shrink-0 truncate text-[13.5px] font-semibold text-fg">{a.picked}</span>
            <ChevronDown className={cn('h-4 w-4 text-fg-3 transition-transform duration-base ease-out', open && 'rotate-180')} />
          </Pressable>
        </Collapsible.Trigger>
        <Collapsible.Content className="space-y-1 border-t border-line px-3 pb-2.5 pt-2" data-testid={`answer-${m.id}-body`}>
          {a.options.map((o) => (
            <div key={o} className={cn('flex items-start gap-2 text-[13px] leading-[1.5]', o === a.picked ? 'font-medium text-fg' : 'text-fg-3')}>
              <span className={cn('mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border', o === a.picked ? 'border-fg bg-fg text-bg' : 'border-fg-3/60')}>{o === a.picked && <Check className="h-2 w-2" strokeWidth={3.5} />}</span>{o}
            </div>
          ))}
          <TextLink onClick={() => jump(m.answerTo!)} className="pt-1 text-[12px]">看原来的提问</TextLink>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
  )
}
