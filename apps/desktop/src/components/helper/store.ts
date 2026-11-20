import type { PItem } from './types'


let seq = 0
export const nid = () => 'hl' + ++seq + '-' + Date.now().toString(36)

export const drafts = new Map<string, string>()

export const panelItems = new Map<string, PItem[]>()
