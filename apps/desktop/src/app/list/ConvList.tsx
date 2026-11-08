import { BellOff, CheckCheck, Link2, Pin } from 'lucide-react'
import { Avatar, GroupAvatar } from '@/components/Avatar'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import type { Conversation } from '@/data'
import { endDrag, startDrag } from '@/drag'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { convState, type ConvTone } from '@/store/select'
import { ListRow } from '../ListRow'

const toneText: Record<ConvTone, string> = { warm: 'font-medium text-warm', err: 'font-medium text-err', run: 'text-fg-2', draft: 'text-fg-2', none: 'text-fg-2' }
const badge = 'grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full px-1 text-[10.5px] font-semibold tabular-nums text-white'

/** 聊天区的会话列表:置顶在前,按搜索词过滤;右键置顶 / 免打扰 / 标为已读 */
export function ConvList({ query }: { query: string }) {
  const convs = useApp((s) => s.convs)
  const list = [...convs].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)).filter((c) => !query || c.title.includes(query))
  return <>{list.map((c) => <ConvRow key={c.id} c={c} />)}</>
}

function ConvRow({ c }: { c: Conversation }) {
  const { active, openFromList, setConvFlag, markRead } = useApp((s) => ({ active: s.active, openFromList: s.openFromList, setConvFlag: s.setConvFlag, markRead: s.markRead }))
  const st = useApp((s) => convState(c, s))
  const pid = c.kind === 'dm' ? c.members.find((m) => m !== 'me')! : null
  const on = c.id === active
  const unread = on ? 0 : (c.unread ?? 0)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <ListRow draggable={!!pid} onDragStart={(e) => pid && startDrag(e, pid, 'contact')} onDragEnd={endDrag} data-testid={`conv-${c.id}`} data-active={on ? '1' : '0'} data-pinned={c.pinned ? '1' : '0'}
          onClick={() => openFromList(c.id)} selected={on} className={cn('relative gap-2.5 px-3 py-2.5', !on && c.pinned && 'bg-hover/60')}>
          {pid ? <Avatar id={pid} size={42} /> : <GroupAvatar ids={c.members} size={42} />}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{c.title}</span>
              {(c.links?.length ?? 0) > 0 && <Link2 className="h-3 w-3 shrink-0 text-fg-3" />}
              <span className="shrink-0 text-[11.5px] tabular-nums text-fg-3">{c.time}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              {st.tone === 'run' && <span className="spin-ring !h-2.5 !w-2.5" />}
              {st.tone === 'draft' && <span className="shrink-0 text-[12.5px] text-err">[草稿]</span>}
              <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', toneText[st.tone])}>{st.text}</span>
              {c.muted && <BellOff className="h-3 w-3 shrink-0 text-fg-3" />}
              {st.count > 0 ? <span className={cn(badge, st.tone === 'err' ? 'bg-err' : 'bg-warm-dot')}>{st.count}</span>
                : unread > 0 ? (c.muted ? <span className="h-2 w-2 shrink-0 rounded-full bg-fg-3/60" /> : <span data-testid={`unread-${c.id}`} className={cn(badge, 'bg-err')}>{unread}</span>) : null}
            </div>
          </div>
        </ListRow>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44 rounded-xl border-line bg-elev p-1 shadow-elev">
        <ContextMenuItem data-testid={`pin-${c.id}`} className="rounded-lg" onSelect={() => setConvFlag(c.id, 'pinned', !c.pinned)}><Pin className="mr-2 h-4 w-4" />{c.pinned ? '取消置顶' : '置顶'}</ContextMenuItem>
        <ContextMenuItem data-testid={`mute-${c.id}`} className="rounded-lg" onSelect={() => setConvFlag(c.id, 'muted', !c.muted)}><BellOff className="mr-2 h-4 w-4" />{c.muted ? '允许消息通知' : '消息免打扰'}</ContextMenuItem>
        <ContextMenuItem className="rounded-lg" onSelect={() => markRead(c.id)}><CheckCheck className="mr-2 h-4 w-4" />标为已读</ContextMenuItem>
        <ContextMenuSeparator className="bg-line" />
        <ContextMenuItem className="rounded-lg text-err focus:text-err">从消息列表删除</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
