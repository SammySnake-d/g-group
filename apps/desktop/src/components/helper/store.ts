import type { PItem } from './types'

/* Helper 的会话内存储(模块级,随页面存活):切换聊天、关掉再开面板都不丢 */

let seq = 0
/** 对话条目的 id */
export const nid = () => 'hl' + ++seq + '-' + Date.now().toString(36)

/** 面板输入框草稿:按聊天分别保存 */
export const drafts = new Map<string, string>()

/** 面板里和 Helper 的对话:按聊天分别保存 */
export const panelItems = new Map<string, PItem[]>()
