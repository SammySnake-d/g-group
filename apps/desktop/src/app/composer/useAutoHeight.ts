import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'

/** 输入框最多长到 8 行,再多就在框里滚动 */
const MAX_LINES = 8

/** 自适应高度:空时一行,随内容长高,超过上限在框里滚动;外框变宽变窄时重算。返回是否已到上限 */
export function useAutoHeight(inputRef: { current: HTMLTextAreaElement | null }, boxRef: RefObject<HTMLDivElement | null>, text: string) {
  const [tall, setTall] = useState(false)
  const fit = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    const cs = getComputedStyle(el)
    const max = parseFloat(cs.lineHeight) * MAX_LINES + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    const over = el.scrollHeight > max + 1
    el.style.overflowY = over ? 'auto' : 'hidden'
    setTall(over)
  }
  useLayoutEffect(fit, [text]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    let w = box.clientWidth
    const ro = new ResizeObserver(() => { if (box.clientWidth !== w) { w = box.clientWidth; fit() } })
    ro.observe(box)
    return () => ro.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return tall
}
