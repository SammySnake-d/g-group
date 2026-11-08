/* U87 / D23 / AC-40:每条交给助手的消息都要有交代,挂在你那条消息底部一行灰字。
   已做 / 在做 / 记下了 / 合并到「x」/ 被后面那条替代 / 知道了;有去处的带一个外跳箭头;交代不对,点「改」一句话改掉 */
import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Pressable } from './Pressable'
import { DISP_CHOICES } from './copy'
import { useDisp } from './disp'
import type { TextMsg } from './types'

export function DispLine({ m }: { m: TextMsg }) {
  const { setDisp } = useApp()
  const d = m.disp!
  const { label, go } = useDisp(d)
  const tone = d.kind === 'superseded' ? 'line-through decoration-fg-3/50' : ''
  return (
    <div data-testid={`disp-${m.id}`} data-kind={d.kind} className="flex min-w-0 items-center gap-1 text-[11.5px] text-fg-3">
      <span title={people[d.by].name} className="inline-flex"><Avatar id={d.by} size={13} status={false} mood="idle" /></span>
      {d.ref
        ? <Pressable onClick={(e) => { e.stopPropagation(); go() }} className={cn('gap-0.5 hover:text-fg-2 hover:underline [&_svg]:size-3', tone)}>{label}<ArrowUpRight /></Pressable>
        : <span className={tone}>{label}</span>}
      {d.note && <span className="max-w-[240px] truncate" title={d.note}>· {d.note}</span>}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button data-testid={`disp-edit-${m.id}`} onClick={(e) => e.stopPropagation()} variant="ghost" size="xs" className="h-6 px-1.5 text-[11.5px] font-normal text-fg-3 opacity-70 hover:opacity-100">改</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 rounded-xl border-line bg-elev p-1 shadow-elev">
          <div className="px-2 py-1 text-[11.5px] text-fg-3">交代不对？告诉 {people[d.by].name} 这条该怎么算</div>
          {DISP_CHOICES.map(({ kind, label: l }) => (
            <DropdownMenuItem key={kind} data-testid={`disp-set-${m.id}-${kind}`} className="rounded-lg"
              onSelect={() => setDisp(m.id, { by: d.by, kind, ref: kind === 'doing' ? d.ref : undefined, refKind: kind === 'doing' ? d.refKind : undefined })}>{l}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
