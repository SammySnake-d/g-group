import { cn } from '@/lib/utils'

/** 键盘调宽每按一下挪多少(像素) */
const KEY_STEP = 16

/* 可拖动的分隔条:所有面板缝隙都能调宽(#1194)。onDrag 收到的是这一拍的水平位移(向右为正)。
   命中区比 1px 的线宽出两侧各 4px(不压住列表的滚动条);也能用 Tab 聚焦后按 ←/→ 调(共同规则追加 2 第 5 条)。 */
export function Divider({ onDrag, testid, side = 'r', label = '拖动调整宽度', value, min, max }: {
  onDrag: (dx: number) => void; testid: string; side?: 'l' | 'r'; label?: string; value?: number; min?: number; max?: number
}) {
  const start = (e: React.PointerEvent) => {
    e.preventDefault()
    let last = e.clientX
    const mv = (ev: PointerEvent) => { onDrag(ev.clientX - last); last = ev.clientX }
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; document.body.style.userSelect = '' }
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
  }
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onDrag(e.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP) }
  }
  return (
    <div role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} tabIndex={0}
      onPointerDown={start} onKeyDown={key} data-testid={testid} title={label}
      className={cn('group/d relative z-10 w-px shrink-0 cursor-col-resize bg-line outline-none', side === 'l' && '-ml-px')}>
      <span className="absolute inset-y-0 -left-1 -right-1 transition-colors duration-fast ease-out group-hover/d:bg-fg-3/25 group-focus-visible/d:bg-ring/60 group-active/d:bg-fg-3/40" />
    </div>
  )
}
