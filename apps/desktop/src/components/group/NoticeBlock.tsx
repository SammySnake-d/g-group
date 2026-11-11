/* 群公告（#1566 #1593 #1618；AC-55）：
   - 像 QQ：可以有多条，只露置顶那条的前几行；「全部 N 条」展开成列表，每条可展开全文；没有公告时只有标题和「+」。
   - 每条都能改（带版本，别人先改过不覆盖）、能撤下（先在原地说清后果再确认）。
   - 不像 mirasim：这里的公告由软件装配进每个助手接活前的上下文，所以每条都标出各助手装配到了哪一版。
     写「已装配」，不写「已遵守」——装配是软件做的、可核对；遵守与否要看它干的活。 */
import { useState, type ReactNode } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useApp } from '@/ctx'
import { people, type Conversation, type Notice } from '@/data'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Textarea } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { collapse } from '@/config/motion'
import { cn } from '@/lib/utils'
import { NOTICE } from './constants'
import { loadedOf, noticesOf } from './notices'

function Loaded({ conv, n }: { conv: Conversation; n: Notice }) {
  const L = loadedOf(conv, n)
  const ok = L.filter((x) => x.ok).length
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-testid={`notice-loaded-${n.id}`} className={cn('inline-flex shrink-0 items-center gap-1 tabular-nums', ok < L.length && 'text-warm')}>
          <span className="flex -space-x-1">{L.map((x) => <span key={x.b} className={cn('rounded-full ring-2 ring-bg', !x.ok && 'opacity-35 grayscale')}><Avatar id={x.b} size={14} status={false} /></span>)}</span>
          {ok}/{L.length} 已装配 v{n.ver}
        </span>
      </TooltipTrigger>
      <TooltipContent className="whitespace-pre-line rounded-lg border-0 bg-fg px-2 py-1 text-xs text-bg">
        {L.map((x) => `${people[x.b].name}：${x.v ? `已装配 v${x.v}${x.ok ? '' : `（当前 v${n.ver}，下次接活时更新）`}` : '还没装配'}`).join('\n')}
      </TooltipContent>
    </Tooltip>
  )
}

/** 「改 · 撤下」两个动作;撤下先在原地确认(破坏性操作不一点就走) */
function Actions({ n, onEdit, onRemove, children }: { n: Notice; onEdit: () => void; onRemove: () => void; children?: ReactNode }) {
  const [asking, setAsking] = useState(false)
  if (asking) {
    return (
      <div data-testid={`notice-remove-ask-${n.id}`} role="alertdialog" aria-label={NOTICE.removeAsk} className="mt-1 flex basis-full items-center gap-1.5 text-[11.5px]">
        <span className="min-w-0 flex-1 text-fg-2">{NOTICE.removeAsk}</span>
        <Button variant="ghost" size="xs" onClick={() => setAsking(false)}>取消</Button>
        <Button data-testid={`notice-remove-go-${n.id}`} variant="danger-solid" size="xs" onClick={() => { setAsking(false); onRemove() }}>{NOTICE.removeGo}</Button>
      </div>
    )
  }
  return (
    <div className="mt-1 flex items-center gap-2 text-[11.5px] text-fg-3">
      {children}
      <Button data-testid={`notice-edit-${n.id}`} variant="link" size={null} className="text-[11.5px] text-fg-2" onClick={onEdit}>改</Button>
      <Button data-testid={`notice-remove-${n.id}`} variant="link" size={null} className="text-[11.5px] text-fg-2 hover:text-err" onClick={() => setAsking(true)}>撤下</Button>
    </div>
  )
}

function Editor({ testid, inputTestid, value, onChange, onCancel, onSave, saveTestid, saveLabel, canSave, placeholder, counter }: {
  testid?: string; inputTestid: string; value: string; onChange: (v: string) => void; onCancel: () => void; onSave: () => void; saveTestid: string; saveLabel: string; canSave: boolean; placeholder?: string; counter?: boolean
}) {
  return (
    <div className="mt-1.5" data-testid={testid}>
      <Textarea data-testid={inputTestid} autoFocus value={value} onChange={(e) => onChange(e.target.value)} rows={3} maxLength={NOTICE.max} placeholder={placeholder} aria-label={NOTICE.title}
        className="resize-none text-[13px]" />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        {counter && <span className="flex-1 text-[11.5px] tabular-nums text-fg-3">{value.length}/{NOTICE.max}</span>}
        <Button variant="ghost" size="xs" onClick={onCancel}>取消</Button>
        <Button data-testid={saveTestid} variant="primary" size="xs" disabled={!canSave} onClick={onSave}>{saveLabel}</Button>
      </div>
    </div>
  )
}

export function NoticeBlock({ conv }: { conv: Conversation }) {
  const { setNotice, editNotice, removeNotice, toast } = useApp()
  const live = useApp((s) => s.backend.mode === 'connected')
  const list = noticesOf(conv)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [ev, setEv] = useState('')
  const [full, setFull] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [v, setV] = useState('')
  const top = list.find((n) => n.top) ?? list[0]
  const many = list.length > 1
  /* 连上后端时发布成功与否由回包提示;演示里直接提示 */
  const publish = () => { const t = v.trim(); if (!t) return; setNotice(conv.id, t); if (!live) toast(NOTICE.published); setAdding(false); setV('') }
  const startEdit = (n: Notice) => { setEditing(n.id); setEv(n.text) }
  const editor = (n: Notice) => editing === n.id && (
    <Editor testid={`notice-editor-${n.id}`} inputTestid={`notice-edit-input-${n.id}`} value={ev} onChange={setEv} onCancel={() => setEditing(null)}
      onSave={() => { editNotice(conv.id, n.id, ev.trim()); setEditing(null) }} saveTestid={`notice-edit-save-${n.id}`} saveLabel={`改到 v${n.ver + 1}`} canSave={!!ev.trim() && ev.trim() !== n.text} />
  )
  return (
    <section className="border-b border-line px-4 pb-3 pt-3" data-testid="notice-block" data-count={list.length}>
      <div className="flex h-7 items-center">
        <Button data-testid="notice-title" variant="ghost" size={null} onClick={() => many && setOpen(!open)}
          className={cn('-ml-1 h-7 gap-1 px-1 text-[14px] font-semibold text-fg active:scale-100', !many && 'cursor-default hover:bg-transparent')}>
          {NOTICE.title}{many && <span className="text-[12px] font-normal tabular-nums text-fg-3">{list.length}</span>}
          {many && <ChevronRight className={cn('h-3.5 w-3.5 text-fg-3 transition-transform duration-fast ease-out', open && 'rotate-90')} />}
        </Button>
        <span className="flex-1" />
        <IconButton data-testid="notice-add" label={NOTICE.add} size="icon-sm" icon={<Plus />} onClick={() => setAdding(true)} />
      </div>
      <AnimatePresence initial={false}>
        {adding && (
          <motion.div key="add" {...collapse} className="overflow-hidden">
            <Editor inputTestid="notice-input" value={v} onChange={setV} onCancel={() => setAdding(false)} onSave={publish} saveTestid="notice-save" saveLabel="发布" canSave={!!v.trim()} placeholder={NOTICE.placeholder} counter />
          </motion.div>
        )}
      </AnimatePresence>
      {!top ? null : !open ? (
        <div data-testid={`notice-${top.id}`}>
          <Button data-testid="notice-text" variant="ghost" size={null} onClick={() => (many ? setOpen(true) : setFull(full ? null : top.id))}
            className="-mx-1.5 mt-0.5 block h-auto w-[calc(100%+12px)] whitespace-normal rounded-lg px-1.5 py-1 text-left font-normal active:scale-100">
            <p className={cn('whitespace-pre-wrap text-[13px] leading-[1.65] text-fg-2', full !== top.id && 'line-clamp-3')}>
              {top.top && many && <Chip tone="warm" size="xs" className="mr-1 align-[1px]">{NOTICE.pinned}</Chip>}{top.text}
            </p>
            <span className="mt-1 flex items-center gap-2 text-[11.5px] text-fg-3"><span className="truncate">{top.by} · {top.at}</span><span className="flex-1" /><Loaded conv={conv} n={top} /></span>
          </Button>
          {!many && <Actions n={top} onEdit={() => startEdit(top)} onRemove={() => removeNotice(conv.id, top.id)} />}
          {!many && editor(top)}
        </div>
      ) : (
        <ul className="-mx-1.5 mt-1 max-h-[340px] space-y-1 overflow-y-auto" data-testid="notice-list">
          {list.map((n) => (
            <li key={n.id} data-testid={`notice-${n.id}`} className="rounded-lg px-1.5 py-1.5 transition-colors duration-fast hover:bg-hover">
              <div className="mb-0.5 flex items-center gap-1.5 text-[11.5px] text-fg-3">
                {n.top && <Chip tone="warm" size="xs">{NOTICE.pinned}</Chip>}
                <span className="truncate">{n.by} · {n.at}</span>
              </div>
              <p className={cn('whitespace-pre-wrap text-[13px] leading-[1.6] text-fg', full !== n.id && 'line-clamp-2')}>{n.text}</p>
              <div className="flex flex-wrap items-center gap-x-2">
                <Actions n={n} onEdit={() => startEdit(n)} onRemove={() => removeNotice(conv.id, n.id)}>
                  {n.text.length > 40 && <Button data-testid={`notice-more-${n.id}`} variant="link" size={null} className="text-[11.5px]" onClick={() => setFull(full === n.id ? null : n.id)}>{full === n.id ? '收起' : '展开'}</Button>}
                </Actions>
                <span className="flex-1" /><span className="mt-1 text-[11.5px] text-fg-3"><Loaded conv={conv} n={n} /></span>
              </div>
              {editor(n)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
