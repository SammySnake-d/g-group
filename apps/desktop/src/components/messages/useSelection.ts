import { useState } from 'react'

/** 多选消息(转发、收藏):选中集合 + 切换 + 清空 */
export function useSelection() {
  const [sel, setSel] = useState<Set<string>>(new Set())
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return { sel, toggle, clear: () => setSel(new Set()) }
}
