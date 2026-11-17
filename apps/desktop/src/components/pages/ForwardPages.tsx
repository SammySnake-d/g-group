import { Forward } from 'lucide-react'
import type { Msg } from '@/data'
import { useApp } from '@/ctx'
import { MessageList } from '@/components/Messages'
import { ConvItem } from './kit/conv-item'
import { Hint, PageScroll } from './kit/parts'

/* ---------- US2 转发:选目标会话;对方只看到选中的几条 ---------- */
export function ForwardPickPage({ from, msgIds }: { from: string; msgIds: string[] }) {
  const { convs, forward, closeAll } = useApp()
  const src = convs.find((c) => c.id === from)!
  return (
    <PageScroll className="px-2">
      <Hint className="mx-2.5 mb-2">把「{src.title}」里选中的 {msgIds.length} 条转过去。对方只看到这几条，看不到原会话的其他内容。</Hint>
      {convs.filter((c) => c.id !== from).map((c) => (
        <ConvItem key={c.id} c={c} testid={`fwd-${c.id}`} onClick={() => { forward(from, msgIds, c.id); closeAll() }} trailing={<Forward aria-hidden className="h-4 w-4 shrink-0 text-fg-3" />} />
      ))}
    </PageScroll>
  )
}

/** 转发过来的记录:只读 */
export function ForwardViewPage({ conv, msgId }: { conv: string; msgId: string }) {
  const { convs } = useApp()
  const m = convs.find((c) => c.id === conv)!.messages.find((x) => 'id' in x && x.id === msgId) as Extract<Msg, { k: 'forward' }>
  return (
    <PageScroll className="px-4">
      <Hint className="mb-2">来自「{m.srcTitle}」· 只读</Hint>
      <MessageList msgs={m.items.map((it, i) => ({ k: 'text', id: 'fv' + i, from: it.from, text: it.text }))} compact />
    </PageScroll>
  )
}
