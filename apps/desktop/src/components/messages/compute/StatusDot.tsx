import { AlertTriangle, Check, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Compute } from '@/data'

/* ============ Compute 的状态:文字和图形 ============ */
export const statusText = (c: Compute) => (c.status === 'done' ? c.result ?? '已完成' : c.status === 'error' ? '出错了' : c.status === 'stopped' ? '已停止' : c.status === 'waiting' ? '做完了，等你回复' : c.phase)

/** 状态的样子(概念卡第 13 张):每种至少两个特征不同,不只靠颜色。等你=橙实心圆,出错=红三角,进行中=绿转环,做完=灰对勾 */
export function StatusDot({ c, className }: { c: Compute; className?: string }) {
  if (c.status === 'done') return <Check className={cn('h-3.5 w-3.5 text-fg-3', className)} strokeWidth={2.5} />
  if (c.status === 'error') return <AlertTriangle className={cn('h-3.5 w-3.5 text-err', className)} strokeWidth={2.25} />
  if (c.status === 'stopped') return <Square className={cn('h-3 w-3 fill-fg-3 text-fg-3', className)} />
  if (c.status === 'running') return <span className={cn('spin-ring', className)} aria-label="进行中" />
  return <span className={cn('inline-block h-2.5 w-2.5 rounded-full bg-warm-dot ring-2 ring-warm-dot/25', className)} aria-label="等你" />
}
