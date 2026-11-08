/* 群资料分栏（#1651）：从标题栏的成员头像组 / 群资料按钮打开，和联系人详情共用右侧分栏位置；
   只有一层页签，每页占满分栏高度，不留空白（#1593）。页签用 Animate UI 的 Tabs：下划线滑到新页签、面板交接由库来做。 */
import { useState } from 'react'
import { isInstalled } from '@g-group/ui-core'
import * as Tabs from '@animate-ui/react/primitives/radix-ui/tabs'
import { useApp } from '@/ctx'
import type { Conversation } from '@/data'
import { cronFailed } from '@/cronView'
import { GroupCrons } from '@/components/CronList'
import { ChecklistTab } from './ChecklistTab'
import { GTABS, GTAB_LABEL, type GTab } from './constants'
import { MembersTab } from './MembersTab'
import { NoticeBlock } from './NoticeBlock'
import { noticesOf } from './notices'
import { PluginTab } from './PluginTab'
import { PulseTimeline } from './PulseTimeline'
import { ToolsTab } from './ToolsTab'

/** 记住每个群上次看的页签：从定时详情等别的分屏标签切回来，还停在原来那页 */
const lastTab: Record<string, GTab> = {}

export function GroupPane({ id, initial }: { id: string; initial?: GTab }) {
  const { convs } = useApp()
  const conv = convs.find((c) => c.id === id)
  if (!conv) return null
  return <GroupSide conv={conv} initial={initial} />
}

function GroupSide({ conv, initial }: { conv: Conversation; initial?: GTab }) {
  const { checklist, crons, plugins } = useApp()
  const [tab, setTabS] = useState<GTab>(initial ?? lastTab[conv.id] ?? 'members')
  const setTab = (k: GTab) => { lastTab[conv.id] = k; setTabS(k) }
  const items = checklist.filter((t) => t.conv === conv.id)
  const myCrons = crons.filter((c) => c.conv === conv.id)
  const myPlugins = plugins.filter((p) => isInstalled(p) && p.convs.includes(conv.id))
  const count: Record<GTab, string | undefined> = {
    members: `${conv.members.length}`,
    notice: `${noticesOf(conv).length}`,
    list: `${items.filter((t) => t.status === '已完成').length}/${items.length}`,
    cron: `${myCrons.length}`,
    plugin: `${myPlugins.length}`,
    tools: undefined,
  }
  const dot: Partial<Record<GTab, string | false>> = {
    list: items.some((t) => t.status === '待验收') && 'bg-warm-dot',
    cron: myCrons.some(cronFailed) && 'bg-err',
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="group-side">
      <Tabs.Root value={tab} onValueChange={(v) => setTab(v as GTab)} className="flex min-h-0 flex-1 flex-col" data-testid="side-tabs">
        <Tabs.List aria-label="群资料" className="no-scrollbar flex shrink-0 gap-0.5 overflow-x-auto border-b border-line px-3 pt-1">
          {GTABS.map((k) => (
            <Tabs.Trigger key={k} value={k} data-testid={`side-tab-${k}`}
              className="relative h-8 shrink-0 rounded-b-none rounded-t-md px-2.5 text-[12.5px] font-medium text-fg-2 outline-none transition-colors duration-fast ease-out hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=active]:text-fg data-[state=active]:shadow-[inset_0_-2px_0_hsl(var(--fg))]">
              {GTAB_LABEL[k]}{count[k] !== undefined && <> <span className="tabular-nums">{count[k]}</span></>}
              {dot[k] && <span aria-hidden className={`absolute right-0.5 top-1.5 h-1.5 w-1.5 rounded-full ${dot[k]}`} />}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="members" className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2 pt-1 outline-none"><MembersTab conv={conv} /></Tabs.Content>
        <Tabs.Content value="notice" className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2 pt-1 outline-none"><NoticeBlock conv={conv} /></Tabs.Content>
        <Tabs.Content value="list" className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2 pt-1 outline-none"><ChecklistTab conv={conv} /></Tabs.Content>
        <Tabs.Content value="cron" className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2 pt-1 outline-none"><GroupCrons conv={conv} /></Tabs.Content>
        <Tabs.Content value="plugin" className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2 pt-1 outline-none">
          <PluginTab conv={conv} />
          {myPlugins.some((p) => p.id === 'g-group.pulse' && p.phase === 'enabled') && <PulseTimeline conv={conv} />}
        </Tabs.Content>
        <Tabs.Content value="tools" className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2 pt-1 outline-none"><ToolsTab conv={conv} /></Tabs.Content>
      </Tabs.Root>
    </div>
  )
}
