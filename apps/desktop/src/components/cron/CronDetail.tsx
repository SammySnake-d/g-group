/* 定时详情（#1286 #1850 #1858）：在右侧分栏打开。能改、能暂停、能删（二次确认）、能立即跑一次，
   能看每次醒来做了什么、点了跳回当次的消息。三处列表（本群 / 它的工作台 / 进展总览）点任意一行都打开这里。
   层级:做什么(标题)→ 规则卡(人话规则 + 表达式,「下次」最醒目,再往后几次)→ 操作 → 公告 → 运行历史。 */
import { useState } from 'react'
import { AlarmClock, ArrowUpRight, Pencil, Play, Trash2 } from 'lucide-react'
import { formatRunAt, localZoneLabel, nextRuns } from '@g-group/ui-core'
import { useApp } from '@/ctx'
import { people } from '@/data'
import { cronExpr, cronFailed, cronNextText, cronRule, useNow } from '@/cronView'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { IconButton } from '@/components/ui/icon-button'
import { Switch } from '@/components/ui/switch'
import { CronEditor } from './CronEditor'
import { CronNotices } from './CronNotices'
import { CronRuns } from './CronRuns'
import { DeleteCronDialog } from './DeleteCronDialog'
import { DETAIL, SPEAKS, STATUS } from './constants'
import { convName } from './util'

export function CronDetail({ id }: { id: string }) {
  const { crons, convs, plugins, updateCron, removeCron, runCronNow, jump, openConv } = useApp()
  const now = useNow()
  const c = crons.find((x) => x.id === id)
  const [edit, setEdit] = useState(false)
  const [asking, setAsking] = useState(false)
  if (!c) return <div className="p-6 text-[13px] text-fg-3" data-testid="cron-detail-gone">{DETAIL.gone}</div>
  const conv = convs.find((x) => x.id === c.conv)
  const expr = cronExpr(c)
  const failed = cronFailed(c)
  const upcoming = expr && !c.paused ? nextRuns(expr, now, 4).slice(1) : []
  const speakText = c.trigger.kind === 'event' ? DETAIL.speakEvent : SPEAKS.find((x) => x.value === c.speak)?.label ?? ''
  const status = failed ? STATUS.failed : c.paused ? STATUS.paused : null
  const hasNotices = conv?.kind === 'group' && (conv.notices?.length ?? 0) > 0
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid={`cron-detail-${c.id}`}>
      <div className="px-5 pt-4">
        <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-3">
          <Avatar id={c.owner} size={18} status={false} mood="idle" />
          <span className="shrink-0">{people[c.owner]?.name} {DETAIL.ownerSuffix}</span><span>·</span>
          <Button variant="ghost" size="xs" onClick={() => openConv(c.conv)} className="h-6 min-w-0 gap-0.5 px-1.5 font-normal text-fg-2">
            <span className="truncate">在「{convName(conv, c.conv)}」</span><ArrowUpRight className="!h-3 !w-3" />
          </Button>
        </div>
        <div data-testid="cron-detail-text" className="mt-2 whitespace-pre-line text-pretty text-[16px] font-semibold leading-snug">{c.text}</div>

        <div className={cn('mt-3 rounded-xl border border-line bg-side px-4 py-3.5', c.paused && 'opacity-70')}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <AlarmClock className="h-4 w-4 shrink-0 text-fg-3" />
            <span data-testid="cron-rule" className="text-[14.5px] font-semibold">{cronRule(c)}</span>
            {expr && <code data-testid="cron-detail-expr" className="rounded-md bg-hover px-1.5 py-px font-code text-[12px] text-fg-2">{expr}</code>}
            {status && <span className={cn('ml-auto inline-flex shrink-0 items-center gap-1.5 text-[12px] font-semibold', status.cls)}><span aria-hidden className="h-[7px] w-[7px] rounded-full bg-current" />{status.label}</span>}
          </div>
          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[12px] text-fg-3">{c.paused ? '' : `${DETAIL.next} `}<span data-testid="cron-next" className={cn('text-[17px] font-semibold tabular-nums tracking-[-0.01em]', c.paused ? 'text-fg-3' : 'text-fg')}>{cronNextText(c, now, plugins)}</span></span>
            <span className="text-[12.5px] text-fg-3">·</span><span className="text-[12.5px] text-fg-2">{speakText}</span>
          </div>
          {upcoming.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1 text-[12px]">
              <span className="mr-0.5 text-fg-3">{DETAIL.later}</span>
              {upcoming.map((d, i) => <Chip key={d.getTime()} data-testid={`cron-detail-next-${i}`} variant="outline" size="sm" className="bg-elev font-normal tabular-nums text-fg-2">{formatRunAt(d, now)}</Chip>)}
            </div>
          )}
          {(c.trigger.kind === 'cron' || c.trigger.kind === 'once') && <div className="mt-2 text-[11.5px] text-fg-3">{DETAIL.zone} · {localZoneLabel(now)}</div>}
          {c.uses?.length ? <div className="mt-2 flex flex-wrap gap-1">{c.uses.map((u) => <Chip key={u} size="sm" className="font-normal">{u}</Chip>)}</div> : null}
        </div>

        <div className="mt-3 flex items-center gap-1.5">
          <Button data-testid="cron-run-now" variant="primary" size="sm" onClick={() => runCronNow(c.id)}><Play />{DETAIL.runNow}</Button>
          <Button data-testid="cron-edit" variant="ghost" size="sm" onClick={() => setEdit(true)}><Pencil />{DETAIL.edit}</Button>
          <span className="flex-1" />
          <label className="flex items-center gap-1.5 text-[12.5px] text-fg-2"><span data-testid="cron-pause-label">{c.paused ? DETAIL.paused : DETAIL.running}</span><Switch data-testid="cron-pause" checked={!c.paused} onCheckedChange={(v) => updateCron(c.id, { paused: !v })} /></label>
          <IconButton data-testid="cron-delete" label={DETAIL.delete} icon={<Trash2 />} className="text-fg-3 hover:bg-err-soft hover:text-err" onClick={() => setAsking(true)} />
        </div>
        {c.srcMsg && <Button variant="link" size="xs" onClick={() => jump(c.srcMsg!)} className="mt-2 h-auto gap-0.5 px-0 text-[12px] font-normal text-fg-3 hover:text-fg">{DETAIL.source}<ArrowUpRight className="!h-3 !w-3" /></Button>}
      </div>

      {hasNotices && <CronNotices c={c} conv={conv!} />}
      <CronRuns c={c} conv={conv} now={now} failed={failed} spaced={!hasNotices} />

      <CronEditor open={edit} init={c} onClose={() => setEdit(false)} onSave={(d) => { updateCron(c.id, d); setEdit(false) }} />
      <DeleteCronDialog c={c} open={asking} onClose={() => setAsking(false)} onConfirm={() => { setAsking(false); removeCron(c.id) }} />
    </div>
  )
}
