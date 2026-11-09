import { Avatar } from '@/components/Avatar'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { people } from '@/data'
import * as Concept from '@/concept'

/** @ 选人:第一项是 Helper(回复留在这里)。和 / 菜单同一套原语,焦点留在输入框里 */
export function MentionMenu({ cands, idx, onHover, onPick }: { cands: string[]; idx: number; onHover: (i: number) => void; onPick: (id: string) => void }) {
  return (
    <Command shouldFilter={false} label="选择要 @ 的人" value={cands[idx] ?? ''} onValueChange={(v) => { const i = cands.indexOf(v); if (i >= 0) onHover(i) }}
      data-testid="at-picker" className="absolute bottom-full left-0 z-20 mb-1.5 w-64 rounded-xl border border-line bg-elev p-1 shadow-elev">
      <div aria-hidden className="px-2 pb-1 pt-0.5 text-[11.5px] text-fg-3">选择要 @ 的人</div>
      <CommandList>
        {cands.map((m) => (
          <CommandItem key={m} value={m} data-testid={`at-${m}`} onMouseDown={(e) => e.preventDefault()} onSelect={() => onPick(m)} className="py-1.5 text-[13.5px]">
            <Avatar id={m} size={22} status={false} />
            <span className="flex-1 truncate">{people[m].name}</span>
            <Concept.DispatchLoad id={m} fallback={m === 'helper' ? '软件助手 · 回复留在这里' : people[m].role} />
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  )
}
