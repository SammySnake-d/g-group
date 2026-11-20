// 全局状态(zustand):按领域切片组合成一个 store。业务组件经 useApp() 读,形状与原来的 Ctx 一致;
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { CHAT_CTX_KEYS, createChatSlice } from './slices/chat'
import { COMPUTE_CTX_KEYS, createComputeSlice } from './slices/compute'
import { LAYOUT_CTX_KEYS, createLayoutSlice } from './slices/layout'
import { MEMBERS_CTX_KEYS, createMembersSlice } from './slices/members'
import { MESSAGES_CTX_KEYS, createMessagesSlice } from './slices/messages'
import { MODELS_CTX_KEYS, createModelsSlice } from './slices/models'
import { PLUGINS_CTX_KEYS, createPluginsSlice } from './slices/plugins'
import { SCHEDULE_CTX_KEYS, createScheduleSlice } from './slices/schedule'
import { createSendSlice } from './slices/send'
import { TASKS_CTX_KEYS, createTasksSlice } from './slices/tasks'
import { bridge } from '@/api/backend'
import { applyDemo } from '@/api/demo-state'
import { guardUnwired } from '@/api/wire/unwired'
import { CONTACTS_CTX_KEYS, createContactsSlice } from './slices/contacts'
import { createFilesSlice } from './slices/files'
import type { AppState } from './state'
import type { Ctx } from './types'

export const useAppStore = create<AppState>()((...a) => ({
  ...createLayoutSlice(...a),
  ...createChatSlice(...a),
  ...createMessagesSlice(...a),
  ...createMembersSlice(...a),
  ...createComputeSlice(...a),
  ...createTasksSlice(...a),
  ...createScheduleSlice(...a),
  ...createPluginsSlice(...a),
  ...createModelsSlice(...a),
  ...createSendSlice(...a),
  ...createContactsSlice(...a),
  ...createFilesSlice(...a),
}))

if (!bridge) applyDemo(useAppStore)
guardUnwired(useAppStore)

const CTX_KEYS = [
  ...LAYOUT_CTX_KEYS, ...CHAT_CTX_KEYS, ...MESSAGES_CTX_KEYS, ...MEMBERS_CTX_KEYS, ...COMPUTE_CTX_KEYS,
  ...TASKS_CTX_KEYS, ...SCHEDULE_CTX_KEYS, ...PLUGINS_CTX_KEYS, ...MODELS_CTX_KEYS, ...CONTACTS_CTX_KEYS,
] as const satisfies readonly (keyof Ctx)[]
const covered: [Exclude<keyof Ctx, (typeof CTX_KEYS)[number]>] extends [never] ? true : never = true
void covered

const pickCtx = (s: AppState): Ctx => {
  const o: Record<string, unknown> = {}
  for (const k of CTX_KEYS) o[k] = s[k]
  return o as unknown as Ctx
}

/** 读界面状态。不传参 = 整个 Ctx(和拆分前一样);传选择器 = 只订阅选中的那部分(浅比较) */
export function useApp<T>(selector: (s: AppState) => T): T
export function useApp(): Ctx
export function useApp<T>(selector?: (s: AppState) => T) {
  return useAppStore(useShallow((selector ?? pickCtx) as (s: AppState) => T | Ctx))
}

export type { AppState }
