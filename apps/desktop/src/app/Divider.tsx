import { cn } from '@/lib/utils'

/** 可拖动的分隔条:所有面板缝隙都能调宽(#1194)。onDrag 收到的是这一拍的水平位移 */
export function Divider({ onDrag, testid, side = 'r' }: { onDrag: (dx: number) => void; testid: string; side?: 'l' | 'r' }) {
  const start = (e: React.PointerEvent) => {
    e.preventDefault()
    let last = e.clientX
    const mv = (ev: PointerEvent) => { onDrag(ev.clientX - last); last = ev.clientX }
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; document.body.style.userSelect = '' }
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
  }
  return (
    <div role="separator" aria-orientation="vertical" onPointerDown={start} data-testid={testid} title="拖动调整宽度" className={cn('group/d relative z-10 w-px shrink-0 cursor-col-resize bg-line', side === 'l' && '-ml-px')}>
      <span className="absolute inset-y-0 -left-[3px] -right-[3px] transition-colors duration-fast ease-out group-hover/d:bg-fg-3/25 group-active/d:bg-fg-3/40" />
    </div>
  )
}
