/* 群清单：属于群（#1246）。业务状态，不照搬 Compute（Astra）。待验收的醒目，进行中的转圈，已完成的收成一行。
   待认领的：有推荐人就「让它领」；没有就「交给…」挑本群一位联系人——都是以你的一条消息 @ 它，由它认领并起 Compute。 */
import { useState } from 'react'
import { Check, ChevronRight, Plus } from 'lucide-react'
import * as Collapsible from '@animate-ui/react/primitives/radix-ui/collapsible'
import { useApp } from '@/ctx'
import { people, type Conversation, type ListItem } from '@/data'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { TaskForm } from './TaskForm'

/** 交给本群哪位联系人(移出中的不算) */
function AssignMenu({ conv, t }: { conv: Conversation; t: ListItem }) {
  const { claimTask } = useApp()
  const who = conv.members.filter((m) => m !== 'me' && m !== 'helper' && !people[m]?.human && !conv.leaving?.includes(m))
  if (!who.length) return null
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button data-testid={`task-assign-${t.id}`} variant="ghost" size="xs" className="h-6 px-1.5 text-[11.5px]">交给…</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="task-assign-menu" className="w-44 rounded-xl border-line bg-elev p-1 shadow-elev">
        {who.map((p) => (
          <DropdownMenuItem key={p} data-testid={`task-assign-pick-${p}`} onSelect={() => claimTask(t.id, p)} className="gap-2 rounded-lg text-[13px]">
            <Avatar id={p} size={18} status={false} mood="idle" />{people[p].name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ChecklistTab({ conv }: { conv: Conversation }) {
  const { checklist, computes, claimTask, addTask, openSplit } = useApp()
  const [open, setOpen] = useState(true)
  const [adding, setAdding] = useState(false)
  const items = checklist.filter((t) => t.conv === conv.id)
  const done = items.filter((t) => t.status === '已完成').length
  return (
    <section className="px-2 pb-2 pt-1" data-testid="side-checklist" id="side-checklist">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <div className="mb-1 flex items-center gap-1">
          <Collapsible.Trigger asChild>
            <Button variant="ghost" size={null} className="h-7 min-w-0 flex-1 justify-start gap-1 px-2 text-left font-normal active:scale-100">
              <span className="flex-1 text-[13px] font-semibold text-fg">群清单</span>
              <span className="text-[12px] tabular-nums text-fg-3">{done}/{items.length} 完成</span>
              <ChevronRight className={cn('h-3.5 w-3.5 text-fg-3 transition-transform duration-fast ease-out', open && 'rotate-90')} />
            </Button>
          </Collapsible.Trigger>
          <Button data-testid="side-task-add" variant="ghost" size="xs" className="h-7 gap-0.5 px-1.5" onClick={() => setAdding(true)}><Plus />新建</Button>
        </div>
        {adding && <div className="px-1 pb-2"><TaskForm conv={conv.id} onDone={(t) => { if (t) addTask(t); setAdding(false) }} /></div>}
        <Collapsible.Content>
          {items.filter((t) => t.status !== '已完成').map((t) => {
            const wait = t.status === '待验收'
            return (
              <div key={t.id} data-testid={`task-${t.id}`} data-status={t.status} className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5', wait && 'bg-warm-soft')}>
                <span aria-hidden className={cn('grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border', wait ? 'border-warm bg-warm-dot/30' : t.status === '进行中' ? 'border-run' : 'border-fg-3/60')}>
                  {t.status === '进行中' && <span className="spin-ring !h-2.5 !w-2.5 !border" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={cn('truncate text-[12.5px]', wait && 'font-semibold')}>{t.text}</div>
                  {t.desc && <div data-testid={`task-desc-${t.id}`} className="truncate text-[11.5px] text-fg-2" title={t.desc}>{t.desc}</div>}
                  <div className={cn('truncate text-[11px]', wait ? 'text-warm' : 'text-fg-3')}>
                    {t.status === '待认领' ? (t.suggest ? `待认领 · 推荐 ${people[t.suggest].name}（${t.why}）` : '待认领') : `${t.status} · ${people[t.who!].name}`}
                    {t.attempts.length > 0 && t.status === '进行中' && ` · ${computes[t.attempts[0]]?.phase ?? ''}`}
                  </div>
                </div>
                {t.status === '待认领' && (t.suggest ? <Button data-testid={`task-claim-${t.id}`} variant="ghost" size="xs" className="h-6 px-1.5 text-[11.5px]" onClick={() => claimTask(t.id, t.suggest!)}>让它领</Button> : <AssignMenu conv={conv} t={t} />)}
                {wait && t.attempts[0] && <Button variant="ghost" size="xs" className="h-6 px-1.5 text-[11.5px]" onClick={() => openSplit({ t: 'compute', id: t.attempts[0] })}>看过程</Button>}
              </div>
            )
          })}
          {done > 0 && <div className="flex items-center gap-1 px-2 py-1 text-[11.5px] text-fg-3"><Check className="h-3 w-3" />已完成 <span className="tabular-nums">{done}</span> 项</div>}
        </Collapsible.Content>
      </Collapsible.Root>
    </section>
  )
}
