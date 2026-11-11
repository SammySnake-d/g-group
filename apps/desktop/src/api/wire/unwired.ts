// 连上后端时还没接线的写动作(扩展件:撤回/编辑/表情、回退、公告、成员管理、Compute 干预、清单、模型设置…)。
// 演示模式照旧在本地做;连上后端时不在本地假装做成——只提示一句,界面不变。接上合同的动作从这张表里删掉。
// 已经自己走 call() 的(定时、插件)不在表里:后端收不收由后端如实回。
// 一行一个动作:并行接线的几块各删自己那几行,合并时不互相冲突。
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/state'
import { live } from './live'

export const UNWIRED = {
  unrewind: '恢复回退',
  decideVote: '拍板',
  setNotice: '改群公告',
  editNotice: '改群公告',
  renameConv: '改群名',
  removeMember: '移出群成员',
  linkConv: '关联会话',
  unlinkConv: '取消关联',
  setConvFlag: '置顶或免打扰',
  poke: '拍一拍',
  silence: '禁言',
  setPool: '设群临时算力',
  leaveConv: '退出或解散群',
  resolve: '在这里回答或处理',
  stop: '停止 Compute',
  resume: '让 Compute 继续',
  tell: '给 Compute 补充',
  rollback: '回到检查点',
  hitCaptcha: '交给你验证',
  declineHuman: '取消验证',
  takeHuman: '接手验证',
  returnHuman: '交还验证',
  claim: '认领',
  importBoard: '导入任务板',
  claimTask: '认领清单项',
  setTaskStatus: '改清单状态',
  addTasks: '加清单项',
  addTask: '新建清单项',
  summarize: '总结',
  helperReply: '让 Helper 回复',
  saveModels: '改模型设置',
  updatePerson: '改联系人设置',
} as const satisfies Partial<Record<keyof AppState, string>>

/** 把表里的动作包一层:连着后端就提示、不改界面;没连就照原样做 */
export function guardUnwired(store: StoreApi<AppState>) {
  const s = store.getState()
  const patch: Record<string, unknown> = {}
  for (const [k, what] of Object.entries(UNWIRED)) {
    const orig = s[k as keyof AppState] as (...a: unknown[]) => unknown
    patch[k] = (...a: unknown[]) => (live(store.getState()) ? store.getState().toast(`暂时不能${what}：这一步还没接上后端，没有改动`) : orig(...a))
  }
  store.setState(patch as Partial<AppState>)
}
