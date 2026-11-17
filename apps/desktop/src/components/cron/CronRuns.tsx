/* 运行历史:每次醒来做了什么(发了消息 / 没打扰你 / 失败),当时带的公告是不是最新,点了跳回当次的消息。
   最近一次失败的那行就地给「重试」。 */
import { RotateCw } from 'lucide-react'
import { formatRunAt } from '@g-group/ui-core'
import { useApp } from '@/ctx'
import type { Conversation, Cron } from '@/data'
import { RESULT } from '@/cronView'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { DETAIL, HEALTH_TICKS, TICK_CLS } from './constants'
import { ResultIcon } from './ResultIcon'

/** 最近几次醒来的结果条(照 mirasim 自动化详情的 health strip):从旧到新一格一次,失败红、发了消息绿、没打扰你灰 */
function HealthStrip({ runs }: { runs: Cron['runs'] }) {
  const recent = runs.slice(0, HEALTH_TICKS).reverse()
  if (!recent.length) return null
  const label = recent.map((r) => RESULT[r.result]).join('、')
  return (
    <span role="img" aria-label={`最近 ${recent.length} 次：${label}`} title={label} className="ml-auto flex shrink-0 gap-[2px]">
      {recent.map((r, i) => <span key={i} data-state={r.result} className={cn('h-3.5 w-[5px] rounded-[1.5px]', TICK_CLS[r.result])} />)}
    </span>
  )
}

export function CronRuns({ c, conv, now, failed, spaced }: { c: Cron; conv: Conversation | undefined; now: Date; failed: boolean; spaced: boolean }) {
  const { jump, runCronNow } = useApp()
  return (
    <div className={cn('border-t border-line px-5 py-3', spaced && 'mt-5')}>
      <div className="mb-1.5 flex min-w-0 items-center gap-2 text-[12px] font-medium text-fg-3">
        {DETAIL.runs}<span data-testid="cron-runs-count" className="font-normal tabular-nums">{c.runs.length} 次</span>
        {failed && <Chip tone="err" size="xs">{DETAIL.lastFailed}</Chip>}
        <HealthStrip runs={c.runs} />
      </div>
      {c.runs.length === 0 && <div className="py-2 text-[13px] text-fg-3">{DETAIL.noRuns}</div>}
      <div className="space-y-1" data-testid="cron-runs">
        {c.runs.map((r, i) => (
          <div key={`${r.at}-${i}`} data-testid={`cron-run-${i}`} data-result={r.result}
            className={cn('rounded-lg px-2 py-1.5 text-[13px]', r.result === 'error' && 'bg-err-soft/60')}>
            <div className="flex min-w-0 items-center gap-2">
              <ResultIcon r={r.result} />
              <span className={cn('shrink-0 text-[12.5px] font-medium', r.result === 'error' ? 'text-err' : r.result === 'silent' ? 'text-fg-2' : 'text-fg')}>{RESULT[r.result]}</span>
              <span className="shrink-0 text-[12px] tabular-nums text-fg-3">{formatRunAt(new Date(r.at), now)}</span>
              <span className="flex-1" />
              {r.notices && conv?.notices && (() => {
                const old = conv.notices.filter((n) => (r.notices![n.id] ?? 0) < n.ver)
                return <span data-testid={`cron-run-notices-${i}`} data-stale={old.length || undefined} title={conv.notices.map((n) => `${n.text.split('\n')[0].slice(0, 16)}… v${r.notices![n.id] ?? '—'}`).join('\n')}
                  className={cn('shrink-0 text-[11px]', old.length ? 'text-warm' : 'text-fg-3')}>公告 {old.length ? `${old.length} 条是旧版` : '当时最新'}</span>
              })()}
              {i === 0 && r.result === 'error' && (
                <Button data-testid="cron-run-retry" variant="ghost" size="xs" onClick={() => runCronNow(c.id)} className="h-6 px-1.5 text-err hover:bg-err-soft hover:text-err"><RotateCw />{DETAIL.retry}</Button>
              )}
              {r.msg && <Button data-testid={`cron-run-jump-${i}`} variant="ghost" size="xs" onClick={() => jump(r.msg!)} className="h-6 px-1.5 text-me hover:bg-me/10 hover:text-me">{DETAIL.jump}</Button>}
            </div>
            <div className={cn('mt-0.5 pl-[22px] text-[12.5px] leading-snug', r.result === 'error' ? 'text-err' : 'text-fg-2')}>{r.note}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
