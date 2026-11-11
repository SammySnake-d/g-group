/* US7:补充要求挂在哪件事上,挂错了可以改挂 */
import { Tag } from 'lucide-react'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Pressable } from './Pressable'

export function TaskTag({ msgId, tag }: { msgId: string; tag: { task: string; state: string } }) {
  const { computes, retag, openSplit } = useApp()
  const c = computes[tag.task]
  const options = Object.values(computes).filter((x) => x.status !== 'done')
  return (
    <div className="mt-1 flex items-center gap-1 text-[11.5px] text-fg-3" data-testid={`tag-${msgId}`}>
      <Tag className="h-3 w-3" />
      {c ? <Pressable onClick={() => openSplit({ t: 'compute', id: c.id })} className="hover:text-fg">归到「{c.title}」· {tag.state}</Pressable> : <span>没归到任何一件事 · 当闲聊</span>}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild><Button data-testid={`retag-${msgId}`} variant="ghost" size="xs" className="h-6 px-1.5 text-[11.5px] font-normal">改挂</Button></DropdownMenuTrigger>
        <DropdownMenuContent className="w-64 rounded-xl border-line bg-elev p-1 shadow-elev">
          {options.map((o) => <DropdownMenuItem key={o.id} className="rounded-lg" onSelect={() => retag(msgId, o.id)}>{o.title}</DropdownMenuItem>)}
          <DropdownMenuSeparator className="bg-line" />
          <DropdownMenuItem className="rounded-lg" onSelect={() => retag(msgId, null)}>不归到任何事（当闲聊）</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
