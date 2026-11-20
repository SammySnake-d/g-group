// 连上后端时还没接线的写动作(扩展件:撤回/编辑/表情、回退、公告、成员管理、Compute 干预、清单、模型设置…)。
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/state'
import { live } from './live'

export const UNWIRED = {
  unrewind: '恢复回退',
  decideVote: '拍板',
  linkConv: '关联会话',
  unlinkConv: '取消关联',
  silence: '禁言',
  rollback: '回到检查点',
  summarize: '总结',
  helperReply: '让 Helper 回复',
  saveModels: '改模型设置',
  updatePerson: '改联系人设置',
} as const satisfies Partial<Record<keyof AppState, string>>

export function guardUnwired(store: StoreApi<AppState>) {
  const s = store.getState()
  const patch: Record<string, unknown> = {}
  for (const [k, what] of Object.entries(UNWIRED)) {
    const orig = s[k as keyof AppState] as (...a: unknown[]) => unknown
    patch[k] = (...a: unknown[]) => (live(store.getState()) ? store.getState().toast(`暂时不能${what}：这一步还没接上后端，没有改动`) : orig(...a))
  }
  store.setState(patch as Partial<AppState>)
}
