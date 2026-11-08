import { useEffect, useRef, useState } from 'react'
import { TopStrip } from '@/components/GroupSide'
import { MessageList } from '@/components/Messages'
import type { Msg } from '@/data'
import { useApp } from '@/store'
import { activeConv, withUnreadDivider } from '@/store/select'
import { JumpToLatest } from '../JumpToLatest'
import { ChatHeader } from './ChatHeader'
import { ComposerSlot } from './ComposerSlot'
import { MentionMe } from './MentionMe'
import { SelectBar } from './SelectBar'

type TextMsg = Extract<Msg, { k: 'text' }>
/** 离底部不到这么多就算「在最新」 */
const NEAR_BOTTOM = 80

/* 聊天主区:头部、群公告条、居中阅读栏(消息流 + 输入框,--chat-col 上限 860)、回到最新、有人 @ 你。
   布局几何是之前反馈修出来的(阅读栏居中、回到最新贴输入框上方),e2e/layout、visual、shell-look 会量。 */
export function ChatView() {
  const { conv, active, highlight, selecting, selected, toggleSelected, openSplit, typing, unreadAt } = useApp((s) => ({
    conv: activeConv(s), active: s.active, highlight: s.highlight, selecting: s.selecting, selected: s.selected, toggleSelected: s.toggleSelected,
    openSplit: s.openSplit, typing: s.typing[s.active], unreadAt: s.unreadAt[activeConv(s).id],
  }))
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [newCount, setNewCount] = useState(0)
  const lastLen = useRef(0)
  const toBottom = (smooth?: boolean) => scrollRef.current?.scrollTo({ top: 1e7, ...(smooth ? { behavior: 'smooth' as const } : {}) })

  useEffect(() => { toBottom(); setAtBottom(true) }, [active])
  /* 新消息:在底部(或是自己发的)就跟着滚,否则攒成「N 条新消息」 */
  useEffect(() => {
    const grew = conv.messages.length - lastLen.current
    const lastMine = (conv.messages[conv.messages.length - 1] as { from?: string })?.from === 'me'
    if (grew > 0 && lastLen.current) { if (atBottom || lastMine) toBottom(true); else setNewCount((n) => n + grew) }
    lastLen.current = conv.messages.length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.messages.length])
  useEffect(() => { if (atBottom) setNewCount(0) }, [atBottom])
  useEffect(() => { lastLen.current = 0; setNewCount(0) }, [active])

  const lastMineMsg = typing ? [...conv.messages].reverse().find((m) => m.k === 'text' && m.from === 'me') as TextMsg | undefined : undefined
  return (
    <main className="flex min-w-[520px] flex-1 flex-col bg-bg [--chat-col:860px]" data-testid="chat">
      <ChatHeader conv={conv} />
      {conv.kind === 'group' && <TopStrip conv={conv} onOpen={(tab) => openSplit({ t: 'group', id: conv.id, tab })} />}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} data-scroll="chat" onScroll={(e) => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM) }} className="scroll-thin h-full overflow-y-auto" style={{ ['--avatar-ring' as string]: 'var(--bg)' }}>
          <div className="mx-auto w-full max-w-[var(--chat-col)] px-6 pb-3 pt-1" data-testid="chat-column">
            <MessageList msgs={withUnreadDivider(conv, unreadAt)} highlight={highlight} selecting={selecting} selected={selected} onSelect={toggleSelected} conv={conv.id} />
            {typing && <div data-testid="typing"><MessageList msgs={[{ k: 'replying', id: 'typing', from: typing, quotes: lastMineMsg ? [{ msgId: lastMineMsg.id, from: 'me', text: lastMineMsg.text }] : [], phase: '在想', mins: 0, steps: ['读了最新几条消息', '判断要不要接这件事'] }]} conv={active} /></div>}
          </div>
        </div>
        <JumpToLatest show={!atBottom} count={newCount} onJump={() => toBottom(true)} />
        <MentionMe conv={conv} show={!atBottom} />
      </div>
      {selecting ? <SelectBar conv={conv} /> : <ComposerSlot conv={conv} />}
    </main>
  )
}

