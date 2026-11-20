import type { CapabilityLibraryView, PluginView } from '@g-group/api-contract'
import type { PluginCategory, PluginManifest } from '@g-group/ui-core'
import { SWATCHES, type PluginState } from '@/data'
import { call } from '../backend'
import { defineWiring, read, type WireCtx } from './types'

const CATEGORY: Record<PluginView['kinds'][number], PluginCategory> = { 'data-source': 'source', 'outbound-channel': 'outbound', 'ui-extension': 'ui' }
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)

function manifestOf(p: PluginView): PluginManifest {
  return {
    id: p.id, name: p.name, publisher: p.source === 'marketplace' ? '插件市场' : p.source === 'url' ? '网址安装' : '本地目录', version: p.version,
    category: p.kinds[0] ? CATEGORY[p.kinds[0]] : 'command',
    summary: p.commands.length ? p.commands.map((c) => `/${c}`).join(' ') : '', description: '',
    icon: { letter: [...p.name][0] ?? '?', color: SWATCHES[hash(p.id) % SWATCHES.length]! },
    permissions: p.permissions.map((x) => ({ scope: x.key, detail: x.description, risk: 'low' as const })),
    contributes: { commands: p.commands.map((name) => ({ name, title: name, desc: '', args: [] })), panels: [], events: [] },
    changelog: [],
  }
}

const PHASE: Record<PluginView['status'], PluginState['phase'] | null> = { installing: 'installing', uninstalling: 'uninstalling', ready: null, updating: null, error: null }

export function toPluginState(p: PluginView, convs: string[]): PluginState {
  const m = manifestOf(p)
  const phase = PHASE[p.status] ?? (p.enabled ? 'enabled' : 'disabled')
  return {
    id: p.id, phase, manifest: phase === 'installing' ? null : m, pending: phase === 'installing' ? m : null,
    granted: m.permissions, convs: [...convs], callers: [],
    ...(p.error ? { cred: p.error } : {}),
  }
}

const allConvs = (w: WireCtx) => w.get().convs.map((c) => c.id)

export const pluginsWiring = defineWiring({
  entity: '插件',
  load: async (w) => {
    const { plugins } = await read(w, 'plugins.list', {})
    const convs = allConvs(w)
    w.get().setPlugins(plugins.map((p) => toPluginState(p, convs)))
  },
  on: {
    'plugin.updated': (ev, w) => w.get().putPlugin(toPluginState(ev.plugin, allConvs(w))),
    'plugin.removed': (ev, w) => w.get().setPlugins(w.get().plugins.filter((p) => p.id !== ev.pluginId)),
    'room.updated': (ev, w) => {
      const ps = w.get().plugins
      if (ps.every((p) => p.convs.includes(ev.room.id))) return
      w.get().setPlugins(ps.map((p) => (p.convs.includes(ev.room.id) ? p : { ...p, convs: [...p.convs, ev.room.id] })))
    },
  },
})

export async function capabilitiesLive(): Promise<CapabilityLibraryView | null> {
  const r = await call('capabilities.list', {})
  return r.ok ? r.value : null
}
