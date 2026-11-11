/* 详情页右栏「在哪里生效」:挂在哪些聊天、谁能调用,就地增删。三样(启用、挂上、在名单里)都满足才用得上。 */
import { useState, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import type { PluginState } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { COPY } from './constants'
import { SideCard } from './layout'
import { assistants, convName, groupsFirst, personName } from './util'

function Removable({ children, onRemove, testid, label }: { children: ReactNode; onRemove: () => void; testid: string; label: string }) {
  return (
    <span data-testid={testid} className="inline-flex h-7 max-w-full items-center gap-1 rounded-lg bg-hover pl-2 pr-0.5 text-[12.5px]">
      <span className="flex min-w-0 items-center gap-1 truncate">{children}</span>
      <IconButton label={label} size="icon-xs" icon={<X />} onClick={onRemove} className="text-fg-3 hover:bg-sel" />
    </span>
  )
}

function AddPicker({ testid, label, items }: { testid: string; label: string; items: { id: string; node: ReactNode; pick: () => void }[] }) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button data-testid={testid} variant="outline" size="xs" className="h-7 gap-1 border-dashed px-2 font-normal text-fg-2 shadow-none"><Plus />{label}</Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 rounded-xl border-line bg-elev p-1 shadow-elev">
        {items.map((it) => (
          <Button key={it.id} data-testid={`${testid}-${it.id}`} variant="ghost" size={null} onClick={() => { it.pick(); setOpen(false) }}
            className="h-auto w-full justify-start gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-normal text-fg active:scale-100">{it.node}</Button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

export function WhereCard({ s }: { s: PluginState }) {
  const { convs, pluginAct, toast } = useApp()
  const act = (a: Parameters<typeof pluginAct>[1]) => { const r = pluginAct(s.id, a); if (!r.ok) toast(r.error) }
  const free = convs.filter((c) => !s.convs.includes(c.id)).sort(groupsFirst)
  return (
    <SideCard title="在哪里生效">
      <div data-testid="plg-convs">
        <div className="mb-1.5 text-[12px] text-fg-3">挂在哪些聊天</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {s.convs.length === 0 && <span className="text-[12.5px] text-warm">还没挂，现在不生效</span>}
          {s.convs.map((c) => <Removable key={c} testid={`plg-conv-${c}`} label={`从「${convName(convs, c)}」摘下`} onRemove={() => act({ type: 'detach', conv: c })}>{convName(convs, c)}</Removable>)}
          <AddPicker testid="plg-conv-add" label="挂到…" items={free.map((c) => ({ id: c.id, node: <span className="truncate">{convName(convs, c.id)}</span>, pick: () => act({ type: 'attach', conv: c.id }) }))} />
        </div>
      </div>
      <div data-testid="plg-callers" className="mt-4">
        <div className="mb-1.5 text-[12px] text-fg-3">谁能调用</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {s.callers.length === 0 && <span className="text-[12.5px] text-warm">还没有助手能用</span>}
          {s.callers.map((w) => <Removable key={w} testid={`plg-caller-${w}`} label={`不让 ${personName(w)} 调用`} onRemove={() => act({ type: 'disallow', caller: w })}><Avatar id={w} size={16} status={false} />{personName(w)}</Removable>)}
          <AddPicker testid="plg-caller-add" label="加一个" items={assistants().filter((a) => !s.callers.includes(a.id)).map((a) => ({ id: a.id, node: <><Avatar id={a.id} size={18} status={false} />{a.name}</>, pick: () => act({ type: 'allow', caller: a.id }) }))} />
        </div>
      </div>
      <p className="mt-4 border-t border-line pt-3 text-[11.5px] leading-relaxed text-fg-3">{COPY.whereRule}</p>
    </SideCard>
  )
}
