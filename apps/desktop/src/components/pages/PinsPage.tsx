import { Pin } from 'lucide-react'
import { people, type Msg } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/section'
import { ListItem } from '@/components/ui/list-row'
import { Hint, PageScroll } from './kit/parts'

/* ---------- 置顶消息:点一条跳回原消息;「移出」贴在这一行右侧,悬停或键盘聚焦时出现 ---------- */
export function PinsPage({ id }: { id: string }) {
  const { convs, jump, closeAll, pinMsg } = useApp()
  const g = convs.find((c) => c.id === id)!
  const list = (g.pins ?? []).map((pid) => g.messages.find((m) => m.k === 'text' && m.id === pid)).filter(Boolean) as Extract<Msg, { k: 'text' }>[]
  return (
    <PageScroll className="px-2">
      <Hint className="mx-2 mb-2 text-[12px]">置顶只是方便你找回，不会当成群规；要助手照做的，写进群公告。</Hint>
      {list.map((m) => (
        <div key={m.id} className="group/p flex items-center gap-1 rounded-xl pr-1.5 transition-colors duration-fast ease-out hover:bg-hover">
          <ListItem onClick={() => { jump(m.id); closeAll() }} className="min-w-0 flex-1 items-start gap-2.5 hover:bg-transparent active:bg-transparent"
            media={<Avatar id={m.from} size={26} status={false} />}
            subtitleFirst clamp={2} subtitle={people[m.from].name} title={m.text} />
          <Button variant="ghost" size="xs" onClick={() => pinMsg(id, m.id)} className="font-normal text-fg-3 opacity-0 hover:bg-err-soft hover:text-err focus-visible:opacity-100 group-hover/p:opacity-100">移出</Button>
        </div>
      ))}
      {!list.length && <EmptyState icon={<Pin />} title="还没有置顶消息" />}
    </PageScroll>
  )
}
