// 接线层的约定:每个实体一个 Wiring——连上后端时(以及 stream.resync 之后)怎么全量读,收到哪些事件怎么写回切片。
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
  /** 全量读一次,写进切片。失败就抛错(用 read()),由接线层记成「这一类没读到」,不拿演示数据顶上 */
  load: (w: WireCtx) => Promise<void>
  /** 这个实体关心的事件 */
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

/** 后端给的当前用户 id。界面里你自己固定是 'me',映射时把它换成 'me' */
export const selfId = (w: WireCtx): string => {
  const b = w.get().backend
  return b.mode === 'connected' ? b.userId : ''
}

/** 写操作的动作号(合同 clientActionId):同一号重发,后端只认一次 */
export const actionId = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** 合同时间(ISO)→ 界面上的「时:分」;认不出给空串,不编 */
export const clockOf = (iso: string | null | undefined): string => {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? d.toTimeString().slice(0, 5) : ''
}

/** 读后端:成功返回值,失败抛 ReadError */
export async function read<M extends MethodName>(w: WireCtx, method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
  const r = await w.call(method, params)
  if (!r.ok) throw new ReadError(method, r.error)
  return r.value
}
