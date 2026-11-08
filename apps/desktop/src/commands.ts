import type { SlashCommand, SlashPluginState } from '@g-group/ui-core'
import type { Plugin } from './data'

/* 斜杠命令清单（演示数据）。将来由后端 commands.list 按会话给：内置命令 + 插件注册的 + 在场助手声明的。
   这里的内置命令就是旧「群资料 · 工具」页签里的 8 项，加上清单、公告、定时、交给助手。 */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'summary', aliases: ['ketchup'], title: '总结未读', desc: '把你不在时的消息总结成几条，只读，不替你批准任何事', args: [], source: 'builtin', scope: 'group' },
  { name: 'todo', title: '加到清单', desc: '把一件事加进群清单，等助手认领', args: [{ name: '内容', kind: 'text', required: true, rest: true, hint: '要做的事，比如「补登录页的测试」' }], source: 'builtin', scope: 'group' },
  {
    name: 'schedule', title: '定时', desc: '到点叫一位助手做一件事', source: 'builtin', scope: 'any',
    args: [
      { name: '何时', kind: 'time', required: true, hint: '每天9点、工作日18:30；带空格的用引号包住，如 "0 9 * * 1-5"' },
      { name: '做什么', kind: 'text', required: true, rest: true, hint: '醒来要做的事，比如「总结昨天的报错」' },
    ],
  },
  { name: 'notice', title: '改群公告', desc: '把群公告换成你写的这段，助手下次接活按新的来', args: [{ name: '内容', kind: 'text', required: true, rest: true, hint: '新的公告' }], source: 'builtin', scope: 'group' },
  {
    name: 'handoff', title: '交给助手', desc: '@ 一位助手，把一件事交给它', source: 'builtin', scope: 'group',
    args: [
      { name: '谁', kind: 'person', required: true, hint: '@ 一位在群里的助手' },
      { name: '事', kind: 'text', required: true, rest: true, hint: '要它做什么' },
    ],
  },
  { name: 'files', title: '群文件', desc: '这里发过、做出来的文件', args: [], source: 'builtin', scope: 'any' },
  { name: 'workspace', title: '工作区', desc: '本群挂的代码仓库，谁提交了什么', args: [], source: 'builtin', scope: 'group' },
  { name: 'links', title: '关联会话', desc: '和这个群关联的其他会话', args: [], source: 'builtin', scope: 'group' },
  { name: 'pins', title: '记下的事', desc: '助手在这里答应过、记下来的事', args: [], source: 'builtin', scope: 'any' },
  { name: 'playbook', title: '协作手册', desc: '本群定下的分工和做事规矩', args: [], source: 'builtin', scope: 'group' },
  { name: 'pool', title: '临时算力', desc: '给本群借几格算力，做完自动还', args: [], source: 'builtin', scope: 'group' },
  { name: 'clone', title: '复制团队', desc: '把这群助手和分工复制到新项目', args: [], source: 'builtin', scope: 'group' },
]

/* 插件注册的命令。版本跟插件当前版本走（插件更新后重新注册）；执行前宿主还要按 toRunParams 里的版本再核一遍 */
const PLUGIN_COMMANDS: (Omit<SlashCommand, 'version' | 'source'> & { plugin: string })[] = [
  { plugin: 'p-feishu', name: 'feishu', title: '飞书消息', desc: '从飞书群里勾几条消息，挂到引用条上', args: [], scope: 'any' },
  {
    plugin: 'p-gmail', name: 'mail', title: '发邮件', desc: '让有授权的助手替你发一封邮件', scope: 'any',
    args: [
      { name: '收件人', kind: 'text', required: true, hint: '邮箱，只能是插件授权过的地址' },
      { name: '内容', kind: 'text', required: true, rest: true, hint: '邮件正文' },
    ],
  },
  { plugin: 'p-cve', name: 'cve', title: '查漏洞公告', desc: '按关键词查最近的漏洞公告', args: [{ name: '关键词', kind: 'text', required: false, rest: true, hint: '比如 openssl，不填看最近的' }], scope: 'any' },
  { plugin: 'p-pulse', name: 'pulse', title: '动向时间线', desc: '看本群每段讨论的摘要', args: [], scope: 'group' },
  { plugin: 'p-hook', name: 'webhook', title: '推到 Webhook', desc: '把一段结果 POST 到你给的地址', args: [{ name: '内容', kind: 'text', required: true, rest: true, hint: '要推出去的内容' }], scope: 'any' },
  { plugin: 'p-tg', name: 'telegram', title: 'Telegram 消息', desc: '从 Telegram 群里勾几条消息带进对话', args: [], scope: 'any' },
]

/* 助手声明的命令：只有它在这个会话里才出现；执行 = 在群里 @ 它说这件事 */
export const ASSISTANT_COMMANDS: SlashCommand[] = [
  { name: 'review', title: '代码审查', desc: '请 Claude Code 审查一段改动，结论回到这里', args: [{ name: '看什么', kind: 'text', required: true, rest: true, hint: '分支、文件，或一句话说明' }], source: 'assistant:claude', scope: 'any' },
  { name: 'research', title: '查资料', desc: '请 Grok 查资料，结论附来源', args: [{ name: '主题', kind: 'text', required: true, rest: true, hint: '想查什么' }], source: 'assistant:grok', scope: 'any' },
]

/** 外部数据源插件 → 现有「勾选消息」页（sources 里的 id） */
export const SOURCE_PAGE: Record<string, string> = { 'p-feishu': 'feishu', 'p-tg': 'telegram' }

export function allCommands(plugins: Plugin[]): SlashCommand[] {
  const ver = (id: string) => plugins.find((p) => p.id === id)?.ver
  const fromPlugins = PLUGIN_COMMANDS.map(({ plugin, ...c }): SlashCommand => {
    const v = ver(plugin)
    return v === undefined ? { ...c, source: `plugin:${plugin}` } : { ...c, source: `plugin:${plugin}`, version: v }
  })
  return [...BUILTIN_COMMANDS, ...fromPlugins, ...ASSISTANT_COMMANDS]
}

/** 插件此刻的状态（给 availableCommands 判断能不能用） */
export function pluginStates(plugins: Plugin[], conv: string): SlashPluginState[] {
  return plugins.map((p) => ({ id: p.id, name: p.name, installed: p.installed, enabled: (p as { enabled?: boolean }).enabled !== false, authorized: !p.revoked, attached: p.convs.includes(conv), version: p.ver }))
}
