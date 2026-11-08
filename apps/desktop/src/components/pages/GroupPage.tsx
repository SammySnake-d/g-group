import { useState } from 'react'
import { LogOut, Pencil, Search } from 'lucide-react'
import { useApp } from '@/ctx'
import { broken } from '@/mut'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ListGroup, ListRow } from '@/components/ui/list-row'
import { PageScroll, TextInput } from './kit/parts'
import { GROUP_CONFIRM, type GroupConfirmKind } from './constants'

/* ---------- 群设置 ----------
   AC-50(#925):成员、公告、关联/记下/手册、复制团队只在右侧群资料(head-side)一处;这里只剩群设置。
   清空 / 解散 / 退出放在最下面一组,和常用开关隔开(危险操作离常用操作远一点);点了先在原地说清后果再确认。 */
export function GroupPage({ id }: { id: string }) {
  const { convs, push, setConvFlag, renameConv, leaveConv, clearHistory, closeAll } = useApp()
  const g = convs.find((c) => c.id === id)
  const [confirm, setConfirm] = useState<null | GroupConfirmKind>(null)
  const [editT, setEditT] = useState(false)
  const [tv, setTv] = useState(g?.title ?? '')
  if (!g) return null
  const owner = g.roles?.me === 'owner'
  const rename = () => { if (tv.trim()) renameConv(id, tv.trim()); setEditT(false) }
  const go = () => {
    if (confirm === 'clear') { clearHistory(id); setConfirm(null); closeAll() }
    else if (confirm) leaveConv(id, confirm === 'dissolve')
  }
  return (
    <PageScroll>
      <div className="px-5 pb-4 pt-1">
        {editT ? (
          <form onSubmit={(e) => { e.preventDefault(); rename() }}>
            <TextInput autoFocus aria-label="群名" value={tv} onChange={(e) => setTv(e.target.value)} onBlur={rename} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setTv(g.title); setEditT(false) } }} className="h-9 px-2.5 text-[16px] font-semibold" />
          </form>
        ) : (
          <Button data-testid="group-rename" variant="ghost" onClick={() => setEditT(true)} className="group/t -ml-2 h-auto max-w-full gap-1.5 px-2 py-0.5 text-left text-[18px] font-semibold tracking-tight text-fg [&_svg]:size-3.5">
            <span className="truncate">{g.title}</span>
            <span className="flex items-center gap-0.5 text-[12px] font-normal text-fg-3 opacity-0 transition-opacity duration-fast group-hover/t:opacity-100 group-focus-visible/t:opacity-100"><Pencil />改名</span>
          </Button>
        )}
        <div className="text-[13px] tabular-nums text-fg-2">{g.members.length} 人</div>
      </div>
      <ListGroup>
        {broken('AC-50-1') && <ListRow testid="group-search" label="查找聊天记录" onClick={() => push({ t: 'search', id })} chevron={false}><Search className="h-4 w-4 text-fg-3" /></ListRow>}
        <ListRow label="置顶聊天"><Switch data-testid="gp-pin" aria-label="置顶聊天" checked={!!g.pinned} onCheckedChange={(v) => setConvFlag(id, 'pinned', v)} /></ListRow>
        <ListRow label="消息免打扰"><Switch data-testid="gp-mute" aria-label="消息免打扰" checked={!!g.muted} onCheckedChange={(v) => setConvFlag(id, 'muted', v)} /></ListRow>
        <ListRow testid="group-clear" label="清空聊天记录" tone="danger" onClick={() => setConfirm('clear')} />
      </ListGroup>
      <ListGroup>
        {confirm ? (
          <div className="space-y-2.5 p-3" data-testid="leave-confirm" role="alertdialog" aria-label={GROUP_CONFIRM[confirm].go}>
            <p className="text-[13px] leading-relaxed text-fg-2">{GROUP_CONFIRM[confirm].note}</p>
            <div className="flex gap-2">
              <Button size="md" onClick={() => setConfirm(null)} className="flex-1" autoFocus>取消</Button>
              <Button data-testid="leave-confirm-go" variant="danger-solid" size="md" onClick={go} className="flex-1">{GROUP_CONFIRM[confirm].go}</Button>
            </div>
          </div>
        ) : (
          <>
            {owner && <Button data-testid="group-dissolve" variant="danger" onClick={() => setConfirm('dissolve')} className="h-11 w-full rounded-none text-[14px] font-normal">解散群聊</Button>}
            <Button data-testid="group-leave" variant="danger" onClick={() => setConfirm('leave')} className="h-11 w-full rounded-none text-[14px] font-normal"><LogOut />退出群聊</Button>
          </>
        )}
      </ListGroup>
    </PageScroll>
  )
}
