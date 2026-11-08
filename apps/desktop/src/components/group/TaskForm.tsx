/* 手动新建群清单项（总账 #17 / 遗漏核查 #930 #24）：标题 + 描述分开、谁做 + 在哪个群 */
import { useState } from 'react'
import { useApp } from '@/ctx'
import { people, type PersonId } from '@/data'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { Field, Input, SelectMenu, Textarea } from '@/components/ui/field'
import { cn } from '@/lib/utils'
import { TASK_FORM } from './constants'

export type NewTask = { text: string; desc?: string; who?: PersonId; conv: string }

export function TaskForm({ conv, onDone }: { conv?: string; onDone: (item?: NewTask) => void }) {
  const { convs } = useApp()
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [who, setWho] = useState<PersonId | undefined>(undefined)
  const [where, setWhere] = useState<string | undefined>(conv)
  const g = convs.find((x) => x.id === where)
  const candidates = (g ? g.members : Object.keys(people)).filter((p) => p !== 'me' && !people[p]?.human && p !== 'helper') as PersonId[]
  const ok = !!title.trim() && !!where
  return (
    <form data-testid="task-form" className="w-full max-w-md space-y-3 rounded-xl border border-line bg-elev p-3.5 shadow-soft"
      onSubmit={(e) => { e.preventDefault(); if (ok) onDone({ text: title.trim(), desc: desc.trim() || undefined, who, conv: where! }) }}>
      <div className="text-[13.5px] font-semibold">{TASK_FORM.title}</div>
      <Input autoFocus data-testid="task-form-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={TASK_FORM.titlePh} aria-label={TASK_FORM.titlePh} />
      <Textarea data-testid="task-form-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={TASK_FORM.descPh} aria-label={TASK_FORM.descPh} className="scroll-thin min-h-[80px] resize-y text-[13px]" />
      {!conv && (
        <SelectMenu testid="task-form-where" label={TASK_FORM.wherePh} placeholder={TASK_FORM.wherePh} value={where} onChange={setWhere}
          options={convs.filter((x) => x.kind === 'group').map((x) => ({ value: x.id, label: x.title }))} />
      )}
      <Field label={TASK_FORM.who} group layout="stack">
        <div className="flex flex-wrap gap-1.5">
          {candidates.map((p) => (
            <Button key={p} data-testid={`task-form-who-${p}`} aria-pressed={who === p} onClick={() => setWho((x) => (x === p ? undefined : p))} size={null} shape="pill" variant="outline"
              className={cn('h-7 gap-1 pl-1 pr-2.5 text-[12.5px] font-normal shadow-none', who === p && 'border-me/60 bg-me/10 text-me hover:bg-me/15')}>
              <Avatar id={p} size={18} status={false} mood="idle" />{people[p].name}
            </Button>
          ))}
        </div>
      </Field>
      <div className="flex gap-2 pt-1">
        <Button data-testid="task-form-cancel" variant="ghost" size="md" className="flex-1" onClick={() => onDone()}>{TASK_FORM.cancel}</Button>
        <Button type="submit" data-testid="task-form-submit" variant="primary" size="md" className="flex-1" disabled={!ok}>{TASK_FORM.submit}</Button>
      </div>
    </form>
  )
}
