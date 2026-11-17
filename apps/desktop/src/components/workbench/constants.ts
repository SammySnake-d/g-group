import type { WbTab } from '@/ctx'
import type { Pending } from '@/data'

/* 联系人工作台的页签、层级说明和「等你」文案:模块自己的常量,不写在组件里 */

export const WB_TABS: readonly { value: WbTab; label: string }[] = [
  { value: 'overview', label: '概览' },
  { value: 'duty', label: '职责与预设' },
  { value: 'memory', label: '记忆' },
  { value: 'cron', label: '定时' },
  { value: 'settings', label: '设置' },
  { value: 'process', label: '完整过程' },
]

export type PaneTab = 'here' | 'talks' | 'process' | 'duty' | 'memory'

/** 右侧分栏里的联系人页签;「在本群」只在群里打开时这么叫 */
export const paneTabs = (inGroup: boolean): readonly { value: PaneTab; label: string }[] => [
  { value: 'here', label: inGroup ? '在本群' : '概览' },
  { value: 'talks', label: '对话' },
  { value: 'process', label: '完整过程' },
  { value: 'duty', label: '职责与预设' },
  { value: 'memory', label: '记忆' },
]

/** 四层设定各自由谁写、多久变一次(职责与预设页的标题旁) */
export const LAYERS: readonly { k: string; who: string }[] = [
  { k: '职责', who: '你写 · 换群或换活时改' },
  { k: '预设', who: '你写 · 偶尔调' },
  { k: '记忆', who: '它自己写，你能删改 · 每天都在长' },
  { k: '红线', who: '只有你能改 · 基本不变' },
]

/** 「等你」一行的第二行:要你做什么 */
export const PENDING_VERB: Record<Pending['kind'], string> = {
  choice: '等你回答',
  proposal: '等你同意',
  accept: '做完了，在聊天里 @你了',
  error: '出错了，等你决定',
}

/** 「等你」一行的按钮 */
export const PENDING_CTA: Record<Pending['kind'], string> = {
  choice: '去回答',
  proposal: '去回答',
  accept: '去回复',
  error: '去处理',
}

export const DUTY_FALLBACK = '未设分工 · 用默认职位'
