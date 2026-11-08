// 插件切片:本机安装状态(ui-core 的 pluginReducer 推进生命周期)、凭据与外发预授权。
import { notInstalled, pluginName, pluginReducer, type PluginAction } from '@g-group/ui-core'
import { pluginCatalog0, plugins0, type PluginState } from '@/data'
import { broken } from '@/mut'
import { later, uid } from '../boot'
import { lens, type Slice } from '../state'
import type { Ctx } from '../types'

export type PluginsSlice = Pick<Ctx, 'plugins' | 'pluginCatalog' | 'updatePlugin' | 'pluginAct' | 'revokePlugin' | 'reauthPlugin'>

export const createPluginsSlice: Slice<PluginsSlice> = (set, get) => {
  const L = lens(set)
  const sys = (cid: string, text: string) => get().pushMsg({ k: 'sys', id: 's' + uid(), text }, cid)
  const mapPlugin = (id: string, f: (p: PluginState) => PluginState) => L.plugins((l) => l.map((x) => (x.id === id ? f(x) : x)))
  /** 演示:安装 / 卸载过一会儿自动完成。后端接上后由 plugins.install / plugins.uninstall 的回执推进 */
  const settle = (id: string, b: PluginAction, ms: number) => later(() => mapPlugin(id, (x) => { const n = pluginReducer(x, b); return n.ok ? n.state : x }), ms)

  return {
    plugins: plugins0,
    pluginCatalog: pluginCatalog0,

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
      if (a.type === 'install') settle(id, { type: 'install_done' }, 1200)
      if (a.type === 'uninstall') { settle(id, { type: 'uninstall_done' }, 700); cur.convs.forEach((cid) => sys(cid, `你卸载了插件「${name}」，这里不能再用它了`)) }
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
