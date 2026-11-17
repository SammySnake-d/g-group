/* 已安装:每行写清挂在哪、谁能调用;就地启停、更新、卸载(卸载走二次确认)。装着的,加上正在装 / 正在卸的(让你看到进度)。
   连着后端时:插件对所有聊天生效(后端不分会话挂载、没有调用者名单),每行只写这一句。 */
import { Trash2 } from 'lucide-react'
import { PHASE_LABEL, marketList } from '@g-group/ui-core'
import type { PluginState } from '@/data'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { IconButton } from '@/components/ui/icon-button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { ActionButton } from './ActionButton'
import { COPY, COPY_LIVE } from './constants'
import type { PluginFlow } from './flow'
import { EmptyBox, PageHead } from './layout'
import { CategoryTag, PluginIcon, Spinner } from './tags'
import { convName, personName } from './util'

export function Installed({ flow, open, onDiscover }: { flow: PluginFlow; open: (id: string) => void; onDiscover: () => void }) {
  const { plugins, pluginCatalog, convs, pluginAct, toast } = useApp()
  const live = useApp((s) => s.backend.mode === 'connected')
  const items = marketList(pluginCatalog, plugins, { text: '', category: 'all', filter: 'all', sort: 'name' }).filter((it) => it.install && it.install.phase !== 'not_installed')
  return (
    <div className="mx-auto max-w-[920px] px-8 pb-14 pt-7" data-testid="plg-installed">
      <PageHead title={COPY.installedTitle} desc={live ? COPY_LIVE.installedDesc : COPY.installedDesc} />
      {items.length === 0 ? (
        live ? <EmptyBox testid="plg-installed-empty">{COPY_LIVE.installedEmpty}</EmptyBox>
          : <EmptyBox>{COPY.installedEmpty}<Button variant="link" size={null} className="text-[13px]" onClick={onDiscover}>去发现</Button></EmptyBox>
      ) : (
        <div className="mt-6 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-elev">
          {items.map((it) => {
            const s = it.install as PluginState
            const m = s.manifest ?? it.manifest
            const busy = s.phase === 'uninstalling' || s.phase === 'installing'
            const on = s.phase === 'enabled'
            return (
              <div key={m.id} role="button" tabIndex={0} data-testid={`plg-row-${m.id}`} data-phase={s.phase} onClick={() => open(m.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(m.id) }}
                className="flex cursor-pointer items-center gap-3.5 px-4 py-3.5 outline-none transition-colors duration-fast ease-out hover:bg-hover/60 focus-visible:bg-hover/60">
                <span className={cn('transition-[opacity,filter] duration-base', s.phase === 'disabled' && 'opacity-50 grayscale')}><PluginIcon m={m} size={40} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={cn('truncate text-[14.5px] font-semibold', s.phase === 'disabled' && 'text-fg-2')}>{m.name}</span>
                    <span className="shrink-0 font-code text-[11.5px] text-fg-3">v{m.version}</span>
                    <CategoryTag c={m.category} />
                    {s.phase === 'disabled' && <Chip data-testid={`plg-disabled-${m.id}`} tone="neutral" variant="outline">已停用</Chip>}
                  </div>
                  {live ? <div data-testid={`plg-row-where-${m.id}`} className="mt-0.5 truncate text-[12.5px] text-fg-2">{COPY_LIVE.rowWhere}</div> : (
                  <div className="mt-0.5 truncate text-[12.5px] text-fg-2">
                    {s.convs.length ? <>挂在 {s.convs.map((c) => convName(convs, c)).join('、')}</> : <span className="text-warm">还没挂到聊天，现在不生效</span>}
                    <span className="text-fg-3"> · {s.callers.length ? `${s.callers.map(personName).join('、')} 能调用` : '还没有助手能调用'}</span>
                  </div>
                  )}
                </div>
                {busy ? <span role="status" className="inline-flex shrink-0 items-center gap-1.5 text-[12.5px] text-fg-2"><Spinner />{PHASE_LABEL[s.phase]}…</span> : <>
                  {it.hasUpdate && <ActionButton m={it.manifest} s={s} upd flow={flow} />}
                  <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="flex shrink-0 items-center gap-2 pl-1">
                    <span className="w-[28px] text-right text-[12px] text-fg-3">{on ? '启用' : '停用'}</span>
                    <Switch data-testid={`plg-toggle-${m.id}`} aria-label={`启用「${m.name}」`} checked={on} onCheckedChange={(v) => { const r = pluginAct(m.id, { type: v ? 'enable' : 'disable' }); if (!r.ok) toast(r.error) }} />
                  </span>
                  {/* 卸载是危险操作:和常用的启停开关隔开一道,不挨着 */}
                  <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />
                  <IconButton data-testid={`plg-uninstall-${m.id}`} label={`卸载「${m.name}」`} icon={<Trash2 />} className="text-fg-3 hover:bg-err-soft hover:text-err"
                    onClick={(e) => { e.stopPropagation(); flow.uninstall(m.id) }} />
                </>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
