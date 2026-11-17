/* 连上后端时的「查找聊天记录」:在这个会话的全部历史里找(search.messages),不只是已经读进来的最近一段。
   每条结果带后端的真实序号;点了跳回原消息——没读进来的先读到它,做不到就把原因写在这条结果下面。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Info, SearchX } from 'lucide-react'
import { liveCtx } from '@/api/wire/live'
import { msgId, senderOf } from '@/api/wire/messages'
import { revealLive, searchLive, type SearchHit } from '@/api/wire/search'
import { useApp } from '@/ctx'
import { useAppStore } from '@/store'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/section'
import { ListItem } from '@/components/ui/list-row'
import { Hint, PageScroll, TextInput } from './kit/parts'

/** 停手这么久才发搜索请求 */
const DEBOUNCE_MS = 250
const TEXT = {
  placeholder: '搜这个会话的全部历史',
  scope: '搜的是这个会话在后端的全部历史，不只是已经读进来的最近一段。多个词用空格分开，要都出现才算；撤回的、你删掉的消息搜不到。',
  busy: '正在找…',
  none: '没找到',
  noneHint: '撤回的、你删掉的消息搜不到',
  failed: '没搜成：',
  more: '再找更早的',
  opening: '正在读到那里…',
  stuck: '跳不过去：',
  attachment: '附件：',
} as const

type Found = { q: string; hits: SearchHit[]; next: string | null; error: string | null }
const NONE: Found = { q: '', hits: [], next: null, error: null }
const wire = () => liveCtx(useAppStore.getState, useAppStore.setState)
const pad = (n: number) => String(n).padStart(2, '0')

/** 消息时刻:今天只写时分,更早的带上日期(跨年带年份) */
function when(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.toDateString() === now.toDateString()) return hm
  return `${d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/** 摘录里把命中的词标出来(位置由后端给) */
function Marked({ text, marks }: { text: string; marks: SearchHit['highlights'] }) {
  const out: ReactNode[] = []
  let pos = 0
  marks.forEach((m, i) => {
    if (m.start < pos || m.start >= text.length) return
    out.push(text.slice(pos, m.start), <mark key={i} className="rounded-[3px] bg-warm-soft px-0.5 text-fg">{text.slice(m.start, m.start + m.length)}</mark>)
    pos = m.start + m.length
  })
  out.push(text.slice(pos))
  return <>{out}</>
}

export function SearchLive({ id }: { id: string }) {
  const jump = useApp((s) => s.jump)
  const userId = useApp((s) => (s.backend.mode === 'connected' ? s.backend.userId : ''))
  const [q, setQ] = useState('')
  const [found, setFound] = useState<Found>(NONE)
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [stuck, setStuck] = useState<{ id: string; why: string } | null>(null)
  const ticket = useRef(0)
  const term = q.trim()

  /* 边打边搜:停手一会儿才发请求;回来时词已经换了的结果丢掉 */
  useEffect(() => {
    const t = ++ticket.current
    setStuck(null)
    if (!term) { setFound(NONE); setBusy(false); return }
    setBusy(true)
    const timer = setTimeout(() => {
      void searchLive(wire(), id, term).then((r) => {
        if (t !== ticket.current) return
        setFound(r.ok ? { q: term, hits: r.hits, next: r.next, error: null } : { q: term, hits: [], next: null, error: r.error })
        setBusy(false)
      })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [id, term])

  const more = () => {
    if (!found.next || busy) return
    const t = ++ticket.current
    setBusy(true)
    void searchLive(wire(), id, found.q, found.next).then((r) => {
      if (t !== ticket.current) return
      setFound((f) => (r.ok ? { ...f, hits: [...f.hits, ...r.hits], next: r.next, error: null } : { ...f, error: r.error }))
      setBusy(false)
    })
  }
  /* 跳回原消息:没读进来的先读到它;做不到(隔得太远、已被撤下、读失败)就把原因留在这条结果下面 */
  const open = (h: SearchHit) => {
    if (opening) return
    const mid = msgId(h.roomId, h.seq)
    setOpening(mid)
    setStuck(null)
    void revealLive(wire(), h.roomId, h.seq).then((r) => {
      setOpening(null)
      if (r.ok) jump(r.id)
      else setStuck({ id: mid, why: r.why })
    })
  }

  const fresh = found.q === term
  const hits = fresh ? found.hits : []
  return (
    <>
      <div className="px-3 pb-2">
        <TextInput data-testid="search-input" autoFocus aria-label="搜索聊天记录" value={q} onChange={(e) => setQ(e.target.value)} placeholder={TEXT.placeholder} className="h-9 border-transparent bg-hover" />
      </div>
      <PageScroll className="px-2">
        {!term && <Hint testid="search-scope" className="px-2.5 pt-1">{TEXT.scope}</Hint>}
        {term && fresh && found.error && <Hint testid="search-error" className="px-2.5 pt-1 text-err">{TEXT.failed}{found.error}</Hint>}
        {hits.map((h) => {
          const mid = msgId(h.roomId, h.seq)
          const who = senderOf(h.sender, userId)
          const at = when(h.at)
          return (
            <div key={mid}>
              <ListItem data-testid={`search-hit-${mid}`} onClick={() => open(h)} className="items-start gap-2.5"
                media={who ? <Avatar id={who} size={26} status={false} /> : <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-hover text-fg-3"><Info className="h-3.5 w-3.5" /></span>}
                subtitleFirst clamp={2}
                subtitle={<span className="tabular-nums">{h.senderName} · <span data-testid="search-hit-seq">#{h.seq}</span>{at && ` · ${at}`}{opening === mid && ` · ${TEXT.opening}`}</span>}
                title={h.matchedIn === 'attachment' && h.attachmentName ? <>{TEXT.attachment}{h.attachmentName}</> : <Marked text={h.snippet} marks={h.highlights} />} />
              {stuck?.id === mid && <div data-testid="search-stuck" role="alert" className="pb-1.5 pl-[46px] pr-2.5 text-[12px] leading-relaxed text-err">{TEXT.stuck}{stuck.why}</div>}
            </div>
          )
        })}
        {term && busy && !hits.length && <Hint testid="search-busy" className="px-2.5 pt-1">{TEXT.busy}</Hint>}
        {term && !busy && fresh && !found.error && !hits.length && <EmptyState icon={<SearchX />} title={TEXT.none} hint={TEXT.noneHint} />}
        {fresh && found.next && <div className="px-1 pt-1"><Button data-testid="search-more" variant="ghost" size="sm" disabled={busy} onClick={more}>{TEXT.more}</Button></div>}
      </PageScroll>
    </>
  )
}
