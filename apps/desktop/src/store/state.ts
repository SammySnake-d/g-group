// 整个界面状态 = 各领域切片的并集。Ctx(原 ctx.ts 的对外形状)是它的子集,
// 其余是壳自己用的内部状态(浮层栈、分栏页签、草稿、宽度…),不经 useApp() 暴露给业务组件。
import type { StateCreator, StoreApi } from 'zustand'
import type { ChatSlice } from './slices/chat'
import type { ComputeSlice } from './slices/compute'
import type { ContactsSlice } from './slices/contacts'
import type { FilesSlice } from './slices/files'
import type { LayoutSlice } from './slices/layout'
import type { MembersSlice } from './slices/members'
import type { MessagesSlice } from './slices/messages'
import type { ModelsSlice } from './slices/models'
import type { PluginsSlice } from './slices/plugins'
import type { ScheduleSlice } from './slices/schedule'
import type { SendSlice } from './slices/send'
import type { TasksSlice } from './slices/tasks'

export type AppState = LayoutSlice & ChatSlice & MessagesSlice & MembersSlice & ComputeSlice & TasksSlice & ScheduleSlice & PluginsSlice & ModelsSlice & SendSlice & ContactsSlice & FilesSlice

export type Slice<T> = StateCreator<AppState, [], [], T>
type SetState = StoreApi<AppState>['setState']

/** 对某一个字段做函数式更新:L.convs((cs) => …) 等价于原来的 setConvs((cs) => …)。任何字段都能用,加字段不用改这里 */
export type Lens = { readonly [K in keyof AppState]: (f: (v: AppState[K]) => AppState[K]) => void }
export function lens(set: SetState): Lens {
  const on = <K extends keyof AppState>(k: K) => (f: (v: AppState[K]) => AppState[K]) => set((s) => ({ [k]: f(s[k]) }) as Pick<AppState, K>)
  return new Proxy({} as Lens, { get: (_t, k) => on(k as keyof AppState) })
}
