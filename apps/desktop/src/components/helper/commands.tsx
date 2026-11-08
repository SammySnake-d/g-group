import type { ReactNode } from 'react'
import { Search, UserPlus, Users, Puzzle, Clock, Send, Eye } from 'lucide-react'
import { READ_ASK, SEND_ASK, SEND_PREFIX } from './constants'

/* 全局 Helper(⌘K)的常用命令:两条「试试」+ 几个直达入口。动作由 HelperGlobal 注入 */

export type Cmd = { id: string; label: string; hint: string; icon: ReactNode; testid?: string; run: () => void }

export type CmdDeps = {
  /** 当前聊天的名字(「找某次聊天」在哪搜) */
  activeTitle: string
  ask: (text: string) => void
  fill: (text: string) => void
  close: () => void
  newContact: () => void
  newGroup: () => void
  plugins: () => void
  crons: () => void
  find: () => void
}

export function globalCommands(d: CmdDeps): Cmd[] {
  return [
    { id: 'read', label: READ_ASK, hint: '试试：先问你能不能读', icon: <Eye />, testid: 'hg-cmd-read', run: () => d.ask(READ_ASK) },
    { id: 'send', label: SEND_ASK, hint: '试试：先给你看草稿', icon: <Send />, testid: 'hg-cmd-send', run: () => d.ask(SEND_ASK) },
    { id: 'contact', label: '新建联系人', hint: '打开新建联系人', icon: <UserPlus />, run: d.newContact },
    { id: 'group', label: '发起群聊', hint: '选人建一个新群', icon: <Users />, run: d.newGroup },
    { id: 'plugins', label: '装插件', hint: '去「插件」', icon: <Puzzle />, run: d.plugins },
    { id: 'crons', label: '看所有定时', hint: '打开「进展」，停在定时那一节', icon: <Clock />, run: d.crons },
    { id: 'find', label: '找某次聊天', hint: `在「${d.activeTitle}」里搜`, icon: <Search />, run: d.find },
    { id: 'say', label: '代我在某个群发一句话', hint: '先出草稿，你点了才发', icon: <Send />, run: () => d.fill(SEND_PREFIX) },
  ]
}
