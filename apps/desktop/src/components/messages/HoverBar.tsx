/* 悬停工具条:表情 | 回复 引用 | 更多。照 mirasim 的消息工具条搬:
   - 位置(需求变更 #1032):压在气泡右上角(底边压进气泡 8px、右边缩进 8px),指针从气泡往上一点就到,不用折返;
     顶上放不下才退到气泡下方。定位在 @g-group/ui-core 的 placeHoverBar。
   - 外观:rounded-lg 细边、1px 内边距、1px 按钮间距、轻阴影;按钮 28px、图标 16px、悬停换选中底;表情和回复组之间一道竖线。
   - 显隐:纯 CSS——指到这一行就出现(淡入走 duration-fast token),离开立刻消失;键盘焦点在条里、或表情/更多开着时保持显示。
     每天几十次的操作,不加缩放和位移(Emil 的频率表)。 */
import { useState } from 'react'
import { CheckSquare, Copy, Forward, MoreHorizontal, Quote as QuoteIcon, Reply, SmilePlus, Undo2, Zap } from 'lucide-react'
import { BAR_INSET, BAR_OVERLAP } from '@g-group/ui-core'
import { REACTION_EMOJI } from '@/config/emoji'
import { cn } from '@/lib/utils'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { quoteText } from './copy'
import { OPEN_SESSION } from './compute/ComputeCardFor'
import { MENU_DANGER, MENU_ITEM, MENU_SEP, MENU_SURFACE } from './menuStyle'
import { useBarPlacement } from './useBarPlacement'
import type { Bodied } from './types'

const ICON = { strokeWidth: 1.75 } as const
/** 工具条上的按钮:28px 方块、圆角 md;悬停和「它的面板开着」都用选中底 */
const VERB = 'rounded-md hover:bg-sel data-[state=open]:bg-sel data-[state=open]:text-fg'
/** 显隐:默认透明且不接指针;指到这一行 / 键盘焦点在条里 / 面板开着时出现。离开时 duration-0 立刻消失 */
const REVEAL = 'pointer-events-none opacity-0 transition-opacity duration-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-hover/row:duration-fast has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100'

export function HoverBar({ m, mine }: { m: Bodied; mine: boolean }) {
  const { react, reactions, addQuote, setSelecting, push, active, recall, toast, openSplit } = useApp()
  const text = quoteText(m)
  const { ref, pos } = useBarPlacement()
  const [emojiOpen, setEmojiOpen] = useState(false)
  const reacted = reactions[m.id] ?? {}
  return (
    <div ref={ref} data-testid={`hoverbar-${m.id}`} data-side={pos?.side} style={pos ? { left: pos.x, top: pos.y } : { right: BAR_INSET, bottom: `calc(100% - ${BAR_OVERLAP}px)` }}
      className={cn('absolute z-10 flex items-center gap-px whitespace-nowrap rounded-lg border border-line bg-elev p-px shadow-soft', REVEAL)}>
      <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
        <PopoverTrigger asChild>
          <IconButton label="表情" icon={<SmilePlus {...ICON} />} size="icon-sm" side="top" className={VERB} />
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="flex w-auto gap-0.5 rounded-xl border-line bg-elev p-1 shadow-elev">
          {REACTION_EMOJI.map((e) => {
            const on = !!reacted[e]?.includes('me')
            return (
              <Button key={e} aria-pressed={on} onClick={() => { react(m.id, e); setEmojiOpen(false) }} variant="ghost" size={null}
                className={cn('size-9 rounded-lg text-[18px] font-normal', on && 'bg-me/10 hover:bg-me/15')}>{e}</Button>
            )
          })}
        </PopoverContent>
      </Popover>
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-line" />
      <IconButton data-testid={`reply-${m.id}`} onClick={() => addQuote({ msgId: m.id, from: m.from, text, reply: true })} label="回复（引用并 @ 作者）" icon={<Reply {...ICON} />} size="icon-sm" side="top" className={VERB} />
      <IconButton data-testid={`quote-${m.id}`} onClick={() => addQuote({ msgId: m.id, from: m.from, text })} label="引用（可以连续加多条）" icon={<QuoteIcon {...ICON} />} size="icon-sm" side="top" className={VERB} />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <IconButton data-testid={`more-${m.id}`} label="更多" icon={<MoreHorizontal {...ICON} />} size="icon-sm" side="top" className={VERB} />
        </DropdownMenuTrigger>
        {/* 顺序照 mirasim 的「更多」:转发、多选、复制 | 撤回(危险操作单独一组、放在最下面) */}
        <DropdownMenuContent align="end" className={cn('w-40', MENU_SURFACE)}>
          <DropdownMenuItem className={MENU_ITEM} onSelect={() => push({ t: 'forwardPick', from: active, msgIds: [m.id] }, true)}><Forward />转发</DropdownMenuItem>
          <DropdownMenuItem data-testid={`multi-${m.id}`} className={MENU_ITEM} onSelect={() => setSelecting(true)}><CheckSquare />多选</DropdownMenuItem>
          <DropdownMenuItem className={MENU_ITEM} onSelect={() => { navigator.clipboard?.writeText(text).catch(() => {}); toast('已复制') }}><Copy />复制</DropdownMenuItem>
          {/* #1005 照 mirasim:「更多」里也能打开会话,进分屏的「会话」页签 */}
          {m.k === 'compute' && <DropdownMenuItem data-testid={`more-open-session-${m.id}`} className={MENU_ITEM} onSelect={() => openSplit({ t: 'compute', id: m.computeId, view: 'session' })}><Zap />{OPEN_SESSION}</DropdownMenuItem>}
          {mine && <DropdownMenuSeparator className={MENU_SEP} />}
          {mine && <DropdownMenuItem className={cn(MENU_ITEM, MENU_DANGER)} onSelect={() => recall(m.id)}><Undo2 />撤回</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
