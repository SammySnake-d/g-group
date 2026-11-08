import * as TabsPrimitive from '@animate-ui/react/primitives/radix-ui/tabs'
import { motion, useReducedMotion } from 'motion/react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, artifacts, type Compute } from '@/data'
import { useApp, type SplitTab } from '@/ctx'
import { paneIn, panelReduced } from '@/components/pages/kit/motion'
import { IconButton } from '@/components/ui/icon-button'
import { ContactPane } from '@/components/Workbench'
import { GroupPane } from '@/components/GroupSide'
import { CronDetail } from '@/components/CronDetail'
import { ComputeWork } from './ComputeWork'
import { ArtifactView } from './ArtifactView'

/* ============ 右侧分屏工作区:工件 / Compute / 联系人 / 群资料 / 定时用页签切换,聊天让出位置 ============
   Animate UI 的 Radix Tabs 负责多页时的 role=tab、←→ 切页;只开一页时不画页签,直接是标题 + 关闭
   (#719:群资料上面再套一层页签,两层页签叠在一起莫名其妙)。 */

const tabLabel = (t: SplitTab, computes: Record<string, Compute>) =>
  t.t === 'compute' ? computes[t.id]?.title : t.t === 'contact' ? people[t.id]?.name : t.t === 'group' ? '群资料' : t.t === 'cron' ? '定时' : artifacts.find((a) => a.id === t.id)?.name

export function SplitPane({ tabs, active, onPick, onClose, onCloseAll, width }: { tabs: SplitTab[]; active: number; onPick: (i: number) => void; onClose: (i: number) => void; onCloseAll: () => void; width?: number }) {
  const { computes } = useApp()
  const reduced = useReducedMotion()
  const tab = tabs[active]
  const many = tabs.length > 1
  return (
    <motion.section
      initial={(reduced ? panelReduced : paneIn).initial}
      animate={(reduced ? panelReduced : paneIn).animate}
      className="flex h-full shrink-0 flex-col border-l border-line bg-bg"
      style={{ width: width ?? 400 }}
      data-testid="split"
    >
      <TabsPrimitive.Root value={String(active)} onValueChange={(v) => onPick(Number(v))} className="flex min-h-0 flex-1 flex-col">
        <div className={cn('flex h-[52px] shrink-0 items-center gap-1 border-b border-line pr-2', many ? 'pl-2' : 'pl-4')}>
          <TabsPrimitive.List aria-label="分屏里打开的页" role={many ? 'tablist' : undefined} className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" data-testid="split-tabs" data-count={tabs.length}>
            {tabs.map((t, i) => {
              const label = tabLabel(t, computes)
              if (tabs.length === 1) return <div key={t.t + t.id} data-testid={`split-tab-${t.t}-${t.id}`} className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em]">{label}</div>
              return (
                <div key={t.t + t.id} data-testid={`split-tab-${t.t}-${t.id}`} className={cn('group/t flex h-8 min-w-0 max-w-[200px] shrink-0 items-center rounded-lg border pr-0.5 text-[12.5px] transition-[background-color,border-color,color,box-shadow] duration-fast ease-out', i === active ? 'border-line bg-elev font-medium text-fg shadow-soft' : 'border-transparent text-fg-2 hover:bg-hover hover:text-fg')}>
                  <TabsPrimitive.Trigger value={String(i)} className="flex h-full min-w-0 flex-1 items-center rounded-l-lg pl-2.5 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60">
                    <span className="truncate">{label}</span>
                  </TabsPrimitive.Trigger>
                  <IconButton label={`关闭「${label ?? ''}」`} tooltip={false} size="icon-xs" icon={<X />} onClick={() => onClose(i)} className="h-5 w-5 rounded text-fg-3 opacity-0 hover:bg-sel hover:text-fg focus-visible:opacity-100 group-hover/t:opacity-100" />
                </div>
              )
            })}
          </TabsPrimitive.List>
          <IconButton data-testid="split-close" label="关闭分屏（Esc）" icon={<X />} onClick={onCloseAll} />
        </div>
        <TabsPrimitive.Content value={String(active)} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
          {tab?.t === 'compute' && <ComputeWork key={tab.id} id={tab.id} initial={tab.view} />}
          {tab?.t === 'artifact' && <ArtifactView key={tab.id} id={tab.id} />}
          {tab?.t === 'cron' && <CronDetail key={tab.id} id={tab.id} />}
          {tab?.t === 'group' && <GroupPane key={tab.id + (tab.tab ?? '')} id={tab.id} initial={tab.tab} />}
          {tab?.t === 'contact' && <ContactPane key={tab.id + (tab.tab ?? '')} id={tab.id} conv={tab.conv} initial={tab.tab} />}
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>
    </motion.section>
  )
}
