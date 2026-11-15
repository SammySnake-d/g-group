import type { SlashCommand as HostCommand } from '@g-group/api-contract'
import type { SlashCommand } from '@g-group/ui-core'
import { people, type Conversation } from '@/data'

/** 将宿主的参数合同转成输入框提示；群里 contact 必填，私聊隐含为对方。 */
export function hostCommand(c: HostCommand, conv: Conversation): SlashCommand {
  const args = c.args.filter((a) => a.kind !== 'contact')
  const contact = c.args.find((a) => a.kind === 'contact')
  const ordered = [...(conv.kind === 'group' && contact ? [{ ...contact, required: true }] : []), ...args]
  return { name: c.name, title: c.description, desc: c.description, source: c.source === 'builtin' ? 'builtin' : c.pluginId ? `plugin:${c.pluginId}` : c.targetContactId ? `assistant:${c.targetContactId}` : 'builtin', scope: 'any', args: ordered.map((a, i) => ({ name: a.name, kind: a.kind === 'contact' ? 'person' : a.kind === 'cron' ? 'time' : a.kind, required: a.required, hint: a.description, ...(a.choices ? { options: a.choices } : {}), ...(i === ordered.length - 1 && a.kind === 'text' ? { rest: true } : {}) })) }
}

/** cron 的五段是一个参数；只在解析副本中加引号，发出的原文不变。 */
export function normalizeHostCron(text: string, c: HostCommand | undefined, conv: Conversation): string {
  if (!c?.args.some((a) => a.kind === 'cron')) return text
  const lead = /^\s*[/／][\w-]+\s+/.exec(text)
  if (!lead) return text
  let at = lead[0].length
  if (conv.kind === 'group' && c.args.some((a) => a.kind === 'contact')) {
    const names = conv.members.map((id) => people[id]?.name).filter((s): s is string => !!s).sort((a, b) => b.length - a.length)
    const who = names.find((n) => text.slice(at).startsWith('@' + n + ' '))
    if (!who) return text
    at += who.length + 2
  }
  const cron = /^([\d*,/\-]+\s+[\d*,/\-]+\s+[\d*,/\-]+\s+[\d*,/\-]+\s+[\d*,/\-]+)(?=\s|$)/.exec(text.slice(at))
  return cron ? text.slice(0, at) + '"' + cron[1] + '"' + text.slice(at + cron[1].length) : text
}
