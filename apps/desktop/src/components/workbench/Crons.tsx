import { useState } from 'react'
import { Clock, Plus } from 'lucide-react'
import { localZoneLabel } from '@g-group/ui-core'
import { people, type Cron, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { cronOrder, openCronOverview, useNow } from '@/cronView'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/section'
import { GroupAvatar } from '../Avatar'
import { CronEditor } from '../CronEditor'
import { CronRow, convName } from '../CronList'
import { TextLink, WbCard } from './parts'

/* 定时:它在各个会话的全部定时,按会话分组(AC-53 联系人视角);点一行在右边看详情 */
export function Crons({ id }: { id: PersonId }) {
  const { crons, convs, openConv, addCron, setPanoOpen } = useApp()
  const now = useNow()
  const [adding, setAdding] = useState(false)
  const mine = crons.filter((c) => c.owner === id).sort(cronOrder(now))
  const byConv = new Map<string, Cron[]>()
  for (const c of mine) byConv.set(c.conv, [...(byConv.get(c.conv) ?? []), c])
  const add = (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-fg-2">{people[id].name} 在各个会话里的全部定时。点一行在右边看详情、改、看每次醒来做了什么</div>
        <div data-testid="wb-cron-zone" className="text-[11.5px] text-fg-3">按本地时间（{localZoneLabel(now)}）· <TextLink className="text-[11.5px]" onClick={() => openCronOverview(setPanoOpen)}>所有人的定时在「进展」里看</TextLink></div>
      </div>
      <Button data-testid="wb-cron-add" variant="primary" size="sm" onClick={() => setAdding(true)}><Plus />新建定时</Button>
    </div>
  )
  const editor = <CronEditor open={adding} owner={id} onClose={() => setAdding(false)} onSave={(d) => { addCron(d, 'panel'); setAdding(false) }} />
  if (!mine.length)
    return (
      <div data-testid="wb-cron" className="space-y-3">
        {add}{editor}
        <WbCard className="p-0"><EmptyState icon={<Clock />} title="它还没有定时任务。" hint="在聊天里跟它说「每天 8 点…」，或点「新建定时」" /></WbCard>
      </div>
    )
  return (
    <div data-testid="wb-cron" className="space-y-4">
      {add}{editor}
      {[...byConv.entries()].map(([cid, list]) => {
        const conv = convs.find((c) => c.id === cid)
        return (
          <WbCard key={cid} testid={`wb-cron-group-${cid}`} className="px-2 pb-2 pt-3">
            <div className="mb-1 flex min-h-7 items-center gap-2 px-2.5">
              {conv?.kind === 'group' ? <GroupAvatar ids={conv.members} size={22} /> : null}
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{convName(conv, cid)}</span>
              <span className="text-[12px] tabular-nums text-fg-3">{list.length} 个</span>
              <TextLink onClick={() => openConv(cid)}>打开会话</TextLink>
            </div>
            <div className="space-y-0.5">{list.map((c) => <CronRow key={c.id} c={c} now={now} showOwner={false} />)}</div>
          </WbCard>
        )
      })}
    </div>
  )
}
