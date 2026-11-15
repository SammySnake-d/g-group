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
import { uploadFilesLive } from '@/api/wire/chat-ops'
import { sendLive } from '@/api/wire/messages'
import { scheduleDraftSave } from '@/api/wire/drafts'
import { PendingImages } from '@/app/composer/PendingImages'
import { addDraftImages, imageDraftOf, removeDraftImages, setImageSending, useImageDrafts } from '@/app/composer/imageDrafts'

/* 输入区:一个圆角输入框,里面从上到下是 引用条 → 命令提示 → 自适应高度的输入 → 工具栏(左下角「+」取外部消息,右下角发送)。
   打 / 弹出命令菜单(Telegram 式),选中后在输入框里提示该填的参数;打 @ 弹出选人。两个菜单都贴着输入框上沿,焦点一直在输入框里。 */
export function Composer({ conv, draft, setDraft, quotes, onRemoveQuote, onSend, inputRef }: {
  conv: Conversation; draft: string; setDraft: (v: string | ((d: string) => string)) => void; quotes: QuoteRef[]
  onRemoveQuote: (q: QuoteRef) => void; onSend: (text?: string) => void; inputRef: RefObject<HTMLTextAreaElement | null>
}) {
  const { pushMsg, toast, editing, setEditing, isLive } = useApp((s) => ({ pushMsg: s.pushMsg, toast: s.toast, editing: s.editing, setEditing: s.setEditing, isLive: live(s) }))
  const [caret, setCaret] = useState(draft.length)
  const [focused, setFocused] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const imageDraft = useImageDrafts((s) => s.rooms[conv.id])

  const send = async (override?: string) => {
    const d = imageDraftOf(conv.id)
    if (d.sending) return
    if (!d.images.length || editing) { onSend(override); return }
    const text = (override ?? draft).trim()
    const submittedText = useAppStore.getState().drafts[conv.id] ?? ''
    const images = [...d.images]
    setImageSending(conv.id, true)
    try {
      if (isLive) {
        const w = liveCtx(useAppStore.getState, useAppStore.setState)
        const files = await uploadFilesLive(w, images.map((x) => x.file))
        if (!files || !await sendLive(w, conv.id, text, quotes, files)) return
      } else {
        const files = await Promise.all(images.map(async (x) => {
          const ref = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(x.file) })
          return { ref, name: x.name, mime: x.file.type, bytes: x.file.size }
        }))
        pushMsg({ k: 'text', id: crypto.randomUUID(), from: 'me', text, files, ...(quotes.length ? { quotes } : {}) }, conv.id)
      }
      // 回执只清本次提交的内容；切去别处或期间新写的草稿不受影响。
      await removeDraftImages(conv.id, images.map((x) => x.id))
      useAppStore.setState((s) => ({
        drafts: s.drafts[conv.id] === submittedText ? { ...s.drafts, [conv.id]: '' } : s.drafts,
        quotes: { ...s.quotes, [conv.id]: (s.quotes[conv.id] ?? []).filter((q) => !quotes.includes(q)) },
      }))
      if (isLive) scheduleDraftSave(liveCtx(useAppStore.getState, useAppStore.setState), conv.id)
    } finally { setImageSending(conv.id, false) }
  }

  const placeCaret = (p: number) => {
    setCaret(p)
    setTimeout(() => { const el = inputRef.current; el?.focus(); el?.setSelectionRange(p, p) }, 0)
  }
  const slash = useSlash({ conv, draft, setDraft, caret, focused, editing: !!editing, placeCaret, onSend: (text) => { void send(text) }, inputRef })
  const at = useMention({ conv, draft, setDraft, placeCaret, inputRef })
  const tall = useAutoHeight(inputRef, boxRef, draft)
  useEffect(() => { setCaret(inputRef.current?.selectionStart ?? draft.length) }, [conv.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /* C-US19:截图、文件、图片都真的发出去,变成一条文件消息,同时进「文件」里,写明来自这个会话 */
  const sendFile = (name: string, kind: Artifact['kind'], meta: string, file?: File) => {
    if (file?.type.startsWith('image/')) { void addDraftImages(conv.id, [file]); return }
    /* 连上后端:按内容上传,再作为一条只有附件的消息发出;以后端回包为准 */
    if (isLive) { if (file) return attachLive(liveCtx(useAppStore.getState, useAppStore.setState), conv.id, [file]); return }
    const id = 'up' + Math.random().toString(36).slice(2, 7)
    artifacts.push({ id, name, kind, meta, by: 'me', conv: conv.id, when: '刚刚' })
    pushMsg({ k: 'file', id: 'f' + id, from: 'me', artifactId: id }, conv.id)
    toast(`已发出「${name}」，也存进了文件`)
  }
  const insert = (s: string) => {
    const pos = inputRef.current?.selectionStart ?? draft.length
    setDraft((d) => d.slice(0, pos) + s + d.slice(pos))
    placeCaret(pos + s.length)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (slash.onMenuKey(e) || at.onKey(e)) return
    /* 输入框空着时,Backspace / Esc 去掉最后一条引用 */
    if ((e.key === 'Backspace' || e.key === 'Escape') && draft === '' && quotes.length > 0) {
      e.preventDefault(); e.stopPropagation(); onRemoveQuote(quotes[quotes.length - 1]); return
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); slash.submit() }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Electron 的系统剪贴板可能只给 items；优先读 files，避免同一张图取两遍。
    const fromFiles = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
    const fromItems = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => !!f)
    const images = fromFiles.length ? fromFiles : fromItems
    if (!images.length) return
    e.preventDefault()
    if (!editing) void addDraftImages(conv.id, images)
  }

  const { inv, menuOpen, token } = slash
  const canSend = !imageDraft?.sending && (inv ? inv.ok : !!draft.trim() || quotes.length > 0 || !!imageDraft?.images.length)
  const ghost = inv && !menuOpen && !tall && caret >= draft.length && !inv.extra && inv.args.some((a) => a.value === undefined)
  const peer = conv.kind === 'dm' ? conv.members.find((m) => m !== 'me') : null
  return (
    <div className="relative shrink-0 pb-4 pt-1" data-testid="composer-wrap">
      <ScheduleDialog conv={conv} />
      <div ref={boxRef} data-testid="composer-box" className="relative rounded-2xl border border-line bg-elev shadow-soft transition-[border-color,box-shadow] duration-fast ease-out focus-within:border-fg-3/50 focus-within:shadow-elev">
        {menuOpen && token && <SlashMenu items={slash.shown} sel={slash.sel} query={token.query} onHover={slash.setSlashIdx} onPick={(e) => slash.choose(e, 'click')} />}
        {!menuOpen && at.open && <MentionMenu cands={at.cands} idx={at.idx} onHover={at.setIdx} onPick={at.pick} />}
        {editing && (
          <div data-testid="edit-bar" className="flex items-center gap-2 px-3 pt-2 text-[12.5px] text-fg-2">
            <span className="h-3.5 w-0.5 rounded bg-me" />正在编辑你发过的消息 · 回车保存
            <Button data-testid="edit-cancel" variant="ghost" size="xs" className="ml-auto font-normal" onClick={() => { setEditing(null); setDraft('') }}>取消</Button>
          </div>
        )}
        {quotes.length > 0 && <QuoteBar quotes={quotes} onRemove={onRemoveQuote} />}
        {!editing && <PendingImages key={conv.id} room={conv.id} />}
        {inv && !menuOpen && <SlashHint inv={inv} />}
        {slash.unknown && <SlashUnknown name={slash.unknown} />}
        <div className="relative px-3">
          {ghost && <ArgGhost inv={inv} draft={draft} />}
          <textarea
            ref={inputRef} value={draft} data-testid="composer" rows={1}
            onChange={(e) => { setDraft(e.target.value); setCaret(e.target.selectionStart); at.track(e.target.value, e.target.selectionStart) }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onFocus={(e) => { setFocused(true); setCaret(e.currentTarget.selectionStart) }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => { setFocused(false); setTimeout(at.close, 120) }}
            placeholder={peer ? `给 ${conv.title} 发消息，/ 用命令` : '发消息，@ 交给助手，/ 用命令'}
            className="relative block w-full resize-none overflow-hidden bg-transparent py-2 text-[14.5px] leading-[1.6] outline-none placeholder:text-fg-3"
          />
        </div>
        <Toolbar conv={conv} inv={inv} canSend={canSend} nudge={slash.nudge} onInsert={insert} onAt={() => { insert('@'); at.start() }} onSlash={slash.open} onFile={sendFile} onSubmit={slash.submit} />
      </div>
    </div>
  )
}
