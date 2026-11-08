/* 右键菜单(QQ 桌面版习惯):表情 / 回复 / 复制 / 转发 / 收藏 / 多选 / 引用 / 置顶或回到这里 / 编辑 / 撤回 / 删除 */
import type { ReactNode } from 'react'
import { Bookmark, CheckSquare, Copy, Forward, History, Pencil, Pin, Quote as QuoteIcon, Reply, Trash2, Undo2 } from 'lucide-react'
import { useApp } from '@/ctx'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { MENU_EMOJI, quoteText } from './copy'
import { MENU_DANGER, MENU_ITEM, MENU_SEP, MENU_SURFACE } from './menuStyle'
import type { Bodied } from './types'


export function MsgMenu({ m, children }: { m: Bodied; children: ReactNode }) {
  const { addQuote, setSelecting, push, active, recall, react, toast, pinMsg, deleteMsg, setEditing, reedit, setRewindAsk } = useApp()
  const mine = m.from === 'me'
  const text = quoteText(m)
  return (
    <ContextMenu>
      {/* Row 是自定义组件,不转发事件;包一层 div 让右键真的落在这条消息上(自审:v4 之前右键菜单从没弹出过) */}
      <ContextMenuTrigger asChild><div>{children}</div></ContextMenuTrigger>
      <ContextMenuContent className={cn('w-44', MENU_SURFACE)} data-testid="ctx-menu">
        <div className="flex gap-0.5 px-1 pb-1">{MENU_EMOJI.map((e) => <ContextMenuItem key={e} onSelect={() => react(m.id, e)} className="grid h-8 w-8 place-items-center rounded-md p-0 text-[17px] focus:bg-sel data-[highlighted]:bg-sel">{e}</ContextMenuItem>)}</div>
        <ContextMenuSeparator className={MENU_SEP} />
        <ContextMenuItem data-testid="ctx-reply" className={MENU_ITEM} onSelect={() => addQuote({ msgId: m.id, from: m.from, text, reply: true })}><Reply />回复</ContextMenuItem>
        <ContextMenuItem data-testid="ctx-copy" className={MENU_ITEM} onSelect={() => { navigator.clipboard?.writeText(text).catch(() => {}); toast('已复制') }}><Copy />复制</ContextMenuItem>
        <ContextMenuItem data-testid="ctx-forward" className={MENU_ITEM} onSelect={() => push({ t: 'forwardPick', from: active, msgIds: [m.id] }, true)}><Forward />转发</ContextMenuItem>
        <ContextMenuItem data-testid="ctx-fav" className={MENU_ITEM} onSelect={() => toast('已收藏，在「文件 › 收藏」里')}><Bookmark />收藏</ContextMenuItem>
        <ContextMenuItem data-testid="ctx-multi" className={MENU_ITEM} onSelect={() => setSelecting(true)}><CheckSquare />多选</ContextMenuItem>
        <ContextMenuItem data-testid="ctx-quote" className={MENU_ITEM} onSelect={() => addQuote({ msgId: m.id, from: m.from, text })}><QuoteIcon />引用</ContextMenuItem>
        {active.startsWith('g') && <ContextMenuItem data-testid="ctx-pin" className={MENU_ITEM} onSelect={() => pinMsg(active, m.id)}><Pin />置顶</ContextMenuItem>}
        {active.startsWith('dm-') && <ContextMenuItem data-testid="ctx-rewind" className={MENU_ITEM} onSelect={() => setRewindAsk(m.id)}><History />回到这里</ContextMenuItem>}
        <ContextMenuSeparator className={MENU_SEP} />
        {mine && m.k === 'text' && <ContextMenuItem data-testid="ctx-edit" className={MENU_ITEM} onSelect={() => { setEditing(m.id); reedit(m.text) }}><Pencil />编辑</ContextMenuItem>}
        {mine && <ContextMenuItem data-testid="ctx-recall" className={MENU_ITEM} onSelect={() => recall(m.id)}><Undo2 />撤回</ContextMenuItem>}
        <ContextMenuItem data-testid="ctx-delete" className={cn(MENU_ITEM, MENU_DANGER)} onSelect={() => deleteMsg(m.id)}><Trash2 />删除（只在你这边）</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
