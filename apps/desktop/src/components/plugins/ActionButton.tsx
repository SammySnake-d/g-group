/* 一个插件此刻能做的那一件事:没装 → 安装;装着有新版 → 更新;正在装 / 卸 → 进度;装好了 → 状态。卡片里小号,详情页大号。 */
import type { MouseEvent } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import { PHASE_LABEL, type PluginManifest } from '@g-group/ui-core'
import type { PluginState } from '@/data'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PluginFlow } from './flow'
import { Spinner } from './tags'

export function ActionButton({ m, s, upd, flow, size = 'sm' }: { m: PluginManifest; s: PluginState | null; upd: boolean; flow: PluginFlow; size?: 'sm' | 'lg' }) {
  const phase = s?.phase ?? 'not_installed'
  const lg = size === 'lg'
  const stop = (f: () => void) => (e: MouseEvent) => { e.stopPropagation(); f() }
  if (phase === 'not_installed') {
    return lg
      ? <Button data-testid={`plg-install-${m.id}`} variant="brand" size="md" onClick={stop(() => flow.install(m))}>安装</Button>
      : <Button data-testid={`plg-install-${m.id}`} variant="secondary" size="xs" shape="pill" className="px-3.5 font-semibold" onClick={stop(() => flow.install(m))}>安装</Button>
  }
  if (phase === 'installing' || phase === 'uninstalling') {
    return <span data-testid={`plg-busy-${m.id}`} role="status" className={cn('inline-flex shrink-0 items-center gap-1.5 text-fg-2', lg ? 'text-[13.5px]' : 'text-[12.5px]')}><Spinner />{PHASE_LABEL[phase]}…</span>
  }
  if (upd) {
    return (
      <Button data-testid={`plg-update-${m.id}`} variant="outline" size={lg ? 'md' : 'xs'} onClick={stop(() => flow.update(m.id))}
        className="border-warm/40 bg-warm-soft text-warm shadow-none hover:border-warm/60 hover:bg-warm-soft">
        <RefreshCw />更新到 v{m.version}
      </Button>
    )
  }
  return <span data-testid={`plg-installed-${m.id}`} className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-fg-3"><Check className="h-3.5 w-3.5" />{phase === 'disabled' ? '已停用' : '已安装'}</span>
}
