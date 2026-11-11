/* #2273 U80：动向时间线插件挂在本群、启用着时，在插件页签里展开；每段点了回到它总结的那段消息。 */
import { ChevronRight } from 'lucide-react'
import { useApp } from '@/ctx'
import { people, type Conversation } from '@/data'
import { Button } from '@/components/ui/button'

export function PulseTimeline({ conv }: { conv: Conversation }) {
  const { pulse, crons, openSplit, jump } = useApp()
  const list = pulse.filter((x) => x.conv === conv.id)
  const cr = crons.find((c) => c.conv === conv.id && c.trigger.kind === 'messages')
  return (
    <section className="mt-1 border-t border-line px-2 pb-3 pt-3" data-testid="side-pulse">
      <div className="mb-1.5 flex items-center gap-2 px-2">
        <span className="flex-1 text-[13px] font-semibold">动向时间线</span>
        {cr && cr.trigger.kind === 'messages' && (
          <Button data-testid="side-pulse-rule" variant="ghost" size={null} onClick={() => openSplit({ t: 'cron', id: cr.id })} className="-mr-1 h-6 gap-0.5 px-1.5 text-[11.5px] font-normal tabular-nums text-fg-3 hover:text-fg">
            {people[cr.owner].name} · 每 {cr.trigger.n} 条一段 · 已 {cr.trigger.seen}/{cr.trigger.n}<ChevronRight className="h-3 w-3" />
          </Button>
        )}
      </div>
      <ol className="ml-3 border-l border-line pl-3">
        {[...list].reverse().map((x) => (
          <li key={x.id} data-testid={`pulse-${x.id}`} className="relative pb-2">
            <span aria-hidden className="absolute -left-[16.5px] top-[6px] h-2 w-2 rounded-full border-2 border-elev bg-fg-3/60" />
            <Button variant="ghost" size={null} onClick={() => jump(x.from)} className="block h-auto w-full whitespace-normal rounded-md px-1 py-0.5 text-left font-normal active:scale-100">
              <span className="mr-1.5 text-[11px] tabular-nums text-fg-3">{x.at}</span>
              <span className="text-[12.5px] leading-snug text-fg-2">{x.text}</span>
            </Button>
          </li>
        ))}
      </ol>
    </section>
  )
}
