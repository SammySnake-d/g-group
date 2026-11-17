import { useState } from 'react'
import { ChevronRight, Plus, Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sources } from '@/data'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ListItem } from '@/components/ui/list-row'
import { Hint, PageFooter, PageScroll, Subhead, ctaDisabled } from './kit/parts'

const Letter = ({ l, muted }: { l: string; muted?: boolean }) => (
  <span aria-hidden className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-hover text-[13px] font-semibold', muted && 'text-fg-3')}>{l}</span>
)

/* ---------- 外部来源:列表 → 某个来源(压栈,返回回到列表) ---------- */
export function SourcesPage() {
  const { push } = useApp()
  return (
    <PageScroll className="px-2">
      <Subhead className="mt-1 px-2.5">已连接</Subhead>
      {sources.filter((x) => x.connected).map((x) => (
        <ListItem key={x.id} data-testid={`source-${x.id}`} onClick={() => push({ t: 'source', id: x.id })} className="py-2.5"
          media={<Letter l={x.letter} />} title={`${x.app} · ${x.name}`} subtitle={x.state}
          trailing={<ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-fg-3" />} />
      ))}
      <Subhead className="mt-4 px-2.5">还可以连接（装插件）</Subhead>
      {sources.filter((x) => !x.connected).map((x) => (
        <div key={x.id} className="flex items-center gap-3 rounded-xl px-2.5 py-2">
          <Letter l={x.letter} muted />
          <span className="min-w-0 flex-1 truncate text-[14px] text-fg-2">{x.app}</span>
          <Button size="xs" shape="pill"><Plus />连接</Button>
        </div>
      ))}
    </PageScroll>
  )
}

/** 某个来源:勾选几条外部消息带进对话(只当参考) */
export function SourcePage({ id }: { id: string }) {
  const { quoteExternal, closeAll } = useApp()
  const s = sources.find((x) => x.id === id)!
  const [sel, setSel] = useState<Record<number, boolean>>({})
  const n = Object.values(sel).filter(Boolean).length
  return (
    <>
      <Hint className="truncate px-4 pb-1">{s.name} · {s.state}</Hint>
      <PageScroll className="px-2">
        {s.msgs!.map((m, i) => (
          <label key={i} data-testid={`srcmsg-${i}`} className={cn('flex cursor-pointer gap-3 rounded-xl px-2.5 py-2.5 transition-colors duration-fast ease-out hover:bg-hover has-[:focus-visible]:bg-hover', sel[i] && 'bg-sel hover:bg-sel')}>
            <Checkbox checked={!!sel[i]} onCheckedChange={(v) => setSel((x) => ({ ...x, [i]: !!v }))} className="mt-0.5 rounded-[5px] border-fg-3 data-[state=checked]:border-me data-[state=checked]:bg-me data-[state=checked]:text-me-fg" />
            <div className="min-w-0"><div className="text-[12px] tabular-nums text-fg-2">{m.who} · {m.time}</div><div className="text-[14px] leading-relaxed">{m.text}</div></div>
          </label>
        ))}
      </PageScroll>
      <PageFooter>
        <Button data-testid="src-quote" variant="primary" size="md" className={cn('w-full tabular-nums', ctaDisabled)} disabled={!n} onClick={() => { quoteExternal(s.msgs!.filter((_, i) => sel[i]), s.app); closeAll() }}><Send />{n ? `带 ${n} 条进对话` : '勾选要带进对话的消息'}</Button>
        <Hint className="mt-2 text-center text-[12px]">外部消息只当参考，不会让助手直接去执行</Hint>
      </PageFooter>
    </>
  )
}
