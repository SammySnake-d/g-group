/* 标题栏的成员头像组（#1651 第 1 条；#976：默认收拢、移上去才展开）。
   平时收成一小叠（大幅重叠只露边 + 成员数）；指针移上来或键盘聚焦（focus-visible）时展开，每个头像悬停浮起并显示名字。
   浮起和名字提示用 Animate UI 的 AvatarGroup；收拢 ↔ 展开的间距变化用 motion 的 layout 动画配库里的 spring.reflow。
   展开只往左长（右边贴着群资料按钮不动），指针一直在组内，悬停链不断；点哪里都打开群资料的成员页。 */
import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { AvatarGroup, AvatarGroupTooltip } from '@animate-ui/react/primitives/avatar-group'
import { people, type Conversation } from '@/data'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { spring } from '@/config/motion'
import { cn } from '@/lib/utils'
import { STACK_MAX } from './constants'

export function MemberStack({ conv, onOpen }: { conv: Conversation; onOpen: () => void }) {
  const [open, setOpen] = useState(false)
  /* motion 给带点按手势的头像容器自动加了 tabIndex=0;整组只有外层按钮一个焦点(名字都在它的 aria-label 里),里面不再嵌一层可聚焦元素 */
  const group = useRef<HTMLDivElement>(null)
  useEffect(() => { group.current?.querySelectorAll<HTMLElement>('[data-slot=tooltip-trigger]').forEach((el) => { el.tabIndex = -1 }) })
  /* 悬停用原生 pointerenter / pointerleave:按 DOM 判断进出。React 的合成事件会把传送门里的名字提示也算进按钮里,指针离开时可能收不回 */
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const el = btn.current
    if (!el) return
    const on = () => setOpen(true)
    const off = () => setOpen(false)
    el.addEventListener('pointerenter', on)
    el.addEventListener('pointerleave', off)
    return () => { el.removeEventListener('pointerenter', on); el.removeEventListener('pointerleave', off) }
  }, [])
  const ms = conv.members.filter((m) => m !== 'me').slice(0, STACK_MAX)
  return (
    <Button ref={btn} data-testid="member-stack" data-open={open ? '1' : '0'} variant="ghost" size={null} shape="pill" onClick={onOpen}
      aria-label={`群成员 ${conv.members.length}：${conv.members.map((m) => people[m].name).join('、')}`}
      onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) setOpen(true) }} onBlur={() => setOpen(false)}
      className={cn('h-8 gap-1.5 py-1 pl-1.5 pr-2 active:scale-100 [--avatar-ring:var(--bg)]', open && 'bg-hover')}>
      <AvatarGroup ref={group} className="flex items-center" side="bottom" sideOffset={10}>
        {ms.map((m, i) => (
          <motion.span key={m} layout transition={spring.reflow} data-testid={`member-stack-avatar-${m}`}
            className={cn('block rounded-full ring-2 ring-bg', i > 0 && (open ? '-ml-1' : '-ml-[17px]'))}>
            <Avatar id={m} size={22} status={false} />
            <AvatarGroupTooltip data-testid="member-stack-name" className="z-50 rounded-lg bg-fg px-2 py-1 text-xs font-medium text-bg shadow-elev">{people[m].name}</AvatarGroupTooltip>
          </motion.span>
        ))}
      </AvatarGroup>
      <motion.span layout transition={spring.reflow} className="text-[12px] tabular-nums text-fg-2">{conv.members.length}</motion.span>
    </Button>
  )
}
