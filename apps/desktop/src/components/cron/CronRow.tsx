/* 定时列表的一行 = 谁的闹钟、做什么、人话时间 + cron 表达式、下次、最近一次结果、开关。
   三个视角共用这一行（AC-53）：群资料「定时」只看本群；联系人工作台看它在各会话的全部；进展总览看所有。
   整行可点(打开详情),里面有开关和重试,所以行本身是 role=button 的 div,不嵌套 button。 */
import { RotateCw } from 'lucide-react'
import { useApp } from '@/ctx'
import { people, type Cron } from '@/data'
import { cronExpr, cronFailed, cronLastText, cronNextText, cronRule } from '@/cronView'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { LIST } from './constants'
import { ResultIcon } from './ResultIcon'
import { convName } from './util'

export function CronRow({ c, now, showOwner = true, showConv = false }: { c: Cron; now: Date; showOwner?: boolean; showConv?: boolean }) {
  const { convs, plugins, openSplit, updateCron, runCronNow } = useApp()
  const failed = cronFailed(c)
  const expr = cronExpr(c)
  const conv = convs.find((x) => x.id === c.conv)
  const open = () => openSplit({ t: 'cron', id: c.id })
  const next = (
    <span className={cn('shrink-0', c.paused ? 'text-fg-3' : 'text-fg-2')}>{c.paused ? '' : '下次 '}
      <span data-testid="cron-row-next" className={cn('tabular-nums', !c.paused && 'font-medium text-fg')}>{cronNextText(c, now, plugins)}</span>
    </span>
  )
  return (
    <div role="button" tabIndex={0} data-testid={`cron-row-${c.id}`} data-cron-row={c.id} data-paused={c.paused || undefined} data-failed={failed || undefined}
      onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open() }}
      className={cn('group/row flex cursor-pointer gap-2.5 rounded-xl px-2.5 py-2.5 outline-none transition-colors duration-fast ease-out hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-ring/60', failed && 'bg-err-soft/40')}>
      {showOwner && <div className={cn('pt-0.5', c.paused && 'opacity-50')}><Avatar id={c.owner} size={26} status={false} mood="idle" /></div>}
      <div className={cn('min-w-0 flex-1', c.paused && 'opacity-60')}>
        {(showOwner || showConv) && (
          <div className="flex min-w-0 items-baseline gap-2 text-[11.5px]">
            <span className="flex min-w-0 flex-1 items-center gap-1 text-fg-3">
              {showOwner && <span className="shrink-0 font-medium text-fg-2">{people[c.owner]?.name}</span>}
              {showOwner && showConv && <span>·</span>}
              {showConv && <span className="truncate">{convName(conv, c.conv)}</span>}
            </span>
            {next}
          </div>
        )}
        <div className={cn('line-clamp-2 whitespace-pre-line text-[13.5px] leading-snug text-fg', (showOwner || showConv) && 'mt-0.5')}>{c.text}</div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px]">
          <span data-testid="cron-row-rule" className="min-w-0 truncate font-medium text-fg-2" title={cronRule(c)}>{cronRule(c)}</span>
          {expr && <code data-testid="cron-row-expr" className="shrink-0 rounded-md bg-hover px-1.5 py-px font-code text-[11.5px] text-fg-2">{expr}</code>}
          {!(showOwner || showConv) && <span className="ml-auto pl-2 text-[12px]">{next}</span>}
        </div>
        <div data-testid="cron-row-last" className={cn('mt-1 flex min-w-0 items-center gap-1 text-[12px]', failed ? 'text-err' : 'text-fg-3')}>
          <ResultIcon r={c.runs[0]?.result} />
          <span className="truncate">{cronLastText(c, now)}</span>
          {failed && (
            <Button data-testid={`cron-retry-${c.id}`} variant="ghost" size="xs" onClick={(e) => { e.stopPropagation(); runCronNow(c.id) }}
              className="ml-1 h-6 gap-1 px-1.5 text-err hover:bg-err-soft hover:text-err"><RotateCw />{LIST.retry}</Button>
          )}
        </div>
      </div>
      <div className="pt-0.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Switch data-testid={`cron-toggle-${c.id}`} aria-label={c.paused ? LIST.resume : LIST.pause} checked={!c.paused} onCheckedChange={(v) => updateCron(c.id, { paused: !v })} />
      </div>
    </div>
  )
}
