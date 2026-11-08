/* 群资料分栏的文案与常量:组件只引用,不写死。 */
import { BookOpen, Copy, Cpu, FileText, FolderGit2, Link2, Pin, Sparkles, type LucideIcon } from 'lucide-react'

export type GTab = 'members' | 'notice' | 'list' | 'cron' | 'plugin' | 'tools'
export const GTABS: GTab[] = ['members', 'notice', 'list', 'cron', 'plugin', 'tools']
export const GTAB_LABEL: Record<GTab, string> = { members: '成员', notice: '公告', list: '清单', cron: '定时', plugin: '插件', tools: '工具' }

export const TASK_FORM = {
  title: '新建任务',
  titlePh: '任务标题',
  descPh: '详细描述（可选）',
  wherePh: '在哪个群',
  who: '谁做（可选）',
  cancel: '取消',
  submit: '创建',
} as const

/** 成员的实时状态 → 文字和色调(颜色不单独表达含义) */
export const LIVE_TEXT = { idle: '', running: '在干活', waiting: '等你', error: '出错' } as const
export const LIVE_TONE = { idle: 'neutral', running: 'run', waiting: 'warm', error: 'err' } as const

export const NOTICE = {
  title: '群公告',
  add: '发布新公告',
  placeholder: '写一条公告（1–600 字）。发布后每个助手接活前都会装配它',
  published: '已发布。助手下次接活前，软件会把它装配进上下文',
  max: 600,
  pinned: '置顶',
  empty: '还没有群公告',
} as const

export const PLUGIN_TAB = {
  title: '本群插件',
  add: '添加插件',
  pickerHead: '已安装、还没挂到本群',
  allAttached: '装好的插件都挂上了',
  market: '去插件市场找更多',
  empty: '本群还没挂插件。',
  emptyHint: '挂上以后，群里的助手才能用它。',
  foot: '启停对所有聊天生效；「×」只从本群摘下。点名字看权限和命令。',
  disabled: '已停用 · 所有聊天都暂时用不了',
} as const

export const TOOLS = {
  builtin: '内置',
  fromPlugins: '本群插件带来的',
  noPluginCmds: '本群挂的插件没有提供命令。在「插件」页签添加。',
  foot: '在输入框里打 / 也能叫出这些命令。',
} as const

export type ToolHow = '执行' | '打开' | '填入输入框'
/** 内置工具:每项写清做什么、对应哪条 / 命令、点了是执行还是打开(打开的页面 key 与 push 的 t 一致) */
export const BUILTIN_TOOLS: { key: string; icon: LucideIcon; title: string; cmd: string; desc: string; how: ToolHow; page?: 'playbook' | 'files' | 'workspace' | 'links' | 'commits' | 'pool' | 'clone' }[] = [
  { key: 'summary', icon: Sparkles, title: '总结未读', cmd: 'summary', desc: '让 Helper 把你不在时的消息总结成几条要点，发在本群，每条能点回原消息', how: '执行' },
  { key: 'playbook', icon: BookOpen, title: '协作手册', cmd: 'playbook', desc: '本群的约定和流程，助手接活前会读；改动要你批准', how: '打开', page: 'playbook' },
  { key: 'files', icon: FileText, title: '群文件', cmd: 'files', desc: '本群发过的文件和助手产出的文档', how: '打开', page: 'files' },
  { key: 'workspace', icon: FolderGit2, title: '工作区', cmd: 'workspace', desc: '本群的代码目录，看各助手的提交', how: '打开', page: 'workspace' },
  { key: 'links', icon: Link2, title: '关联会话', cmd: 'links', desc: '把私聊记录关联进来，本群的助手才看得到', how: '打开', page: 'links' },
  { key: 'commits', icon: Pin, title: '记下的事', cmd: 'pins', desc: '助手答应过的事，比如「有进度就 @你」', how: '打开', page: 'commits' },
  { key: 'compute', icon: Cpu, title: '临时算力', cmd: 'pool', desc: '本群借给助手的临时算力，用完归还', how: '打开', page: 'pool' },
  { key: 'clone', icon: Copy, title: '复制团队', cmd: 'clone', desc: '把成员和协作手册复制到新群；聊天、任务和凭据不带', how: '打开', page: 'clone' },
]

export const MEMBERS = {
  search: '搜成员',
  dropOut: '拖到这里移出群（它借的群算力会先停下归还）',
} as const

/** 标题栏头像叠最多露几个 */
export const STACK_MAX = 5
