import { completeToken, detectSlash, filterCommands, parseInvocation, parseSource, removeToken, type SlashEntry, type SlashInvocation } from '@g-group/ui-core'
import { useEffect, useMemo, useState } from 'react'
import { SOURCE_PAGE } from '@/commands'
import { people, type Conversation } from '@/data'
import { findInfo } from '@/pluginInfo'
import { useApp } from '@/store'
import { slashEntries } from '@/store/select'

/** 后端这个会话没给这条命令 */
const NOT_OFFERED = '后端在这个会话没提供这条命令'

type Args = {
  conv: Conversation
  draft: string
  setDraft: (v: string) => void
  /** 光标位置和输入框是否聚焦:决定 / 菜单开不开 */
  caret: number
  focused: boolean
  editing: boolean
  placeCaret: (p: number) => void
  onSend: (text?: string) => void
  inputRef: { current: HTMLTextAreaElement | null }
}

/** 斜杠命令:识别光标处的 /token、过滤菜单、解析参数、执行。Telegram 式:选中后在输入框里提示该填的参数 */
export function useSlash({ conv, draft, setDraft, caret, focused, editing, placeCaret, onSend, inputRef }: Args) {
  const { plugins, pluginCatalog, offered, loadCommands, push, toast, summarize, addTask, setNotice, openSplit, openSchedule } = useApp((s) => ({
    plugins: s.plugins, pluginCatalog: s.pluginCatalog, offered: s.roomCommands[conv.id], loadCommands: s.loadCommands,
    push: s.push, toast: s.toast, summarize: s.summarize, addTask: s.addTask, setNotice: s.setNotice, openSplit: s.openSplit, openSchedule: s.openSchedule,
  }))
  const [slashIdx, setSlashIdx] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [nudge, setNudge] = useState(0)
  /* 命令清单:本地按会话现算(含灰显原因);后端经 commands.list 给了这个会话的清单、且是按当前状态拉的,
     本地能用而后端没给的就灰掉。合同只给能用的命令,中文名、别名、参数提示、灰显原因仍取本地(合同缺口) */
  useEffect(() => { loadCommands(conv.id) }, [conv.id, conv.members, plugins, loadCommands])
  const entries = useMemo(() => {
    const local = slashEntries({ plugins, pluginCatalog }, conv)
    if (!offered || offered.plugins !== plugins || offered.members !== conv.members) return local
    return local.map((e) => (!e.disabled && !offered.names.includes(e.command.name) ? { ...e, disabled: NOT_OFFERED } : e))
  }, [plugins, pluginCatalog, conv, offered])
  const assistantNames = useMemo(() => conv.members.filter((m) => m !== 'me' && !people[m]?.human).map((m) => people[m].name), [conv.members])
  const token = editing ? null : detectSlash(draft, Math.min(caret, draft.length))
  const tokenKey = token ? `${token.start}:${token.query}` : ''
  const menuOpen = !!token && focused && dismissed !== tokenKey
  const shown = menuOpen && token ? filterCommands(entries, token.query) : []
  const nUsable = shown.filter((e) => !e.disabled).length
  const sel = nUsable ? Math.min(slashIdx, nUsable - 1) : -1
  const inv = editing ? null : parseInvocation(draft, entries, { people: assistantNames })
  const unknown = !inv && !menuOpen && !editing ? /^\s*[/／]([a-z0-9][a-z0-9-]*)(?=\s|$)/i.exec(draft)?.[1] : undefined

  useEffect(() => { setSlashIdx(0) }, [token?.query])

  /** 执行一条命令。返回 true = 做了,输入框清空;false = 没做(要等后端、被拦),草稿留着 */
  const run = (v: SlashInvocation): boolean => {
    const c = v.command
    const val = (k: string) => v.values[k] ?? ''
    if (v.blocked) { toast(v.blocked); return false }
    const src = parseSource(c.source)
    if (src?.kind === 'assistant') { onSend(`@${people[src.id].name} ${c.title}：${Object.values(v.values).join(' ')}`); return true }
    if (src?.kind === 'plugin') {
      const page = SOURCE_PAGE[src.id]
      if (page) { push({ t: 'source', id: page }, true); return true }
      if (src.id === 'g-group.pulse') { openSplit({ t: 'group', id: conv.id, tab: 'plugin' }); return true }
      toast(`插件命令要等后端连接：${findInfo(plugins, src.id)?.name ?? src.id} 的 /${c.name} 现在还不能真的执行`)
      return false
    }
    switch (c.name) {
      case 'summary': summarize(conv.id); return true
      case 'todo': addTask({ text: val('内容'), conv: conv.id }); return true
      case 'notice': setNotice(conv.id, val('内容')); return true
      case 'schedule': openSchedule({ conv: conv.id, when: val('何时'), what: val('做什么'), via: 'slash' }); return true
      case 'handoff': onSend(`@${val('谁')} ${val('事')}`); return true
      case 'files': push({ t: 'files', id: conv.id }, true); return true
      case 'workspace': push({ t: 'workspace', id: conv.id }, true); return true
      case 'links': push({ t: 'links', id: conv.id }, true); return true
      case 'pins': push({ t: 'commits', id: conv.id }, true); return true
      case 'playbook': push({ t: 'playbook', id: conv.id }, true); return true
      case 'pool': push({ t: 'pool', id: conv.id }, true); return true
      case 'clone': push({ t: 'clone', id: conv.id }, true); return true
    }
    toast(`/${c.name} 还没接上`)
    return false
  }

  /** 从菜单里选中:不带参数的直接执行(Tab 只补全);带参数的把 /name 填进输入框,等你填参数 */
  const choose = (e: SlashEntry, how: 'enter' | 'tab' | 'click') => {
    if (!token || e.disabled) return
    const c = e.command
    if (how !== 'tab' && c.args.length === 0) {
      const r = removeToken(draft, token)
      setDraft(r.text); placeCaret(r.cursor)
      const one = parseInvocation(`/${c.name}`, [e])
      if (one) run(one)
      return
    }
    const r = completeToken(draft, token, c.name)
    setDraft(r.text); placeCaret(r.cursor)
  }

  /** 回车:是命令就执行(参数不全时提醒缺什么),否则当普通消息发 */
  const submit = () => {
    if (inv) {
      if (!inv.ok) { setNudge((n) => n + 1); if (inv.blocked) toast(inv.blocked); return }
      if (run(inv)) setDraft('')
      return
    }
    onSend()
  }

  /** 工具栏的 / 按钮:光标处已有 /token 就重新弹出,否则插一个 / */
  const open = () => {
    setDismissed(null)
    if (token) { placeCaret(caret); return }
    const pos = inputRef.current?.selectionStart ?? draft.length
    const before = draft.slice(0, pos)
    const ins = before === '' || /\s$/.test(before) ? '/' : ' /'
    setDraft(before + ins + draft.slice(pos))
    placeCaret(pos + ins.length)
  }

  /** 菜单开着时接管方向键、回车、Tab、Esc;返回 true = 已处理 */
  const onMenuKey = (e: React.KeyboardEvent): boolean => {
    if (!menuOpen) return false
    if (nUsable && e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((sel + 1) % nUsable); return true }
    if (nUsable && e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((sel - 1 + nUsable) % nUsable); return true }
    if (nUsable && (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) { e.preventDefault(); choose(shown[sel]!, e.key === 'Tab' ? 'tab' : 'enter'); return true }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(tokenKey); return true }
    return false
  }

  return { token, menuOpen, shown, sel, setSlashIdx, inv, unknown, nudge, choose, submit, open, onMenuKey }
}
