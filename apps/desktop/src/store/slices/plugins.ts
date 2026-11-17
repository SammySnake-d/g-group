// 插件切片:本机安装状态(ui-core 的 pluginReducer 推进生命周期)、凭据与外发预授权,以及每个会话后端给的命令清单。
// 安装 / 卸载 / 启停 / 更新经合同写到后端(plugins.install / uninstall / setEnabled / update),后端不收就撤回本地改动;
// 挂到聊天、调用者白名单、凭据失效与重新授权、外发预授权是合同缺口:演示里只在本地;连着后端时不做(宿主里的插件对所有聊天生效,
// 后端不分会话挂载、没有调用者名单;外发预授权后端没有这一项),也不往会话里插本地灰字、不以联系人名义编消息。
// 连着后端时卸载 / 启停 / 更新走接线层(api/wire/plugins 的 pluginWriteLive):后端收下才改界面、才提示,不先改本地再说「已…」。
import { notInstalled, pluginName, pluginReducer, type PluginAction, type PluginManifest, type PluginResult } from '@g-group/ui-core'
import { call } from '@/api/backend'
import { live, liveCtx } from '@/api/wire/live'
import { pluginWriteLive } from '@/api/wire/plugins'
import type { PersonId, PluginState } from '@/data'
import { broken } from '@/mut'
import { uid } from '../boot'
import { atLeast, sync } from '../remote'
import { lens, type Slice } from '../state'

/** 后端给的某个会话可用命令名;连同请求时的插件状态和成员一起记,本地状态变了就先按本地判断,等新清单 */
export type RoomCommands = { names: string[]; plugins: PluginState[]; members: PersonId[] }

/** 这一片经 useApp() 对外暴露的字段(Ctx 的一部分)。加字段:写在这里,再把名字加进下面的 PLUGINS_CTX_KEYS */
export interface PluginsCtx {
  /** 本机插件安装状态（ui-core 的 PluginInstall + 凭据说明 + 外发预授权） */
  plugins: PluginState[]
  /** 插件市场目录：各插件最新版本的清单 */
  pluginCatalog: PluginManifest[]
  /** 只改凭据说明、预授权这些附加信息；安装状态走 pluginAct */
  updatePlugin: (id: string, patch: Partial<Pick<PluginState, 'cred' | 'grant'>>) => void
  /** 推进插件生命周期（ui-core pluginReducer）。非法转移原样返回错误，不改状态；安装 / 卸载会在演示里稍后自动完成 */
  pluginAct: (id: string, a: PluginAction) => PluginResult<PluginState>
  revokePlugin: (id: string) => void
  reauthPlugin: (id: string) => void
}
/** 连着后端时挂到 / 摘下 / 调用者名单为什么不能做(界面上也写这句) */
export const PLUGIN_WHERE_LIVE = '插件对所有聊天生效，后端不分会话挂载'
const LOCAL_ONLY: PluginAction['type'][] = ['attach', 'detach', 'allow', 'disallow']

export const PLUGINS_CTX_KEYS = ['plugins', 'pluginCatalog', 'updatePlugin', 'pluginAct', 'revokePlugin', 'reauthPlugin'] as const satisfies readonly (keyof PluginsCtx)[]

export type PluginsSlice = PluginsCtx & {
  roomCommands: Record<string, RoomCommands>
  /** commands.list:拉这个会话后端认的命令(插件启停、挂摘、成员变了都要重拉) */
  loadCommands: (roomId: string) => void
  /** 插件整表换掉 / 换一个(连上后端时由 api/wire/plugins 按 plugins.list 与事件写) */
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
  /** 写到后端:安装 / 卸载等回执(演示服务立即回包时至少留一会儿「安装中 / 卸载中」),启停 / 更新失败就撤回 */
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
    /* 初值空:演示数据由 api/demo-state.ts 装 */
    plugins: [],
    pluginCatalog: [],
    roomCommands: {},

    loadCommands: (roomId) => {
      const s = get()
      const conv = s.convs.find((c) => c.id === roomId)
      if (!conv) return
      const stamp = { plugins: s.plugins, members: conv.members }
      /* 拿不到清单就按本地判断,不打扰你 */
      void call('commands.list', { roomId }).then((r) => { if (r.ok) set((st) => ({ roomCommands: { ...st.roomCommands, [roomId]: { names: r.value.commands.map((c) => c.name), ...stamp } } })) })
    },

    setPlugins: (plugins) => set({ plugins }),
    putPlugin: (p) => L.plugins((l) => (l.some((x) => x.id === p.id) ? l.map((x) => (x.id === p.id ? p : x)) : [...l, p])),
    /* 凭据说明、外发预授权只在演示里存本地;连着后端时后端没有这一项,不改 */
    updatePlugin: (id, patch) => { if (!live(get())) mapPlugin(id, (x) => ({ ...x, ...patch })) },
    /* 推进生命周期:非法转移原样返回错误,不改状态。store 的 set 是同步的,同一拍里连着推进几次(装好后一次挂到几个聊天)不会互相覆盖 */
    pluginAct: (id, a) => {
      const { plugins, convs, toast } = get()
      const cur: PluginState = plugins.find((x) => x.id === id) ?? notInstalled(id)
      const isLive = live(get())
      /* 连着后端:挂到 / 摘下 / 调用者名单后端表达不了,不改本地、不提示做成 */
      if (isLive && LOCAL_ONLY.includes(a.type)) return { ok: false, state: cur, error: PLUGIN_WHERE_LIVE, needsConsent: [] }
      const r = pluginReducer(cur, a)
      if (!r.ok) return r
      const name = pluginName(r.state)
      const done = a.type === 'disable' ? `已停用「${name}」，所有聊天里都暂时用不了` : a.type === 'enable' ? `已启用「${name}」` : a.type === 'update' ? `「${name}」更新到 v${a.manifest.version}` : undefined
      /* 连着后端:卸载 / 启停 / 更新等后端收下才改界面、才提示(这里只借 reducer 判断这一步合不合法),会话里不插本地灰字 */
      if (isLive && (a.type === 'uninstall' || a.type === 'enable' || a.type === 'disable' || a.type === 'update')) {
        void pluginWriteLive(liveCtx(get, set), id, a, done)
        return r
      }
      L.plugins((l) => (l.some((x) => x.id === id) ? l.map((x) => (x.id === id ? r.state : x)) : [...l, r.state]))
      const title = (cid: string) => convs.find((c) => c.id === cid)?.title ?? cid
      remote(cur, a)
      if (a.type === 'uninstall') cur.convs.forEach((cid) => sys(cid, `你卸载了插件「${name}」，这里不能再用它了`))
      if (done) toast(done)
      if (a.type === 'attach') { sys(a.conv, `你把插件「${name}」挂到了这里`); toast(`「${name}」挂到了「${title(a.conv)}」`) }
      if (a.type === 'detach') { sys(a.conv, `你把插件「${name}」从这里摘下了`); toast(`「${name}」从「${title(a.conv)}」摘下了`) }
      return r
    },
    /* AC-35⑤:凭据失效(原型里用按钮模拟)/ 重新授权 */
    revokePlugin: (id) => {
      const p = get().plugins.find((x) => x.id === id); if (!p || live(get())) return
      const name = pluginName(p)
      if (!broken('AC-35-5')) mapPlugin(id, (x) => ({ ...x, cred: '授权失效', grant: x.grant ? { ...x.grant, revoked: true } : x.grant }))
      const who = p.callers[0] ?? 'helper'
      if (!broken('AC-35-5')) p.convs.forEach((cid) => get().pushMsg({ k: 'authfix', id: 'af' + uid(), from: who, plugin: id, text: `发不了邮件：${name} 授权过期了，外发已暂停，待发的先不发` }, cid))
    },
    /* 演示里的重新授权会以联系人名义说一句;连着后端时不做,不编消息 */
    reauthPlugin: (id) => {
      const p = get().plugins.find((x) => x.id === id); if (!p || live(get())) return
      mapPlugin(id, (x) => ({ ...x, cred: 'OAuth · 刚重新授权 · 7 天后过期', grant: x.grant ? { ...x.grant, revoked: false } : x.grant }))
      L.convs((cs) => cs.map((c) => ({ ...c, messages: c.messages.map((m) => (m.k === 'authfix' && m.plugin === id ? { ...m, fixed: true } : m)) })))
      p.convs.forEach((cid) => get().say(cid, p.callers[0] ?? 'helper', `${pluginName(p)} 重新授权好了，暂停的外发接着发。`, 500))
    },
  }
}
