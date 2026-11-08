import { useEffect, useRef, type RefObject } from 'react'
import { animate, useReducedMotion } from 'motion/react'
import { useApp } from '@/ctx'
import type { Conversation, Msg } from '@/data'
import { scale, spring } from '@/config/motion'

/* 概念 · 双击就回复(#1032「移动到消息 → 再移动到旁边的按钮,这段路程是成本」)
   指针已经在消息上了,就地双击 = 回复它(引用 + @ 作者 + 光标进输入框),一步也不用挪。
   照 Telegram Desktop 的老习惯(双击消息回复),不是新发明的手势;悬浮条上的「回复」照旧可用。
   双击在按钮、链接、输入框、选项上不算;按住 ⌥ / ⌘ / ⇧ / Ctrl 双击 = 系统原样选词。
   回馈:气泡按下再弹回(库里的 scale.press + spring.press,和按钮按下同一套),告诉你「收到了」。
   教得会:你第一次走远路(点悬浮条上的「回复」)时,轻提示一次「双击消息也能回复」,之后不再打扰。 */
const TIP_KEY = 'gg.concept.dblreply.tip'
const TIP = '小提示：在消息上双击，也能直接回复它'


/** 和悬浮条「回复」一致的引用摘要 */
const quoteText = (m: Msg) => (m.k === 'text' ? m.text.replace(/^@\S+\s/, '') : m.k === 'compute' ? '[Compute]' : m.k === 'file' ? '[文件]' : m.k === 'board' ? '[任务板]' : m.k === 'forward' ? '[转发]' : null)

const SKIP = 'button, a, input, textarea, select, label, [role=button], [role=menuitem], [contenteditable=true], [data-no-dblreply]'

export function DoubleClickReply({ conv, scrollRef, disabled }: { conv: Conversation; scrollRef: RefObject<HTMLDivElement | null>; disabled?: boolean }) {
  const { addQuote, toast } = useApp()
  const reduce = useReducedMotion()
  /* 监听器只挂一次,读最新的会话 / 开关 */
  const latest = useRef({ conv, disabled, addQuote, reduce, toast })
  latest.current = { conv, disabled, addQuote, reduce, toast }

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const onDbl = (e: MouseEvent) => {
      const { conv, disabled, addQuote, reduce } = latest.current
      if (disabled || e.altKey || e.metaKey || e.shiftKey || e.ctrlKey) return
      const t = e.target as HTMLElement
      if (t.closest(SKIP)) return
      const anchor = t.closest<HTMLElement>('[data-anchor]')
      const id = anchor?.dataset.anchor
      const m = id ? conv.messages.find((x) => 'id' in x && x.id === id) : undefined
      const text = m && quoteText(m)
      if (!anchor || !m || !('from' in m) || text === null || !text) return
      window.getSelection()?.removeAllRanges()
      addQuote({ msgId: m.id, from: m.from, text, reply: true })
      anchor.dataset.dblreply = '1'
      if (reduce) return
      void animate(anchor, { scale: scale.press }, spring.press).then(() => animate(anchor, { scale: 1 }, spring.press))
    }
    /* 第一次点悬浮条「回复」(走了远路):提示一次就记住 */
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-testid^="reply-"]')) return
      try { if (localStorage.getItem(TIP_KEY)) return; localStorage.setItem(TIP_KEY, '1') } catch { return }
      setTimeout(() => latest.current.toast(TIP), 0)
    }
    root.addEventListener('dblclick', onDbl)
    root.addEventListener('click', onClick)
    return () => { root.removeEventListener('dblclick', onDbl); root.removeEventListener('click', onClick) }
  }, [scrollRef])
  return null
}
