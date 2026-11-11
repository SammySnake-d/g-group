/* 输入框里光标的屏幕坐标(镜像 div 法:复制 textarea 的排版,量光标前那段文字之后的位置) */
const COPY = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize', 'textIndent', 'whiteSpace', 'wordBreak', 'overflowWrap'] as const

export function caretPoint(ta: HTMLTextAreaElement): { x: number; y: number } {
  const cs = getComputedStyle(ta)
  const mirror = document.createElement('div')
  for (const k of COPY) mirror.style[k] = cs[k]
  Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflow: 'hidden' })
  mirror.textContent = ta.value.slice(0, ta.selectionEnd ?? ta.value.length)
  const mark = document.createElement('span')
  mark.textContent = '\u200b'
  mirror.appendChild(mark)
  document.body.appendChild(mirror)
  const r = ta.getBoundingClientRect()
  const x = r.left + mark.offsetLeft - ta.scrollLeft
  const y = r.top + mark.offsetTop - ta.scrollTop + mark.offsetHeight / 2
  mirror.remove()
  return { x, y }
}
