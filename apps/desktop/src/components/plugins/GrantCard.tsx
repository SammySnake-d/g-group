/* 输出渠道的六项预授权（需求 US12 第 5 条）。收件人对助手只读：只能在这里由你改。 */
import { useState } from 'react'
import { CONTENT_POLICIES, CONTENT_POLICY_LABEL, isInstalled, splitList, validateGrant, type OutboundGrant } from '@g-group/ui-core'
import type { PluginState } from '@/data'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { Field, Input, SelectMenu, Textarea } from '@/components/ui/field'
import { cn } from '@/lib/utils'
import { GRANT_DEFAULT_SOURCE } from './constants'
import { SideCard } from './layout'

type Status = { t: string; tone: 'warm' | 'err' | 'ok' }
const TONE: Record<Status['tone'], string> = { warm: 'text-warm', err: 'text-err', ok: 'text-ok' }

export function GrantCard({ s }: { s: PluginState }) {
  const { plugins, updatePlugin, revokePlugin, reauthPlugin, toast } = useApp()
  const m = s.manifest!
  const kind = m.id === 'g-group.webhook' ? 'url' : 'email'
  const g = s.grant ?? null
  const [edit, setEdit] = useState(false)
  const sourceOpts = [GRANT_DEFAULT_SOURCE, ...plugins.filter((p) => p.manifest?.category === 'source' && isInstalled(p)).map((p) => p.manifest!.name)]
  const blank: OutboundGrant = { commitment: '', sender: '', recipients: [], sources: [GRANT_DEFAULT_SOURCE], contentPolicy: 'summary', maxPerHour: 3, pluginVersion: m.version, revoked: false }
  const [d, setD] = useState<OutboundGrant>(g ?? blank)
  const [to, setTo] = useState((g?.recipients ?? []).join('\n'))
  const [errs, setErrs] = useState<string[]>([])
  const save = () => {
    const next = { ...d, recipients: splitList(to), pluginVersion: m.version, revoked: false }
    const e = validateGrant(next, kind)
    setErrs(e)
    if (e.length) return
    updatePlugin(s.id, { grant: next })
    setEdit(false)
    toast(`「${m.name}」的外发预授权已保存`)
  }
  const status: Status = !g ? { t: '还没授权，一封也发不出去', tone: 'warm' } : g.revoked ? { t: '授权失效，外发已阻断', tone: 'err' } : g.pluginVersion !== m.version ? { t: `插件已到 v${m.version}，要你重新确认`, tone: 'warm' } : { t: '有效', tone: 'ok' }
  const senderLabel = kind === 'email' ? '发件账号' : '发件身份'
  return (
    <SideCard title="外发预授权" testid="plg-grant">
      <div data-testid="plg-grant-status" className={cn('mb-2.5 text-[12.5px] font-medium', TONE[status.tone])}>{status.t}</div>
      {!edit && g && (
        <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-[12.5px]">
          <dt className="text-fg-3">给谁用</dt><dd>{g.commitment}</dd>
          <dt className="text-fg-3">{senderLabel}</dt><dd className="break-all">{g.sender}</dd>
          <dt className="text-fg-3">{kind === 'email' ? '收件人' : '目标地址'}</dt><dd className="break-all">{g.recipients.join('、')}</dd>
          <dt className="text-fg-3">数据源</dt><dd>{g.sources.join('、')}</dd>
          <dt className="text-fg-3">发什么</dt><dd>{CONTENT_POLICY_LABEL[g.contentPolicy]}</dd>
          <dt className="text-fg-3">频率</dt><dd className="tabular-nums">每小时最多 {g.maxPerHour} 次</dd>
        </dl>
      )}
      {edit && (
        <div className="space-y-2.5" data-testid="plg-grant-form">
          <Field label="给哪项承诺用"><Input size="sm" value={d.commitment} onChange={(e) => setD({ ...d, commitment: e.target.value })} placeholder="比如：每天 8 点日报" /></Field>
          <Field label={senderLabel}><Input size="sm" value={d.sender} onChange={(e) => setD({ ...d, sender: e.target.value })} placeholder={kind === 'email' ? 'me@team.com' : '签名密钥的名字'} /></Field>
          <Field label={kind === 'email' ? '收件白名单（一行一个）' : '目标地址（一行一个）'}><Textarea rows={2} value={to} onChange={(e) => setTo(e.target.value)} className="py-1.5 text-[13px]" /></Field>
          <Field label="能用哪些数据" group>
            <div className="flex flex-wrap gap-1.5">
              {sourceOpts.map((o) => {
                const on = d.sources.includes(o)
                return (
                  <Button key={o} aria-pressed={on} variant="outline" size="xs" onClick={() => setD({ ...d, sources: on ? d.sources.filter((x) => x !== o) : [...d.sources, o] })}
                    className={cn('font-normal shadow-none', on ? 'border-me/50 bg-me/10 text-fg hover:bg-me/15' : 'text-fg-2')}>{o}</Button>
                )
              })}
            </div>
          </Field>
          <Field label="发什么"><SelectMenu size="sm" value={d.contentPolicy} onChange={(v) => setD({ ...d, contentPolicy: v })} options={CONTENT_POLICIES.map((c) => ({ value: c, label: CONTENT_POLICY_LABEL[c] }))} /></Field>
          <Field label="每小时最多几次"><Input size="sm" type="number" min={1} max={60} value={d.maxPerHour} onChange={(e) => setD({ ...d, maxPerHour: Number(e.target.value) })} className="tabular-nums" /></Field>
          {errs.length > 0 && <ul data-testid="plg-grant-errors" role="alert" className="space-y-0.5 rounded-lg bg-err-soft px-2.5 py-2 text-[12px] text-err">{errs.map((e) => <li key={e}>{e}</li>)}</ul>}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {edit ? <>
          <Button data-testid="plg-grant-save" variant="primary" size="xs" onClick={save}>保存授权</Button>
          <Button variant="ghost" size="xs" onClick={() => { setEdit(false); setErrs([]) }}>取消</Button>
        </> : <>
          {g?.revoked ? <Button data-testid="plg-reauth" variant="danger-solid" size="xs" onClick={() => reauthPlugin(s.id)}>重新授权</Button>
            : g && g.pluginVersion !== m.version ? <Button data-testid="plg-grant-reconfirm" variant="primary" size="xs" onClick={() => updatePlugin(s.id, { grant: { ...g, pluginVersion: m.version } })}>确认沿用到 v{m.version}</Button> : null}
          <Button data-testid="plg-grant-edit" variant="outline" size="xs" onClick={() => { setD(g ?? blank); setTo((g?.recipients ?? []).join('\n')); setEdit(true) }}>{g ? '改' : '设置授权'}</Button>
          {g && !g.revoked && <Button data-testid="plg-revoke" variant="ghost" size="xs" title="原型里模拟你撤销授权 / OAuth 过期" className="text-fg-3" onClick={() => revokePlugin(s.id)}>模拟授权失效</Button>}
        </>}
      </div>
    </SideCard>
  )
}
