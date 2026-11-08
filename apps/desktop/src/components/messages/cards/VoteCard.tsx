/* C-US23 投票:每位助手投票附理由,你拍板 */
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import type { MsgOf } from '../types'

export function VoteCard({ m }: { m: MsgOf<'vote'> }) {
  const { decideVote } = useApp()
  const total = Object.keys(m.votes).length
  return (
    <div data-testid={`vote-${m.id}`} className="w-[360px] max-w-full rounded-2xl border border-line bg-elev p-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2"><Chip size="xs">投票</Chip><span className="text-[14px] font-semibold">{m.title}</span></div>
      <div className="mt-2 space-y-1.5">
        {m.options.map((o, i) => {
          const who = Object.entries(m.votes).filter(([, v]) => v.opt === i)
          const pct = total ? (who.length / total) * 100 : 0
          return (
            <div key={i} className={cn('relative overflow-hidden rounded-lg border px-2.5 py-1.5', m.decided === i ? 'border-me' : 'border-line')}>
              <div className="absolute inset-y-0 left-0 bg-me/10" style={{ width: pct + '%' }} />
              <div className="relative flex items-center gap-2 text-[13px]">
                <span className="flex-1 font-medium">{o}</span>
                <span className="flex -space-x-1">{who.map(([p]) => <Avatar key={p} id={p} size={16} status={false} mood="idle" />)}</span>
                <span className="w-6 text-right text-[12px] tabular-nums text-fg-3">{who.length}</span>
                {m.decided === undefined && <Button data-testid={`decide-${m.id}-${i}`} onClick={() => decideVote(m.id, i)} variant="primary" size="xs" className="h-6 px-2 text-[11.5px]">就这个</Button>}
                {m.decided === i && <Check className="h-4 w-4 text-me" />}
              </div>
              {who.map(([p, v]) => <div key={p} className="relative mt-0.5 text-[11.5px] text-fg-2">{people[p].name}：{v.why}</div>)}
            </div>
          )
        })}
      </div>
      <div className="mt-2 text-[11.5px] text-fg-3">{m.decided === undefined ? `${total} 位助手投了票，由你拍板` : `你选了「${m.options[m.decided]}」，已写进群协作手册`}</div>
    </div>
  )
}
