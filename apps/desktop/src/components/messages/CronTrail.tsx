/* #1858:定时发出的消息、或「记成定时」的确认消息,底部挂一行灰字,点了在分栏打开那个定时 */
import { AlarmClock, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/ctx'
import { cronRule } from '@/components/CronDetail'
import { Pressable } from './Pressable'
import type { TextMsg } from './types'

export function CronTrail({ m, mine }: { m: TextMsg; mine: boolean }) {
  const { crons, openSplit } = useApp()
  const c = crons.find((x) => x.id === m.cron)
  if (!c) return <div className="mt-0.5 flex items-center gap-1 text-[12px] text-fg-3" data-testid={`cron-trail-${m.id}`}><AlarmClock className="h-3 w-3" />这个定时已删除</div>
  return (
    <Pressable data-testid={`cron-trail-${m.id}`} onClick={(e) => { e.stopPropagation(); openSplit({ t: 'cron', id: c.id }) }}
      className={cn('mt-0.5 gap-1 rounded-full py-0.5 pl-1.5 pr-2 text-[12px] text-fg-3 hover:bg-hover hover:text-fg-2 [&_svg]:size-3', mine && 'self-end')}>
      <AlarmClock />{m.cronNew ? '已记成定时' : '来自定时'} · {cronRule(c)}{c.paused ? ' · 已暂停' : ''}<ChevronRight className="opacity-60" />
    </Pressable>
  )
}
