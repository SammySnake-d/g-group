import type { PluginManifest, SlashArg, SlashCommand, SlashPluginState } from '@g-group/ui-core'
import type { PluginState } from './data'
import { pinfo } from './pluginInfo'

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

/* 助手声明的命令：只有它在这个会话里才出现；执行 = 在群里 @ 它说这件事 */
export const ASSISTANT_COMMANDS: SlashCommand[] = [
  { name: 'review', title: '代码审查', desc: '请 Claude Code 审查一段改动，结论回到这里', args: [{ name: '看什么', kind: 'text', required: true, rest: true, hint: '分支、文件，或一句话说明' }], source: 'assistant:claude', scope: 'any' },
  { name: 'research', title: '查资料', desc: '请 Grok 查资料，结论附来源', args: [{ name: '主题', kind: 'text', required: true, rest: true, hint: '想查什么' }], source: 'assistant:grok', scope: 'any' },
]

/** 外部数据源插件 → 现有「勾选消息」页(sources 里的 id) */
export const SOURCE_PAGE: Record<string, string> = { 'g-group.feishu': 'feishu', 'openbridge.telegram': 'telegram' }

/** 插件注册的命令:从插件清单(contributes.commands)派生,单一真源。版本跟本机装的版本走,没装的按市场最新版显示并灰掉 */
export function pluginCommands(catalog: PluginManifest[], plugins: PluginState[]): SlashCommand[] {
  return catalog.flatMap((m) => {
    const ver = plugins.find((p) => p.id === m.id)?.manifest?.version ?? m.version
    return m.contributes.commands.map((c): SlashCommand => ({
      name: c.name, title: c.title, desc: c.desc, source: `plugin:${m.id}`, scope: 'any', version: ver,
      args: c.args.map((a, i): SlashArg => ({ name: a.name, kind: 'text', required: a.required, hint: a.desc, ...(i === c.args.length - 1 ? { rest: true } : {}) })),
    }))
  })
}

export function allCommands(catalog: PluginManifest[], plugins: PluginState[]): SlashCommand[] {
  const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.name))
  return [...BUILTIN_COMMANDS, ...pluginCommands(catalog, plugins).filter((c) => !builtinNames.has(c.name)), ...ASSISTANT_COMMANDS]
}

/** 每个市场插件此刻在这个会话的状态(给 availableCommands 判断能不能用、写灰显原因) */
export function pluginStates(catalog: PluginManifest[], plugins: PluginState[], conv: string): SlashPluginState[] {
  return catalog.map((m) => {
    const st = plugins.find((p) => p.id === m.id)
    const i = st ? pinfo(st) : undefined
    return { id: m.id, name: m.name, installed: !!i?.installed, enabled: !!i?.enabled, authorized: !i?.revoked, attached: !!i?.convs.includes(conv), version: i?.version ?? m.version }
  })
}
