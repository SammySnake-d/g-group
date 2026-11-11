import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { people, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { broken } from '@/mut'
import { Button } from '@/components/ui/button'
import { appear } from '@/components/pages/kit/motion'
import { transition } from '@/config/motion'
import { DOC_DEMO } from './constants'

/* AC-21 共享文档单一提交点:两人基于同一版本改,后提交者遇到版本冲突,不静默覆盖;冲突左右对照两版,等你选 */
type DocRev = { v: number; by: PersonId; text: string }

export function DocConflict({ sec, onResolved }: { sec: string; onResolved: (t: string) => void }) {
  const { pushMsg, active } = useApp()
  const [head, setHead] = useState<DocRev>({ v: 3, by: 'astra', text: sec })
  const [conflict, setConflict] = useState<{ mine: DocRev; theirs: DocRev } | null>(null)
  const [log, setLog] = useState<string[]>([])
  const commit = (by: PersonId, base: number, text: string) => {
    if (base !== head.v && !broken('AC-21')) {
      setConflict({ mine: { v: base, by, text }, theirs: head })
      pushMsg({ k: 'sys', id: 's' + Math.random().toString(36).slice(2, 8), text: `${people[by].name} 改「${DOC_DEMO.title}」${DOC_DEMO.section}时，${people[head.by].name} 已经先提交了 v${head.v}；没有覆盖，等你选` }, active)
      return
    }
    const n = { v: head.v + 1, by, text }; setHead(n); setLog((l) => [`v${n.v} · ${people[by].name}`, ...l]); onResolved(text)
  }
  const pick = (r: DocRev) => { const n = { v: head.v + 1, by: r.by, text: r.text }; setHead(n); setLog((l) => [`v${n.v} · 你选了 ${people[r.by].name} 的`, ...l]); setConflict(null); onResolved(r.text) }
  return (
    <div data-testid="doc-rev" data-v={head.v} className="mt-4 rounded-xl border border-line p-3 text-[13px]">
      <div className="flex items-center gap-2"><span className="font-medium tabular-nums">{DOC_DEMO.section} · 当前 v{head.v}</span><span className="text-fg-3">{people[head.by].name}</span></div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <Button data-testid="doc-demo-claude" variant="ghost" size="xs" onClick={() => commit('claude', 3, DOC_DEMO.claude)} className="h-6 px-2 text-[12px] font-normal">演示：Claude Code 基于 v3 提交</Button>
        <Button data-testid="doc-demo-argon" variant="ghost" size="xs" onClick={() => commit('argon', 3, DOC_DEMO.argon)} className="h-6 px-2 text-[12px] font-normal">演示：Argon 也基于 v3 提交</Button>
      </div>
      <AnimatePresence initial={false}>
        {conflict && (
          <motion.div key="conflict" {...appear} exit={{ opacity: 0, transition: transition.popOut }} data-testid="doc-conflict" role="alert" className="mt-2.5 rounded-lg border border-warm/50 bg-warm/5 p-2.5">
            <div className="mb-2 text-warm">版本冲突：{people[conflict.mine.by].name} 基于 v{conflict.mine.v} 改的，但 {people[conflict.theirs.by].name} 已经提交了 v{conflict.theirs.v}。没有覆盖，选一版：</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {[conflict.theirs, conflict.mine].map((r, i) => (
                <div key={i} className="flex flex-col rounded-md border border-line bg-bg p-2">
                  <div className="mb-1 text-[12px] tabular-nums text-fg-3">{i === 0 ? `已提交 v${r.v}` : `后到 · 基于 v${r.v}`} · {people[r.by].name}</div>
                  <div className="flex-1 leading-relaxed">{r.text}</div>
                  <Button data-testid={`doc-pick-${r.by}`} variant="primary" size="xs" onClick={() => pick(r)} className="mt-1.5 h-6 self-start px-2 text-[12px]">用这版</Button>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {log.length > 0 && <div className="mt-2 text-[12px] tabular-nums text-fg-3">版本：{log.join(' ← ')}</div>}
    </div>
  )
}
