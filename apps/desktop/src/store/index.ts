// 全局状态(zustand):按领域切片组合成一个 store。业务组件经 useApp() 读,形状与原来的 Ctx 一致;
// 只关心一两个字段的组件传选择器 useApp((s) => s.xxx),别的字段变了它不重渲染。
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { createChatSlice } from './slices/chat'
import { createComputeSlice } from './slices/compute'
import { createLayoutSlice } from './slices/layout'
import { createMembersSlice } from './slices/members'
import { createMessagesSlice } from './slices/messages'
import { createModelsSlice } from './slices/models'
import { createPluginsSlice } from './slices/plugins'
import { createScheduleSlice } from './slices/schedule'
import { createSendSlice } from './slices/send'
import { createTasksSlice } from './slices/tasks'
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
}))

/** Ctx 的全部字段:useApp() 只订阅这些(壳内部的宽度、草稿、浮层栈变了,业务组件不跟着重渲染) */
const CTX_KEYS = [
  'answers', 'computes', 'pending', 'convs', 'boards', 'commits', 'playbook', 'reactions', 'active', 'dark', 'debug', 'typing', 'setDark', 'setDebug',
  'push', 'back', 'closeAll', 'openSplit', 'setPanoOpen', 'openConv', 'openDm', 'mention', 'addQuote', 'react', 'jump', 'resolve', 'stop', 'resume',
  'tell', 'rollback', 'retag', 'setDisp', 'claim', 'addMembers', 'removeMember', 'createContact', 'createGroup', 'quoteExternal', 'linkConv', 'unlinkConv',
  'forward', 'sendAs', 'importBoard', 'setSelecting', 'showPip', 'setNotice', 'editNotice', 'setConvFlag', 'markRead', 'recall', 'reedit', 'rewind',
  'unrewind', 'rewindAsk', 'setRewindAsk', 'renameConv', 'toast', 'decideVote', 'poke', 'silence', 'pinMsg', 'deleteMsgs', 'leaveConv', 'setPool',
  'deleteMsg', 'openContact', 'summarize', 'editMsg', 'editing', 'setEditing', 'clearHistory', 'updatePerson', 'crons', 'pulse', 'checklist', 'plugins',
  'pluginCatalog', 'section', 'setSection', 'openWorkbench', 'helperPanel', 'setHelperPanel', 'helperGlobal', 'setHelperGlobal', 'helperReply',
  'claimTask', 'setTaskStatus', 'addTasks', 'addTask', 'updateCron', 'addCron', 'removeCron', 'runCronNow', 'updatePlugin', 'pluginAct', 'putCommand',
  'hitCaptcha', 'declineHuman', 'takeHuman', 'returnHuman', 'revokePlugin', 'reauthPlugin', 'pushMsg', 'scheduleDraft', 'openSchedule',
  'modelSettings', 'modelsRev', 'saveModels',
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
export function useApp(): Ctx
export function useApp<T>(selector: (s: AppState) => T): T
export function useApp<T>(selector?: (s: AppState) => T) {
  return useAppStore(useShallow((selector ?? pickCtx) as (s: AppState) => T | Ctx))
}

export type { AppState }
