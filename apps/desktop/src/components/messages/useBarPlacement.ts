import { useEffect, useRef, useState } from 'react'
import { placeHoverBar, type BarPlacement } from '@g-group/ui-core'

/** 悬浮工具条的位置(#719 贴着气泡;#1032 放在气泡上方右上角,移动路径最短)。
 *  工具条挂在气泡(锚点)里;每次鼠标进入这一行、或键盘焦点进来时,按气泡和可视区的实际位置重新算(滚动、窗口宽度变化后也贴着)。
 *  定位规则在 @g-group/ui-core 的 placeHoverBar,这里只负责量尺寸。显隐交给 CSS(group-hover),不经过 React 状态。 */
export function useBarPlacement() {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<BarPlacement | null>(null)
  useEffect(() => {
    const bar = ref.current
    const anchor = bar?.parentElement
    const row = anchor?.closest('[data-msg]')
    if (!bar || !anchor || !row) return
    const place = () => {
      const scroller = anchor.closest('[data-scroll]') ?? document.documentElement
      const b = scroller.getBoundingClientRect()
      const a = anchor.getBoundingClientRect()
      setPos(placeHoverBar(a, { width: bar.offsetWidth, height: bar.offsetHeight }, { left: b.left, top: b.top, right: Math.min(b.right, window.innerWidth), bottom: Math.min(b.bottom, window.innerHeight) }))
    }
    row.addEventListener('mouseenter', place)
    row.addEventListener('focusin', place)
    return () => { row.removeEventListener('mouseenter', place); row.removeEventListener('focusin', place) }
  }, [])
  return { ref, pos }
}
