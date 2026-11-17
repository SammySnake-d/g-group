// 状态切片里的写动作在连上后端时改走接线层(合同方法,以后端回包和事件为准);没连上时照旧是本地演示行为。
// 这里只给切片两样东西:现在是不是连着后端,以及调接线层动作要的上下文。
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/state'
import { call } from '../backend'
import type { WireCtx } from './types'

export const live = (s: Pick<AppState, 'backend'>) => s.backend.mode === 'connected'

export const liveCtx = (get: StoreApi<AppState>['getState'], set: StoreApi<AppState>['setState']): WireCtx => ({ call, get, set })
