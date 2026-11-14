// 插件接线:plugins.list 全量读 → 插件切片(本机真实装好的插件);plugin.updated 整条换,plugin.removed 删掉。
// 宿主里装好的插件对所有聊天生效(commands.list 不分会话),所以连上后端时每个插件都挂在全部会话上;新会话出现时补上。
// 合同里没有的(简介、图标、命令标题与参数、更新记录、风险级别)不编:名字用合同的,图标按 id 稳定挑色、取名字首字,风险一律按低显示原文说明。
// 写:卸载(plugins.uninstall)、启停(plugins.setEnabled)、更新(plugins.update)以后端回包为准写回;后端不收就提示原因,界面不变。
// 合同缺、所以连着后端时不做的:挂到某个聊天 / 摘下 / 调用者名单(后端不分会话挂载),外发预授权(plugins.configure 只存插件自己的配置,
// 外发前后端不核对范围,PluginView 也表达不了授权失效)。
import type { CapabilityLibraryView, PluginView } from '@g-group/api-contract'
import type { PluginAction, PluginCategory, PluginManifest } from '@g-group/ui-core'
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
    /* 合同只给命令名,没有标题与参数说明:标题就用命令名,参数与说明不编 */
    contributes: { commands: p.commands.map((name) => ({ name, title: name, desc: '', args: [] })), panels: [], events: [] },
    changelog: [],
  }
}

const PHASE: Record<PluginView['status'], PluginState['phase'] | null> = { installing: 'installing', uninstalling: 'uninstalling', ready: null, updating: null, error: null }

/** 合同的插件 → 界面的插件;挂在 convs 这些会话上(宿主里装好就对所有聊天生效) */
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

/** 全局能力库(capabilities.list):群资料「工具」页给联系人勾选的 skill / MCP 配上说明;读不到返回 null */
export async function capabilitiesLive(): Promise<CapabilityLibraryView | null> {
  const r = await call('capabilities.list', {})
  return r.ok ? r.value : null
}

const WRITE_LABEL = { uninstall: '卸载', enable: '启用', disable: '停用', update: '更新' } as const
export type PluginWrite = Extract<PluginAction, { type: keyof typeof WRITE_LABEL }>

/** 卸载 / 启停 / 更新:后端收下才改界面(以回包为准),不收就提示原因、界面不变;done 是收下后的一句提示 */
export async function pluginWriteLive(w: WireCtx, id: string, a: PluginWrite, done?: string) {
  const r = a.type === 'uninstall' ? await w.call('plugins.uninstall', { pluginId: id })
    : a.type === 'update' ? await w.call('plugins.update', { pluginId: id, version: a.manifest.version, grantedPermissions: [...a.consent] })
    : await w.call('plugins.setEnabled', { pluginId: id, enabled: a.type === 'enable' })
  if (!r.ok) { w.get().toast(`没${WRITE_LABEL[a.type]}成：${r.error.message}`); return }
  if ('id' in r.value) w.get().putPlugin(toPluginState(r.value, allConvs(w)))
  else w.get().setPlugins(w.get().plugins.filter((p) => p.id !== id))
  if (done) w.get().toast(done)
}
