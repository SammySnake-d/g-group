/* D02 第 2 条 / U86 / C-US26（#413 ⑪）：到点醒来时，宿主先把这个会话当前的群公告装配进它的上下文，不用建定时那会儿的旧规矩。
   这里写明下次醒来会带哪几条、各是第几版；每次醒来也记下当时带的是哪一版。坏实现（埋雷 AC-35-11）：一直用建定时时的版本 */
import { Megaphone } from 'lucide-react'
import { broken } from '@/mut'
import type { Conversation, Cron } from '@/data'
import { Chip } from '@/components/ui/chip'
import { DETAIL } from './constants'

export function CronNotices({ c, conv }: { c: Cron; conv: Conversation }) {
  return (
    <div className="mt-5 border-t border-line px-5 py-3" data-testid="cron-notices">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-fg-3"><Megaphone className="h-3.5 w-3.5" />{DETAIL.noticesTitle}</div>
      <div className="space-y-0.5">
        {conv.notices!.map((n) => {
          const v = broken('AC-35-11') ? (c.runs[c.runs.length - 1]?.notices?.[n.id] ?? n.ver) : n.ver
          return (
            <div key={n.id} data-testid={`cron-notice-${n.id}`} data-ver={v} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-[13px]">
              <Chip size="xs" className="font-code">v{v}</Chip>
              <span className="min-w-0 flex-1 truncate text-fg-2">{n.text.split('\n')[0]}</span>
              <span className="shrink-0 text-[11.5px] tabular-nums text-fg-3">{n.at}</span>
            </div>
          )
        })}
      </div>
      <div className="mt-1 px-2 text-[11.5px] text-fg-3">{DETAIL.noticesNote}</div>
    </div>
  )
}
