/* 定时模块的文案与选项:组件只引用,不写死。 */
import type { CronTriggerKind } from '@g-group/ui-core'
import type { Cron, CronRun } from '@/data'

/** 什么时候醒:四种触发方式 */
export const KINDS: readonly { value: CronTriggerKind; label: string }[] = [
  { value: 'cron', label: '按时间重复' },
  { value: 'once', label: '只跑一次' },
  { value: 'messages', label: '每 N 条消息' },
  { value: 'event', label: '某件事发生' },
]

/** 什么时候开口 */
export const SPEAKS: readonly { value: Cron['speak']; label: string }[] = [
  { value: 'always', label: '每次都发结果' },
  { value: 'only-if', label: '有情况才说' },
]
export const SPEAK_HINT: Record<Cron['speak'], string> = {
  always: '每次醒来都在会话里发一条结果',
  'only-if': '看过没情况就不说话，只记进运行历史',
}

/** 连上后端时关着的几项:合同的 schedules.create / update 只表达按 cron 触发、每次都发结果,也不收负责人和会话的改动。
 *  原因直接写在编辑器里那一项下面,不用点就能看到 */
export const CRON_LIVE = {
  kinds: '后端的定时只按时间重复：「只跑一次」「每 N 条消息」「某件事发生」还不支持',
  speak: '后端的定时每次醒来都发结果：「有情况才说」还不支持',
  fixed: '由谁做、在哪个会话，建好后改不了：后端的定时不收这两项的改动。要换就删掉这条再新建',
} as const

/** 运行历史结果条:最多画几格、每种结果的颜色 */
export const HEALTH_TICKS = 12
export const TICK_CLS: Record<CronRun['result'], string> = { said: 'bg-ok/50', silent: 'bg-fg-3/30', error: 'bg-err' }

/** 规则卡右上的状态(圆点 + 字,颜色之外有文字);正常开着时不显示,开关旁已写明 */
export const STATUS = {
  failed: { label: '上次失败', cls: 'text-err' },
  paused: { label: '已暂停', cls: 'text-fg-3' },
} as const

export const EDITOR = {
  titleNew: '新建定时',
  titleEdit: '改定时',
  desc: '到点叫醒一位助手，让它在会话里替你做一件事',
  what: '做什么',
  whatPh: '醒来做什么，比如「总结昨天的报错，有 P0 才叫我」',
  where: '在哪个会话',
  wherePh: '选一个会话',
  who: '由谁做',
  whoHint: '这个会话里的助手',
  whoFirst: '先选会话',
  when: '什么时候醒',
  speak: '什么时候开口',
  custom: '自定义',
  exprLabel: 'cron',
  upcoming: '接下来',
  zone: '按本地时间算',
  onceWill: '将在',
  onceTail: '醒来一次，跑完自动停用',
  msgHead: '会话里每有',
  msgTail: '条新消息醒一次（只数人和助手说的话）',
  noSource: '这个会话还没挂数据源插件。先到「插件」里把来源挂到这个会话，再回来选。',
  sourcePh: '哪个插件报来的事',
  condPh: '满足什么条件才叫醒它，比如「CVSS ≥ 9 且命中本项目依赖」',
  eventNote: '插件只负责把事报过来，判断要不要开口的仍是这位助手',
  on: '开启',
  off: '先不开',
  cancel: '取消',
  save: '保存',
  missingText: '写一下醒来做什么',
  missingWhere: '选一个会话',
  missingWho: '选由谁来做',
} as const

export const DETAIL = {
  gone: '这个定时已经删掉了',
  ownerSuffix: '的定时',
  next: '下次',
  later: '再往后',
  zone: '按本地时间',
  runNow: '立即跑一次',
  edit: '编辑',
  paused: '已暂停',
  running: '开着',
  delete: '删除',
  source: '看当初是怎么说的',
  noticesTitle: '下次醒来先带上的群公告',
  noticesNote: '公告改了，下次醒来就按新版本做，不用重建定时。',
  runs: '运行历史',
  lastFailed: '最近一次失败',
  noRuns: '还没跑过。点「立即跑一次」先试试',
  jump: '看消息',
  retry: '重试',
  speakEvent: '命中才说话',
} as const

export const DELETE = {
  title: '删除这个定时？',
  cancel: '取消',
  ok: '删除',
} as const

export const LIST = {
  title: '本群定时',
  on: '开着',
  zone: '只看本群 · 按本地时间',
  add: '新建定时',
  emptyTitle: '还没有定时',
  emptyHint: '点「新建定时」，或者在群里跟某个助手说「每天 8 点…」',
  overview: '所有会话的定时在「进展」里看',
  retry: '重试',
  pause: '暂停这个定时',
  resume: '开启这个定时',
} as const
