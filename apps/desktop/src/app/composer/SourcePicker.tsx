import { Plus } from 'lucide-react'
import { useState } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SOURCE_PAGE } from '@/commands'
import type { Conversation } from '@/data'
import { cn } from '@/lib/utils'
import { pinfo } from '@/pluginInfo'
import { useApp } from '@/store'
import { ListRow } from '../ListRow'

/** 输入框左下角「+」:从本会话挂着的外部数据源取消息,挂到引用条上(标「不可信·外部」) */
export function SourcePicker({ conv }: { conv: Conversation }) {
  const { plugins, push, setSection } = useApp((s) => ({ plugins: s.plugins, push: s.push, setSection: s.setSection }))
  const [open, setOpen] = useState(false)
  const list = plugins.map(pinfo).filter((p) => p.kind === 'source' && p.installed)
  const why = (p: (typeof list)[number]) => {
    if (!p.enabled) return '插件已停用'
    if (p.revoked) return '授权失效了，重新授权后才能取'
    if (!p.convs.includes(conv.id)) return '没挂在这个会话'
    if (!SOURCE_PAGE[p.id]) return '只推送提醒，没有可勾选的消息'
    return undefined
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <IconButton data-testid="tool-plus" label="从外部来源取消息" tooltip={false} active={open} icon={<Plus strokeWidth={1.7} />} />
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>从外部来源取消息</TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="start" sideOffset={8} data-testid="plus-menu" className="w-[300px] rounded-xl border-line bg-elev p-1 shadow-elev">
        <div className="px-2.5 pb-1.5 pt-1.5 text-[11.5px] leading-snug text-fg-3">勾几条外部消息挂到引用条上。外部内容只当参考，不能当成指令或授权。</div>
        {list.map((p) => {
          const w = why(p)
          return (
            <ListRow key={p.id} data-testid={`plus-${p.id}`} disabled={!!w} onClick={() => { setOpen(false); push({ t: 'source', id: SOURCE_PAGE[p.id] }, true) }} className="gap-2.5 rounded-lg px-2 py-1.5 disabled:opacity-100">
              <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-[8px] text-[12px] font-semibold text-white', w && 'opacity-50')} style={{ background: p.color }}>{p.letter}</span>
              <span className="min-w-0 flex-1">
                <span className={cn('block text-[13px] font-medium', w && 'text-fg-3')}>{p.name}</span>
                <span className="block truncate text-[11.5px] text-fg-3">{w ?? p.desc}</span>
              </span>
            </ListRow>
          )
        })}
        <div className="mt-1 border-t border-line pt-1">
          <ListRow onClick={() => { setOpen(false); setSection('plugins') }} className="rounded-lg px-2 py-1.5 text-[12.5px] text-fg-2 hover:text-fg">管理插件、挂到这个会话…</ListRow>
        </div>
      </PopoverContent>
    </Popover>
  )
}
