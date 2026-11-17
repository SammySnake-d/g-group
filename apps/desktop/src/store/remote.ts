// 状态动作写到后端:经 api/backend 的 call() 走接口合同(没连上后端时是进程内的演示服务)。
// 界面上的改动已经先做了(乐观更新,时序和拆分前一样);后端不收就提示原因,由调用方决定要不要撤回本地改动。
import type { MethodName, ParamsOf, ResultOf } from '@g-group/api-contract'
import { call } from '@/api/backend'
import { notify } from '@/hooks/use-toast'
import { later } from './boot'

export async function sync<M extends MethodName>(method: M, params: ParamsOf<M>, what: string): Promise<ResultOf<M> | null> {
  const r = await call(method, params)
  if (r.ok) return r.value
  notify(`${what}没存到后端：${r.error.message}`)
  return null
}

/** 演示里的「至少等这么久」:接上真后端后以回执为准,演示服务立即回包时仍保留可见的中间态(安装中、卸载中) */
export const atLeast = (ms: number) => new Promise<void>((r) => later(r, ms))
