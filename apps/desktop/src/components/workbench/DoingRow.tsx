import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Compute, Conversation } from '@/data'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Source, pressRow, pressRowCls } from './parts'
import { stepOf } from './status'

/* 在做的一件事:在跑的转圈 + 第几步;出错的整行浅红底 + 重试。点整行在右边分屏看它 */
export function DoingRow({ c, conv, link }: { c: Compute; conv?: Conversation; link: ReactNode }) {
  const { openSplit, resume } = useApp()
  const err = c.status === 'error'
  return (
    <div data-testid={`wb-doing-${c.id}`} {...pressRow(() => openSplit({ t: 'compute', id: c.id }))}
      className={cn('flex items-center gap-2 rounded-lg px-3 py-2 transition-colors duration-fast ease-out', pressRowCls, err ? 'bg-err-soft' : 'hover:bg-hover')}>
      {err ? <AlertTriangle className="h-4 w-4 shrink-0 text-err" /> : <Spinner />}
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-[13.5px] font-medium', err && 'text-err')}>{c.title}</div>
        <div className={cn('truncate text-[12px] tabular-nums', err ? 'text-err' : 'text-run')}>{err ? c.error ?? '出错了' : `${c.phase} · 第 ${stepOf(c)}/共 ${c.steps.length} 步`}</div>
      </div>
      <Source conv={conv} />
      {err && (
        <Button data-testid={`wb-retry-${c.id}`} variant="outline" size="xs" shape="pill" onClick={(e) => { e.stopPropagation(); resume(c.id) }}
          className="border-err/40 bg-transparent text-err shadow-none hover:border-err hover:bg-err hover:text-white">
          重试
        </Button>
      )}
      {link}
    </div>
  )
}
