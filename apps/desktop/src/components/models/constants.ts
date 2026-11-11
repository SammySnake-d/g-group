/* 模型配置界面的文案与常量:组件只引用,不写死。 */
import type { ModelSlot } from '@g-group/ui-core'

/** Compute 模型三态的顺序 */
export const MODES: readonly ModelSlot['mode'][] = ['inherit', 'follow-speaking', 'explicit']

/** 设置页「默认」一节的四个字段 */
export const DEFAULT_FIELDS = ['defaultHarness', 'defaultSpeakingModel', 'defaultComputeModel', 'defaultEffort'] as const
export type DefaultField = (typeof DEFAULT_FIELDS)[number]
export const DEFAULT_FIELD_LABEL: Record<DefaultField, string> = {
  defaultHarness: '默认 Harness', defaultSpeakingModel: '默认说话模型', defaultComputeModel: '默认 Compute 模型', defaultEffort: '默认 effort',
}

/** 批量替换里一处引用的说法 */
export const REF_LABEL: Record<string, string> = {
  defaultSpeakingModel: '默认说话模型', defaultComputeModel: '默认 Compute 模型', speakingModel: '说话模型', 'computeModel.model': 'Compute（单独指定）',
}

export const CM = {
  title: '模型',
  where: '只在这里和设置页「默认」改模型',
  talk: '说话模型',
  talkHint: '在群里聊天、判断要不要接活。说话不选 Harness',
  compute: 'Compute（干活）',
  harness: 'Harness',
  model: '模型',
  modeGroup: 'Compute 模型从哪来',
  explicitModel: '指定的模型',
  explicitHint: '后面写着它能在哪些 Harness 上跑',
  effort: 'effort',
  effortHint: '跟着这个槽位走；跟随说话模型时也可以单独设',
  effectiveDirty: '保存后，下一轮会用',
  effectiveClean: '按现在的配置，下一轮会用',
  runningTitle: '在跑的任务实际在用（启动时记下，不追溯）',
  advTitle: '高级 · 卡死判定',
  stallDesc: '一轮多久没有新进展就判失败，失败卡上写清原因，你可以自己换上游；模型调用发出后多久还没收到第一个字，算上游没回应。等你回答、工具在跑的时间不算。',
  stallOwnHint: '只对它生效',
  stallDefaultHint: '默认 15 分钟 / 120 秒',
  hintBlocked: '模型和 Harness 对不上，修好才能保存',
  hintStall: '卡死判定的数不对，改好才能保存',
  hintDirty: '改了还没保存',
  revert: '还原',
  save: '保存',
} as const

export const DEFAULTS = {
  section: '默认',
  overview: '各联系人现在用的模型',
  effortHint: '没单独设 effort 的联系人用它',
  harnessHint: '新建联系人的 Compute 用它',
  talkHint: '新建联系人说话用它',
  review: '复核必须换一家模型',
  batch: '批量替换模型',
  batchHint: '把 X 换成 Y，先预览',
  noneAffected: '已有的联系人都不受影响',
  affectedHint: '保存后它们下一轮就用新值，正在跑的这一轮不打断',
  noCompatible: '这个 Harness 上没有能用的模型',
  undo: '撤销',
  cancel: '取消',
  save: '保存',
  savedToast: '全局默认已保存',
} as const

export const BATCH = {
  title: '批量替换模型',
  desc: '新出了好模型，不用挨个点开联系人改。先看会动到哪些地方，确认后才改；固定在别的模型上的不动，在途任务按启动时的模型跑完。',
  inheritors: '跟着变的',
  conflicts: '兼容冲突',
  none: '没有',
  undo: '撤销',
  cancel: '取消',
  confirm: '确认替换',
} as const
