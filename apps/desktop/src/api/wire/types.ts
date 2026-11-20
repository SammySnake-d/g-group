// 接线只经 call() 和事件流访问后端;写界面状态只经切片暴露的动作(setContacts、upsertContact…),不直接改别的切片的字段。
import type { ApiError, EventOf, MethodName, ParamsOf, ResultOf, ServerEventType } from '@g-group/api-contract'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/state'
import type { call } from '../backend'

export interface WireCtx {
  call: typeof call
  get: StoreApi<AppState>['getState']
  set: StoreApi<AppState>['setState']
}

export type EventHandlers = { [T in ServerEventType]?: (ev: EventOf<T>, w: WireCtx) => void }

export interface Wiring {
  /** 实体名(连接状态提示、日志里用) */
  entity: string
  load: (w: WireCtx) => Promise<void>
  on: EventHandlers
}

/** 写一个实体的接线(只为了类型推断) */
export const defineWiring = (w: Wiring): Wiring => w

export class ReadError extends Error {
  readonly method: MethodName
  readonly error: ApiError
  constructor(method: MethodName, error: ApiError) {
    super(`${method}:${error.message}`)
    this.method = method
    this.error = error
  }
}

export const selfId = (w: WireCtx): string => {
  const b = w.get().backend
  return b.mode === 'connected' ? b.userId : ''
}

export const actionId = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export const clockOf = (iso: string | null | undefined): string => {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? d.toTimeString().slice(0, 5) : ''
}

export async function read<M extends MethodName>(w: WireCtx, method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
  const r = await w.call(method, params)
  if (!r.ok) throw new ReadError(method, r.error)
  return r.value
}
