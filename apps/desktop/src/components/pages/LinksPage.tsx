import { Link2, Plus, Unlink } from 'lucide-react'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/section'
import { ListGroup } from '@/components/ui/list-row'
import { ConvItem } from './kit/conv-item'
import { Hint, PageScroll } from './kit/parts'

/* ---------- US2 会话关联:已关联的列表 + 「关联一个会话」压栈去选 ---------- */
export function LinksPage({ id }: { id: string }) {
  const { convs, push, unlinkConv, openConv } = useApp()
  const g = convs.find((c) => c.id === id)!
  const links = (g.links ?? []).map((l) => convs.find((c) => c.id === l)!).filter(Boolean)
  return (
    <PageScroll className="px-1">
      <Hint className="mx-4 mb-3">默认每个会话的记录互不相通：群里的助手看不到你和它的私聊。关联之后，这里的助手回答时可以参考被关联会话的记录。取消关联后不再参考，已经转发过的内容不受影响。</Hint>
      <ListGroup title={<span className="tabular-nums">已关联 · {links.length}</span>}>
        {links.map((l) => (
          <div key={l.id} className="flex items-center gap-3 py-1.5 pl-4 pr-2">
            <Link2 aria-hidden className="h-4 w-4 shrink-0 text-fg-3" />
            <Button variant="link" onClick={() => openConv(l.id)} className="min-w-0 flex-1 justify-start px-0 text-[14px] font-normal text-fg"><span className="truncate">{l.title}</span></Button>
            <Button data-testid={`unlink-${l.id}`} variant="ghost" size="xs" onClick={() => unlinkConv(id, l.id)} className="hover:bg-err-soft hover:text-err"><Unlink />取消</Button>
          </div>
        ))}
        {!links.length && <div className="px-4 py-3 text-[13px] text-fg-3">还没有关联任何会话</div>}
      </ListGroup>
      <div className="mx-3">
        <Button data-testid="link-add" variant="outline" size="md" onClick={() => push({ t: 'linkPick', id })} className="w-full border-dashed bg-transparent shadow-none"><Plus />关联一个会话</Button>
      </div>
    </PageScroll>
  )
}

export function LinkPickPage({ id }: { id: string }) {
  const { convs, linkConv, back } = useApp()
  const g = convs.find((c) => c.id === id)!
  const list = convs.filter((c) => c.id !== id && !(g.links ?? []).includes(c.id))
  return (
    <PageScroll className="px-2">
      {list.map((c) => <ConvItem key={c.id} c={c} testid={`linkpick-${c.id}`} onClick={() => { linkConv(id, c.id); back() }} />)}
      {!list.length && <EmptyState icon={<Link2 />} title="能关联的会话都关联上了" />}
    </PageScroll>
  )
}
