import { cn } from '@/lib/utils'
import { people } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Surface } from '@/components/ui/surface'
import { PageScroll, Subhead } from './kit/parts'
import { POOL_MAX } from './constants'

/* U09 #13 #154:群临时算力。给这个群额外借几格算力,只能本群用、不串群;做完、停下、出错、踢人、解散都自动还回来。
   群主能改上限、能把某一格立刻收回(= 停下那件事);别人只能看。
   格子:借出 = 实心墨色;超出上限还没还完的 = 暖色(要注意);空 = 线色 */
export function PoolPage({ id }: { id: string }) {
  const { convs, computes, setPool, stop, openSplit, closeAll } = useApp()
  const g = convs.find((c) => c.id === id)
  if (!g) return null
  const owner = g.roles?.me === 'owner'
  const max = g.tempCompute?.max ?? 0
  const lent = Object.values(computes).filter((c) => c.conv === id && c.pool === 'group' && (c.status === 'running' || c.status === 'waiting' || c.stopping))
  const back = Object.values(computes).filter((c) => c.conv === id && c.pool === 'group' && !lent.includes(c))
  return (
    <PageScroll className="px-4 pb-4">
      <Surface elevation="flat" data-testid="pool-page" data-max={max} data-used={lent.length} className="p-3.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[14px] font-semibold tabular-nums">借出 {lent.length} / {max} 格</span>
          <span className="min-w-0 truncate text-[12px] text-fg-3">只给本群用，做完自动还</span>
        </div>
        <div className="mt-2 flex gap-1.5" role="img" aria-label={`借出 ${lent.length} 格,上限 ${max} 格`}>
          {Array.from({ length: Math.max(max, lent.length) }, (_, i) => (
            <span key={i} className={cn('h-2 flex-1 rounded-full', i < lent.length ? (i < max ? 'bg-fg-2' : 'bg-warm') : 'bg-line')} />
          ))}
        </div>
        {owner ? (
          <div className="mt-3 flex items-center gap-2 text-[13px]">
            <span className="text-fg-2">上限</span>
            <Segmented ariaLabel="上限" size="xs" value={String(max)} onChange={(v) => setPool(id, Number(v))}
              options={POOL_MAX.map((n) => ({ value: String(n), label: n === 0 ? '不给' : n, testid: `pool-max-${n}` }))} />
          </div>
        ) : <div className="mt-3 text-[12.5px] text-fg-3">上限由群主设</div>}
      </Surface>
      <Subhead className="mt-4 [&_h4]:text-[12.5px]">正在用</Subhead>
      {lent.length === 0 && <div className="py-3 text-[13px] text-fg-3">没有借出去的</div>}
      {lent.map((c) => (
        <div key={c.id} data-testid={`pool-lent-${c.id}`} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5">
          <Avatar id={c.owner} size={26} status={false} />
          <Button variant="ghost" onClick={() => { closeAll(); openSplit({ t: 'compute', id: c.id }) }} className="h-auto min-w-0 flex-1 flex-col items-start gap-0 whitespace-normal px-1.5 py-1 text-left font-normal">
            <span className="w-full truncate text-[13.5px] text-fg">{c.short ?? c.title}</span>
            <span className="w-full truncate text-[12px] text-fg-3">{people[c.owner].name} · {c.stopping ? '正在停止，停完才归还' : c.phase}</span>
          </Button>
          {owner && !c.stopping && <Button data-testid={`pool-reclaim-${c.id}`} variant="outline" size="xs" onClick={() => stop(c.id)} className="shadow-none hover:border-err/40 hover:text-err">停下并收回</Button>}
        </div>
      ))}
      {back.length > 0 && <>
        <Subhead className="mt-4 [&_h4]:text-[12.5px]">已归还</Subhead>
        {back.map((c) => (
          <div key={c.id} data-testid={`pool-back-${c.id}`} className="flex items-center gap-2.5 px-1 py-1.5 text-[12.5px] text-fg-3">
            <Avatar id={c.owner} size={20} status={false} /><span className="min-w-0 flex-1 truncate">{c.short ?? c.title}</span><span className="shrink-0">{c.phase}</span>
          </div>
        ))}
      </>}
    </PageScroll>
  )
}
