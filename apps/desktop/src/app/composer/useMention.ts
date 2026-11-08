import { useEffect, useState } from 'react'
import { people, type Conversation } from '@/data'

type Args = { conv: Conversation; draft: string; setDraft: (v: string) => void; placeCaret: (p: number) => void; inputRef: { current: HTMLTextAreaElement | null } }

/** @ 选人:打 @ 或点工具栏 @ 弹出,按名字过滤;第一项是 Helper */
export function useMention({ conv, draft, setDraft, placeCaret, inputRef }: Args) {
  const [at, setAt] = useState<{ q: string } | null>(null)
  const [idx, setIdx] = useState(0)
  const cands = ['helper', ...conv.members.filter((m) => m !== 'me')].filter((m) => !at || people[m].name.toLowerCase().includes(at.q.toLowerCase()))
  useEffect(() => { setIdx(0) }, [at?.q])

  const pick = (id: string) => {
    const pos = inputRef.current?.selectionStart ?? draft.length
    const before = draft.slice(0, pos).replace(/@([^\s@]*)$/, '')
    const after = draft.slice(pos)
    const ins = '@' + people[id].name + ' '
    setDraft(before + ins + after)
    setAt(null)
    placeCaret(before.length + ins.length)
  }
  /** 输入变化时看光标前是不是正在打 @名字 */
  const track = (v: string, pos: number) => { const m = v.slice(0, pos).match(/@([^\s@]*)$/); setAt(m ? { q: m[1] } : null) }

  /** 选人列表开着时接管方向键、回车、Tab、Esc;返回 true = 已处理 */
  const onKey = (e: React.KeyboardEvent): boolean => {
    if (!at || !cands.length) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => (i + 1) % cands.length); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => (i - 1 + cands.length) % cands.length); return true }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(cands[idx]); return true }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAt(null); return true }
    return false
  }

  return { open: !!at && cands.length > 0, cands, idx, setIdx, pick, track, start: () => setAt({ q: '' }), close: () => setAt(null), onKey }
}
