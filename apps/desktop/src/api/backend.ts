// 渲染层访问后端的唯一入口:Electron 里是 preload 暴露的 window.gg(按 @g-group/api-contract);
// 浏览器预览或后端没接上时为演示模式,界面明确标出「演示数据」,不假装已连上。
import { API_VERSION, type ApiResult, type GGroupBridge, type MethodName, type ParamsOf } from '@g-group/api-contract'

export type BackendState = { mode: 'checking' } | { mode: 'connected'; userId: string } | { mode: 'demo'; reason: string }

export const bridge: GGroupBridge | null = typeof window !== 'undefined' && 'gg' in window ? (window as unknown as { gg: GGroupBridge }).gg : null

export async function probeBackend(): Promise<BackendState> {
  if (!bridge) return { mode: 'demo', reason: '在浏览器里预览,没有桌面壳' }
  try {
    const r = await bridge.invoke('session.hello', { clientApiVersion: API_VERSION })
    if (r.ok) return r.value.apiVersion.split('.')[0] === API_VERSION.split('.')[0] ? { mode: 'connected', userId: r.value.userId } : { mode: 'demo', reason: `接口版本不一致:后端 ${r.value.apiVersion},界面 ${API_VERSION}` }
    return { mode: 'demo', reason: r.error.message }
  } catch (e) {
    return { mode: 'demo', reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ApiResult<M>> {
  if (!bridge) return { ok: false, error: { code: 'unavailable', message: '后端未连接' } }
  return bridge.invoke(method, params)
}
