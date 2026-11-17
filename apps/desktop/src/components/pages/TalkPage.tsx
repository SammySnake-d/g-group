import { people, agentTalks } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { MessageList } from '@/components/Messages'
import { Button } from '@/components/ui/button'
import { PageFooter, PageScroll } from './kit/parts'

/* ---------- 助手之间的一段对话:只读原话;底部回到群里看结论 ---------- */
export function TalkPage({ id }: { id: string }) {
  const { convs, jump, closeAll } = useApp()
  const t = agentTalks.find((x) => x.id === id)!
  const back = () => {
    const c = convs.find((x) => x.id === t.conv)!
    const last = [...c.messages].reverse().find((m) => m.k === 'text' && t.who.includes(m.from)) as { id: string } | undefined
    if (last) jump(last.id)
    closeAll()
  }
  return (
    <>
      <PageScroll className="px-4">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px] text-fg-2" data-testid="talk-page">
          {t.who.map((w) => <span key={w} className="flex items-center gap-1"><Avatar id={w} size={18} status={false} mood="idle" />{people[w].name}</span>)}
          <span className="tabular-nums text-fg-3">· {t.items.length} 条 · 只读 · 在{convs.find((c) => c.id === t.conv)?.title}</span>
        </div>
        <MessageList msgs={t.items.map((it, i) => ({ k: 'text', id: t.id + i, from: it.from, text: it.text }))} compact />
      </PageScroll>
      <PageFooter><Button size="md" className="w-full" onClick={back}>回到群里看结论</Button></PageFooter>
    </>
  )
}
