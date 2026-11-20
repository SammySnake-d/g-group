// 渲染层访问后端的唯一入口:Electron 里是 preload 暴露的 window.gg(按 @g-group/api-contract);
import { API_VERSION, type ApiResult, type GGroupBridge, type MethodName, type ParamsOf } from '@g-group/api-contract'
import { createDemoServer, type DemoSeed } from './demo-server'

export type BackendState = { mode: 'checking' } | { mode: 'connected'; userId: string; eventSeq: number } | { mode: 'demo'; reason: string }

export const bridge: GGroupBridge | null = typeof window !== 'undefined' && 'gg' in window ? (window as unknown as { gg: GGroupBridge }).gg : null

async function hello(): Promise<BackendState> {
  if (!bridge) return { mode: 'demo', reason: '在浏览器里预览,没有桌面壳' }
  try {
    const r = await bridge.invoke('session.hello', { clientApiVersion: API_VERSION })
    if (r.ok) return r.value.apiVersion.split('.')[0] === API_VERSION.split('.')[0] ? { mode: 'connected', userId: r.value.userId, eventSeq: r.value.eventSeq } : { mode: 'demo', reason: `接口版本不一致:后端 ${r.value.apiVersion},界面 ${API_VERSION}` }
    return { mode: 'demo', reason: r.error.message }
  } catch (e) {
    return { mode: 'demo', reason: e instanceof Error ? e.message : String(e) }
  }
}

let probed: Promise<BackendState> | null = null
export const probeBackend = () => (probed ??= hello())

let demo: ReturnType<typeof createDemoServer> | null = null
/** 状态层启动时登记演示服务的种子(初始演示数据转成合同形状) */
export function installDemo(seed: DemoSeed) { demo = createDemoServer(seed) }
export const demoCalls = () => demo?.calls ?? []

export async function call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ApiResult<M>> {
  const state = await probeBackend()
  if (state.mode === 'connected' && bridge) return bridge.invoke(method, params)
  if (demo) return demo.handle(method, params) as Promise<ApiResult<M>>
  return { ok: false, error: { code: 'unavailable', message: '后端未连接' } }
}
