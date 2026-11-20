import { useEffect, useRef, useState } from 'react'
import { TopStrip } from '@/components/GroupSide'
import { MessageList } from '@/components/Messages'
import type { Conversation, Msg, PersonId } from '@/data'
import { useApp } from '@/store'
import { chatFollow } from '@/store/dom'
import { activeConv, withUnreadDivider } from '@/store/select'
import { JumpToLatest } from '../JumpToLatest'
import { FileReturn } from '@/components/files/FileReturn'
import { ChatHeader } from './ChatHeader'
import { ComposerSlot } from './ComposerSlot'
import { MentionMe } from './MentionMe'
import { SelectBar } from './SelectBar'
import * as Concept from '@/concept'
import { live } from '@/api/wire/live'
import { rankIn } from '@/store/reads'

type TextMsg = Extract<Msg, { k: 'text' }>
const ACTIVITY: Record<string, string> = { reading: '在看消息', thinking: '在想', replying: '在写回答' }
function takenBy(conv: Conversation, who: PersonId): TextMsg | undefined {
  const marks = conv.reads?.[who]
  const upto = marks?.[marks.length - 1]?.upto
  if (!upto) return undefined
  const rank = rankIn(conv.messages.flatMap((m) => ('id' in m ? [m.id] : [])))
  const at = rank(upto)
  const last = [...conv.messages].reverse().find((m) => 'id' in m && rank(m.id) <= at && ((m.k === 'text' && m.from === 'me') || (m.k === 'sys' && m.rewind) || (m.k === 'forward' && m.from === 'me')))
  if (last?.k !== 'text') return undefined
  return last.text ? last : { ...last, text: (last.files ?? []).map((f) => f.name).join('、') }
}
const NEAR_BOTTOM = 80

export function ChatView() {
  const { conv, active, highlight, selecting, selected, toggleSelected, openSplit, typing, unreadAt, newFrom, isLive, since, what } = useApp((s) => ({
    conv: activeConv(s), active: s.active, highlight: s.highlight, selecting: s.selecting, selected: s.selected, toggleSelected: s.toggleSelected,
    openSplit: s.openSplit, typing: s.typing[s.active], unreadAt: s.unreadAt[activeConv(s).id], newFrom: s.newFrom[s.active],
    isLive: live(s), since: s.replyingSince[s.active], what: s.replyingWhat[s.active],
  }))
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [newCount, setNewCount] = useState(0)
  const lastLen = useRef(0)
  const colRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const following = useRef(false)
  const toBottom = (smooth?: boolean) => {
    following.current = true
    scrollRef.current?.scrollTo({ top: 1e7, ...(smooth ? { behavior: 'smooth' as const } : {}) })
  }
  const onScroll = (el: HTMLDivElement) => {
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM
    if (following.current && !near) return
    stick.current = near
    setAtBottom(near)
  }

  useEffect(() => { stick.current = true; toBottom(); setAtBottom(true) }, [active])
  useEffect(() => {
    const el = scrollRef.current, col = colRef.current
    if (!el || !col) return
    const done = () => {
      const was = following.current
      following.current = false
      if (was && el.scrollHeight - el.scrollTop - el.clientHeight >= NEAR_BOTTOM) { toBottom(); return }
      onScroll(el)
    }
    const userScroll = () => { following.current = false }
    const ro = new ResizeObserver(() => { if (stick.current || following.current) el.scrollTo({ top: 1e7 }) })
    ro.observe(col)
    ro.observe(el)
    chatFollow.release = () => { following.current = false; stick.current = false }
    el.addEventListener('scrollend', done)
    for (const ev of ['wheel', 'touchstart', 'keydown'] as const) el.addEventListener(ev, userScroll, { passive: true })
    return () => {
      ro.disconnect()
      chatFollow.release = () => {}
      el.removeEventListener('scrollend', done)
      for (const ev of ['wheel', 'touchstart', 'keydown'] as const) el.removeEventListener(ev, userScroll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const grew = conv.messages.length - lastLen.current
    const lastMine = (conv.messages[conv.messages.length - 1] as { from?: string })?.from === 'me'
    if (grew > 0 && lastLen.current) { if (atBottom || lastMine) toBottom(true); else setNewCount((n) => n + grew) }
    lastLen.current = conv.messages.length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.messages.length])
  useEffect(() => { if (atBottom) setNewCount(0) }, [atBottom])
  useEffect(() => { lastLen.current = 0; setNewCount(0) }, [active])

  const lastMineMsg = typing ? (isLive ? takenBy(conv, typing) : [...conv.messages].reverse().find((m) => m.k === 'text' && m.from === 'me') as TextMsg | undefined) : undefined
  const replying: Msg | null = !typing ? null : isLive
    ? { k: 'replying', id: 'typing', from: typing, quotes: lastMineMsg ? [{ msgId: lastMineMsg.id, from: 'me', text: lastMineMsg.text }] : [], phase: ACTIVITY[what ?? ''] ?? '在想', mins: 0, steps: [], since: since ?? Date.now() }
    : { k: 'replying', id: 'typing', from: typing, quotes: lastMineMsg ? [{ msgId: lastMineMsg.id, from: 'me', text: lastMineMsg.text }] : [], phase: '在想', mins: 0, steps: ['读了最新几条消息', '判断要不要接这件事'] }
  return (
    <main className="flex min-w-[520px] flex-1 flex-col bg-bg [--chat-col:860px]" data-testid="chat">
      <ChatHeader conv={conv} />
      {conv.kind === 'group' && <TopStrip conv={conv} onOpen={(tab) => openSplit({ t: 'group', id: conv.id, tab })} />}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} data-scroll="chat" onScroll={(e) => onScroll(e.currentTarget)} className="scroll-thin h-full overflow-y-auto" style={{ ['--avatar-ring' as string]: 'var(--bg)' }}>
          <div ref={colRef} className="mx-auto w-full max-w-[var(--chat-col)] px-6 pb-3 pt-1" data-testid="chat-column">
            <MessageList msgs={withUnreadDivider(conv, unreadAt, newFrom)} highlight={highlight} selecting={selecting} selected={selected} onSelect={toggleSelected} conv={conv.id} />
            {replying && <div data-testid="typing"><MessageList msgs={[replying]} conv={active} /></div>}
          </div>
        </div>
        <JumpToLatest show={!atBottom} count={newCount} onJump={() => toBottom(true)} />
        <FileReturn conv={conv.id} />
        <MentionMe conv={conv} show={!atBottom} />
        {/* 概念版(src/concept):双击就回复、等你刻度 */}
        <Concept.DoubleClickReply conv={conv} scrollRef={scrollRef} disabled={selecting} />
        <Concept.WaitingRuler conv={conv} scrollRef={scrollRef} />
      </div>
      {selecting ? <SelectBar conv={conv} /> : <ComposerSlot conv={conv} />}
    </main>
  )
}

