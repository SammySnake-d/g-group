// 插件在界面上要用的几项(名字、图标、类别、启停、授权),统一从 ui-core 的安装状态 + 清单里取。
import { isInstalled, type PluginCategory } from '@g-group/ui-core'
import type { PluginState } from './data'

/** 清单还没到时的图标底色:跟着主题的三级文字色走,不写死色值 */
const FALLBACK_ICON_COLOR = 'hsl(var(--fg3))'

export type PluginInfo = { id: string; name: string; letter: string; color: string; kind: PluginCategory | undefined; desc: string; installed: boolean; enabled: boolean; revoked: boolean; convs: string[]; version: string | undefined }

export function pinfo(p: PluginState): PluginInfo {
  const m = p.manifest ?? p.pending
  return {
    id: p.id, name: m?.name ?? p.id, letter: m?.icon.letter ?? '?', color: m?.icon.color ?? FALLBACK_ICON_COLOR, kind: m?.category, desc: m?.summary ?? '',
    installed: isInstalled(p), enabled: p.phase === 'enabled', revoked: !!p.grant?.revoked, convs: p.convs, version: p.manifest?.version,
  }
}
export const findInfo = (plugins: PluginState[], id: string) => { const p = plugins.find((x) => x.id === id); return p ? pinfo(p) : undefined }
