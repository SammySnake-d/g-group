import { useMemo, useState } from 'react'
import { AlertCircle, ArrowUpRight, Check, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/ctx'
import type { Activity, Compute } from '@/data'
import { Button } from '@/components/ui/button'
import { ListItem } from '@/components/ui/list-row'
import { Spinner } from '@/components/ui/spinner'
import { Avatar } from '@/components/Avatar'
import { ACT } from './acts'
import { Collapse } from './Collapse'

/* 过程:左边步骤(可点筛选,再点一次取消),右边按步骤分组的活动流;默认展开最新一条 */

/** 行状按钮:整行可点、左对齐、能换行(Button 原语的默认是居中单行) */
const rowBtn = 'h-auto w-full justify-start whitespace-normal rounded-lg text-left font-normal active:scale-100'

function StepIcon({ c, state }: { c: Compute; state: Compute['steps'][number]['state'] }) {
  if (state === 'done') return <Check className="h-3.5 w-3.5 text-fg-3" strokeWidth={2.5} />
  if (state === 'fail') return <AlertCircle className="h-3.5 w-3.5 text-err" />
  if (state === 'now' && c.status === 'running') return <Spinner size="xs" />
  return <span className="h-2 w-2 rounded-full border border-fg-3" />
}

export function ActivityView({ c }: { c: Compute }) {
  const { jump } = useApp()
  const [step, setStep] = useState<number | null>(null)
  const latest = c.activity[c.activity.length - 1]?.id
  const [open, setOpen] = useState<Set<string>>(() => new Set(latest ? [latest] : []))
  const list = useMemo(() => c.activity.filter((a) => step === null || a.step === step), [c.activity, step])
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return (
    <div className="flex gap-5" data-testid="activity">
      <ol className="w-[168px] shrink-0 pt-0.5" aria-label="按步骤筛选">
        <li>
          <Button variant="ghost" aria-pressed={step === null} onClick={() => setStep(null)} className={cn(rowBtn, 'mb-1 px-2 py-1 text-[12.5px] tabular-nums', step === null ? 'bg-hover font-medium text-fg' : 'hover:bg-hover/60')}>全部 · {c.activity.length} 条</Button>
        </li>
        {c.steps.map((s, i) => {
          const n = c.activity.filter((a) => a.step === i).length
          return (
            <li key={i}>
              <Button variant="ghost" data-testid={`step-${i}`} aria-pressed={step === i} onClick={() => setStep(step === i ? null : i)} className={cn(rowBtn, 'items-start gap-2 px-2 py-1.5 text-[12.5px] [&_svg]:size-3.5', step === i ? 'bg-hover' : 'hover:bg-hover/60')}>
                <span className="mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center"><StepIcon c={c} state={s.state} /></span>
                <span className={cn('min-w-0 flex-1 leading-[20px]', s.state === 'todo' ? 'text-fg-3' : s.state === 'now' ? 'font-medium text-fg' : s.state === 'fail' ? 'text-err' : 'text-fg-2')}>{s.text}</span>
                {n > 0 && <span className="text-[11px] tabular-nums text-fg-3">{n}</span>}
              </Button>
            </li>
          )
        })}
      </ol>
      <div className="min-w-0 flex-1">
        {list.length === 0 && <div className="py-8 text-center text-[13px] text-fg-3">这一步还没开始</div>}
        {list.map((a, i) => {
          const prev = list[i - 1]
          return (
            <div key={a.id}>
              {(!prev || prev.step !== a.step) && step === null && <div className="mb-1 mt-3 truncate text-[11.5px] font-medium text-fg-3 first:mt-0">{c.steps[a.step]?.text}</div>}
              <ActRow a={a} open={open.has(a.id)} onToggle={() => toggle(a.id)} onLink={jump} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ActRow({ a, open, onToggle, onLink }: { a: Activity; open: boolean; onToggle: () => void; onLink: (id: string) => void }) {
  const K = ACT[a.kind]
  const can = !!a.detail || !!a.files?.length || !!a.link
  const userish = a.kind === 'user' || a.kind === 'ask'
  const media = a.who ? <Avatar id={a.who} size={18} status={false} mood="idle" /> : <K.I aria-label={K.label} className={cn('h-[15px] w-[15px] shrink-0', a.kind === 'error' ? 'text-err' : userish ? 'text-warm' : 'text-fg-3')} strokeWidth={1.75} />
  const title = <span className={cn('text-[13.5px] font-normal', a.kind === 'think' ? 'italic text-fg-2' : a.kind === 'error' ? 'text-err' : 'text-fg')}>{a.title}</span>
  const meta = (
    <>
      {a.dur && <span className="shrink-0 text-[11.5px] tabular-nums text-fg-3">{a.dur}</span>}
      <span className="shrink-0 text-[11.5px] tabular-nums text-fg-3">{a.at}</span>
    </>
  )
  return (
    <div className={cn('rounded-lg transition-colors duration-fast ease-out', open && can && 'bg-hover/50')} data-testid={`act-${a.id}`}>
      {can ? (
        <ListItem aria-expanded={open} onClick={onToggle} media={media} title={title} className="gap-2.5 rounded-lg px-2 py-1.5 hover:bg-hover/60"
          trailing={<>{meta}<ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-fg-3 transition-transform duration-fast ease-out', open && 'rotate-90')} /></>} />
      ) : (
        <div className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5">{media}<span className="min-w-0 flex-1 truncate">{title}</span>{meta}</div>
      )}
      <Collapse open={open && can}>
        <div className="px-2 pb-2 pl-[34px]">
          {a.detail && <pre className="scroll-thin max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-bg px-3 py-2 font-mono text-[12px] leading-[1.6] text-fg-2">{a.detail}</pre>}
          {a.files && <div className="mt-1 flex flex-wrap gap-1">{a.files.map((f) => <span key={f} className="max-w-full truncate rounded bg-bg px-1.5 py-0.5 font-mono text-[11.5px] text-fg-2">{f}</span>)}</div>}
          {a.link && <Button variant="link" onClick={() => onLink(a.link!)} className="mt-1 h-auto gap-1 px-0 text-[12.5px] font-normal text-fg-2 hover:text-fg [&_svg]:size-3">在聊天里看<ArrowUpRight /></Button>}
        </div>
      </Collapse>
    </div>
  )
}
