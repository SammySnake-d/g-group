/* C-US25 未读总结:每条带来源可跳;有原消息被撤回就过期,可以重新总结 */
import { cn } from '@/lib/utils'
import { useApp } from '@/ctx'
import { TextLink } from '../Pressable'
import type { MsgOf } from '../types'

export function SummaryCard({ m }: { m: MsgOf<'summary'> }) {
  const { jump, summarize, active } = useApp()
  return (
    <div data-testid={`summary-${m.id}`} data-expired={m.expired ? '1' : undefined} className={cn('w-[380px] max-w-full rounded-2xl border border-line bg-elev p-3', m.expired && 'opacity-60')}>
      <div className="flex items-center gap-2 text-[13.5px] font-semibold"><span className="flex-1">{m.title}</span>
        {m.expired && <span className="flex shrink-0 items-center gap-1.5 text-[12px] font-normal text-fg-3">已过期 · 有条消息被撤回
          <TextLink data-testid={`summary-redo-${m.id}`} onClick={() => summarize(active)}>重新总结</TextLink></span>}
      </div>
      <ul className="mt-1.5 space-y-1">{m.items.map((it, i) => (
        <li key={i} className="flex gap-1.5 text-[13px] leading-relaxed"><span className="text-fg-3">·</span>
          <span className="flex-1">{it.text}{it.ref && <TextLink onClick={(e) => { e.stopPropagation(); jump(it.ref!) }} className="ml-1 text-[12px]">原消息</TextLink>}</span>
        </li>
      ))}</ul>
    </div>
  )
}
