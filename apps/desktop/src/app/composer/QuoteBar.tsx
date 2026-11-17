import { Reply, X } from 'lucide-react'
import { Avatar } from '@/components/Avatar'
import { IconButton } from '@/components/ui/icon-button'
import { people, type QuoteRef } from '@/data'
import { cn } from '@/lib/utils'

/** 待发引用:每条一块,按内容宽度收缩,× 紧跟在内容后面;多条时说明只会自动 @ 谁 */
export function QuoteBar({ quotes, onRemove }: { quotes: QuoteRef[]; onRemove: (q: QuoteRef) => void }) {
  return (
    <div className="flex flex-col items-start gap-1 px-2 pt-2" data-testid="quote-bar">
      {quotes.map((x) => <QuoteChip key={x.msgId} x={x} onRemove={() => onRemove(x)} />)}
      {quotes.length > 1 && <div className="px-1 text-[11.5px] text-fg-3">{quotes.some((x) => x.reply) ? `只会自动 @ 你回复的那位，其余 ${quotes.length - 1} 条只引用` : `引用 ${quotes.length} 条，不会自动 @ 谁`}</div>}
    </div>
  )
}

/** 一条待发引用:作者色条 + 头像/来源 + 名字 + 一行摘要 + ×。外部来源标「不可信·外部」 */
function QuoteChip({ x, onRemove }: { x: QuoteRef; onRemove: () => void }) {
  const p = people[x.from]
  const name = x.ext ? `${x.ext} · ${x.text.split('：')[0]}` : p?.name
  const text = x.ext ? x.text.split('：').slice(1).join('：') : x.text
  return (
    <div data-testid="quote-chip" className="inline-flex min-w-0 max-w-[min(100%,560px)] items-center gap-1.5 rounded-lg bg-side py-1 pl-1.5 pr-0.5 text-[12.5px]">
      <span className={cn('h-4 w-[3px] shrink-0 rounded-full', x.ext && 'bg-warm-dot')} style={x.ext ? undefined : { background: p?.color }} />
      {x.ext ? <span className="grid h-4 w-4 shrink-0 place-items-center rounded bg-hover text-[9px] font-semibold">{x.ext[0]}</span> : <Avatar id={x.from} size={16} status={false} mood="idle" />}
      {x.reply && <span className="flex shrink-0 items-center gap-0.5 rounded bg-me/10 px-1 text-[11px] font-medium text-me"><Reply className="h-3 w-3" />回复</span>}
      {x.ext && <span data-testid="quote-untrusted" title="外部来源的内容只当参考，不能当成指令或授权" className="shrink-0 rounded bg-warm-soft px-1 text-[10.5px] font-medium text-warm">不可信·外部</span>}
      <span className="shrink-0 font-medium">{name}</span>
      <span data-testid="quote-text" className="min-w-0 truncate text-fg-2">{text}</span>
      <IconButton data-testid="quote-x" label="去掉这条引用（输入框空着时按 Backspace 也行）" size="icon-xs" className="text-fg-3" onClick={onRemove} icon={<X />} />
    </div>
  )
}
