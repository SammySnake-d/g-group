import { useEffect, useRef, useState } from 'react'
import { Plus, Ban } from 'lucide-react'
import { parseSource, scheduleHint, type SlashEntry, type SlashSource } from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { people, type Conversation } from '@/data'
import { useApp } from '@/ctx'
import { SOURCE_PAGE } from '@/commands'
import { Avatar } from './Avatar'
import { Tip } from './Messages'
import { CronForm } from './CronDetail'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

/** 命令来源标记：内置 / 插件（品牌色字母 + 插件名）/ 助手（头像 + 名字） */
export function SourceBadge({ src }: { src: SlashSource }) {
  const { plugins } = useApp()
  const s = parseSource(src)
  const box = 'flex shrink-0 items-center gap-1 rounded-md border border-line px-1.5 py-[1px] text-[11px] text-fg-2'
  if (!s || s.kind === 'builtin') return <span data-testid="slash-src" className="shrink-0 px-1.5 text-[11px] text-fg-3">内置</span>
  if (s.kind === 'plugin') {
    const p = plugins.find((x) => x.id === s.id)
    return (
      <span data-testid="slash-src" className={box}>
        <span className="grid h-3.5 w-3.5 place-items-center rounded-[4px] text-[8.5px] font-semibold leading-none text-white" style={{ background: p?.color }}>{p?.letter}</span>
        插件 · {p?.name ?? s.id}
      </span>
    )
  }
  return (
    <span data-testid="slash-src" className={box}>
      <Avatar id={s.id} size={14} status={false} mood="idle" />
      助手 · {people[s.id]?.name ?? s.id}
    </span>
  )
}

/** 打 / 弹出的命令菜单：贴着输入框上沿、和输入框左对齐。能用的在前，灰显的在后并写明原因 */
export function SlashMenu({ items, sel, query, onHover, onPick }: { items: SlashEntry[]; sel: number; query: string; onHover: (i: number) => void; onPick: (e: SlashEntry) => void }) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => { listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' }) }, [sel])
  const q = query.toLowerCase()
  return (
    <div data-testid="slash-menu" className="fade-up absolute bottom-full left-0 z-30 mb-1.5 w-[min(560px,100%)] overflow-hidden rounded-xl border border-line bg-elev shadow-elev">
      <div className="flex items-center gap-2 px-3 pb-1 pt-2 text-[11.5px] text-fg-3">
        <span className="font-medium text-fg-2">命令</span>
        <span className="ml-auto">↑↓ 选择 · Enter 选中 · Tab 补全 · Esc 关闭</span>
      </div>
      {items.length === 0 ? (
        <div data-testid="slash-empty" className="px-3 pb-3 pt-1 text-[13px] text-fg-2">没有这个命令{query && <span className="text-fg-3">：/{query}</span>}</div>
      ) : (
        <div ref={listRef} role="listbox" className="scroll-thin max-h-[330px] overflow-y-auto px-1 pb-1">
          {items.map((e, i) => {
            const c = e.command
            const alias = c.aliases?.find((a) => q && a.startsWith(q) && !c.name.startsWith(q))
            const hit = q && c.name.startsWith(q) ? q.length : 0
            return (
              <button
                key={c.name} type="button" data-idx={i} data-testid={`slash-item-${c.name}`} role="option" aria-selected={i === sel} aria-disabled={!!e.disabled}
                onMouseEnter={() => !e.disabled && onHover(i)}
                onMouseDown={(ev) => { ev.preventDefault(); if (!e.disabled) onPick(e) }}
                className={cn('flex w-full items-center gap-3 rounded-lg px-2 py-[7px] text-left', i === sel && 'bg-hover', e.disabled && 'cursor-not-allowed')}
              >
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
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 输入框左下角「+」：从本会话挂着的外部数据源取消息，挂到引用条上（标「不可信·外部」） */
export function SourcePicker({ conv, className }: { conv: Conversation; className: string }) {
  const { plugins, push, setSection } = useApp()
  const [open, setOpen] = useState(false)
  const list = plugins.filter((p) => p.kind === 'source' && p.installed)
  const why = (p: (typeof list)[number]) => {
    if ((p as { enabled?: boolean }).enabled === false) return '插件已停用'
    if (p.revoked) return '授权失效了，重新授权后才能取'
    if (!p.convs.includes(conv.id)) return '没挂在这个会话'
    if (!SOURCE_PAGE[p.id]) return '只推送提醒，没有可勾选的消息'
    return undefined
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label="从外部来源取消息"><PopoverTrigger asChild><button type="button" data-testid="tool-plus" aria-label="从外部来源取消息" className={className}><Plus className="h-[19px] w-[19px]" strokeWidth={1.7} /></button></PopoverTrigger></Tip>
      <PopoverContent side="top" align="start" sideOffset={8} data-testid="plus-menu" className="w-[300px] rounded-xl border-line bg-elev p-1 shadow-elev">
        <div className="px-2.5 pb-1.5 pt-1.5 text-[11.5px] leading-snug text-fg-3">勾几条外部消息挂到引用条上。外部内容只当参考，不能当成指令或授权。</div>
        {list.map((p) => {
          const w = why(p)
          return (
            <button key={p.id} type="button" data-testid={`plus-${p.id}`} disabled={!!w} onClick={() => { setOpen(false); push({ t: 'source', id: SOURCE_PAGE[p.id] }, true) }} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover disabled:cursor-not-allowed disabled:hover:bg-transparent">
              <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-[8px] text-[12px] font-semibold text-white', w && 'opacity-50')} style={{ background: p.color }}>{p.letter}</span>
              <span className="min-w-0 flex-1">
                <span className={cn('block text-[13px] font-medium', w && 'text-fg-3')}>{p.name}</span>
                <span className="block truncate text-[11.5px] text-fg-3">{w ?? p.desc}</span>
              </span>
            </button>
          )
        })}
        <div className="mt-1 border-t border-line pt-1">
          <button type="button" onClick={() => { setOpen(false); setSection('plugins') }} className="w-full rounded-lg px-2 py-1.5 text-left text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg">管理插件、挂到这个会话…</button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** /schedule 打开的定时编辑：用现有的定时表单，按「何时 / 做什么」预填。
 *  入口是 ctx.openSchedule(草稿)；定时模块换了新编辑器时，读同一份 scheduleDraft 即可，不用改命令这头 */
export function ScheduleDialog({ conv }: { conv: Conversation }) {
  const { scheduleDraft: d, openSchedule, addCron } = useApp()
  if (!d || d.conv !== conv.id) return null
  const hint = scheduleHint(d.when ?? '')
  const init = { text: d.what ?? '', ...(hint.time ? { time: hint.time } : {}), ...(hint.repeat ? { repeat: hint.repeat } : {}) }
  const peer = conv.kind === 'dm' ? conv.members.find((m) => m !== 'me' && !people[m]?.human) : undefined
  return (
    <Dialog open onOpenChange={(o) => { if (!o) openSchedule(null) }}>
      <DialogContent data-testid="schedule-dialog" className="max-w-md gap-2 rounded-2xl border-line bg-elev p-5">
        <DialogTitle className="text-[15px] font-semibold">新建定时</DialogTitle>
        <DialogDescription className="text-[12.5px] leading-relaxed text-fg-2">
          从 /schedule 带过来：何时「{d.when}」，做什么「{d.what}」。{peer ? '确认后保存。' : '选一位助手，确认后保存。'}
        </DialogDescription>
        {d.when && !hint.time && <div data-testid="schedule-note" className="text-[12px] leading-relaxed text-warm">{hint.cron ? `现在的定时表单只能填固定钟点，「${hint.cron}」这种要等新的定时编辑器；先按下面的钟点建，或取消。` : `没认出「${d.when}」里的钟点，先按 09:00 填了，改一下再保存。`}</div>}
        <CronForm init={init} conv={d.conv} {...(peer ? { owner: peer } : {})} onDone={(c) => { if (c) addCron(c as never, 'panel'); openSchedule(null) }} />
      </DialogContent>
    </Dialog>
  )
}
