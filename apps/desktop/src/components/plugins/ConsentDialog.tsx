/* 安装 / 更新前的权限同意:逐条看过、逐条勾选,全部勾上才能确认(更新只列新版本多要的那几项)。 */
import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { PluginManifest, PluginPermission } from '@g-group/ui-core'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Modal, ModalBody, ModalFooter, useExitValue } from '@/components/ui/modal'
import { cn } from '@/lib/utils'
import { COPY } from './constants'
import { PluginIcon, RiskBadge } from './tags'

export type Consent = { mode: 'install' | 'update'; manifest: PluginManifest; perms: PluginPermission[]; from?: string }

export function ConsentDialog({ c: live, onCancel, onConfirm }: { c: Consent | null; onCancel: () => void; onConfirm: (scopes: string[]) => void }) {
  const c = useExitValue(live)
  if (!c) return null
  const m = c.manifest
  return (
    <Modal open={!!live} onClose={onCancel} testid="plg-consent" width={540} icon={<PluginIcon m={m} size={44} />}
      title={c.mode === 'install' ? `安装「${m.name}」` : `更新「${m.name}」到 v${m.version}`}
      description={c.mode === 'install'
        ? <>{m.publisher} · v{m.version}。它要下面 <span className="tabular-nums">{c.perms.length}</span> 项权限，逐条看过并勾选同意，才能安装。</>
        : <>新版本比已装的 v{c.from} 多要 <span className="tabular-nums">{c.perms.length}</span> 项权限。同意之前还用旧版本，用到这些权限的事会先停着。</>}>
      <ConsentBody c={c} onCancel={onCancel} onConfirm={onConfirm} />
    </Modal>
  )
}

function ConsentBody({ c, onCancel, onConfirm }: { c: Consent; onCancel: () => void; onConfirm: (scopes: string[]) => void }) {
  const [ok, setOk] = useState<Set<string>>(new Set())
  const n = c.perms.filter((p) => ok.has(p.scope)).length
  const all = c.perms.length > 0 && n === c.perms.length
  const toggle = (scope: string, on: boolean) => setOk((s) => { const x = new Set(s); if (on) x.add(scope); else x.delete(scope); return x })
  return (
    <>
      <ModalBody>
        <ul className="space-y-2" data-testid="plg-consent-list">
          {c.perms.map((p) => {
            const on = ok.has(p.scope)
            return (
              <li key={p.scope}>
                <label data-testid={`plg-consent-perm-${p.scope}`} data-risk={p.risk} data-checked={on || undefined}
                  className={cn('flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-[background-color,border-color] duration-fast ease-out',
                    p.risk === 'high' ? 'border-err/35 bg-err-soft' : on ? 'border-fg-3/40 bg-hover/60' : 'border-line hover:bg-hover/60')}>
                  <Checkbox checked={on} onCheckedChange={(v) => toggle(p.scope, v === true)} aria-label={`同意：${p.detail}`} className="mt-0.5 rounded-[5px]" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-medium leading-snug">{p.detail}</span>
                    <span className="mt-0.5 block truncate font-code text-[11.5px] text-fg-3">{p.scope}</span>
                  </span>
                  <RiskBadge r={p.risk} />
                </label>
              </li>
            )
          })}
        </ul>
        {c.manifest.category === 'source' && (
          <p className="mt-3 flex gap-2 rounded-xl bg-hover px-3 py-2.5 text-[12.5px] leading-relaxed text-fg-2"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-fg-3" />{COPY.untrusted}</p>
        )}
      </ModalBody>
      <ModalFooter>
        <span data-testid="plg-consent-count" className={cn('text-[12.5px] font-medium tabular-nums transition-colors duration-fast', all ? 'text-ok' : 'text-fg-3')}>已同意 {n}/{c.perms.length}</span>
        <span className="flex-1" />
        <Button variant="ghost" onClick={onCancel}>取消</Button>
        <Button data-testid="plg-consent-confirm" variant="brand" disabled={!all} onClick={() => onConfirm([...ok])}>{c.mode === 'install' ? '同意并安装' : '同意并更新'}</Button>
      </ModalFooter>
    </>
  )
}
