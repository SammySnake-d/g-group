import { Settings } from 'lucide-react'
import type { BackendState } from '@/api/backend'
import { Avatar, Bot } from '@/components/Avatar'
import { Chip } from '@/components/ui/chip'
import { IconButton } from '@/components/ui/icon-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HELPER_MARK } from '@/config/brand'
import { NAV_ITEMS, type NavKey } from '@/config/nav'
import type { Section } from '@/ctx'
import { cn } from '@/lib/utils'

/* 左侧导航:和页面同一张纸,只深一层(第二层中性色);当前位置 = 选中底色 + 柿红竖标。
   #929:之前的深墨竖条和浅色页面割裂。 */
export function Rail({ section, panoOpen, badge, running, helperOpen, backend, onSection, onPano, onHelper, onSettings }: {
  section: Section
  panoOpen: boolean
  badge: number
  running: boolean
  helperOpen: boolean
  backend: BackendState
  onSection: (s: Section) => void
  onPano: () => void
  onHelper: () => void
  onSettings: () => void
}) {
  const on = (k: NavKey) => (k === 'activity' ? panoOpen : section === k && !panoOpen)
  return (
    <nav aria-label="主导航" data-testid="rail" className="flex w-[64px] shrink-0 flex-col items-center gap-1 border-r border-line bg-rail pb-3 pt-10">
      <div data-testid="brand-mark" title="g-group" className="mb-3 grid h-9 w-9 select-none place-items-center rounded-[10px] bg-brand text-[17px] font-black italic leading-none tracking-tight text-brand-fg shadow-soft ring-1 ring-inset ring-black/10">g</div>
      {NAV_ITEMS.map((it) => (
        <div key={it.key} className="relative">
          {on(it.key) && <span aria-hidden className="absolute -left-[12px] top-2 h-6 w-[3px] rounded-r bg-brand" />}
          <IconButton data-testid={`nav-${it.key}`} data-on={on(it.key) ? '1' : '0'} label={it.label} side="right" size="icon-lg" active={on(it.key)}
            icon={<it.icon strokeWidth={on(it.key) ? 2 : 1.75} />}
            onClick={() => (it.key === 'activity' ? onPano() : onSection(it.key))}
            badge={it.signal === 'badge' && badge > 0 ? <span className="absolute -right-0.5 -top-0.5 grid h-[17px] min-w-[17px] place-items-center rounded-full border-2 border-rail bg-brand px-1 text-[10px] font-semibold tabular-nums text-brand-fg">{badge}</span>
              : it.signal === 'dot' && running ? <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full border-2 border-rail bg-run" /> : undefined} />
        </div>
      ))}
      <div className="flex-1" />
      <IconButton data-testid="nav-helper" label="Helper（全局 · ⌘K）：默认不读任何聊天" side="right" size="icon-lg" active={helperOpen} onClick={onHelper} icon={<Bot shape={HELPER_MARK.shape} color={HELPER_MARK.color} size={26} />} />
      {/* 界面数据还是演示数据时一直标「演示」;后端连上了也如实说明界面还没接真实数据(真实数据层接好后再去掉) */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Chip data-testid="backend-demo" data-mode={backend.mode} variant="outline" size="xs" tabIndex={0} className="my-1 cursor-default">演示</Chip>
        </TooltipTrigger>
        <TooltipContent side="right">{backend.mode === 'checking' ? '正在连接后端…' : backend.mode === 'connected' ? '后端已连接；界面还没接真实数据，这里仍是演示数据' : `后端未连接（${backend.reason}），界面里是演示数据`}</TooltipContent>
      </Tooltip>
      <IconButton data-testid="nav-settings" label="设置" side="right" size="icon-lg" onClick={onSettings} icon={<Settings strokeWidth={1.75} />} />
      <div className={cn('mt-1 rounded-full ring-2 ring-rail-hover')} style={{ ['--avatar-ring' as string]: 'var(--rail)' }}><Avatar id="me" size={30} /></div>
    </nav>
  )
}
