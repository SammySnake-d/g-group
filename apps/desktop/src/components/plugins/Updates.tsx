/* 有更新:旧版本 → 新版本、这之间的更新日志;新版本多要的权限先摆出来,更新时再逐条同意。 */
import { RefreshCw } from 'lucide-react'
import { changesSince, marketList, permissionsToConsent } from '@g-group/ui-core'
import type { PluginState } from '@/data'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { COPY, COPY_LIVE } from './constants'
import type { PluginFlow } from './flow'
import { EmptyBox, PageHead } from './layout'
import { PluginIcon, RiskBadge } from './tags'

export function Updates({ flow, open }: { flow: PluginFlow; open: (id: string) => void }) {
  const { plugins, pluginCatalog } = useApp()
  const live = useApp((s) => s.backend.mode === 'connected')
  const items = marketList(pluginCatalog, plugins, { text: '', category: 'all', filter: 'updates', sort: 'name' })
  return (
    <div className="mx-auto max-w-[920px] px-8 pb-14 pt-7" data-testid="plg-updates">
      <PageHead title={COPY.updatesTitle} desc={live ? COPY_LIVE.updatesDesc : COPY.updatesDesc} />
      {items.length === 0 && <EmptyBox testid="plg-updates-empty">{COPY.updatesEmpty}</EmptyBox>}
      <div className="mt-6 space-y-3">
        {items.map((it) => {
          const s = it.install as PluginState
          const m = it.manifest
          const need = permissionsToConsent(s.granted, m.permissions)
          return (
            <div key={m.id} data-testid={`plg-upd-${m.id}`} className="rounded-2xl border border-line bg-elev p-4">
              <div className="flex items-center gap-3">
                <PluginIcon m={m} size={40} />
                <Button variant="ghost" size={null} onClick={() => open(m.id)} className="group -mx-1.5 h-auto min-w-0 flex-1 flex-col items-start gap-0 rounded-lg px-1.5 py-0.5 text-left text-fg hover:bg-transparent active:scale-100">
                  <span className="max-w-full truncate text-[14.5px] font-semibold underline-offset-4 group-hover:underline">{m.name}</span>
                  <span className="font-code text-[12px] font-normal text-fg-2">v{it.installedVersion} <span className="text-fg-3">→</span> <span className="font-semibold text-fg">v{m.version}</span></span>
                </Button>
                <Button data-testid={`plg-update-${m.id}`} variant="primary" onClick={() => flow.update(m.id)}><RefreshCw />{need.length ? '同意新权限并更新' : '更新'}</Button>
              </div>
              <ol className="mt-3 space-y-2 rounded-xl bg-hover/50 px-3.5 py-2.5">
                {changesSince(it.installedVersion ?? '0.0.0', m).map((e) => (
                  <li key={e.version} className="text-[13px]">
                    <div className="flex items-baseline gap-2"><span className="font-code text-[12px] font-semibold">v{e.version}</span><span className="text-[12px] tabular-nums text-fg-3">{e.date}</span></div>
                    <div className="text-pretty text-fg-2">{e.notes.join('；')}</div>
                  </li>
                ))}
              </ol>
              {need.length > 0 && (
                <div data-testid={`plg-upd-perms-${m.id}`} className="mt-3 rounded-xl border border-warm/30 bg-warm-soft px-3.5 py-2.5">
                  <div className="text-[12.5px] font-medium text-warm">新版本多要 <span className="tabular-nums">{need.length}</span> 项权限，更新时要你同意</div>
                  {need.map((p) => <div key={p.scope} className="mt-1.5 flex items-center gap-2 text-[12.5px] text-fg"><RiskBadge r={p.risk} className="bg-elev" />{p.detail}</div>)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
