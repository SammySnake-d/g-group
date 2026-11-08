import { useState } from 'react'
import { SearchX } from 'lucide-react'
import { people, type Msg } from '@/data'
import { useApp } from '@/ctx'
import { broken } from '@/mut'
import { Avatar } from '@/components/Avatar'
import { EmptyState } from '@/components/ui/section'
import { ListItem } from '@/components/ui/list-row'
import { PageScroll, TextInput } from './kit/parts'

/* ---------- 查找聊天记录 ----------
   AC-25:每条结果带 #seq,点了跳回原消息并高亮;AC-08:撤回的消息变成系统行,原文不再被搜到 */
export function SearchPage({ id }: { id: string }) {
  const { convs, jump, closeAll } = useApp()
  const [q, setQ] = useState('飞书')
  const g = convs.find((c) => c.id === id)!
  const seqOf = (mid: string) => g.messages.filter((m) => 'id' in m).findIndex((m) => 'id' in m && m.id === mid) + 1
  const hits = (broken('AC-25') ? [] : g.messages.filter((m) => m.k === 'text' && q && m.text.includes(q))) as Extract<Msg, { k: 'text' }>[]
  return (
    <>
      <div className="px-3 pb-2">
        <TextInput data-testid="search-input" autoFocus aria-label="搜索聊天记录" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" className="h-9 border-transparent bg-hover" />
      </div>
      <PageScroll className="px-2">
        {hits.map((m) => (
          <ListItem key={m.id} data-testid={`search-hit-${m.id}`} onClick={() => { jump(m.id); closeAll() }} className="items-start gap-2.5"
            media={<Avatar id={m.from} size={26} status={false} />}
            subtitleFirst clamp={2}
            subtitle={<span className="tabular-nums">{people[m.from].name} · #{seqOf(m.id)}</span>}
            title={m.text} />
        ))}
        {!hits.length && <EmptyState icon={<SearchX />} title="没找到" />}
      </PageScroll>
    </>
  )
}
