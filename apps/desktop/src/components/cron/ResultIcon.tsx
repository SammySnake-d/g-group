/* 一次醒来的结果图标:发了消息 / 没打扰你 / 失败。列表、详情、进展总览共用 */
import { AlertTriangle, Check, MoonStar } from 'lucide-react'
import type { Cron } from '@/data'
import { cn } from '@/lib/utils'

export function ResultIcon({ r, className }: { r?: Cron['runs'][number]['result']; className?: string }) {
  if (r === 'error') return <AlertTriangle className={cn('h-3.5 w-3.5 shrink-0 text-err', className)} />
  if (r === 'silent') return <MoonStar className={cn('h-3.5 w-3.5 shrink-0 text-fg-3', className)} />
  if (r === 'said') return <Check className={cn('h-3.5 w-3.5 shrink-0 text-ok', className)} strokeWidth={2.5} />
  return null
}
