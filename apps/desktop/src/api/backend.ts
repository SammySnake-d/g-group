// 渲染层访问后端的唯一入口:Electron 里是 preload 暴露的 window.gg(按 @g-group/api-contract);
// 浏览器预览或后端没接上时为演示模式,界面明确标出「演示数据」,不假装已连上。
// 演示模式下 call() 交给进程内的演示服务(demo-server.ts):同样按合同校验参数和回包,只是数据是演示的。
import { API_VERSION, type ApiResult, type GGroupBridge, type MethodName, type ParamsOf } from '@g-group/api-contract'
import { createDemoServer, type DemoSeed } from './demo-server'

export type BackendState = { mode: 'checking' } | { mode: 'connected'; userId: string } | { mode: 'demo'; reason: string }

export const bridge: GGroupBridge | null = typeof window !== 'undefined' && 'gg' in window ? (window as unknown as { gg: GGroupBridge }).gg : null

async function hello(): Promise<BackendState> {
  if (!bridge) return { mode: 'demo', reason: '在浏览器里预览,没有桌面壳' }
  try {
    const r = await bridge.invoke('session.hello', { clientApiVersion: API_VERSION })
    if (r.ok) return r.value.apiVersion.split('.')[0] === API_VERSION.split('.')[0] ? { mode: 'connected', userId: r.value.userId } : { mode: 'demo', reason: `接口版本不一致:后端 ${r.value.apiVersion},界面 ${API_VERSION}` }
    return { mode: 'demo', reason: r.error.message }
  } catch (e) {
    return { mode: 'demo', reason: e instanceof Error ? e.message : String(e) }
  }
}

let probed: Promise<BackendState> | null = null
/** 探测一次后端;之后的 call() 都按这次结果走真后端或演示服务 */
export const probeBackend = () => (probed ??= hello())

let demo: ReturnType<typeof createDemoServer> | null = null
/** 状态层启动时登记演示服务的种子(初始演示数据转成合同形状) */
export function installDemo(seed: DemoSeed) { demo = createDemoServer(seed) }
/** 演示服务收到过的调用(走查 / 测试核对「确实走了合同」用) */
export const demoCalls = () => demo?.calls ?? []

export async function call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ApiResult<M>> {
  const state = await probeBackend()
  if (state.mode === 'connected' && bridge) return bridge.invoke(method, params)
  if (demo) return demo.handle(method, params) as Promise<ApiResult<M>>
  return { ok: false, error: { code: 'unavailable', message: '后端未连接' } }
}
