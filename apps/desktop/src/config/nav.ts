import { Activity, FolderOpen, MessageCircle, Puzzle, Users, type LucideIcon } from 'lucide-react'
import type { Section } from '@/ctx'

// 左侧导航的一级入口(R-16:每个入口对应一个用户故事)。「进展」是遮罩,不是一级页面(#1618)。
export type NavKey = Section | 'activity'
export interface NavItem { key: NavKey; label: string; icon: LucideIcon; signal?: 'badge' | 'dot' }
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'chat', label: '消息', icon: MessageCircle, signal: 'badge' },
  { key: 'contacts', label: '通讯录', icon: Users },
  { key: 'activity', label: '进展', icon: Activity, signal: 'dot' },
  { key: 'files', label: '文件', icon: FolderOpen },
  { key: 'plugins', label: '插件', icon: Puzzle },
]
