/* 已发消息的引用:放在气泡外、上方,用作者色竖条 + 头像区分;不和正文同色(回应 #1194 图二)。点了跳到原消息;外部来源只当参考,不跳 */
import { Reply } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, type QuoteRef } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { Pressable } from './Pressable'

export function SentQuotes({ quotes, mine }: { quotes: QuoteRef[]; mine: boolean }) {
  const { jump } = useApp()
  return (
    <div className={cn('mb-1 flex max-w-full flex-col gap-1', mine ? 'items-end' : 'items-start')} data-testid="sent-quotes">
      {quotes.map((q) => {
        const p = people[q.from]
        const [src, ...rest] = q.ext ? q.text.split('：') : []
        return (
          <Pressable key={q.msgId} onClick={(e) => { e.stopPropagation(); if (!q.ext) jump(q.msgId) }} title={q.ext ? `来自${q.ext}，只当参考` : '跳到原消息'}
            className="max-w-full shrink gap-2 rounded-xl border border-line bg-quote py-1 pl-1.5 pr-2.5 text-[12.5px] text-fg-2 hover:border-fg-3/40 hover:text-fg">
            {/* 作者色是人员数据(people.color),不是写死的色值;没有作者色就用弱化色 */}
            <span className={cn('h-4 w-[3px] shrink-0 rounded-full', !p?.color && 'bg-fg-3')} style={p?.color ? { background: p.color } : undefined} />
            {q.ext ? <span className="grid h-4 w-4 shrink-0 place-items-center rounded bg-hover text-[9px] font-semibold">{q.ext[0]}</span> : <Avatar id={q.from} size={16} status={false} mood="idle" />}
            {q.reply && <Reply className="h-3 w-3 text-fg-3" />}
            <span className="shrink-0 font-medium text-fg">{q.ext ? src : p?.name}</span>
            <span className="min-w-0 truncate">{q.ext ? rest.join('：') : q.text}</span>
          </Pressable>
        )
      })}
    </div>
  )
}
