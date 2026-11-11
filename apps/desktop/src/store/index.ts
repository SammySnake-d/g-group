// 全局状态(zustand):按领域切片组合成一个 store。业务组件经 useApp() 读,形状与原来的 Ctx 一致;
// 只关心一两个字段的组件传选择器 useApp((s) => s.xxx),别的字段变了它不重渲染。
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
}))

/* 演示数据只在没连上后端时装:没有桌面壳(浏览器预览、renderer 用例)就在建 store 时同步装好,首帧就是演示界面;
   有桌面壳时等 app/useShell 探测——连上了由 api/wire 读真实数据,一条演示数据都不装;没连上才装演示数据 */
if (!bridge) applyDemo(useAppStore)
/* 连上后端时还没接线的写动作不在本地假装做成(api/wire/unwired) */
guardUnwired(useAppStore)

/** Ctx 的全部字段:useApp() 只订阅这些(壳内部的宽度、草稿、浮层栈变了,业务组件不跟着重渲染)。各片的清单在各自切片文件里 */
const CTX_KEYS = [
  ...LAYOUT_CTX_KEYS, ...CHAT_CTX_KEYS, ...MESSAGES_CTX_KEYS, ...MEMBERS_CTX_KEYS, ...COMPUTE_CTX_KEYS,
  ...TASKS_CTX_KEYS, ...SCHEDULE_CTX_KEYS, ...PLUGINS_CTX_KEYS, ...MODELS_CTX_KEYS, ...CONTACTS_CTX_KEYS,
] as const satisfies readonly (keyof Ctx)[]
/* 编译期保证上面列全了:Ctx 加了字段而这里漏掉,这一行报错 */
const covered: [Exclude<keyof Ctx, (typeof CTX_KEYS)[number]>] extends [never] ? true : never = true
void covered

const pickCtx = (s: AppState): Ctx => {
  const o: Record<string, unknown> = {}
  for (const k of CTX_KEYS) o[k] = s[k]
  return o as unknown as Ctx
}

/** 读界面状态。不传参 = 整个 Ctx(和拆分前一样);传选择器 = 只订阅选中的那部分(浅比较) */
/* 无参签名放最后:ReturnType<typeof useApp> 取的是最后一个重载,外部(如 messages/disp.ts)靠它拿到 Ctx */
export function useApp<T>(selector: (s: AppState) => T): T
export function useApp(): Ctx
export function useApp<T>(selector?: (s: AppState) => T) {
  return useAppStore(useShallow((selector ?? pickCtx) as (s: AppState) => T | Ctx))
}

export type { AppState }
