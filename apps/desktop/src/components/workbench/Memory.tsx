import { useState } from 'react'
import { people, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { SectionHeader } from '@/components/ui/section'
import { Hint, TextInput } from '@/components/pages/kit/parts'
import { TextLink, WbCard } from './parts'

/* 记忆(MEMORY.md):它自己写,你可以纠正或删除;每条带出处,出处是消息就能点回去 */
export function Memory({ id }: { id: PersonId }) {
  const { jump, updatePerson } = useApp()
  const p = people[id]
  const [list, setList] = useState(p.memory ?? [])
  const [fixing, setFixing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const save = (next: typeof list, note: string) => { setList(next); updatePerson(id, { memory: next }, note) }
  return (
    <WbCard testid="wb-memory">
      <SectionHeader title="记忆（MEMORY.md）" />
      <Hint className="mb-2 text-[12px]">它自己写，你可以删或纠正。每条都记着是从哪句话学来的。</Hint>
      {list.length === 0 && <div className="py-2 text-[13px] text-fg-3">它还没记下什么</div>}
      <div className="divide-y divide-line">
        {list.map((m, i) => {
          const msgId = /^#([A-Za-z][\w-]*)$/.exec(m.src)?.[1]
          return (
            <div key={i + m.text} className="flex min-h-11 items-center gap-2 py-1.5">
              {fixing === i ? (
                <form className="flex min-w-0 flex-1 items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) save(list.map((x, j) => (j === i ? { ...x, text: draft.trim() } : x)), `纠正了一条记忆：${draft.trim()}`); setFixing(null) }}>
                  <TextInput dense autoFocus data-testid={`mem-fix-input-${i}`} value={draft} onChange={(e) => setDraft(e.target.value)} className="flex-1"
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setFixing(null) } }} />
                  <Button type="submit" variant="primary" size="sm" data-testid={`mem-fix-save-${i}`}>保存</Button>
                  <Button variant="ghost" size="sm" onClick={() => setFixing(null)}>取消</Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 text-[13.5px] [text-wrap:pretty]">{m.text}</span>
                  {msgId ? <TextLink testid={`mem-src-${i}`} onClick={() => jump(msgId)}>来自 {m.src}</TextLink>
                    : <span className="max-w-[40%] shrink-0 truncate text-[12px] text-fg-3">来自 {m.src}</span>}
                  <Button data-testid={`mem-fix-${i}`} variant="ghost" size="xs" onClick={() => { setDraft(m.text); setFixing(i) }}>纠正</Button>
                  <Button data-testid={`mem-del-${i}`} variant="danger" size="xs" className="text-fg-2 hover:text-err" onClick={() => save(list.filter((_, j) => j !== i), `删了一条记忆：${m.text}`)}>删除</Button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </WbCard>
  )
}
