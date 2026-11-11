import { useState } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PersonId } from '@/data'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { PageFooter } from '@/components/pages/kit/parts'
import { STEPS, type Item } from './constants'
import { cloneItems } from './items'
import { StepConfirm, StepName, StepPick } from './CloneSteps'

/* 群模板:复制团队到新项目,三步(概念卡第 12 张;#1160 #1172 #1278)。
   这里持有全部状态:第几步、群名、成员、哪些条目不带(本项目专属的默认不带,要勾才带) */

export function CloneFlow({ id }: { id: string }) {
  const { convs, playbook, createGroup, closeAll } = useApp()
  const g = convs.find((c) => c.id === id)
  const [step, setStep] = useState(0)
  const [title, setTitle] = useState(() => `${g?.title ?? '群'}（新项目）`)
  const allMembers = (g?.members ?? []).filter((m) => m !== 'me')
  const [members, setMembers] = useState<PersonId[]>(allMembers)
  const items = cloneItems(g, playbook, members)

  const [off, setOff] = useState<Record<string, boolean>>({})
  const [localOn, setLocalOn] = useState<Record<string, boolean>>({})
  const [openLocal, setOpenLocal] = useState(false)
  const picked = (it: Item) => (it.group === 'local' ? !!localOn[it.id] : !off[it.id])
  const toggle = (it: Item, v: boolean) => (it.group === 'local' ? setLocalOn((s) => ({ ...s, [it.id]: v })) : setOff((s) => ({ ...s, [it.id]: !v })))

  if (!g) return <div className="p-6 text-[14px] text-fg-3">找不到这个群</div>

  const kept = items.filter(picked)
  const dropped = items.filter((it) => !picked(it))
  const nRules = kept.filter((it) => it.group !== 'member').length
  const nMembers = members.length
  const canNext = step === 0 ? !!title.trim() && members.length > 0 : true

  const go = () => {
    createGroup(title.trim(), members, `从「${g.title}」复制了团队：带了 ${nMembers} 位成员、${nRules} 条规则和经验；没有带聊天记录、文件和任务`)
    closeAll()
  }

  return (
    <div data-testid="clone-flow" className="flex h-full min-h-0 flex-col">
      <Stepper step={step} />

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {step === 0 && <StepName title={title} setTitle={setTitle} allMembers={allMembers} members={members} setMembers={setMembers} />}
        {step === 1 && <StepPick items={items} picked={picked} toggle={toggle} openLocal={openLocal} setOpenLocal={setOpenLocal} />}
        {step === 2 && <StepConfirm title={title} members={members} allMembers={allMembers} kept={kept} dropped={dropped} nMembers={nMembers} nRules={nRules} />}
      </div>

      <PageFooter className="flex items-center gap-2">
        {step > 0 && <Button data-testid="clone-prev" variant="outline" size="md" onClick={() => setStep((s) => s - 1)} className="pl-3"><ChevronLeft />上一步</Button>}
        <span className="flex-1" />
        {step < 2 ? (
          <Button data-testid="clone-next" variant="primary" size="md" disabled={!canNext} onClick={() => setStep((s) => s + 1)} className="px-5">下一步</Button>
        ) : (
          <Button data-testid="clone-go" variant="primary" size="md" onClick={go} className="px-5">创建新群</Button>
        )}
      </PageFooter>
    </div>
  )
}

/** 步骤指示:做完的打勾、当前的墨色实心、没到的空心;当前步 aria-current=step */
function Stepper({ step }: { step: number }) {
  return (
    <ol className="flex items-center gap-1.5 border-b border-line px-4 py-3">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i === step ? 'step' : undefined} className="flex min-w-0 items-center gap-1.5">
          <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular-nums transition-colors duration-base ease-out',
            i < step ? 'bg-hover text-fg-2' : i === step ? 'bg-fg text-bg' : 'border border-line text-fg-3')}>
            {i < step ? <Check className="h-3 w-3" strokeWidth={2.5} /> : i + 1}
          </span>
          <span className={cn('truncate text-[12.5px]', i === step ? 'font-medium text-fg' : 'text-fg-3')}>{s}</span>
          {i < STEPS.length - 1 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-3" />}
        </li>
      ))}
    </ol>
  )
}
