import { FileText, Image as ImageIcon, X } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { ArgGhost, SlashHint, SlashUnknown } from '@/app/composer/SlashHint'
import { MentionMenu } from '@/app/composer/MentionMenu'
import { QuoteBar } from '@/app/composer/QuoteBar'
import { ScheduleDialog } from '@/app/composer/ScheduleDialog'
import { SlashMenu } from '@/app/composer/SlashMenu'
import { Toolbar } from '@/app/composer/Toolbar'
import { useAutoHeight } from '@/app/composer/useAutoHeight'
import { useMention } from '@/app/composer/useMention'
import { useSlash } from '@/app/composer/useSlash'
import { Button } from '@/components/ui/button'
import { artifacts, type Artifact, type Conversation, type QuoteRef } from '@/data'
import { attachLive } from '@/api/wire/chat-ops'
import { live, liveCtx } from '@/api/wire/live'
import { useApp, useAppStore } from '@/store'

type PendingAttachment = { id: string; name: string; kind: Artifact['kind']; meta: string; file?: File; previewUrl?: string }

/* 输入区:一个圆角输入框,里面从上到下是 待发附件 → 引用条 → 命令提示 → 自适应高度的输入 → 工具栏。 */
export function Composer({ conv, draft, setDraft, quotes, onRemoveQuote, onSend, inputRef }: {
  conv: Conversation; draft: string; setDraft: (v: string | ((d: string) => string)) => void; quotes: QuoteRef[]
  onRemoveQuote: (q: QuoteRef) => void; onSend: (text?: string) => void; inputRef: RefObject<HTMLTextAreaElement | null>
}) {
  const { pushMsg, toast, editing, setEditing, isLive } = useApp((s) => ({ pushMsg: s.pushMsg, toast: s.toast, editing: s.editing, setEditing: s.setEditing, isLive: live(s) }))
  const [caret, setCaret] = useState(draft.length)
  const [focused, setFocused] = useState(false)
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const [sendingFiles, setSendingFiles] = useState(false)
  const pendingRef = useRef<PendingAttachment[]>([])
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => { pendingRef.current = pending }, [pending])
  useEffect(() => () => { for (const item of pendingRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl) }, [])

  const placeCaret = (p: number) => {
    setCaret(p)
    setTimeout(() => { const el = inputRef.current; el?.focus(); el?.setSelectionRange(p, p) }, 0)
  }
  const queueFile = (name: string, kind: Artifact['kind'], meta: string, file?: File) => {
    const previewUrl = file?.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
    setPending((items) => [...items, { id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name, kind, meta, file, previewUrl }])
  }
  const removePending = (id: string) => setPending((items) => {
    const item = items.find((x) => x.id === id)
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
    return items.filter((x) => x.id !== id)
  })
  const sendPending = async (items: readonly PendingAttachment[]) => {
    if (!items.length) return
    if (isLive) {
      const files = items.flatMap((x) => x.file ? [x.file] : [])
      if (files.length) await attachLive(liveCtx(useAppStore.getState, useAppStore.setState), conv.id, files)
      return
    }
    for (const item of items) {
      const id = 'up' + Math.random().toString(36).slice(2, 7)
      artifacts.push({ id, name: item.name, kind: item.kind, meta: item.meta, by: 'me', conv: conv.id, when: '刚刚' })
      pushMsg({ k: 'file', id: 'f' + id, from: 'me', artifactId: id }, conv.id)
    }
    toast(items.length === 1 ? `已发出「${items[0]!.name}」，也存进了文件` : `已发出 ${items.length} 个附件，也存进了文件`)
  }
  const submit = (text?: string) => {
    if (sendingFiles) return
    const items = pending
    const shouldSendText = !!text?.trim() || quotes.length > 0 || (!!draft.trim() && text === undefined)
    if (shouldSendText) onSend(text)
    if (!items.length) return
    setPending([])
    setSendingFiles(true)
    void sendPending(items).finally(() => setSendingFiles(false))
  }
  const slash = useSlash({ conv, draft, setDraft, caret, focused, editing: !!editing, placeCaret, onSend: submit, inputRef })
  const at = useMention({ conv, draft, setDraft, placeCaret, inputRef })
  const tall = useAutoHeight(inputRef, boxRef, draft)
  useEffect(() => { setCaret(inputRef.current?.selectionStart ?? draft.length) }, [conv.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const insert = (s: string) => {
    const pos = inputRef.current?.selectionStart ?? draft.length
    setDraft((d) => d.slice(0, pos) + s + d.slice(pos))
    placeCaret(pos + s.length)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (slash.onMenuKey(e) || at.onKey(e)) return
    if ((e.key === 'Backspace' || e.key === 'Escape') && draft === '' && quotes.length > 0) {
      e.preventDefault(); e.stopPropagation(); onRemoveQuote(quotes[quotes.length - 1]!); return
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); slash.submit() }
  }
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    e.preventDefault()
    for (const file of images) queueFile(file.name || `粘贴图片-${Date.now()}.png`, 'asset', `${(file.size / 1024).toFixed(0)} KB · 你粘贴的`, file)
  }

  const { inv, menuOpen, token } = slash
  const canSend = !sendingFiles && (inv ? inv.ok : !!draft.trim() || quotes.length > 0 || pending.length > 0)
  const ghost = inv && !menuOpen && !tall && caret >= draft.length && !inv.extra && inv.args.some((a) => a.value === undefined)
  const peer = conv.kind === 'dm' ? conv.members.find((m) => m !== 'me') : null
  return (
    <div className="dsbot-composer relative shrink-0 pb-4 pt-2" data-testid="composer-wrap" data-dsbot-composer="true">
      <ScheduleDialog conv={conv} />
      <div ref={boxRef} data-testid="composer-box" className="relative rounded-[22px] border border-line bg-elev shadow-soft transition-[border-color,box-shadow] duration-fast ease-out focus-within:border-fg-3/50 focus-within:shadow-elev">
        {menuOpen && token && <SlashMenu items={slash.shown} sel={slash.sel} query={token.query} onHover={slash.setSlashIdx} onPick={(e) => slash.choose(e, 'click')} />}
        {!menuOpen && at.open && <MentionMenu cands={at.cands} idx={at.idx} onHover={at.setIdx} onPick={at.pick} />}
        {editing && <div data-testid="edit-bar" className="flex items-center gap-2 px-3 pt-2 text-[12.5px] text-fg-2"><span className="h-3.5 w-0.5 rounded bg-me" />正在编辑你发过的消息 · 回车保存<Button data-testid="edit-cancel" variant="ghost" size="xs" className="ml-auto font-normal" onClick={() => { setEditing(null); setDraft('') }}>取消</Button></div>}
        {pending.length > 0 && <PendingAttachments items={pending} onRemove={removePending} />}
        {quotes.length > 0 && <QuoteBar quotes={quotes} onRemove={onRemoveQuote} />}
        {inv && !menuOpen && <SlashHint inv={inv} />}
        {slash.unknown && <SlashUnknown name={slash.unknown} />}
        <div className="relative px-3">
          {ghost && <ArgGhost inv={inv} draft={draft} />}
          <textarea ref={inputRef} value={draft} data-testid="composer" rows={1}
            onChange={(e) => { setDraft(e.target.value); setCaret(e.target.selectionStart); at.track(e.target.value, e.target.selectionStart) }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onFocus={(e) => { setFocused(true); setCaret(e.currentTarget.selectionStart) }}
            onKeyDown={onKeyDown} onPaste={onPaste} onBlur={() => { setFocused(false); setTimeout(at.close, 120) }}
            placeholder={peer ? `给 ${conv.title} 发消息，/ 用命令` : '发消息，@ 交给助手，/ 用命令'}
            className="relative block w-full resize-none overflow-hidden bg-transparent py-2 text-[14.5px] leading-[1.6] outline-none placeholder:text-fg-3" />
        </div>
        <Toolbar conv={conv} inv={inv} canSend={canSend} nudge={slash.nudge} onInsert={insert} onAt={() => { insert('@'); at.start() }} onSlash={slash.open} onFile={queueFile} onSubmit={() => { if (inv) slash.submit(); else submit() }} />
      </div>
    </div>
  )
}

function PendingAttachments({ items, onRemove }: { items: readonly PendingAttachment[]; onRemove: (id: string) => void }) {
  return <div className="flex flex-wrap gap-2 px-3 pb-2 pt-2" data-testid="pending-attachments">
    {items.map((item) => <div key={item.id} data-testid={`pending-attachment-${item.id}`} className="group relative flex w-[168px] items-center gap-2 rounded-xl border border-line bg-hover p-1.5 pr-8">
      {item.previewUrl ? <img src={item.previewUrl} alt={item.name} className="h-10 w-10 rounded-lg object-cover" /> : <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-elev text-fg-2">{item.kind === 'asset' ? <ImageIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}</span>}
      <span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium">{item.name}</span><span className="block truncate text-[11px] text-fg-3">待发送 · {item.meta}</span></span>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`移除${item.name}`} data-testid={`remove-pending-${item.id}`} onClick={() => onRemove(item.id)} className="absolute right-1.5 top-1.5 rounded-full text-fg-3 opacity-70 hover:bg-elev hover:text-fg"><X className="h-3.5 w-3.5" /></Button>
    </div>)}
  </div>
}
