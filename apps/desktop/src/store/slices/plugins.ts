// 插件切片:本机安装状态(ui-core 的 pluginReducer 推进生命周期)、凭据与外发预授权,以及每个会话后端给的命令清单。
import { notInstalled, pluginName, pluginReducer, type PluginAction, type PluginManifest, type PluginResult } from '@g-group/ui-core'
import { call } from '@/api/backend'
import type { PersonId, PluginState } from '@/data'
import { broken } from '@/mut'
import { uid } from '../boot'
import { atLeast, sync } from '../remote'
import { lens, type Slice } from '../state'

/** 后端给的某个会话可用命令名;连同请求时的插件状态和成员一起记,本地状态变了就先按本地判断,等新清单 */
export type RoomCommands = { names: string[]; plugins: PluginState[]; members: PersonId[] }

export interface PluginsCtx {
  /** 本机插件安装状态（ui-core 的 PluginInstall + 凭据说明 + 外发预授权） */
  plugins: PluginState[]
  pluginCatalog: PluginManifest[]
  /** 只改凭据说明、预授权这些附加信息；安装状态走 pluginAct */
  updatePlugin: (id: string, patch: Partial<Pick<PluginState, 'cred' | 'grant'>>) => void
  /** 推进插件生命周期（ui-core pluginReducer）。非法转移原样返回错误，不改状态；安装 / 卸载会在演示里稍后自动完成 */
  pluginAct: (id: string, a: PluginAction) => PluginResult<PluginState>
  revokePlugin: (id: string) => void
  reauthPlugin: (id: string) => void
}
export const PLUGINS_CTX_KEYS = ['plugins', 'pluginCatalog', 'updatePlugin', 'pluginAct', 'revokePlugin', 'reauthPlugin'] as const satisfies readonly (keyof PluginsCtx)[]

export type PluginsSlice = PluginsCtx & {
  roomCommands: Record<string, RoomCommands>
  loadCommands: (roomId: string) => void
  setPlugins: (list: PluginState[]) => void
  putPlugin: (p: PluginState) => void
}

export const createPluginsSlice: Slice<PluginsSlice> = (set, get) => {
  const L = lens(set)
  const sys = (cid: string, text: string) => get().pushMsg({ k: 'sys', id: 's' + uid(), text }, cid)
  const mapPlugin = (id: string, f: (p: PluginState) => PluginState) => L.plugins((l) => l.map((x) => (x.id === id ? f(x) : x)))
  const step = (id: string, b: PluginAction) => mapPlugin(id, (x) => { const n = pluginReducer(x, b); return n.ok ? n.state : x })
  /** 后端不收:安装状态回到动作之前(卸载、启停、更新没有「失败」这一步,直接撤回);挂在哪些聊天、谁能调用这些本地设置不动 */
  const restore = (cur: PluginState) => mapPlugin(cur.id, (x) => ({ ...x, phase: cur.phase, manifest: cur.manifest, pending: cur.pending, granted: cur.granted }))
  const remote = (cur: PluginState, a: PluginAction) => {
    const id = cur.id
    if (a.type === 'install') {
      const done = sync('plugins.install', { clientActionId: uid(), source: { kind: 'marketplace', id, version: a.manifest.version }, grantedPermissions: [...a.consent] }, `「${a.manifest.name}」的安装`)
      void Promise.all([done, atLeast(1200)]).then(([v]) => step(id, { type: v ? 'install_done' : 'install_failed' }))
    }
    if (a.type === 'uninstall') void Promise.all([sync('plugins.uninstall', { pluginId: id }, '卸载'), atLeast(700)]).then(([v]) => (v ? step(id, { type: 'uninstall_done' }) : restore(cur)))
    if (a.type === 'enable' || a.type === 'disable') void sync('plugins.setEnabled', { pluginId: id, enabled: a.type === 'enable' }, a.type === 'enable' ? '启用' : '停用').then((v) => v || restore(cur))
    if (a.type === 'update') void sync('plugins.update', { pluginId: id, version: a.manifest.version }, '更新').then((v) => v || restore(cur))
  }

  return {
    plugins: [],
    pluginCatalog: [],
    roomCommands: {},

    loadCommands: (roomId) => {
      const s = get()
      const conv = s.convs.find((c) => c.id === roomId)
      if (!conv) return
      const stamp = { plugins: s.plugins, members: conv.members }
      void call('commands.list', { roomId }).then((r) => { if (r.ok) set((st) => ({ roomCommands: { ...st.roomCommands, [roomId]: { names: r.value.commands.map((c) => c.name), ...stamp } } })) })
    },

    setPlugins: (plugins) => set({ plugins }),
    putPlugin: (p) => L.plugins((l) => (l.some((x) => x.id === p.id) ? l.map((x) => (x.id === p.id ? p : x)) : [...l, p])),
    updatePlugin: (id, patch) => mapPlugin(id, (x) => ({ ...x, ...patch })),
    /* 推进生命周期:非法转移原样返回错误,不改状态。store 的 set 是同步的,同一拍里连着推进几次(装好后一次挂到几个聊天)不会互相覆盖 */
    pluginAct: (id, a) => {
      const { plugins, convs, toast } = get()
      const cur: PluginState = plugins.find((x) => x.id === id) ?? notInstalled(id)
      const r = pluginReducer(cur, a)
      if (!r.ok) return r
      L.plugins((l) => (l.some((x) => x.id === id) ? l.map((x) => (x.id === id ? r.state : x)) : [...l, r.state]))
      const name = pluginName(r.state)
      const title = (cid: string) => convs.find((c) => c.id === cid)?.title ?? cid
      remote(cur, a)
      if (a.type === 'uninstall') cur.convs.forEach((cid) => sys(cid, `你卸载了插件「${name}」，这里不能再用它了`))
      if (a.type === 'disable') toast(`已停用「${name}」，所有聊天里都暂时用不了`)
      if (a.type === 'enable') toast(`已启用「${name}」`)
      if (a.type === 'update') toast(`「${name}」更新到 v${a.manifest.version}`)
      if (a.type === 'attach') { sys(a.conv, `你把插件「${name}」挂到了这里`); toast(`「${name}」挂到了「${title(a.conv)}」`) }
      if (a.type === 'detach') { sys(a.conv, `你把插件「${name}」从这里摘下了`); toast(`「${name}」从「${title(a.conv)}」摘下了`) }
      return r
    },
    /* AC-35⑤:凭据失效(原型里用按钮模拟)/ 重新授权 */
    revokePlugin: (id) => {
      const p = get().plugins.find((x) => x.id === id); if (!p) return
      const name = pluginName(p)
      if (!broken('AC-35-5')) mapPlugin(id, (x) => ({ ...x, cred: '授权失效', grant: x.grant ? { ...x.grant, revoked: true } : x.grant }))
      const who = p.callers[0] ?? 'helper'
      if (!broken('AC-35-5')) p.convs.forEach((cid) => get().pushMsg({ k: 'authfix', id: 'af' + uid(), from: who, plugin: id, text: `发不了邮件：${name} 授权过期了，外发已暂停，待发的先不发` }, cid))
    },
    reauthPlugin: (id) => {
      const p = get().plugins.find((x) => x.id === id); if (!p) return
      mapPlugin(id, (x) => ({ ...x, cred: 'OAuth · 刚重新授权 · 7 天后过期', grant: x.grant ? { ...x.grant, revoked: false } : x.grant }))
      L.convs((cs) => cs.map((c) => ({ ...c, messages: c.messages.map((m) => (m.k === 'authfix' && m.plugin === id ? { ...m, fixed: true } : m)) })))
      p.convs.forEach((cid) => get().say(cid, p.callers[0] ?? 'helper', `${pluginName(p)} 重新授权好了，暂停的外发接着发。`, 500))
    },
  }
}
