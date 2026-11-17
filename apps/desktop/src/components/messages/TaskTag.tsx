/* US7:补充要求挂在哪件事上,挂错了可以改挂 */
import { Tag } from 'lucide-react'
import { useApp } from '@/ctx'
import { liveTaskOpen, taskRoom } from '@/api/wire/chat-ops'
import { live } from '@/api/wire/live'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Pressable } from './Pressable'

export function TaskTag({ msgId, tag }: { msgId: string; tag: { task: string; state: string } }) {
  const { computes, retag, openSplit } = useApp()
  const isLive = useAppStore((s) => live(s))
  const c = computes[tag.task]
  /* 连上后端:只能改挂到同一个会话里还没收口的另一件事上(宿主的改挂是「从一件移到另一件」) */
  const options = isLive
    ? Object.values(computes).filter((x) => x.id !== tag.task && taskRoom(x.id) === taskRoom(tag.task) && liveTaskOpen(x.id))
    : Object.values(computes).filter((x) => x.status !== 'done')
  return (
    <div className="mt-1 flex items-center gap-1 text-[11.5px] text-fg-3" data-testid={`tag-${msgId}`}>
      <Tag className="h-3 w-3" />
      {c ? <Pressable onClick={() => openSplit({ t: 'compute', id: c.id })} className="hover:text-fg">归到「{c.title}」· {tag.state}</Pressable> : <span>没归到任何一件事 · 当闲聊</span>}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild><Button data-testid={`retag-${msgId}`} variant="ghost" size="xs" className="h-6 px-1.5 text-[11.5px] font-normal">改挂</Button></DropdownMenuTrigger>
        <DropdownMenuContent className="w-64 rounded-xl border-line bg-elev p-1 shadow-elev">
          {options.map((o) => <DropdownMenuItem key={o.id} data-testid={`retag-to-${o.id}`} className="rounded-lg" onSelect={() => retag(msgId, o.id)}>{o.title}</DropdownMenuItem>)}
          {!isLive && <DropdownMenuSeparator className="bg-line" />}
          {!isLive && <DropdownMenuItem className="rounded-lg" onSelect={() => retag(msgId, null)}>不归到任何事（当闲聊）</DropdownMenuItem>}
          {isLive && !options.length && <div className="px-2 py-1.5 text-[12.5px] text-fg-3">这个会话里没有别的进行中的事</div>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
