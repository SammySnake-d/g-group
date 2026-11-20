import type { PersonId } from '@/data'

export const FLOAT_RESIZE = { min: 340, max: 720 } as const

/** 联系人此刻的状态:文字 + 语义色(颜色不单独表达含义) */
export const LIVE = {
  idle: { text: '空闲', cls: 'text-fg-3' },
  running: { text: '在干活', cls: 'text-run' },
  waiting: { text: '在等你', cls: 'text-warm' },
  error: { text: '遇到问题', cls: 'text-err' },
} as const

/** 群协作手册的分类顺序与适用范围 */
export const PLAYBOOK_KINDS = ['分工', '交接', '纠正落点', '可信度'] as const
export const PLAYBOOK_SCOPE = { project: '只限本项目', team: '这个团队通用', global: '到哪都通用' } as const

export const GROUP_CONFIRM = {
  clear: { note: '只清掉你自己看到的聊天记录。助手的记忆、清单、定时和文件都不受影响，别人也照样看得到。', go: '清空' },
  dissolve: { note: '解散后所有人都没有这个群了，群里的 定时也会一起停。聊天记录和文件不会删，还能在「文件」里找到。', go: '解散' },
  leave: { note: '退出后你看不到这个群的新消息，助手们还在群里，它们的定时照常跑。', go: '退出' },
} as const
export type GroupConfirmKind = keyof typeof GROUP_CONFIRM
export const DISSOLVE_LIVE = {
  note: '解散后这个群从你和所有助手那里移除，群里的定时一起删掉，借出的群算力停下后作废。',
  stop: '解散前要先停下这些事，停稳群才移除。',
} as const

export const THEMES = [
  { dark: false, label: '浅色', paper: 'bg-stone-100', ink: 'bg-stone-300' },
  { dark: true, label: '深色', paper: 'bg-zinc-900', ink: 'bg-zinc-700' },
] as const

export const NEW_GROUP_POOL = [0, 1, 2, 3] as const
export const POOL_MAX = [0, 1, 2, 3, 5] as const

export const DEFAULT_SHAPE = 'cat'
export const DEFAULT_SWATCH_INDEX = 7

export const HELPER_PAGE = {
  hello: '你好，我是 Helper。手动能做的事都可以跟我说：拉人、建联系人、导入任务表、设提醒、关联会话、接外部来源。',
  chips: ['把 Grok 拉进这个群', '导入这个 CSV 做成任务板', '把我和 Claude Code 的私聊关联进来', '新建一个联系人'],
  placeholder: '想让软件做什么？',
  confirm: '好，确认一下：',
  csvRead: '读到 4 行任务。确认一下：',
  csvLines: ['登录页深色 / 首页性能 / 飞书接入方案 / 设计规范', '建好后我在群里 @所有人 认领'],
  inviteLines: ['Grok 只看得到之后的新消息'],
  linkLines: ['群里的助手回答时可以参考那段私聊', '随时可以在群资料里取消'],
  openedContact: '我打开了新建联系人，你填名字和擅长的事就行。',
  fallback: '收到。这个原型里我演示了：拉人、导入任务表、关联会话、新建联系人。',
  invite: 'grok' as PersonId,
  linkDm: 'dm-claude',
  replyDelay: 500,
  openDelay: 500,
} as const

export const IN_CONV = '在：'
