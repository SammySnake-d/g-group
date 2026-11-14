// 渲染层访问应用壳(接入模型、版本与更新)的入口:Electron 里是 preload 暴露的 window.ggApp;浏览器预览里没有,返回 null。
import { create } from 'zustand'
import type { AppInfo, AppShellBridge, AppShellMethod, AppShellMethods, AppShellResult, SetupView, UpdateState } from './app-shell-types'

export const appShell: AppShellBridge | null = typeof window !== 'undefined' && 'ggApp' in window ? (window as unknown as { ggApp: AppShellBridge }).ggApp : null

export async function shellCall<M extends AppShellMethod>(method: M, params: AppShellMethods[M][0]): Promise<AppShellResult<M>> {
  if (!appShell) return { ok: false, error: '不在桌面应用里' }
  try {
    return await appShell.invoke(method, params)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 应用壳状态:接入模型的设置、版本、更新进度。只在桌面应用里有值 */
export const useAppShell = create<{ setup: SetupView | null; info: AppInfo | null; update: UpdateState | null }>(() => ({ setup: null, info: null, update: null }))

/** 启动时读一次,之后跟着更新事件走;返回退订 */
export function startAppShell(): () => void {
  if (!appShell) return () => {}
  void shellCall('setup.get', {}).then((r) => r.ok && useAppShell.setState({ setup: r.value }))
  void shellCall('app.info', {}).then((r) => r.ok && useAppShell.setState({ info: r.value }))
  void shellCall('update.get', {}).then((r) => r.ok && useAppShell.setState({ update: r.value }))
  return appShell.subscribe((e) => { if (e.type === 'update') useAppShell.setState({ update: e.state }) })
}

/** 没接入模型(或上次没起来)时,整个窗口先是「接入模型」 */
export const needsSetup = (s: SetupView | null) => !!s && (s.backend.state === 'needs-setup' || s.backend.state === 'failed')
