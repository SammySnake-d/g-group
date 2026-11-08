/* 定时列表：一行 = 谁的闹钟、做什么、人话时间 + cron 表达式、下次、最近一次结果、开关。
   三个视角共用这一行（AC-53）：群资料「定时」只看本群；联系人工作台看它在各会话的全部；进展总览看所有。 */
import { useState } from 'react'
import { AlertTriangle, ArrowUpRight, Check, MoonStar, Plus } from 'lucide-react'
import { localZoneLabel } from '@g-group/ui-core'
import { useApp } from '@/ctx'
import { people, type Conversation, type Cron } from '@/data'
import { cronExpr, cronFailed, cronLastText, cronNextText, cronOrder, cronRule, openCronOverview, useNow } from '@/cronView'
import { cn } from '@/lib/utils'
import { Avatar } from './Avatar'
import { CronEditor } from './CronEditor'
import { Switch } from '@/components/ui/switch'

export const convName = (c?: Conversation, id?: string) => (c ? (c.kind === 'dm' ? `与 ${c.title} 私聊` : c.title) : id ?? '')

export function ResultIcon({ r, className }: { r?: Cron['runs'][number]['result']; className?: string }) {
  if (r === 'error') return <AlertTriangle className={cn('h-3.5 w-3.5 shrink-0 text-err', className)} />
  if (r === 'silent') return <MoonStar className={cn('h-3.5 w-3.5 shrink-0 text-fg-3', className)} />
  if (r === 'said') return <Check className={cn('h-3.5 w-3.5 shrink-0 text-ok', className)} strokeWidth={2.5} />
  return null
}

export function CronRow({ c, now, showOwner = true, showConv = false }: { c: Cron; now: Date; showOwner?: boolean; showConv?: boolean }) {
  const { convs, plugins, openSplit, updateCron, runCronNow } = useApp()
  const failed = cronFailed(c)
  const expr = cronExpr(c)
  const conv = convs.find((x) => x.id === c.conv)
  const next = <span className={cn('shrink-0', c.paused ? 'text-fg-3' : 'text-fg-2')}>{c.paused ? '' : '下次 '}<span data-testid="cron-row-next" className={cn(!c.paused && 'font-medium tabular-nums text-fg')}>{cronNextText(c, now, plugins)}</span></span>
  return (
    <div role="button" tabIndex={0} data-testid={`cron-row-${c.id}`} data-cron-row={c.id} data-paused={c.paused || undefined} data-failed={failed || undefined}
      onClick={() => openSplit({ t: 'cron', id: c.id })} onKeyDown={(e) => { if (e.key === 'Enter') openSplit({ t: 'cron', id: c.id }) }}
      className={cn('group/row flex cursor-pointer gap-2.5 rounded-xl px-2.5 py-2.5 outline-none transition hover:bg-hover focus-visible:bg-hover', failed && 'bg-err-soft/40')}>
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
          {expr && <code data-testid="cron-row-expr" className="shrink-0 rounded bg-hover px-1.5 py-px font-mono text-[11.5px] text-fg-2">{expr}</code>}
          {!(showOwner || showConv) && <span className="ml-auto pl-2 text-[12px]">{next}</span>}
        </div>
        <div data-testid="cron-row-last" className={cn('mt-1 flex min-w-0 items-center gap-1 text-[12px]', failed ? 'text-err' : 'text-fg-3')}>
          <ResultIcon r={c.runs[0]?.result} />
          <span className="truncate">{cronLastText(c, now)}</span>
          {failed && <button data-testid={`cron-retry-${c.id}`} onClick={(e) => { e.stopPropagation(); runCronNow(c.id) }} className="ml-1 shrink-0 rounded-md px-1.5 font-medium text-err hover:bg-err-soft">重试</button>}
        </div>
      </div>
      <div className="pt-0.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Switch data-testid={`cron-toggle-${c.id}`} aria-label={c.paused ? '开启这个定时' : '暂停这个定时'} checked={!c.paused} onCheckedChange={(v) => updateCron(c.id, { paused: !v })} />
      </div>
    </div>
  )
}

/** 群资料「定时」页签：只看本群（不把别的群混进来） */
export function GroupCrons({ conv }: { conv: Conversation }) {
  const { crons, addCron, setPanoOpen } = useApp()
  const now = useNow()
  const [adding, setAdding] = useState(false)
  const mine = crons.filter((c) => c.conv === conv.id).sort(cronOrder(now))
  const live = mine.filter((c) => !c.paused).length
  return (
    <section className="px-2 pb-4 pt-2" data-testid="side-crons">
      <div className="mb-1.5 flex items-center gap-2 px-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">本群定时 <span className="font-normal text-fg-3">{live}/{mine.length} 开着</span></div>
          <div data-testid="side-cron-zone" className="truncate text-[11.5px] text-fg-3">只看本群 · 按本地时间（{localZoneLabel(now)}）</div>
        </div>
        <button data-testid="side-cron-add" onClick={() => setAdding(true)} className="flex h-8 shrink-0 items-center gap-1 rounded-lg bg-btn px-2.5 text-[12.5px] font-medium text-btn-fg hover:opacity-90"><Plus className="h-3.5 w-3.5" />新建定时</button>
      </div>
      {mine.length === 0 && (
        <div className="mx-2 rounded-xl border border-dashed border-line px-4 py-6 text-center text-[12.5px] leading-relaxed text-fg-3">
          还没有定时。点「新建定时」，或者在群里跟某个助手说「每天 8 点…」
        </div>
      )}
      <div className="space-y-0.5">{mine.map((c) => <CronRow key={c.id} c={c} now={now} />)}</div>
      <button data-testid="side-cron-overview" onClick={() => openCronOverview(setPanoOpen)} className="mt-2 flex items-center gap-0.5 px-2.5 text-[12px] text-fg-3 hover:text-fg">所有会话的定时在「进展」里看<ArrowUpRight className="h-3 w-3" /></button>
      <CronEditor open={adding} conv={conv.id} onClose={() => setAdding(false)} onSave={(d) => { addCron(d, 'panel'); setAdding(false) }} />
    </section>
  )
}
