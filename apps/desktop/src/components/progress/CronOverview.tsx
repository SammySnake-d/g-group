import { useState, type ReactNode } from 'react'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { formatRunAt } from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { people, type Conversation, type Cron } from '@/data'
import { useApp } from '@/ctx'
import { cronDay, cronExpr, cronFailed, cronLastText, cronNextAt, cronRule, cronWhen, useNow } from '@/cronView'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Segmented } from '@/components/ui/segmented'
import { ResultIcon } from '../CronList'
import { Avatar } from '../Avatar'

/*
  定时总览(AC-53):所有会话、所有联系人的定时,按今天 / 明天 / 本周 / 随时排,出错的置顶(#1858)。
  #806 把它移出了进展全景的看板;从「所有会话的定时」「看所有定时」这些入口打开遮罩时显示它(cronView.openCronOverview),看板另有其页。
*/

type Scope = 'all' | 'conv' | 'person'
const SCOPES: { value: Scope; label: string; testid: string }[] = [
  { value: 'all', label: '全部', testid: 'pano-cron-scope-all' },
  { value: 'conv', label: '按会话', testid: 'pano-cron-scope-conv' },
  { value: 'person', label: '按联系人', testid: 'pano-cron-scope-person' },
]
const DAYS = ['今天', '明天', '本周', '随时'] as const
const rowCls = 'h-auto w-full justify-start gap-2.5 rounded-md px-1.5 py-1.5 text-left text-[13px] font-normal'

const convLabel = (c: Conversation) => {
  if (c.kind === 'group') return c.title
  const peer = c.members.find((m) => m !== 'me')
  return `与 ${peer ? people[peer].name : c.title} 私聊`
}

/** 看绿:正常、同一时刻同一规则的折成一行「每天 08:00 ×3」,出错的永远单独一行(#1286) */
function foldRows(rows: Cron[], now: Date) {
  const key = (r: Cron) => `${cronWhen(r, now)}|${cronRule(r)}`
  const out: { rows: Cron[] }[] = []
  for (const r of rows) {
    const g = !cronFailed(r) && !r.paused ? out.find((x) => !cronFailed(x.rows[0]) && !x.rows[0].paused && key(x.rows[0]) === key(r)) : undefined
    if (g) g.rows.push(r); else out.push({ rows: [r] })
  }
  return out
}

function FoldedCron({ rows, render, now }: { rows: Cron[]; render: (r: Cron) => ReactNode; now: Date }) {
  const [open, setOpen] = useState(false)
  if (open) return <div>{rows.map((r) => render(r))}<Button variant="link" size="xs" className="text-fg-3" onClick={() => setOpen(false)}>收起</Button></div>
  return (
    <Button variant="ghost" size="sm" data-testid={`pano-cron-fold-${cronWhen(rows[0], now)}`} onClick={() => setOpen(true)} className={rowCls}>
      <span className="w-11 shrink-0 tabular-nums">{cronWhen(rows[0], now)}</span>
      <span className="flex -space-x-1">{rows.map((r) => <Avatar key={r.id} id={r.owner} size={18} status={false} mood="idle" />)}</span>
      <span className="flex-1">{cronRule(rows[0])} ×{rows.length} · 都正常</span>
      <ChevronRight className="text-fg-3" />
    </Button>
  )
}

function NowLine({ text }: { text: string }) {
  return <div data-testid="pano-now" className="my-1 flex items-center gap-2 text-[11.5px] font-medium text-err"><span className="h-1.5 w-1.5 rounded-full bg-err" />现在 {text}<span className="h-px flex-1 bg-err/50" /></div>
}

export function CronOverview() {
  const { crons, convs, openSplit, setPanoOpen } = useApp()
  const [scope, setScope] = useState<Scope>('all')
  const now = useNow()
  const nowText = now.toTimeString().slice(0, 5)
  const at = (r: Cron) => cronNextAt(r, now)?.getTime() ?? Number.MAX_SAFE_INTEGER
  const days = DAYS.map((d) => ({ d, items: crons.filter((r) => cronDay(r, now) === d && !cronFailed(r)).sort((a, b) => at(a) - at(b)) })).filter((x) => x.items.length)
  const label = (cid: string) => { const c = convs.find((x) => x.id === cid); return c ? convLabel(c) : cid }
  const groupKey = (r: Cron) => (scope === 'person' ? people[r.owner].name : scope === 'conv' ? label(r.conv) : '')
  const open = (r: Cron) => { setPanoOpen(false); openSplit({ t: 'cron', id: r.id }) }
  const failed = crons.filter(cronFailed)
  const Row = (r: Cron) => {
    const expr = cronExpr(r)
    return (
      <Button key={r.id} variant="ghost" size="sm" onClick={() => open(r)} data-testid={`pano-cron-${r.id}`} className={cn(rowCls, r.paused && 'opacity-55')}>
        <span className="w-11 shrink-0 tabular-nums text-fg-2">{cronWhen(r, now)}</span>
        <Avatar id={r.owner} size={18} status={false} mood="idle" />
        <span className="min-w-0 flex-1 truncate text-fg">{r.text}</span>
        <span className="shrink-0 text-[12px] text-fg-2">{cronRule(r)}</span>
        {expr && <code className="font-code shrink-0 rounded bg-hover px-1.5 py-px text-[11px] text-fg-3">{expr}</code>}
        <Chip tone="neutral" size="sm">{label(r.conv)}</Chip>
        <span className="flex w-[190px] shrink-0 items-center justify-end gap-1 truncate text-right text-[12px] text-fg-3"><ResultIcon r={r.runs[0]?.result} /><span className="truncate">{cronLastText(r, now)}</span></span>
      </Button>
    )
  }
  return (
    <section data-testid="pano-cron" aria-label="定时总览" className="scroll-thin min-w-0 flex-1 overflow-y-auto">
      <div className="px-6 pb-8 pt-4">
        <div className="flex min-h-8 items-center gap-3 pr-10">
          <h2 className="text-[16px] font-semibold tracking-tight">定时总览</h2>
          <span className="min-w-0 truncate text-[12px] text-fg-2">所有会话 · 今天 / 明天 / 本周 / 随时 · 每条是某个联系人自己的闹钟 · 按本地时间</span>
        </div>
        <Segmented className="mt-3" size="xs" ariaLabel="分组" value={scope} onChange={setScope} options={SCOPES} />
        {days.length === 0 && failed.length === 0 && <div className="py-4 text-[13px] text-fg-3">还没有定时</div>}
        {failed.length > 0 && (
          <div data-testid="pano-cron-errors" className="mt-3 rounded-lg bg-err-soft/50 px-2 py-1">
            <div className="py-0.5 text-[12px] font-medium text-err">要处理 {failed.length}</div>
            {failed.map((r) => (
              <Button key={'e' + r.id} variant="ghost" size="sm" data-testid={`pano-cron-err-${r.id}`} onClick={() => open(r)} className={rowCls}>
                <span className="w-11 shrink-0 tabular-nums text-fg-2">{cronWhen(r, now)}</span><Avatar id={r.owner} size={18} status={false} mood="idle" />
                <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-err"><AlertTriangle className="size-3" />{r.text}</span>
                <Chip tone="neutral" size="sm">{label(r.conv)}</Chip>
                <span className="shrink-0 text-[12px] text-err">{r.runs[0] ? `${formatRunAt(new Date(r.runs[0].at), now)} ${r.runs[0].note}` : ''}</span>
              </Button>
            ))}
          </div>
        )}
        {days.map(({ d, items }) => {
          const keys = Array.from(new Set(items.map(groupKey)))
          return (
            <div key={d} className="mt-3">
              <div className="mb-1 text-[12px] font-medium text-fg-2">{d}</div>
              {keys.map((k) => {
                const rows = items.filter((r) => groupKey(r) === k)
                const cut = d === '今天' ? rows.findIndex((r) => at(r) > now.getTime()) : -1
                return (
                  <div key={k || 'all'} className={cn(k && 'mb-2')}>
                    {k && <div className="py-1 text-[11.5px] text-fg-3">{k}</div>}
                    {foldRows(rows, now).map((g) => (
                      <div key={g.rows[0].id}>
                        {rows.indexOf(g.rows[0]) === cut && <NowLine text={nowText} />}
                        {g.rows.length > 1 ? <FoldedCron rows={g.rows} render={Row} now={now} /> : Row(g.rows[0])}
                      </div>
                    ))}
                    {d === '今天' && cut === -1 && <NowLine text={nowText} />}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </section>
  )
}
