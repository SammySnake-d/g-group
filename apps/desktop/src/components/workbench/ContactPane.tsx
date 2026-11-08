import { useState } from 'react'
import { people, dutyByConv, dutyDefault, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { Tabs, TabList, TabPanel } from '@/components/pages/kit/tabs'
import { Avatar } from '../Avatar'
import { DetailPage } from '../Overlays'
import { paneTabs, type PaneTab } from './constants'
import { DoingRow } from './DoingRow'
import { Duty } from './Duty'
import { Memory } from './Memory'
import { ProcessView } from './ProcessView'

/* 右侧分栏里的联系人详情(#1620):不遮挡聊天,和 Compute 分栏同一套缝隙与标签。
   从群里打开:默认看「在本群」——本群分工、在本群做的事、它在本群的完整过程;
   想管理全部(记忆、定时、设置)再点「去工作台」,在主面板展开。 */
export function ContactPane({ id, conv, initial }: { id: PersonId; conv?: string; initial?: PaneTab }) {
  const { convs, openDm, mention, openWorkbench, computes } = useApp()
  const p = people[id]
  const [tab, setTab] = useState<PaneTab>(initial ?? 'here')
  if (!p) return null
  const c = convs.find((x) => x.id === conv)
  const inGroup = c?.kind === 'group'
  const here = Object.values(computes).filter((x) => x.owner === id && (!conv || x.conv === conv))
  const duty = inGroup && dutyByConv[conv!]?.[id] ? `在「${c!.title}」：${dutyByConv[conv!][id]}` : dutyDefault[id] ?? p.role
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
      <div data-testid={`contact-pane-${id}`} className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-4 pt-3">
          <div className="flex items-center gap-3">
            <Avatar id={id} size={44} status={false} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold">{p.name}</div>
              <div className="truncate text-[12px] text-fg-2">{duty}</div>
            </div>
          </div>
          <div className="mt-2.5 flex gap-1.5">
            <Button data-testid="cp-dm" variant="primary" size="xs" shape="pill" onClick={() => openDm(id)}>私聊</Button>
            {inGroup && <Button data-testid="cp-at" variant="secondary" size="xs" shape="pill" onClick={() => mention(id)}>@它</Button>}
            <Button data-testid="cp-workbench" variant="ghost" size="xs" shape="pill" onClick={() => openWorkbench(id)}>去工作台 ›</Button>
          </div>
          <div className="-mx-1 mt-2 border-b border-line">
            <TabList size="sm" label={`${p.name} 的详情`} items={paneTabs(inGroup).map((t) => ({ ...t, testid: `cp-tab-${t.value}` }))} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TabPanel value="process"><ProcessView id={id} conv={inGroup ? conv : undefined} /></TabPanel>
          <TabPanel value="talks"><DetailPage id={id} conv={conv ?? ''} tab="agents" bare /></TabPanel>
          <TabPanel value="here" className="space-y-3 px-4 py-3 text-[13px]">
            {here.length === 0 && <div className="py-6 text-center text-fg-3">{inGroup ? '它在本群还没开过 Compute' : '还没开过 Compute'}</div>}
            {here.map((x) => <DoingRow key={x.id} c={x} conv={convs.find((y) => y.id === x.conv)} link={null} />)}
          </TabPanel>
          <TabPanel value="duty" className="space-y-3 px-4 py-3 text-[13px]"><Duty id={id} /></TabPanel>
          <TabPanel value="memory" className="space-y-3 px-4 py-3 text-[13px]"><Memory id={id} /></TabPanel>
        </div>
      </div>
    </Tabs>
  )
}
