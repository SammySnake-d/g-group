/* A2UI 提问卡片(#823:「a2ui应该参考mirasim这种可以折叠的2ui的形式，而不是现在这样做成气泡」)。
   挂在提问那条消息下面:标题 + 状态 + 折叠;选项短的排成一行小按钮,长的每项占一整行。
   点了以普通消息发出(U98:回复就是回答,不另造验收组件);答完卡片收起成「标题 · 你选了什么」,点开还能看全部选项。
   (#1560 的约定照旧:决定是共享的上下文,点了就以你的名义在群里发一条回复,所有人都看得到。) */
import { useState } from 'react'
import * as Collapsible from '@animate-ui/react/primitives/radix-ui/collapsible'
import { Check, ChevronDown, ListChecks, PenLine } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Pressable } from '../Pressable'
import { ASK_STATUS } from '../copy'
import { useNoEnterOnMount } from '../motion'
import { useAsk } from './askModel'
import { AskChipOption, AskRowOption } from './AskOption'

export function AskCard({ msgId }: { msgId: string }) {
  const ask = useAsk(msgId)
  const [open, setOpen] = useState<boolean | null>(null)
  const firstPaint = useNoEnterOnMount()
  if (!ask) return null
  const { title, state, live, stale, done, opts, short, answerOwn } = ask
  const expanded = open ?? live
  const Option = short ? AskChipOption : AskRowOption
  return (
    <div data-testid={`ask-${msgId}`} data-state={state} data-expanded={expanded ? '1' : '0'} onClick={(e) => e.stopPropagation()}
      className={cn('mb-1 mt-1.5 w-[min(560px,100%)] overflow-hidden rounded-[14px] border bg-elev shadow-soft transition-colors duration-base ease-out', live ? 'border-warm/40' : 'border-line')}>
      <Collapsible.Root open={expanded} onOpenChange={setOpen}>
        <Collapsible.Trigger asChild>
          <Pressable data-testid={`ask-${msgId}-head`} className="flex w-full gap-2.5 rounded-none bg-side/60 px-3.5 py-2.5 hover:bg-hover/70 active:scale-100">
            <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg', live ? 'bg-hover text-fg' : 'bg-hover/70 text-fg-3')}><ListChecks className="h-4 w-4" strokeWidth={1.9} /></span>
            <span className="min-w-0 flex-1">
              <span className={cn('block truncate text-[13.5px]', live ? 'font-semibold text-fg' : 'font-medium text-fg-2')}>{title}</span>
              {!expanded && done && <span data-testid={`ask-${msgId}-picked`} className="mt-px block truncate text-[12.5px] font-medium text-fg"><Check className="mr-1 inline h-3.5 w-3.5 -translate-y-px text-ok" strokeWidth={2.5} />{done.picked}</span>}
            </span>
            <Chip data-testid={`ask-${msgId}-status`} tone={live ? 'warm' : 'neutral'} variant={stale ? 'dashed' : 'soft'} className={cn('rounded-full px-2', !live && 'font-normal')}>
              {live ? ASK_STATUS.live : stale ? ASK_STATUS.stale : ASK_STATUS.answered(done?.at)}
            </Chip>
            <ChevronDown className={cn('h-4 w-4 text-fg-3 transition-transform duration-base ease-out', expanded && 'rotate-180')} />
          </Pressable>
        </Collapsible.Trigger>
        <Collapsible.Content transition={firstPaint} className="flex flex-col gap-2.5 border-t border-line px-3.5 py-3" data-testid={`ask-${msgId}-body`}>
          <div className={cn(short ? 'flex flex-wrap gap-1.5' : 'flex flex-col gap-1')} data-layout={short ? 'chips' : 'rows'}>
            {opts.map((o, i) => <Option key={o.label} o={o} testid={`quick-${msgId}-${i}`} picked={done?.picked === o.label} can={live && !!o.run} stale={!!stale} />)}
          </div>
          {(live || stale) && (
            <div className="flex min-h-5 items-center gap-2 text-[12px] text-fg-3" role="status">
              {stale && <span>你后面改了前提，这几个选项不再执行。</span>}
              {live && (
                <Button data-testid={`quick-${msgId}-own`} onClick={answerOwn} variant="ghost" size="xs" title="引用这条并 @ 它，你自己写回答"
                  className="-ml-1.5 h-6 gap-1 rounded-md px-1.5 text-[12px] font-normal text-fg-3 hover:text-fg-2">
                  <PenLine strokeWidth={1.75} />都不是，自己回答
                </Button>
              )}
            </div>
          )}
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
  )
}
