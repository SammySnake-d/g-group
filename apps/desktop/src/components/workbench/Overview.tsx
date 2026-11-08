import { useState, type ReactNode } from 'react'
import { AlertTriangle, Check, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { dutyByConv, type Compute, type Conversation, type Pending, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { Collapse } from '@/components/pages/kit/collapse'
import { Button } from '@/components/ui/button'
import { SectionHeader } from '@/components/ui/section'
import { GroupAvatar } from '../Avatar'
import { DUTY_FALLBACK, PENDING_CTA, PENDING_VERB } from './constants'
import { DoingRow } from './DoingRow'
import { Source, TextLink, WbCard, pressRow, pressRowCls } from './parts'

/* 概览:等你(最先看)→ 在做 → 做完(默认收起)→ 所在的群。等你和出错用底色区分,不用彩色左边框 */
const Empty = ({ children }: { children: string }) => <div className="text-[13px] text-fg-3">{children}</div>
const rowCls = 'flex items-center gap-2 rounded-lg px-3 py-2 transition-[filter] duration-fast ease-out hover:brightness-[0.98]'
const warmCta = 'bg-warm text-white hover:bg-warm/90'

export function Overview({ id }: { id: PersonId }) {
  const { computes, pending, convs, openSplit, openConv } = useApp()
  const [showDone, setShowDone] = useState(false)
  const mine = Object.values(computes).filter((c) => c.owner === id)
  const convOf = (cid: string) => convs.find((c) => c.id === cid)
  const myPending = pending.filter((x) => x.from === id)
  const pendingCids = new Set(myPending.flatMap((x) => ('computeId' in x ? [x.computeId] : [])))
  const waitC = mine.filter((c) => c.status === 'waiting' && !pendingCids.has(c.id))
  const doing = mine.filter((c) => c.status === 'running' || c.status === 'error').sort((a, b) => (a.status === 'error' ? -1 : 0) - (b.status === 'error' ? -1 : 0))
  const done = mine.filter((c) => c.status === 'done')
  const groups = convs.filter((c) => c.kind === 'group' && c.members.includes(id))
  const openLink = (conv: string) => <TextLink testid={`wb-open-conv-${conv}`} onClick={() => openConv(conv)}>打开会话</TextLink>
  const waitCount = myPending.length + waitC.length
  return (
    <>
      <WbCard testid="wb-waiting">
        <SectionHeader className="mb-2" title="等你" count={waitCount > 0 ? <span className="text-warm">{waitCount}</span> : undefined} />
        {waitCount === 0 && <Empty>没有要你处理的事</Empty>}
        <div className="space-y-1.5">
          {myPending.map((x) => <PendingRow key={x.id} x={x} conv={convOf(x.conv)} title={x.kind === 'choice' || x.kind === 'proposal' ? x.title : computes[x.computeId]?.title ?? ''} link={openLink(x.conv)} />)}
          {waitC.map((c) => (
            <div key={c.id} data-testid={`wb-wait-${c.id}`} {...pressRow(() => openSplit({ t: 'compute', id: c.id }))} className={cn(rowCls, pressRowCls, 'bg-warm-soft')}>
              <span className="h-2 w-2 shrink-0 rounded-full bg-warm-dot" />
              <div className="min-w-0 flex-1"><div className="truncate text-[13.5px] font-semibold">{c.title}</div><div className="text-[12px] text-warm">{PENDING_VERB.accept}</div></div>
              <Source conv={convOf(c.conv)} />
              <Button size="xs" shape="pill" className={warmCta} onClick={(e) => { e.stopPropagation(); openConv(c.conv) }}>{PENDING_CTA.accept}</Button>
              {openLink(c.conv)}
            </div>
          ))}
        </div>
      </WbCard>

      <WbCard testid="wb-doing">
        <SectionHeader className="mb-2" title="在做" count={doing.length > 0 ? doing.length : undefined} />
        {doing.length === 0 && <Empty>现在没有在做的事</Empty>}
        <div className="space-y-1">
          {doing.map((c) => <DoingRow key={c.id} c={c} conv={convOf(c.conv)} link={openLink(c.conv)} />)}
        </div>
      </WbCard>

      <WbCard testid="wb-done" className="py-3">
        {done.length === 0 ? <div className="text-[12.5px] text-fg-3">最近没有做完的事</div> : (
          <>
            <Button data-testid="wb-done-toggle" variant="ghost" size="xs" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)} className="-ml-2 gap-1.5 font-normal text-fg-3 tabular-nums hover:text-fg-2">
              <Check strokeWidth={2.5} />做完 {done.length} 件<ChevronRight className={cn('transition-transform duration-fast ease-out', showDone && 'rotate-90')} />
            </Button>
            <Collapse open={showDone}>
                  <div className="mt-2 space-y-0.5">
                    {done.map((c) => <DoneRow key={c.id} c={c} conv={convOf(c.conv)} link={openLink(c.conv)} />)}
                  </div>
            </Collapse>
          </>
        )}
      </WbCard>

      <WbCard testid="wb-groups">
        <SectionHeader className="mb-1" title="所在的群" count={groups.length} />
        {groups.length === 0 && <Empty>还没进任何群</Empty>}
        <div className="divide-y divide-line">
          {groups.map((g) => {
            const duty = dutyByConv[g.id]?.[id]
            return (
              <div key={g.id} data-testid={`wb-group-${g.id}`} className="flex items-center gap-2.5 py-2">
                <GroupAvatar ids={g.members} size={28} />
                <span className="w-36 shrink-0 truncate text-[13.5px] font-medium">{g.title}</span>
                <span className={cn('min-w-0 flex-1 truncate text-[13px]', duty ? 'text-fg-2' : 'text-fg-3')}>{duty ?? DUTY_FALLBACK}</span>
                {openLink(g.id)}
              </div>
            )
          })}
        </div>
      </WbCard>
    </>
  )
}

/** 等你的一件事:问题 / 提议 / 交付 / 出错。点整行去处理的地方,按钮直接去回答 */
function PendingRow({ x, conv, title, link }: { x: Pending; conv?: Conversation; title: string; link: ReactNode }) {
  const { openSplit, openConv } = useApp()
  const cid = 'computeId' in x ? x.computeId : undefined
  const err = x.kind === 'error'
  return (
    <div data-testid={`wb-wait-${x.id}`} {...pressRow(() => (cid ? openSplit({ t: 'compute', id: cid }) : openConv(x.conv)))}
      className={cn(rowCls, pressRowCls, err ? 'bg-err-soft' : 'bg-warm-soft')}>
      {err ? <AlertTriangle className="h-4 w-4 shrink-0 text-err" /> : <span className="h-2 w-2 shrink-0 rounded-full bg-warm-dot" />}
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-[13.5px] font-semibold', err ? 'text-err' : 'text-fg')}>{title}</div>
        <div className={cn('text-[12px]', err ? 'text-err' : 'text-warm')}>{PENDING_VERB[x.kind]}</div>
      </div>
      <Source conv={conv} />
      <Button size="xs" shape="pill" variant={err ? 'danger-solid' : 'secondary'} className={err ? undefined : warmCta}
        onClick={(e) => { e.stopPropagation(); if (cid && x.kind !== 'accept') openSplit({ t: 'compute', id: cid }); else openConv(x.conv) }}>
        {PENDING_CTA[x.kind]}
      </Button>
      {link}
    </div>
  )
}

/** 做完的一件:弱化成一行灰字,点了照样能看过程 */
function DoneRow({ c, conv, link }: { c: Compute; conv?: Conversation; link: ReactNode }) {
  const { openSplit } = useApp()
  return (
    <div data-testid={`wb-done-${c.id}`} {...pressRow(() => openSplit({ t: 'compute', id: c.id }))} className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] text-fg-3 transition-colors duration-fast ease-out hover:bg-hover', pressRowCls)}>
      <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
      <span className="min-w-0 flex-1 truncate">{c.title}<span className="ml-2">{c.result}</span></span>
      <Source conv={conv} />
      {link}
    </div>
  )
}
