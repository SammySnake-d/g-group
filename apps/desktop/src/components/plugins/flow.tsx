/* 安装 / 更新 / 卸载流程:先逐条同意权限 → 安装中 → 装好后直接问挂到哪个聊天;卸载二次确认;更新多要权限时先同意新增的那几项。
   状态推进全部走 ui-core 的 pluginReducer(ctx.pluginAct),这里只管什么时候弹哪个对话框。 */
import { useEffect, useState } from 'react'
import { permissionsToConsent, type PluginManifest } from '@g-group/ui-core'
import { useApp } from '@/ctx'
import { AttachDialog } from './AttachDialog'
import { ConsentDialog, type Consent } from './ConsentDialog'
import { UninstallDialog } from './UninstallDialog'

export function usePluginFlow() {
  const { plugins, pluginCatalog, pluginAct, toast } = useApp()
  const [consent, setConsent] = useState<Consent | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [justInstalled, setJustInstalled] = useState<string | null>(null)
  const [attachFor, setAttachFor] = useState<string | null>(null)
  /* 装好的那一刻（安装中 → 已启用）接着问挂到哪个聊天 */
  useEffect(() => {
    if (justInstalled && plugins.find((p) => p.id === justInstalled)?.phase === 'enabled') { setAttachFor(justInstalled); setJustInstalled(null) }
  }, [plugins, justInstalled])
  const latestOf = (id: string) => pluginCatalog.find((m) => m.id === id) ?? plugins.find((p) => p.id === id)?.manifest ?? null
  const install = (m: PluginManifest) => setConsent({ mode: 'install', manifest: m, perms: m.permissions })
  const update = (id: string) => {
    const s = plugins.find((p) => p.id === id)
    const latest = latestOf(id)
    if (!s?.manifest || !latest) return
    const need = permissionsToConsent(s.granted, latest.permissions)
    if (need.length) { setConsent({ mode: 'update', manifest: latest, perms: need, from: s.manifest.version }); return }
    const r = pluginAct(id, { type: 'update', manifest: latest, consent: [] })
    if (!r.ok) toast(r.error)
  }
  const confirm = (scopes: string[]) => {
    if (!consent) return
    const { manifest } = consent
    const r = pluginAct(manifest.id, consent.mode === 'install' ? { type: 'install', manifest, consent: scopes } : { type: 'update', manifest, consent: scopes })
    if (!r.ok) { toast(r.error); return }
    if (consent.mode === 'install') setJustInstalled(manifest.id)
    setConsent(null)
  }
  const dialogs = (
    <>
      <ConsentDialog c={consent} onCancel={() => setConsent(null)} onConfirm={confirm} />
      <UninstallDialog id={removing} onClose={() => setRemoving(null)} />
      <AttachDialog id={attachFor} onClose={() => setAttachFor(null)} />
    </>
  )
  return { install, update, uninstall: setRemoving, dialogs }
}

export type PluginFlow = ReturnType<typeof usePluginFlow>
