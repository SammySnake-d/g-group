import { useEffect, useState, type RefObject, useRef } from 'react'
import { Smile, AtSign, Scissors, FolderClosed, Image as ImageIcon, Link2, History, X, Reply } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, type Conversation, type QuoteRef, artifacts, type Artifact } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from './Avatar'
import { Tip } from './Messages'
import { broken } from '@/mut'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const EMOJIS = ['😀', '😂', '🥹', '😊', '😉', '😍', '🤔', '😮', '😴', '😭', '😡', '👍', '👎', '👏', '🙏', '💪', '🎉', '❤️', '🔥', '✅', '❌', '👀', '🤝', '🫡']

/* QQ 式输入区：上面一排工具，中间多行输入（顶边可拖高），右下角「发送」，提示 Enter 发送 */
export function Composer({ conv, draft, setDraft, quotes, onRemoveQuote, onSend, inputRef }: {
  conv: Conversation; draft: string; setDraft: (v: string | ((d: string) => string)) => void; quotes: QuoteRef[]
  onRemoveQuote: (q: QuoteRef) => void; onSend: () => void; inputRef: RefObject<HTMLTextAreaElement | null>
}) {
  const { push, pushMsg, toast, editing, setEditing } = useApp()
  const [h, setH] = useState(92)
  const fileRef = useRef<HTMLInputElement>(null)
  const imgRef = useRef<HTMLInputElement>(null)
  /* C-US19：截图、文件、图片都真的发出去，变成一条文件消息，同时进「文件」里，写明来自这个会话 */
  const sendFile = (name: string, kind: Artifact['kind'], meta: string) => {
    const id = 'up' + Math.random().toString(36).slice(2, 7)
    artifacts.push({ id, name, kind, meta, by: 'me', conv: conv.id, when: '刚刚' })
    pushMsg({ k: 'file', id: 'f' + id, from: 'me', artifactId: id }, conv.id)
    toast(`已发出「${name}」，也存进了文件`)
  }
  const pick = (e: React.ChangeEvent<HTMLInputElement>, kind: Artifact['kind']) => {
    for (const f of Array.from(e.target.files ?? [])) sendFile(f.name, kind, `${(f.size / 1024).toFixed(0)} KB · 你发的`)
    e.target.value = ''
  }
  const [at, setAt] = useState<{ q: string } | null>(null)
  const [atIdx, setAtIdx] = useState(0)
  const peer = conv.kind === 'dm' ? conv.members.find((m) => m !== 'me') : null
  const cands = ['helper', ...conv.members.filter((m) => m !== 'me')].filter((m) => !at || people[m].name.toLowerCase().includes(at.q.toLowerCase()))
  const canSend = !!draft.trim() || quotes.length > 0

  useEffect(() => { setAtIdx(0) }, [at?.q])

  const insert = (s: string) => {
    const el = inputRef.current
    const pos = el?.selectionStart ?? draft.length
    setDraft((d) => d.slice(0, pos) + s + d.slice(pos))
    setTimeout(() => { el?.focus(); el?.setSelectionRange(pos + s.length, pos + s.length) }, 0)
  }
  const pickAt = (id: string) => {
    const el = inputRef.current
    const pos = el?.selectionStart ?? draft.length
    const before = draft.slice(0, pos).replace(/@([^\s@]*)$/, '')
    const after = draft.slice(pos)
    const ins = '@' + people[id].name + ' '
    setDraft(before + ins + after)
    setAt(null)
    setTimeout(() => { el?.focus(); const p = before.length + ins.length; el?.setSelectionRange(p, p) }, 0)
  }
  const onChange = (v: string, pos: number) => {
    setDraft(v)
    const m = v.slice(0, pos).match(/@([^\s@]*)$/)
    setAt(m ? { q: m[1] } : null)
  }
  const dragTop = (e: React.PointerEvent) => {
    e.preventDefault()
    const sy = e.clientY, sh = h
    const mv = (ev: PointerEvent) => setH(Math.max(64, Math.min(320, sh - (ev.clientY - sy))))
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); document.body.style.cursor = '' }
    document.body.style.cursor = 'row-resize'
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
  }

  const tool = 'grid h-8 w-8 place-items-center rounded-md text-fg-2 transition hover:bg-hover hover:text-fg'
  return (
    <div className="relative shrink-0 border-t border-line bg-bg" data-testid="composer-wrap">
      <div onPointerDown={dragTop} data-testid="composer-resize" title="拖动调整输入框高度" className="absolute inset-x-0 -top-[3px] z-10 h-[6px] cursor-row-resize" />
      {/* 工具栏 */}
      <div className="flex items-center gap-0.5 px-3 pt-1.5">
        <Popover>
          <PopoverTrigger asChild><button data-testid="tool-emoji" className={tool}><Smile className="h-[19px] w-[19px]" strokeWidth={1.6} /></button></PopoverTrigger>
          <PopoverContent side="top" align="start" className="grid w-[312px] grid-cols-8 gap-0.5 rounded-xl border-line bg-elev p-2 shadow-elev">
            {EMOJIS.map((e) => <button key={e} onClick={() => insert(e)} className="grid h-9 w-9 place-items-center rounded-lg text-[20px] hover:bg-hover">{e}</button>)}
          </PopoverContent>
        </Popover>
        {<Tip label="@ 某人（第一项是 Helper）"><button data-testid="tool-at" onClick={() => { insert('@'); setAt({ q: '' }) }} className={tool}><AtSign className="h-[18px] w-[18px]" strokeWidth={1.6} /></button></Tip>}
        <Tip label="截图（截当前窗口发出去）"><button data-testid="tool-shot" onClick={() => sendFile(`截图 ${new Date().toTimeString().slice(0, 5)}.png`, 'asset', '1440×900 · 你截的')} className={tool}><Scissors className="h-[18px] w-[18px]" strokeWidth={1.6} /></button></Tip>
        <Tip label="文件"><button data-testid="tool-file" onClick={() => fileRef.current?.click()} className={tool}><FolderClosed className="h-[18px] w-[18px]" strokeWidth={1.6} /></button></Tip>
        <Tip label="图片"><button data-testid="tool-image" onClick={() => imgRef.current?.click()} className={tool}><ImageIcon className="h-[18px] w-[18px]" strokeWidth={1.6} /></button></Tip>
        <input ref={fileRef} data-testid="file-input" type="file" multiple hidden onChange={(e) => pick(e, 'doc')} />
        <input ref={imgRef} data-testid="image-input" type="file" accept="image/*" multiple hidden onChange={(e) => pick(e, 'asset')} />
        <Tip label="从插件取消息（本聊天挂着：飞书）"><button data-testid="tool-source" onClick={() => push({ t: 'source', id: 'feishu' }, true)} className={tool}><Link2 className="h-[18px] w-[18px]" strokeWidth={1.6} /></button></Tip>
        <div className="flex-1" />
        {broken('AC-50-2') && <Tip label="聊天记录"><button data-testid="tool-history" onClick={() => push({ t: 'search', id: conv.id }, true)} className={tool}><History className="h-[18px] w-[18px]" strokeWidth={1.6} /></button></Tip>}
      </div>

      {/* 待发引用：每条独立一行，带作者色、× */}
      {editing && (
        <div data-testid="edit-bar" className="flex items-center gap-2 px-4 pt-1.5 text-[12.5px] text-fg-2">
          <span className="h-3.5 w-0.5 rounded bg-me" />正在编辑你发过的消息 · 回车保存
          <button data-testid="edit-cancel" onClick={() => { setEditing(null); setDraft('') }} className="ml-auto text-fg-3 hover:text-fg">取消</button>
        </div>
      )}
      {quotes.length > 0 && (
        <div className="flex flex-col gap-1 px-4 pt-1.5" data-testid="quote-bar">
          {quotes.map((x) => {
            const p = people[x.from]
            return (
              <div key={x.msgId} data-testid="quote-chip" className="fade-up flex min-w-0 items-center gap-2 rounded-lg border border-line bg-side py-1 pl-1.5 pr-1 text-[12.5px]">
                <span className="h-4 w-[3px] shrink-0 rounded-full" style={{ background: p?.color }} />
                {x.ext ? <span className="grid h-4 w-4 shrink-0 place-items-center rounded bg-hover text-[9px] font-semibold">{x.ext[0]}</span> : <Avatar id={x.from} size={16} status={false} mood="idle" />}
                {x.reply && <span className="flex shrink-0 items-center gap-0.5 rounded bg-me/10 px-1 text-[11px] font-medium text-me"><Reply className="h-3 w-3" />回复</span>}
                <span className="shrink-0 font-medium">{x.ext ? `${x.ext} · ${x.text.split('：')[0]}` : p?.name}</span>
                <span className="min-w-0 flex-1 truncate text-fg-2">{x.ext ? x.text.split('：').slice(1).join('：') : x.text}</span>
                <button data-testid="quote-x" onClick={() => onRemoveQuote(x)} className="grid h-5 w-5 shrink-0 place-items-center rounded text-fg-3 hover:bg-hover hover:text-fg" title="去掉这条"><X className="h-3.5 w-3.5" /></button>
              </div>
            )
          })}
          {quotes.length > 1 && <div className="px-1 text-[11.5px] text-fg-3">{quotes.some((x) => x.reply) ? `只会自动 @ 你回复的那位，其余 ${quotes.length - 1} 条只引用` : `引用 ${quotes.length} 条，不会自动 @ 谁`}</div>}
        </div>
      )}

      <div className="relative px-4">
        {at && cands.length > 0 && (
          <div data-testid="at-picker" className="fade-up absolute bottom-full left-4 z-20 mb-1 w-60 rounded-xl border border-line bg-elev p-1 shadow-elev">
            <div className="px-2 pb-1 pt-0.5 text-[11.5px] text-fg-3">选择要 @ 的人</div>
            {cands.map((m, i) => (
              <button key={m} data-testid={`at-${m}`} onMouseDown={(e) => { e.preventDefault(); pickAt(m) }} className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13.5px]', i === atIdx ? 'bg-hover' : 'hover:bg-hover')}>
                <Avatar id={m} size={22} status={false} />
                <span className="flex-1 truncate">{people[m].name}</span>
                <span className="truncate text-[11.5px] text-fg-3">{m === 'helper' ? '软件助手 · 回复留在这里' : people[m].role}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef} value={draft} data-testid="composer"
          style={{ height: h }}
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onKeyDown={(e) => {
            if (at && cands.length) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setAtIdx((i) => (i + 1) % cands.length); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setAtIdx((i) => (i - 1 + cands.length) % cands.length); return }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickAt(cands[atIdx]); return }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAt(null); return }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSend() }
          }}
          onBlur={() => setTimeout(() => setAt(null), 120)}
          placeholder={peer ? `给 ${conv.title} 发消息` : '发消息，输入 @ 选一位助手交给他做'}
          className="block w-full resize-none bg-transparent py-1.5 text-[14.5px] leading-[1.6] outline-none placeholder:text-fg-3"
        />
      </div>
      <div className="flex items-center justify-end gap-3 px-4 pb-3">
        <span className="text-[12px] text-fg-3">Enter 发送 · Shift+Enter 换行</span>
        <button data-testid="send" onClick={onSend} disabled={!canSend} className="h-8 rounded-lg bg-me px-5 text-[13.5px] font-medium text-me-fg transition hover:brightness-110 disabled:bg-hover disabled:text-fg-3">发送</button>
      </div>
    </div>
  )
}
