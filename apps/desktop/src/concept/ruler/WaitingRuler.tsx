import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useApp } from '@/store'
import type { Conversation } from '@/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { transition } from '@/config/motion'
import { waitingIn, type WaitItem } from '../shared/waiting'

/* 概念 · 等你刻度(#1032 的同一类:少走路、少找)
   长群聊里,要你回的事散落在上上下下。聊天区右缘一条细轨,每件「等你」的事在它所在的位置画一道刻度:
   橙 = 等你选 / 同意 / 验收,红 = 出错等你决定。悬停看是什么,点一下跳过去并高亮那条消息。
   手不离键盘:⌥↓ / ⌥↑ 跳到下一件 / 上一件(输入框里有字时不抢)。事情办完,刻度自己消失。
   参照 VS Code 滚动条上的标注(overview ruler):位置即信息,不加面板、不加数字徽标。 */
type Tick = WaitItem & { top: number }

const KEY_HINT = '⌥↓ 下一件 · ⌥↑ 上一件'

export function WaitingRuler({ conv, scrollRef }: { conv: Conversation; scrollRef: RefObject<HTMLDivElement | null> }) {
  const { pending, checklist, computes, jump } = useApp((s) => ({ pending: s.pending, checklist: s.checklist, computes: s.computes, jump: s.jump }))
  const items = useMemo(() => waitingIn(conv, pending, checklist, computes), [conv, pending, checklist, computes])
  const [ticks, setTicks] = useState<Tick[]>([])

  /* 刻度位置 = 那条消息在整段聊天里的高度比例;内容尺寸变了(图片、展开、窗口宽度)就重算 */
  const measure = useCallback(() => {
    const root = scrollRef.current
    if (!root || !root.scrollHeight) return setTicks([])
    const r = root.getBoundingClientRect()
    setTicks(items.flatMap((it) => {
      const el = document.getElementById('m-' + it.msgId)
      if (!el) return []
      const b = el.getBoundingClientRect()
      return [{ ...it, top: (b.top - r.top + root.scrollTop + b.height / 2) / root.scrollHeight }]
    }))
  }, [items, scrollRef])
  useLayoutEffect(measure, [measure])
  useEffect(() => {
    const root = scrollRef.current
    const col = root?.firstElementChild
    if (!root || !col || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(root)
    ro.observe(col)
    return () => ro.disconnect()
  }, [measure, scrollRef])

  /* ⌥↓ / ⌥↑:以当前可视区中线为基准,跳到下一件 / 上一件 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || !ticks.length) return
      const f = document.activeElement as HTMLInputElement | null
      if (f && (f.tagName === 'TEXTAREA' || f.tagName === 'INPUT') && f.value.trim()) return
      const root = scrollRef.current
      if (!root) return
      e.preventDefault()
      const mid = (root.scrollTop + root.clientHeight / 2) / root.scrollHeight
      const eps = 1 / root.scrollHeight
      const next = e.key === 'ArrowDown' ? ticks.find((t) => t.top > mid + eps) ?? ticks[0] : [...ticks].reverse().find((t) => t.top < mid - eps) ?? ticks[ticks.length - 1]
      jump(next.msgId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ticks, jump, scrollRef])

  if (!ticks.length) return null
  return (
    <div data-testid="waiting-ruler" aria-label={`这里有 ${ticks.length} 件事在等你`} className="pointer-events-none absolute bottom-2 right-3 top-2 w-6">
      <AnimatePresence initial={false}>
        {ticks.map((t) => (
          <Tooltip key={t.msgId}>
            <TooltipTrigger asChild>
              <Button
                asChild
                variant="ghost"
                size="icon-xs"
                aria-label={t.label}
                aria-keyshortcuts="Alt+ArrowDown Alt+ArrowUp"
                onClick={() => jump(t.msgId)}
                className="group/tick pointer-events-auto absolute right-0 h-4 w-6 -translate-y-1/2 rounded-sm hover:bg-transparent"
                style={{ top: `${t.top * 100}%` }}
              >
                <motion.span
                  data-testid={`ruler-tick-${t.msgId}`}
                  data-kind={t.kind}
                  role="button"
                  tabIndex={0}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: transition.fade }}
                  exit={{ opacity: 0, transition: transition.popOut }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(t.msgId) } }}
                >
                  <span className={cn('block h-[3px] w-3 rounded-full transition-[width,background-color] duration-fast ease-out group-hover/tick:w-5', t.kind === 'error' ? 'bg-err' : 'bg-warm-dot')} />
                </motion.span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-[320px]">
              <div className="truncate">{t.label}</div>
              <div className="mt-0.5 text-[11px] opacity-70">{KEY_HINT}</div>
            </TooltipContent>
          </Tooltip>
        ))}
      </AnimatePresence>
    </div>
  )
}
