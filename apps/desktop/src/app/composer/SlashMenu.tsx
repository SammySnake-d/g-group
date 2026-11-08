import type { SlashEntry } from '@g-group/ui-core'
import { Ban } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { SourceBadge } from './SourceBadge'

/* 打 / 弹出的命令菜单(cmdk):贴着输入框上沿、和输入框左对齐。能用的在前,灰显的在后并写明原因。
   焦点一直留在输入框里——过滤、上下键、回车由输入框转发,这里只按受控的选中项渲染;指针移上去也会改选中。
   打 / 是键盘触发的高频操作,菜单直接出现,不加入场动画。 */
export function SlashMenu({ items, sel, query, onHover, onPick }: { items: SlashEntry[]; sel: number; query: string; onHover: (i: number) => void; onPick: (e: SlashEntry) => void }) {
  const listRef = useRef<HTMLDivElement>(null)
  const value = sel >= 0 ? (items[sel]?.command.name ?? '') : ''
  useEffect(() => { if (value) listRef.current?.querySelector(`[data-value="${CSS.escape(value)}"]`)?.scrollIntoView({ block: 'nearest' }) }, [value])
  const q = query.toLowerCase()
  return (
    <Command shouldFilter={false} label="命令" value={value} onValueChange={(v) => { const i = items.findIndex((e) => e.command.name === v && !e.disabled); if (i >= 0) onHover(i) }}
      data-testid="slash-menu" className="absolute bottom-full left-0 z-30 mb-1.5 w-[min(560px,100%)] rounded-xl border border-line bg-elev shadow-elev">
      <div aria-hidden className="flex items-center gap-2 px-3 pb-1 pt-2 text-[11.5px] text-fg-3">
        <span className="font-medium text-fg-2">命令</span>
        <span className="ml-auto">↑↓ 选择 · Enter 选中 · Tab 补全 · Esc 关闭</span>
      </div>
      <CommandList ref={listRef} className="px-1 pb-1">
        <CommandEmpty data-testid="slash-empty" className="pb-2 pt-1">没有这个命令{query && <span className="text-fg-3">：/{query}</span>}</CommandEmpty>
        {items.map((e) => {
          const c = e.command
          const alias = c.aliases?.find((a) => q && a.startsWith(q) && !c.name.startsWith(q))
          const hit = q && c.name.startsWith(q) ? q.length : 0
          return (
            <CommandItem key={c.name} value={c.name} disabled={!!e.disabled} data-testid={`slash-item-${c.name}`} onMouseDown={(ev) => ev.preventDefault()} onSelect={() => onPick(e)} className="gap-3">
              <span className={cn('w-[100px] shrink-0 truncate font-mono text-[13px]', e.disabled ? 'text-fg-3' : 'text-fg-2')}>
                /<span className={cn(hit > 0 && !e.disabled && 'font-semibold text-fg')}>{c.name.slice(0, hit)}</span>{c.name.slice(hit)}
              </span>
              <span className={cn('w-[104px] shrink-0 truncate text-[13px] font-medium', e.disabled && 'text-fg-3')}>{c.title}{alias && <span className="ml-1.5 font-mono text-[11.5px] font-normal text-fg-3">/{alias}</span>}</span>
              {e.disabled ? (
                <span data-testid="slash-disabled" className="flex min-w-0 flex-1 items-center gap-1 truncate text-[12px] text-fg-3"><Ban className="h-3 w-3 shrink-0" />{e.disabled}</span>
              ) : (
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3">{c.desc}</span>
              )}
              <SourceBadge src={c.source} />
            </CommandItem>
          )
        })}
      </CommandList>
    </Command>
  )
}
