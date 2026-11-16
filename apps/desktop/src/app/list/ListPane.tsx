import { Plus, Search, Sparkles, UserPlus, UsersRound } from 'lucide-react'
import { useState } from 'react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/ui/icon-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { moveRowFocus } from '../ListRow'
import { ContactList } from './ContactList'
import { ConvList } from './ConvList'
import { FileList } from './FileList'

/** 列表栏(可调宽):搜索 + 新建,下面按左侧所在区域列会话 / 通讯录 / 文件 */
export function ListPane() {
  const { section, width, push, fileQuery, setFileQuery } = useApp((s) => ({ section: s.section, width: s.widths.list, push: s.push, fileQuery: s.fileQuery, setFileQuery: s.setFileQuery }))
  const [localQuery, setLocalQuery] = useState('')
  // 文件区的搜索词放在 store 里:列表和右边的文件总览按同一个词筛
  const [query, setQuery] = section === 'files' ? [fileQuery, setFileQuery] : [localQuery, setLocalQuery]
  return (
    <aside className="dsbot-sidebar flex shrink-0 flex-col bg-side" style={{ width }} data-testid="list" data-dsbot-sidebar="true">
      <div className="dsbot-brand-row flex h-12 items-center justify-between gap-2 px-4 pt-1">
        <div className="flex min-w-0 items-center gap-2.5" aria-label="g-group">
          <span className="dsbot-brand-mark grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13px] font-bold" aria-hidden="true"><Sparkles className="h-4 w-4" strokeWidth={2.2} /></span>
          <span className="truncate text-[15px] font-semibold tracking-[-0.01em]">g-group</span>
        </div>
        <DropdownMenu modal={false}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <IconButton data-testid="list-plus" label="新建" tooltip={false} variant="secondary" icon={<Plus />} />
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>新建群聊或联系人</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-44 rounded-xl border-line bg-elev p-1 shadow-elev">
            <DropdownMenuItem data-testid="menu-new-group" className="rounded-lg py-2" onSelect={() => push({ t: 'newGroup' }, true)}><UsersRound className="mr-2 h-4 w-4" />发起群聊</DropdownMenuItem>
            <DropdownMenuItem className="rounded-lg py-2" onSelect={() => push({ t: 'addContact' }, true)}><UserPlus className="mr-2 h-4 w-4" />添加联系人</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="px-3 pb-2">
        <label className="dsbot-search flex h-9 items-center gap-2 rounded-xl bg-hover px-2.5 text-fg-3 transition-colors duration-fast ease-out focus-within:bg-sel">
          <Search className="h-[15px] w-[15px]" strokeWidth={1.75} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索联系人或会话" aria-label="搜索" className="min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-fg-3" />
          <kbd className="hidden rounded-md border border-line bg-elev px-1.5 py-0.5 text-[10px] text-fg-3 xl:inline">⌘K</kbd>
        </label>
      </div>
      <div onKeyDown={moveRowFocus} className={cn('scroll-thin flex-1 overflow-y-auto pb-2', section !== 'chat' && 'px-1.5')} style={{ ['--avatar-ring' as string]: 'var(--side)' }}>
        {section === 'chat' && <ConvList query={query} />}
        {section === 'contacts' && <ContactList query={query} />}
        {section === 'files' && <FileList query={query} />}
      </div>
    </aside>
  )
}
