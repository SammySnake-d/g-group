/* 表情回应:一行小胶囊,照 mirasim 的回应胶囊搬——24px 高、无边框浅底、表情和后面的头像之间一道淡竖线;
   你点过的那颗用靛蓝浅底(aria-pressed)。悬停看是谁;点了切换你的回应,按下有 Button 原语的回馈 */
import { cn } from '@/lib/utils'
import { people } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Pressable } from './Pressable'

export function Reactions({ msgId, mine, inline }: { msgId: string; mine: boolean; inline?: boolean }) {
  const { reactions, react } = useApp()
  const r = reactions[msgId]
  if (!r || !Object.keys(r).length) return null
  return (
    <div className={cn('flex flex-wrap gap-1', inline ? 'shrink-0' : cn('mt-1', mine ? 'justify-end' : 'ml-1'))}>
      {Object.entries(r).map(([e, who], ri) => {
        const meIn = who.includes('me')
        return (
          <Tooltip key={e}>
            <TooltipTrigger asChild>
              <Pressable data-testid={`reaction-${msgId}-${ri}`} aria-pressed={meIn} onClick={() => react(msgId, e)}
                className={cn('h-6 gap-[5px] rounded-full pl-1.5 pr-2 text-[12px] leading-none', meIn ? 'bg-me/10 text-me hover:bg-me/15' : 'bg-hover text-fg-2 hover:bg-sel')}>
                <span className="text-[13px] leading-none">{e}</span>
                <span aria-hidden className="h-2.5 w-px shrink-0 bg-current opacity-25" />
                <span className="flex -space-x-1">{who.slice(0, 3).map((w) => <Avatar key={w} id={w} size={14} status={false} mood="idle" />)}</span>
                {who.length > 3 && <span className="tabular-nums text-fg-2">{who.length}</span>}
              </Pressable>
            </TooltipTrigger>
            <TooltipContent data-testid={`reaction-tip-${msgId}`}>{who.map((w) => (w === 'me' ? '你' : people[w].name)).join('、')}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
