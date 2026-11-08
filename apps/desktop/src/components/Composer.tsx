import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Smile, AtSign, Scissors, FolderClosed, Image as ImageIcon, History, X, Reply } from 'lucide-react'
import { availableCommands, completeToken, detectSlash, filterCommands, parseInvocation, parseSource, removeToken, type SlashEntry, type SlashInvocation } from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { people, type Conversation, type QuoteRef, artifacts, type Artifact } from '@/data'
import { useApp } from '@/ctx'
import { allCommands, pluginStates, SOURCE_PAGE } from '@/commands'
import { Avatar } from './Avatar'
import { Tip } from './Messages'
import { broken } from '@/mut'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScheduleDialog, SlashMenu, SourceBadge, SourcePicker } from './Slash'

const EMOJIS = ['😀', '😂', '🥹', '😊', '😉', '😍', '🤔', '😮', '😴', '😭', '😡', '👍', '👎', '👏', '🙏', '💪', '🎉', '❤️', '🔥', '✅', '❌', '👀', '🤝', '🫡']
/** 输入框最多长到 8 行，再多就在框里滚动 */
const MAX_LINES = 8

/* 输入区：一个圆角输入框，里面从上到下是 引用条 → 命令提示 → 自适应高度的输入 → 工具栏（左下角「+」取外部消息，右下角发送）。
   打 / 弹出命令菜单（Telegram 式），选中后在输入框里提示该填的参数。 */
export function Composer({ conv, draft, setDraft, quotes, onRemoveQuote, onSend, inputRef }: {
  conv: Conversation; draft: string; setDraft: (v: string | ((d: string) => string)) => void; quotes: QuoteRef[]
  onRemoveQuote: (q: QuoteRef) => void; onSend: (text?: string) => void; inputRef: RefObject<HTMLTextAreaElement | null>
}) {
  const { push, pushMsg, toast, editing, setEditing, plugins, summarize, addTask, setNotice, openSplit, openSchedule } = useApp()
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

  useEffect(() => { setAtIdx(0) }, [at?.q])

  /* ---------- 斜杠命令 ---------- */
  const [caret, setCaret] = useState(draft.length)
  const [focused, setFocused] = useState(false)
  const [slashIdx, setSlashIdx] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [nudge, setNudge] = useState(0)
  const where = useMemo(() => ({ scope: conv.kind, plugins: pluginStates(plugins, conv.id), assistants: conv.members.filter((m) => m !== 'me' && !people[m]?.human) }), [conv.kind, conv.id, conv.members, plugins])
  const entries = useMemo(() => availableCommands(allCommands(plugins), where), [plugins, where])
  const assistantNames = useMemo(() => where.assistants.map((m) => people[m].name), [where])
  const token = editing ? null : detectSlash(draft, Math.min(caret, draft.length))
  const tokenKey = token ? `${token.start}:${token.query}` : ''
  const menuOpen = !!token && focused && dismissed !== tokenKey
  const shown = menuOpen && token ? filterCommands(entries, token.query) : []
  const nUsable = shown.filter((e) => !e.disabled).length
  const sel = nUsable ? Math.min(slashIdx, nUsable - 1) : -1
  const inv = editing ? null : parseInvocation(draft, entries, { people: assistantNames })
  const unknown = !inv && !menuOpen && !editing ? /^\s*[/／]([a-z0-9][a-z0-9-]*)(?=\s|$)/i.exec(draft)?.[1] : undefined
  const canSend = inv ? inv.ok : !!draft.trim() || quotes.length > 0

  useEffect(() => { setSlashIdx(0) }, [token?.query])
  useEffect(() => { setCaret(inputRef.current?.selectionStart ?? draft.length) }, [conv.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const placeCaret = (p: number) => {
    setCaret(p)
    setTimeout(() => { const el = inputRef.current; el?.focus(); el?.setSelectionRange(p, p) }, 0)
  }

  /** 执行一条命令。返回 true = 做了，输入框清空；false = 没做（要等后端、被拦），草稿留着 */
  const run = (v: SlashInvocation): boolean => {
    const c = v.command
    const val = (k: string) => v.values[k] ?? ''
    if (v.blocked) { toast(v.blocked); return false }
    const src = parseSource(c.source)
    if (src?.kind === 'assistant') { onSend(`@${people[src.id].name} ${c.title}：${Object.values(v.values).join(' ')}`); return true }
    if (src?.kind === 'plugin') {
      const page = SOURCE_PAGE[src.id]
      if (page) { push({ t: 'source', id: page }, true); return true }
      if (src.id === 'p-pulse') { openSplit({ t: 'group', id: conv.id, tab: 'plugin' }); return true }
      toast(`插件命令要等后端连接：${plugins.find((p) => p.id === src.id)?.name ?? src.id} 的 /${c.name} 现在还不能真的执行`)
      return false
    }
    switch (c.name) {
      case 'summary': summarize(conv.id); return true
      case 'todo': addTask({ text: val('内容'), conv: conv.id }); return true
      case 'notice': setNotice(conv.id, val('内容')); return true
      case 'schedule': openSchedule({ conv: conv.id, when: val('何时'), what: val('做什么'), via: 'slash' }); return true
      case 'handoff': onSend(`@${val('谁')} ${val('事')}`); return true
      case 'files': push({ t: 'files', id: conv.id }, true); return true
      case 'workspace': push({ t: 'workspace', id: conv.id }, true); return true
      case 'links': push({ t: 'links', id: conv.id }, true); return true
      case 'pins': push({ t: 'commits', id: conv.id }, true); return true
      case 'playbook': push({ t: 'playbook', id: conv.id }, true); return true
      case 'pool': push({ t: 'pool', id: conv.id }, true); return true
      case 'clone': push({ t: 'clone', id: conv.id }, true); return true
    }
    toast(`/${c.name} 还没接上`)
    return false
  }

  /** 从菜单里选中：不带参数的直接执行（Tab 只补全）；带参数的把 /name 填进输入框，等你填参数 */
  const choose = (e: SlashEntry, how: 'enter' | 'tab' | 'click') => {
    if (!token || e.disabled) return
    const c = e.command
    if (how !== 'tab' && c.args.length === 0) {
      const r = removeToken(draft, token)
      setDraft(r.text); placeCaret(r.cursor)
      const one = parseInvocation(`/${c.name}`, [e])
      if (one) run(one)
      return
    }
    const r = completeToken(draft, token, c.name)
    setDraft(r.text); placeCaret(r.cursor)
  }

  const submit = () => {
    if (inv) {
      if (!inv.ok) { setNudge((n) => n + 1); if (inv.blocked) toast(inv.blocked); return }
      if (run(inv)) setDraft('')
      return
    }
    onSend()
  }

  const openSlash = () => {
    setDismissed(null)
    if (token) { placeCaret(caret); return }
    const pos = inputRef.current?.selectionStart ?? draft.length
    const before = draft.slice(0, pos)
    const ins = before === '' || /\s$/.test(before) ? '/' : ' /'
    setDraft(before + ins + draft.slice(pos))
    placeCaret(pos + ins.length)
  }

  const insert = (s: string) => {
    const el = inputRef.current
    const pos = el?.selectionStart ?? draft.length
    setDraft((d) => d.slice(0, pos) + s + d.slice(pos))
    placeCaret(pos + s.length)
  }
  const pickAt = (id: string) => {
    const pos = inputRef.current?.selectionStart ?? draft.length
    const before = draft.slice(0, pos).replace(/@([^\s@]*)$/, '')
    const after = draft.slice(pos)
    const ins = '@' + people[id].name + ' '
    setDraft(before + ins + after)
    setAt(null)
    placeCaret(before.length + ins.length)
  }
  const onChange = (v: string, pos: number) => {
    setDraft(v)
    setCaret(pos)
    const m = v.slice(0, pos).match(/@([^\s@]*)$/)
    setAt(m ? { q: m[1] } : null)
  }

  /* ---------- 自适应高度：空时一行，最多 8 行，再多在框里滚动 ---------- */
  const [tall, setTall] = useState(false)
  const fit = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    const cs = getComputedStyle(el)
    const max = parseFloat(cs.lineHeight) * MAX_LINES + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    const over = el.scrollHeight > max + 1
    el.style.overflowY = over ? 'auto' : 'hidden'
    setTall(over)
  }
  useLayoutEffect(fit, [draft]) // eslint-disable-line react-hooks/exhaustive-deps
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    let w = box.clientWidth
    const ro = new ResizeObserver(() => { if (box.clientWidth !== w) { w = box.clientWidth; fit() } })
    ro.observe(box)
    return () => ro.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /* 参数提示：输入框里在你打的字后面接上还没填的参数（当前该填的高亮，后面的灰色） */
  const ghost = inv && !menuOpen && !tall && caret >= draft.length && !inv.extra && inv.args.some((a) => a.value === undefined)
  const shownErr = inv ? inv.args.filter((a, i) => a.error && !(inv.typing && i === inv.current)).map((a) => a.error!) : []
  const cur = inv && inv.current >= 0 ? inv.args[inv.current]!.arg : undefined

  const tool = 'grid h-8 w-8 place-items-center rounded-md text-fg-2 transition hover:bg-hover hover:text-fg'
  return (
    <div className="relative shrink-0 bg-bg px-4 pb-3 pt-1" data-testid="composer-wrap">
      <ScheduleDialog conv={conv} />
      <div ref={boxRef} data-testid="composer-box" className="relative rounded-xl border border-line bg-bg transition-colors focus-within:border-fg-3/60">
        {menuOpen && token && (
          <SlashMenu items={shown} sel={sel} query={token.query} onHover={setSlashIdx} onPick={(e) => choose(e, 'click')} />
        )}
        {!menuOpen && at && cands.length > 0 && (
          <div data-testid="at-picker" className="fade-up absolute bottom-full left-0 z-20 mb-1.5 w-60 rounded-xl border border-line bg-elev p-1 shadow-elev">
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

        {editing && (
          <div data-testid="edit-bar" className="flex items-center gap-2 px-3 pt-2 text-[12.5px] text-fg-2">
            <span className="h-3.5 w-0.5 rounded bg-me" />正在编辑你发过的消息 · 回车保存
            <button data-testid="edit-cancel" onClick={() => { setEditing(null); setDraft('') }} className="ml-auto text-fg-3 hover:text-fg">取消</button>
          </div>
        )}

        {/* 待发引用：每条一块，按内容宽度收缩，× 紧跟在内容后面 */}
        {quotes.length > 0 && (
          <div className="flex flex-col items-start gap-1 px-2 pt-2" data-testid="quote-bar">
            {quotes.map((x) => <QuoteChip key={x.msgId} x={x} onRemove={() => onRemoveQuote(x)} />)}
            {quotes.length > 1 && <div className="px-1 text-[11.5px] text-fg-3">{quotes.some((x) => x.reply) ? `只会自动 @ 你回复的那位，其余 ${quotes.length - 1} 条只引用` : `引用 ${quotes.length} 条，不会自动 @ 谁`}</div>}
          </div>
        )}

        {/* 命令提示：是哪条命令、现在该填什么、哪里不对 */}
        {inv && !menuOpen && (
          <div data-testid="slash-hint" className="flex min-w-0 items-center gap-2 px-3 pt-2 text-[12px]">
            <SourceBadge src={inv.command.source} />
            <span className="shrink-0 font-mono text-fg">/{inv.command.name}</span>
            <span className="shrink-0 text-fg-2">{inv.command.title}</span>
            <span className="text-fg-3">·</span>
            {inv.blocked ? <span className="min-w-0 truncate text-err">{inv.blocked}</span>
              : shownErr.length ? <span data-testid="slash-error" className="min-w-0 truncate text-err">{shownErr[0]}</span>
              : inv.ok && !(cur && inv.args[inv.current]?.value === undefined) ? <span className="min-w-0 truncate text-fg-3">回车执行 · {inv.command.desc}</span>
              : cur ? <span className="min-w-0 truncate text-fg-3"><span className="font-medium text-fg-2">{cur.name}</span>{cur.required ? '' : '（可选）'}：{cur.hint}</span>
              : null}
          </div>
        )}
        {unknown && (
          <div data-testid="slash-unknown" className="px-3 pt-2 text-[12px] text-fg-3">没有 <span className="font-mono text-fg-2">/{unknown}</span> 这个命令，回车会当普通消息发出</div>
        )}

        <div className="relative px-3">
          {ghost && (
            <div aria-hidden data-testid="slash-ghost" className="pointer-events-none absolute inset-x-3 top-0 whitespace-pre-wrap break-words py-2 text-[14.5px] leading-[1.6]">
              <span className="invisible">{draft}</span>
              {/\s$/.test(draft) ? '' : ' '}
              {inv.args.map((a, i) => a.value === undefined && (
                <span key={a.arg.name}>
                  <span data-testid={`slash-arg-${a.arg.name}`} data-current={i === inv.current && !inv.typing ? '1' : undefined} className={cn('rounded-[5px] px-1 py-px', i === inv.current && !inv.typing ? 'bg-me/10 text-me' : 'text-fg-3')}>{a.arg.required ? a.arg.name : `${a.arg.name}（可选）`}</span>{' '}
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef} value={draft} data-testid="composer" rows={1}
            onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onFocus={(e) => { setFocused(true); setCaret(e.currentTarget.selectionStart) }}
            onKeyDown={(e) => {
              const composing = e.nativeEvent.isComposing || e.keyCode === 229
              if (composing) return
              if (menuOpen) {
                if (nUsable && e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((sel + 1) % nUsable); return }
                if (nUsable && e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((sel - 1 + nUsable) % nUsable); return }
                if (nUsable && (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) { e.preventDefault(); choose(shown[sel]!, e.key === 'Tab' ? 'tab' : 'enter'); return }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(tokenKey); return }
              }
              if (at && cands.length) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setAtIdx((i) => (i + 1) % cands.length); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setAtIdx((i) => (i - 1 + cands.length) % cands.length); return }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickAt(cands[atIdx]); return }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAt(null); return }
              }
              /* 输入框空着时，Backspace / Esc 去掉最后一条引用 */
              if ((e.key === 'Backspace' || e.key === 'Escape') && draft === '' && quotes.length > 0) {
                e.preventDefault(); e.stopPropagation(); onRemoveQuote(quotes[quotes.length - 1]); return
              }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
            }}
            onBlur={() => { setFocused(false); setTimeout(() => setAt(null), 120) }}
            placeholder={peer ? `给 ${conv.title} 发消息，/ 用命令` : '发消息，@ 交给助手，/ 用命令'}
            className="relative block w-full resize-none overflow-hidden bg-transparent py-2 text-[14.5px] leading-[1.6] outline-none placeholder:text-fg-3"
          />
        </div>

        {/* 工具栏：左下角「+」取外部消息；右下角发送 */}
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <SourcePicker conv={conv} className={tool} />
          <Popover>
            <PopoverTrigger asChild><button data-testid="tool-emoji" aria-label="表情" className={tool}><Smile className="h-[18px] w-[18px]" strokeWidth={1.6} /></button></PopoverTrigger>
            <PopoverContent side="top" align="start" className="grid w-[312px] grid-cols-8 gap-0.5 rounded-xl border-line bg-elev p-2 shadow-elev">
              {EMOJIS.map((e) => <button key={e} onClick={() => insert(e)} className="grid h-9 w-9 place-items-center rounded-lg text-[20px] hover:bg-hover">{e}</button>)}
            </PopoverContent>
          </Popover>
          <Tip label="@ 某人（第一项是 Helper）"><button data-testid="tool-at" aria-label="@ 某人" onClick={() => { insert('@'); setAt({ q: '' }) }} className={tool}><AtSign className="h-[17px] w-[17px]" strokeWidth={1.6} /></button></Tip>
          <Tip label="命令（也可以直接打 /）"><button data-testid="tool-slash" aria-label="命令" onMouseDown={(e) => e.preventDefault()} onClick={openSlash} className={tool}><span className="font-mono text-[16px] font-semibold leading-none">/</span></button></Tip>
          <Tip label="截图（截当前窗口发出去）"><button data-testid="tool-shot" aria-label="截图" onClick={() => sendFile(`截图 ${new Date().toTimeString().slice(0, 5)}.png`, 'asset', '1440×900 · 你截的')} className={tool}><Scissors className="h-[17px] w-[17px]" strokeWidth={1.6} /></button></Tip>
          <Tip label="文件"><button data-testid="tool-file" aria-label="文件" onClick={() => fileRef.current?.click()} className={tool}><FolderClosed className="h-[17px] w-[17px]" strokeWidth={1.6} /></button></Tip>
          <Tip label="图片"><button data-testid="tool-image" aria-label="图片" onClick={() => imgRef.current?.click()} className={tool}><ImageIcon className="h-[17px] w-[17px]" strokeWidth={1.6} /></button></Tip>
          <input ref={fileRef} data-testid="file-input" type="file" multiple hidden onChange={(e) => pick(e, 'doc')} />
          <input ref={imgRef} data-testid="image-input" type="file" accept="image/*" multiple hidden onChange={(e) => pick(e, 'asset')} />
          {broken('AC-50-2') && <Tip label="聊天记录"><button data-testid="tool-history" onClick={() => push({ t: 'search', id: conv.id }, true)} className={tool}><History className="h-[17px] w-[17px]" strokeWidth={1.6} /></button></Tip>}
          <div className="min-w-0 flex-1" />
          {inv && inv.missing.length > 0 && <span key={nudge} data-testid="slash-missing" className={cn('mr-2 truncate text-[12px] text-warm', nudge > 0 && 'fade-up font-medium')}>还差 {inv.missing.join('、')}</span>}
          <button data-testid="send" onClick={submit} disabled={!canSend} title="Enter 发送 · Shift+Enter 换行" className="h-8 shrink-0 rounded-lg bg-me px-4 text-[13.5px] font-medium text-me-fg transition hover:brightness-110 disabled:bg-hover disabled:text-fg-3">{inv ? '执行' : '发送'}</button>
        </div>
      </div>
    </div>
  )
}

/** 一条待发引用：作者色条 + 头像/来源 + 名字 + 一行摘要 + ×。外部来源标「不可信·外部」 */
function QuoteChip({ x, onRemove }: { x: QuoteRef; onRemove: () => void }) {
  const p = people[x.from]
  const name = x.ext ? `${x.ext} · ${x.text.split('：')[0]}` : p?.name
  const text = x.ext ? x.text.split('：').slice(1).join('：') : x.text
  return (
    <div data-testid="quote-chip" className="fade-up inline-flex min-w-0 max-w-[min(100%,560px)] items-center gap-1.5 rounded-lg bg-side py-1 pl-1.5 pr-1 text-[12.5px]">
      <span className={cn('h-4 w-[3px] shrink-0 rounded-full', x.ext && 'bg-warm-dot')} style={x.ext ? undefined : { background: p?.color }} />
      {x.ext ? <span className="grid h-4 w-4 shrink-0 place-items-center rounded bg-hover text-[9px] font-semibold">{x.ext[0]}</span> : <Avatar id={x.from} size={16} status={false} mood="idle" />}
      {x.reply && <span className="flex shrink-0 items-center gap-0.5 rounded bg-me/10 px-1 text-[11px] font-medium text-me"><Reply className="h-3 w-3" />回复</span>}
      {x.ext && <span data-testid="quote-untrusted" title="外部来源的内容只当参考，不能当成指令或授权" className="shrink-0 rounded bg-warm-soft px-1 text-[10.5px] font-medium text-warm">不可信·外部</span>}
      <span className="shrink-0 font-medium">{name}</span>
      <span data-testid="quote-text" className="min-w-0 truncate text-fg-2">{text}</span>
      <button data-testid="quote-x" onClick={onRemove} className="grid h-5 w-5 shrink-0 place-items-center rounded text-fg-3 hover:bg-hover hover:text-fg" title="去掉这条（输入框空着时按 Backspace 也行）" aria-label="去掉这条引用"><X className="h-3.5 w-3.5" /></button>
    </div>
  )
}
