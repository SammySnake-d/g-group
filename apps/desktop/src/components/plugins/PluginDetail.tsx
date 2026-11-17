/* 插件详情:头部(图标、名字、发布者、版本、状态、能做的事)→ 左栏说明 / 能力 / 权限 / 日志 → 右栏在哪里生效、外发预授权、信息。 */
import { ArrowLeft, Trash2 } from 'lucide-react'
import { CATEGORY_LABEL, PHASE_LABEL, hasUpdate, isInstalled, permissionsToConsent } from '@g-group/ui-core'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { ActionButton } from './ActionButton'
import { COPY, COPY_LIVE } from './constants'
import { About, Capabilities, Changelog, Permissions } from './DetailSections'
import type { PluginFlow } from './flow'
import { GrantCard } from './GrantCard'
import { SideCard } from './layout'
import { CategoryTag, PluginIcon, Publisher } from './tags'
import { WhereCard } from './WhereCard'

export function PluginDetail({ id, flow, onBack, backLabel }: { id: string; flow: PluginFlow; onBack: () => void; backLabel: string }) {
  const { plugins, pluginCatalog, pluginAct, toast } = useApp()
  const live = useApp((st) => st.backend.mode === 'connected')
  const s = plugins.find((p) => p.id === id) ?? null
  const latest = pluginCatalog.find((m) => m.id === id) ?? s?.manifest ?? null
  if (!latest) return <div className="p-8 text-[13px] text-fg-2">没有这个插件。<Button variant="link" size={null} className="text-[13px]" onClick={onBack}>返回</Button></div>
  const installed = !!s && isInstalled(s)
  const m = installed && s?.manifest ? s.manifest : latest
  const upd = hasUpdate(s, latest)
  const granted = new Set(s?.granted.map((p) => p.scope) ?? [])
  const pendingNew = upd && s ? permissionsToConsent(s.granted, latest.permissions) : []
  const lastDate = latest.changelog[0]?.date
  const toggle = (v: boolean) => { const r = pluginAct(id, { type: v ? 'enable' : 'disable' }); if (!r.ok) toast(r.error) }
  return (
    <div className="mx-auto max-w-[1080px] px-8 pb-16 pt-5" data-testid={`plg-detail-${id}`}>
      <Button data-testid="plg-detail-back" variant="ghost" className="-ml-2 gap-1 px-2" onClick={onBack}><ArrowLeft />{backLabel}</Button>
      <header className="mt-3 flex items-start gap-5">
        <PluginIcon m={m} size={72} />
        <div className="min-w-0 flex-1">
          <h1 className="text-balance text-[24px] font-semibold leading-tight tracking-[-0.02em]">{m.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-fg-2">
            <Publisher name={m.publisher} />
            <span aria-hidden className="text-fg-3">·</span><CategoryTag c={m.category} />
            <span aria-hidden className="text-fg-3">·</span>
            <span data-testid="plg-detail-version" className="font-code text-[12.5px]">{installed ? `已装 v${m.version}` : `v${latest.version}`}</span>
            {upd && <Chip data-testid="plg-detail-has-update" tone="warm" size="md" className="h-5 px-2">有新版本 v{latest.version}</Chip>}
            {installed && !upd && <span className="text-[12px] text-fg-3">已是最新</span>}
            {s && <Chip data-testid="plg-detail-phase" tone={s.phase === 'enabled' ? 'ok' : 'neutral'} size="md" className="h-5 px-2">{PHASE_LABEL[s.phase]}</Chip>}
          </div>
          <p className="mt-2 max-w-[68ch] text-pretty text-[14px] text-fg-2">{m.summary}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          {installed && s ? <>
            <label className="flex items-center gap-2 rounded-lg px-2 text-[13px] text-fg-2">启用
              <Switch data-testid="plg-detail-toggle" aria-label={`启用「${m.name}」`} checked={s.phase === 'enabled'} onCheckedChange={toggle} />
            </label>
            {upd && <ActionButton m={latest} s={s} upd flow={flow} size="lg" />}
            <Button data-testid="plg-detail-uninstall" variant="outline" size="md" className="text-fg-2 shadow-none hover:border-err/40 hover:bg-err-soft hover:text-err" onClick={() => flow.uninstall(id)}><Trash2 />卸载</Button>
          </> : <ActionButton m={latest} s={s} upd={false} flow={flow} size="lg" />}
        </div>
      </header>

      <div className="mt-8 grid grid-cols-[minmax(0,1fr)_300px] gap-8">
        <div className="min-w-0 space-y-8">
          <About m={m} />
          <Capabilities m={m} />
          <Permissions latest={latest} installed={installed} granted={granted} pendingNew={pendingNew} />
          <Changelog latest={latest} s={s} installed={installed} />
        </div>
        <aside className="min-w-0 space-y-4">
          {installed && s ? <WhereCard s={s} /> : <SideCard title="在哪里生效"><p className="text-[13px] leading-relaxed text-fg-2">{live ? COPY_LIVE.where : COPY.whereEmpty}</p></SideCard>}
          {installed && s && m.category === 'outbound' && <GrantCard s={s} />}
          <SideCard title="信息">
            <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-y-1.5 text-[12.5px]">
              <dt className="text-fg-3">发布者</dt><dd className="truncate">{m.publisher}</dd>
              <dt className="text-fg-3">版本</dt><dd className="font-code">{installed ? `v${m.version}` : `v${latest.version}`}{upd && <span className="text-warm">（最新 v{latest.version}）</span>}</dd>
              {lastDate && <><dt className="text-fg-3">更新于</dt><dd className="tabular-nums">{lastDate}</dd></>}
              <dt className="text-fg-3">类别</dt><dd>{CATEGORY_LABEL[m.category]}</dd>
              {s?.cred && <><dt className="text-fg-3">凭据</dt><dd data-testid="plg-detail-cred" className={cn(s.cred.includes('失效') && 'text-err')}>{s.cred}</dd></>}
              <dt className="text-fg-3">id</dt><dd className="break-all font-code text-[11.5px] text-fg-2">{m.id}</dd>
            </dl>
          </SideCard>
        </aside>
      </div>
    </div>
  )
}
