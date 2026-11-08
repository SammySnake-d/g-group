import { people, type Msg } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { MessageList } from '@/components/Messages'
import { Button } from '@/components/ui/button'
import { PageFooter, PageScroll } from './kit/parts'

/* ---------- GrokBot 式讨论:只读看原话,结论在群里 ---------- */
export function HuddlePage({ conv, msgId }: { conv: string; msgId: string }) {
  const { convs, jump, closeAll, addQuote } = useApp()
  const c = convs.find((x) => x.id === conv)!
  const m = c.messages.find((x) => 'id' in x && x.id === msgId) as Extract<Msg, { k: 'huddle' }>
  return (
    <>
      <PageScroll className="px-4">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px] text-fg-2" data-testid="huddle-page">
          {m.who.map((w) => <span key={w} className="flex items-center gap-1"><Avatar id={w} size={18} status={false} mood="idle" />{people[w].name}</span>)}
          <span className="tabular-nums text-fg-3">· {m.items.length} 条 · 只读</span>
        </div>
        <MessageList msgs={m.items.map((it) => ({ k: 'text', id: it.id, from: it.from, text: it.text }))} compact />
      </PageScroll>
      <PageFooter className="flex gap-2">
        <Button size="md" className="flex-1" onClick={() => { addQuote({ msgId: m.conclusion, from: m.who[1] ?? m.who[0], text: '讨论结论', reply: true }); closeAll() }}>回复这次讨论</Button>
        <Button data-testid="huddle-conclusion" variant="primary" size="md" className="flex-1" onClick={() => { jump(m.conclusion); closeAll() }}>看群里的结论</Button>
      </PageFooter>
    </>
  )
}
