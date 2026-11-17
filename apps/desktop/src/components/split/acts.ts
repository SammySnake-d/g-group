import { AlertCircle, Brain, FileText, GitBranch, HelpCircle, Pencil, Search, Send, ShieldCheck, Terminal, Undo2, User } from 'lucide-react'
import type { ActKind } from '@/data'

/* 活动流每种事件的图标和名字(参照 Devin Activity / Copilot session log 的类型化事件) */
export const ACT: Record<ActKind, { I: typeof FileText; label: string }> = {
  think: { I: Brain, label: '想法' },
  read: { I: FileText, label: '读文件' },
  search: { I: Search, label: '搜索' },
  edit: { I: Pencil, label: '改文件' },
  cmd: { I: Terminal, label: '命令' },
  review: { I: ShieldCheck, label: '复核' },
  report: { I: Send, label: '汇报' },
  user: { I: User, label: '你补充' },
  ask: { I: HelpCircle, label: '顺便问' },
  answer: { I: HelpCircle, label: '回答' },
  sub: { I: GitBranch, label: '子任务' },
  error: { I: AlertCircle, label: '出错' },
  rollback: { I: Undo2, label: '回滚' },
}
