import { AlertTriangle, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, dutyDefault, type PersonId } from '@/data'
import { useApp, type WbTab } from '@/ctx'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabList, TabPanel } from '@/components/pages/kit/tabs'
import { Avatar, useLive } from '../Avatar'
import { WB_TABS } from './constants'
import { Crons } from './Crons'
import { Duty } from './Duty'
import { Memory } from './Memory'
import { Overview } from './Overview'
import { ProcessView } from './ProcessView'
import { Settings } from './Settings'
import { workbenchStatus, type WbStatus } from './status'

/* ============ 联系人工作台(主面板):头像 + 名字 + 状态 + 两个按钮,下面一排页签 ============ */
const TAB_ITEMS = WB_TABS.map((t) => ({ ...t, testid: `wb-tab-${t.value}` }))
const column = 'mx-auto w-full max-w-[1080px]'
const panel = cn(column, 'space-y-4 px-5 py-5')

const toneCls: Record<WbStatus['tone'], string> = { err: 'text-err', warm: 'font-semibold text-warm', run: 'text-run', idle: 'text-fg-3' }
function StatusIcon({ tone }: { tone: WbStatus['tone'] }) {
  if (tone === 'err') return <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
  if (tone === 'warm') return <span className="h-2 w-2 shrink-0 rounded-full bg-warm-dot" />
  if (tone === 'run') return <Spinner />
  return null
}

export function Workbench({ id, tab, onTab }: { id: PersonId; tab: WbTab; onTab: (t: WbTab) => void }) {
  const { openDm, computes } = useApp()
  const p = people[id]
  const live = useLive(id)
  if (!p) return <main data-testid={`workbench-${id}`} className="grid flex-1 place-items-center text-[13px] text-fg-3">在左侧选一个联系人</main>
  const status = workbenchStatus(live, Object.values(computes).filter((c) => c.owner === id))
  return (
    <main data-testid={`workbench-${id}`} className="flex min-w-0 flex-1 flex-col overflow-hidden bg-bg">
      <Tabs value={tab} onValueChange={onTab} className="flex min-h-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-line">
          <div className={cn(column, 'px-5 pt-6')}>
            <div className="flex items-center gap-4">
              <Avatar id={id} size={64} follow status={false} />
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[20px] font-semibold tracking-tight">{p.name}</h1>
                <div className="mt-0.5 truncate text-[13px] text-fg-2">{dutyDefault[id] ?? p.role}</div>
                {!p.human && (
                  <div data-testid="wb-status" className={cn('mt-1 flex items-center gap-1.5 text-[12.5px]', toneCls[status.tone])}>
                    <StatusIcon tone={status.tone} /><span className="truncate">{status.text}</span>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {!p.human && <Button data-testid="wb-dm" variant="primary" size="sm" shape="pill" onClick={() => openDm(id)}><MessageSquare className="!size-3.5" />发消息</Button>}
                <Button data-testid="wb-open-process" variant="secondary" size="sm" shape="pill" onClick={() => onTab('process')}>看完整过程</Button>
              </div>
            </div>
            <TabList items={TAB_ITEMS} label={`${p.name} 的工作台`} className="mt-5" />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TabPanel value="process" className={cn(column, 'h-full')}><ProcessView id={id} /></TabPanel>
          <TabPanel value="overview" className={panel}><Overview id={id} /></TabPanel>
          <TabPanel value="duty" className={panel}><Duty id={id} /></TabPanel>
          <TabPanel value="memory" className={panel}><Memory id={id} /></TabPanel>
          <TabPanel value="cron" className={panel}><Crons id={id} /></TabPanel>
          <TabPanel value="settings" className={panel}><Settings id={id} /></TabPanel>
        </div>
      </Tabs>
    </main>
  )
}
