/* 群资料·插件：本群挂了哪些插件。启停对所有聊天生效（插件是装在这台电脑上的）；从本群摘下只影响这里。
   连上后端时读的是宿主里真实装好的插件(plugins.list):装好就对所有聊天生效,宿主没有「只挂到某个群」这一层,
   所以不放「添加 / 摘下」,只留启停和去插件市场。 */
import { useState } from 'react'
import { ChevronRight, Plus, Store, X } from 'lucide-react'
import { CATEGORY_LABEL, attachable, isInstalled } from '@g-group/ui-core'
import { useApp } from '@/ctx'
import type { Conversation } from '@/data'
import { PluginIcon } from '@/components/plugins/tags'
import { openPluginDetail } from '@/components/plugins/util'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { PLUGIN_TAB } from './constants'

const pickRow = 'h-auto w-full justify-start gap-2.5 rounded-lg px-2 py-1.5 text-left font-normal text-fg active:scale-100'

export function PluginTab({ conv }: { conv: Conversation }) {
  const { plugins, pluginAct, toast, setSection } = useApp()
  const live = useApp((s) => s.backend.mode === 'connected')
  const [picking, setPicking] = useState(false)
  const mine = plugins.filter((p) => isInstalled(p) && p.manifest && p.convs.includes(conv.id))
  const free = attachable(plugins, conv.id)
  const act = (id: string, a: Parameters<typeof pluginAct>[1]) => { const r = pluginAct(id, a); if (!r.ok) toast(r.error) }
  return (
    <section className="px-2 pb-2 pt-1" data-testid="side-plugins">
      <div className="mb-1 flex h-8 items-center px-2">
        <span className="flex-1 text-[13px] font-semibold">{PLUGIN_TAB.title} <span className="font-normal tabular-nums text-fg-3">{mine.length}</span></span>
        {live ? (
          <Button data-testid="side-plugin-market" variant="ghost" size="xs" className="-mr-1 gap-1 px-2" onClick={() => setSection('plugins')}><Store />{PLUGIN_TAB.market}</Button>
        ) : (
        <Popover open={picking} onOpenChange={setPicking}>
          <PopoverTrigger asChild>
            <Button data-testid="side-plugin-add" variant="ghost" size="xs" className="-mr-1 gap-1 px-2"><Plus />{PLUGIN_TAB.add}</Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[290px] rounded-xl border-line bg-elev p-1.5 shadow-elev" data-testid="side-plugin-picker">
            <div className="px-2 pb-1 pt-1 text-[11.5px] font-medium text-fg-3">{PLUGIN_TAB.pickerHead}</div>
            {free.length === 0 && <div className="px-2 py-2 text-[12.5px] text-fg-2">{PLUGIN_TAB.allAttached}</div>}
            {free.map((p) => (
              <Button key={p.id} data-testid={`side-plugin-pick-${p.id}`} variant="ghost" size={null} className={cn(pickRow, 'group')} onClick={() => { act(p.id, { type: 'attach', conv: conv.id }); setPicking(false) }}>
                <PluginIcon m={p.manifest!} size={28} />
                <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{p.manifest!.name}</span><span className="block truncate text-[11.5px] text-fg-3">{CATEGORY_LABEL[p.manifest!.category]}{p.phase === 'disabled' ? ' · 已停用' : ''}</span></span>
                <span className="text-[12px] font-medium text-me opacity-70 transition-opacity duration-fast group-hover:opacity-100">挂上</span>
              </Button>
            ))}
            <div className="mt-1 border-t border-line pt-1">
              <Button data-testid="side-plugin-market" variant="ghost" size={null} className={cn(pickRow, 'py-2 text-[12.5px] text-fg-2 hover:text-fg')} onClick={() => { setPicking(false); setSection('plugins') }}>
                <Store className="h-4 w-4" /><span className="flex-1">{PLUGIN_TAB.market}</span><ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        )}
      </div>
      {mine.length === 0 && <div className="mx-2 rounded-xl border border-dashed border-line px-3 py-5 text-center text-[12.5px] text-fg-2">{live ? PLUGIN_TAB.emptyLive : PLUGIN_TAB.empty}<br />{live ? PLUGIN_TAB.emptyLiveHint : PLUGIN_TAB.emptyHint}</div>}
      <div className="space-y-0.5">
        {mine.map((p) => {
          const m = p.manifest!
          const on = p.phase === 'enabled'
          return (
            <div key={p.id} data-testid={`side-plugin-${p.id}`} data-phase={p.phase} className="group flex items-center gap-2 rounded-xl px-2 py-1.5 transition-colors duration-fast hover:bg-hover">
              <span className={cn('transition-[opacity,filter] duration-base', !on && 'opacity-50 grayscale')}><PluginIcon m={m} size={32} /></span>
              <Button variant="ghost" size={null} title="看插件详情" onClick={() => openPluginDetail(setSection, p.id)} className="h-auto min-w-0 flex-1 flex-col items-stretch gap-0 rounded-md px-1 py-0.5 text-left font-normal text-fg hover:bg-transparent active:scale-100">
                <span className="flex min-w-0 items-center gap-1.5"><span className="truncate text-[13px] font-medium underline-offset-2 group-hover:underline">{m.name}</span><Chip size="xs" className="group-hover:bg-bg">{CATEGORY_LABEL[m.category]}</Chip></span>
                <span className={cn('block truncate text-[11.5px]', on ? 'text-fg-3' : 'text-warm')}>
                  {on ? (m.contributes.commands.map((c) => `/${c.name}`).join(' ') || m.contributes.panels.map((x) => `面板：${x.title}`).join(' ') || m.summary) : PLUGIN_TAB.disabled}
                </span>
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="grid h-7 place-items-center px-0.5"><Switch data-testid={`side-plugin-toggle-${p.id}`} aria-label={`启用「${m.name}」（对所有聊天生效）`} checked={on} onCheckedChange={(v) => act(p.id, { type: v ? 'enable' : 'disable' })} /></span>
                </TooltipTrigger>
                <TooltipContent>{on ? '停用（所有聊天）' : '启用（所有聊天）'}</TooltipContent>
              </Tooltip>
              {!live && <IconButton data-testid={`side-plugin-detach-${p.id}`} label={`把「${m.name}」从本群摘下`} size="icon-sm" icon={<X />} className="ml-1 text-fg-3 hover:bg-sel" onClick={() => act(p.id, { type: 'detach', conv: conv.id })} />}
            </div>
          )
        })}
      </div>
      {mine.length > 0 && <p className="px-2 pt-2 text-[11.5px] text-fg-3">{live ? PLUGIN_TAB.footLive : PLUGIN_TAB.foot}</p>}
    </section>
  )
}
