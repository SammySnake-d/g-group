/** 群资料「定时」页签：只看本群（不把别的群混进来）。出错的排最前，暂停的最后 */
import { useState } from 'react'
import { AlarmClock, ArrowUpRight, Plus } from 'lucide-react'
import { localZoneLabel } from '@g-group/ui-core'
import { useApp } from '@/ctx'
import type { Conversation } from '@/data'
import { cronOrder, openCronOverview, useNow } from '@/cronView'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/section'
import { CronEditor } from './CronEditor'
import { CronRow } from './CronRow'
import { LIST } from './constants'

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
          <div className="text-[13px] font-semibold">{LIST.title} <span className="font-normal tabular-nums text-fg-3">{live}/{mine.length} {LIST.on}</span></div>
          <div data-testid="side-cron-zone" className="truncate text-[11.5px] text-fg-3">{LIST.zone}（{localZoneLabel(now)}）</div>
        </div>
        <Button data-testid="side-cron-add" variant="primary" size="sm" onClick={() => setAdding(true)} className="px-2.5"><Plus />{LIST.add}</Button>
      </div>
      {mine.length === 0 && (
        <EmptyState className="mx-2 rounded-xl border border-dashed border-line py-7" icon={<AlarmClock />} title={LIST.emptyTitle} hint={LIST.emptyHint} />
      )}
      <div className="space-y-0.5">{mine.map((c) => <CronRow key={c.id} c={c} now={now} />)}</div>
      <Button data-testid="side-cron-overview" variant="link" size="xs" onClick={() => openCronOverview(setPanoOpen)}
        className="mt-2 h-auto gap-0.5 px-2.5 text-[12px] font-normal text-fg-3 hover:text-fg">{LIST.overview}<ArrowUpRight className="!h-3 !w-3" /></Button>
      <CronEditor open={adding} conv={conv.id} onClose={() => setAdding(false)} onSave={(d) => { addCron(d, 'panel'); setAdding(false) }} />
    </section>
  )
}
