/* 详情页左栏的几节:说明、提供的能力、权限、版本与更新日志。 */
import type { ReactNode } from 'react'
import { Check, ShieldAlert } from 'lucide-react'
import { commandUsage, type PluginManifest, type PluginPermission } from '@g-group/ui-core'
import type { PluginState } from '@/data'
import { useApp } from '@/ctx'
import { Chip } from '@/components/ui/chip'
import { cn } from '@/lib/utils'
import { COPY, COPY_LIVE } from './constants'
import { DetailSection } from './layout'
import { RiskBadge } from './tags'

const Note = ({ testid, children }: { testid?: string; children: ReactNode }) => (
  <p data-testid={testid} className="mt-3 flex gap-2.5 rounded-xl bg-hover px-3.5 py-3 text-[13px] leading-relaxed text-fg-2"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-fg-3" /><span>{children}</span></p>
)

export function About({ m }: { m: PluginManifest }) {
  /* 连着后端:外发前后端不核对预授权,不照演示的说法写「只能在说好的范围里发」 */
  const live = useApp((s) => s.backend.mode === 'connected')
  return (
    <DetailSection title="说明">
      <div className="max-w-[68ch] space-y-2 text-pretty text-[14px] leading-[1.7] text-fg">{m.description.split('\n').map((t) => <p key={t}>{t}</p>)}</div>
      {m.category === 'source' && <Note testid="plg-untrusted">{COPY.untrusted}{COPY.untrustedHow}</Note>}
      {m.category === 'outbound' && <Note testid="plg-outbound-note">{live ? COPY_LIVE.outbound : COPY.outbound}</Note>}
    </DetailSection>
  )
}

const Kind = ({ children }: { children: ReactNode }) => <span className="w-12 shrink-0 pt-px text-[11.5px] text-fg-3">{children}</span>

export function Capabilities({ m }: { m: PluginManifest }) {
  const { commands, panels, events } = m.contributes
  return (
    <DetailSection title="提供的能力" testid="plg-capabilities">
      <div className="divide-y divide-line rounded-2xl border border-line">
        {commands.map((c) => (
          <div key={c.name} data-testid={`plg-cmd-${c.name}`} className="px-4 py-3">
            <div className="flex min-w-0 items-center gap-2"><Kind>命令</Kind><code className="shrink-0 font-code text-[13px] font-medium text-fg">{commandUsage(c)}</code><span className="truncate text-[13px] text-fg-2">{c.title}</span></div>
            <div className="mt-1 pl-14 text-[12.5px] text-fg-2">{c.desc}</div>
            {c.args.length > 0 && <div className="mt-1 pl-14 text-[12px] text-fg-3">{c.args.map((a) => `${a.name}${a.required ? '' : '（可选）'}：${a.desc}`).join('；')}</div>}
          </div>
        ))}
        {panels.map((p) => (
          <div key={p.id} data-testid={`plg-panel-${p.id}`} className="flex items-start gap-2 px-4 py-3"><Kind>面板</Kind><div><div className="text-[13px] font-medium">{p.title}</div><div className="text-[12.5px] text-fg-2">{p.desc}</div></div></div>
        ))}
        {events.map((e) => (
          <div key={e.name} data-testid={`plg-event-${e.name}`} className="flex items-start gap-2 px-4 py-3"><Kind>事件</Kind><div><code className="font-code text-[12.5px]">{e.name}</code><div className="text-[12.5px] text-fg-2">{e.desc}</div></div></div>
        ))}
        {!commands.length && !panels.length && !events.length && <div className="px-4 py-3 text-[13px] text-fg-3">没有声明命令、面板或事件</div>}
      </div>
    </DetailSection>
  )
}

export function Permissions({ latest, installed, granted, pendingNew }: { latest: PluginManifest; installed: boolean; granted: Set<string>; pendingNew: PluginPermission[] }) {
  return (
    <DetailSection title="权限" sub={installed ? '你安装时逐条同意过；新版本多要的会再问你' : '安装时会逐条问你'} testid="plg-perms">
      <div className="space-y-2">
        {latest.permissions.map((p) => {
          const isNew = pendingNew.some((x) => x.scope === p.scope)
          return (
            <div key={p.scope} data-testid={`plg-perm-${p.scope}`} data-risk={p.risk} className={cn('flex items-center gap-3 rounded-xl border px-3.5 py-2.5', p.risk === 'high' ? 'border-err/35 bg-err-soft' : 'border-line')}>
              <RiskBadge r={p.risk} />
              <div className="min-w-0 flex-1"><div className="text-[13.5px]">{p.detail}</div><div className="truncate font-code text-[11.5px] text-fg-3">{p.scope}</div></div>
              {isNew ? <Chip tone="warm" variant="outline" className="shrink-0">v{latest.version} 新增 · 更新时问你</Chip>
                : installed && granted.has(p.scope) ? <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-fg-3"><Check className="h-3.5 w-3.5" />已同意</span> : null}
            </div>
          )
        })}
        {latest.permissions.length === 0 && <div className="text-[13px] text-fg-3">不需要任何权限</div>}
      </div>
    </DetailSection>
  )
}

export function Changelog({ latest, s, installed }: { latest: PluginManifest; s: PluginState | null; installed: boolean }) {
  return (
    <DetailSection title="版本与更新日志" testid="plg-changelog">
      <ol className="relative ml-1.5 border-l border-line pl-5">
        {latest.changelog.map((e) => {
          const mine = s?.manifest?.version === e.version
          return (
            <li key={e.version} className="relative pb-4 last:pb-0">
              <span aria-hidden className={cn('absolute -left-[25px] top-1.5 h-2 w-2 rounded-full ring-4 ring-bg', mine ? 'bg-me' : 'bg-fg-3/50')} />
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-code text-[13px] font-semibold">v{e.version}</span>
                <span className="text-[12px] tabular-nums text-fg-3">{e.date}</span>
                {e.version === latest.version && <Chip tone="neutral" size="xs">最新</Chip>}
                {installed && mine && <Chip tone="link" size="xs">你装的</Chip>}
              </div>
              <ul className="mt-0.5 text-[13px] text-fg-2">{e.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            </li>
          )
        })}
      </ol>
    </DetailSection>
  )
}
