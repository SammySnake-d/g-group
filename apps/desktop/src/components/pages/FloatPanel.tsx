import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { ChevronLeft, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp, type Page } from '@/ctx'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { pageIn, panel, panelReduced } from './kit/motion'
import { FLOAT_RESIZE } from './constants'
import { pageKey, pageTitle } from './titles'
import { PageBody } from './PageBody'

/* ============ 右侧浮层:一摞页面。返回 / 关闭 / Esc 都只退一层;点浮层外面才全部收起(Esc 与遮罩在 App) ============
   进出场:从右侧滑入,退场更快(数值全部取自 Animate UI token,见 kit/motion)。
   压栈时新页从右边来、返回时从左边来,旧页立即让位——浮层里永远只有一份控件,testid 不会重复。 */

export function FloatPanel({ stack, width, onResize }: { stack: Page[]; width: number; onResize: (w: number) => void }) {
  const reduced = useReducedMotion()
  // 退场动画期间 stack 已经空了,用最后一摞把内容画完
  const last = useRef(stack)
  if (stack.length) last.current = stack
  const depth = useRef(stack.length)
  const dir: 1 | -1 = stack.length >= depth.current ? 1 : -1
  useEffect(() => { depth.current = stack.length }, [stack.length])
  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 z-30 flex p-2.5 pl-0">
      <AnimatePresence>
        {stack.length > 0 && <Sheet key="float" stack={last.current} width={width} onResize={onResize} dir={dir} reduced={!!reduced} />}
      </AnimatePresence>
    </div>
  )
}

function Sheet({ stack, width, onResize, dir, reduced }: { stack: Page[]; width: number; onResize: (w: number) => void; dir: 1 | -1; reduced: boolean }) {
  const { back, convs } = useApp()
  const present = useIsPresent()
  const top = stack[stack.length - 1]
  const prev = stack[stack.length - 2]
  const drag = (e: ReactPointerEvent) => {
    e.preventDefault()
    const sx = e.clientX, sw = width
    const mv = (ev: PointerEvent) => onResize(Math.max(FLOAT_RESIZE.min, Math.min(FLOAT_RESIZE.max, sw - (ev.clientX - sx))))
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); document.body.style.cursor = '' }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
  }
  return (
    <motion.aside
      {...(reduced ? panelReduced : panel)}
      data-testid="float"
      data-page={top.t}
      aria-label={pageTitle(top, convs)}
      inert={!present || undefined}
      className={cn('relative flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-elev shadow-elev', present ? 'pointer-events-auto' : 'pointer-events-none')}
      style={{ width }}
    >
      <div onPointerDown={drag} data-testid="float-resize" title="拖动调宽" role="separator" aria-orientation="vertical" aria-label="拖动调宽" className="group/r absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize">
        <span className="absolute inset-y-6 left-0.5 w-[3px] rounded-full opacity-0 transition-[opacity,background-color] duration-fast ease-out group-hover/r:bg-fg-3/40 group-hover/r:opacity-100" />
      </div>
      <header className="flex h-12 shrink-0 items-center gap-1 px-2.5">
        {prev && (
          <Button data-testid="float-back" variant="ghost" onClick={back} className="max-w-[45%] gap-0.5 pl-1 pr-2 font-normal [&_svg]:size-[18px]">
            <ChevronLeft /><span className="truncate">{pageTitle(prev, convs)}</span>
          </Button>
        )}
        <h2 className={cn('min-w-0 flex-1 truncate text-[14.5px] font-semibold', !prev && 'pl-1.5')}>{prev ? '' : pageTitle(top, convs)}</h2>
        <IconButton data-testid="float-close" label={prev ? `关闭，回到「${pageTitle(prev, convs)}」` : '关闭（Esc）'} icon={<X />} onClick={back} />
      </header>
      <motion.div key={pageKey(top, stack.length)} {...pageIn(dir, reduced)} className="flex min-h-0 flex-1 flex-col">
        {prev && top.t !== 'person' && <h2 className="-mt-1 truncate px-4 pb-1 text-[16px] font-semibold tracking-tight">{pageTitle(top, convs)}</h2>}
        <PageBody p={top} />
      </motion.div>
    </motion.aside>
  )
}
