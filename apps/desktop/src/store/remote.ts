// 状态动作写到后端:经 api/backend 的 call() 走接口合同(没连上后端时是进程内的演示服务)。
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

export const atLeast = (ms: number) => new Promise<void>((r) => later(r, ms))
