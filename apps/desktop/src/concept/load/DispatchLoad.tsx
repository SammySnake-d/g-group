import { useApp } from '@/store'
import { people, type PersonId } from '@/data'
import { cn } from '@/lib/utils'

/* 概念 · 派活前看一眼谁闲着
   @ 谁,就是把活派给谁。原来 @ 列表里只写职位(「写代码、做审查」),要知道它手上忙不忙,得去它的工作台翻。
   现在每一行右边直接写它此刻的状态:在等你几件、手上在做几件、出错没有;都没有就是「空闲」。悬停看细账(同时最多做几件、借了群算力几件)。
   形状 + 颜色 + 文字三样一起表达状态(不只靠颜色);@ 列表一天开几十次,所以不加任何动画。 */
type Fact = { tone: 'warm' | 'run' | 'err'; text: string; long: string }

export function useLoad(id: PersonId): Fact[] | null {
  const { computes, pending } = useApp((s) => ({ computes: s.computes, pending: s.pending }))
  const p = people[id]
  if (!p || p.human || id === 'helper') return null
  const mine = Object.values(computes).filter((c) => c.owner === id)
  /* 借群临时算力的不占它自己的格子(U09) */
  const running = mine.filter((c) => c.status === 'running' && c.pool !== 'group').length
  const borrowed = mine.filter((c) => c.status === 'running' && c.pool === 'group').length
  const wait = pending.filter((x) => x.from === id && x.kind !== 'error').length
  const err = pending.filter((x) => x.from === id && x.kind === 'error').length
  const facts: Fact[] = []
  if (err) facts.push({ tone: 'err', text: `出错 ${err}`, long: `${err} 件出错了，在等你决定` })
  if (wait) facts.push({ tone: 'warm', text: `等你 ${wait}`, long: `${wait} 件在等你回话` })
  if (running || borrowed) facts.push({ tone: 'run', text: `在做 ${running + borrowed}`, long: `同时最多做 ${p.computeQuota ?? 1} 件，现在在做 ${running} 件${borrowed ? `，另借群里的临时算力在做 ${borrowed} 件` : ''}` })
  return facts
}

const dot = { warm: 'bg-warm-dot', run: 'bg-run', err: 'bg-err' } as const
const ink = { warm: 'text-warm', run: 'text-run', err: 'text-err' } as const

export function DispatchLoad({ id, fallback }: { id: PersonId; fallback: string }) {
  const facts = useLoad(id)
  if (!facts) return <span className="truncate text-[11.5px] text-fg-3">{fallback}</span>
  const p = people[id]
  const title = facts.length ? `${p.name}：${facts.map((f) => f.long).join('；')}` : `${p.name} 现在手上没有活（${p.role}）`
  return (
    <span data-testid={`load-${id}`} data-free={facts.length ? '0' : '1'} title={title} className="flex shrink-0 items-center gap-2 text-[11.5px] tabular-nums">
      {facts.length === 0 && <span className="text-fg-3">空闲</span>}
      {facts.slice(0, 2).map((f) => (
        <span key={f.tone} className={cn('flex items-center gap-1', ink[f.tone])}>
          <span className={cn('h-1.5 w-1.5 rounded-full', dot[f.tone], f.tone === 'err' && 'rounded-[1px]')} />
          {f.text}
        </span>
      ))}
    </span>
  )
}
