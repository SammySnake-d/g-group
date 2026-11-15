import { useEffect, useRef, useState } from 'react'
import { TopStrip } from '@/components/GroupSide'
import { MessageList } from '@/components/Messages'
import { people, type Conversation, type Msg, type PersonId, type QuoteRef } from '@/data'
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
/** 宿主推来的联系人活动 → 卡里那几个字 */
const ACTIVITY: Record<string, string> = { reading: '在看消息', thinking: '在想', replying: '在写回答' }
/** 联系人这一轮接走的是哪条:它的已读位置(接走即已读)之前、你最后发的那一条。只有附件就写文件名;
 *  最后一条不是你说的话(回退说明、转发)就不引用——不把更早的一句安到它头上 */
function takenBy(conv: Conversation, who: PersonId): TextMsg | undefined {
  const marks = conv.reads?.[who]
  const upto = marks?.[marks.length - 1]?.upto
  if (!upto) return undefined
  const rank = rankIn(conv.messages.flatMap((m) => ('id' in m ? [m.id] : [])))
  const at = rank(upto)
  const last = [...conv.messages].reverse().find((m) => 'id' in m && rank(m.id) <= at && ((m.k === 'text' && m.from === 'me') || (m.k === 'sys' && m.rewind) || (m.k === 'forward' && m.from === 'me')))
  if (last?.k !== 'text') return undefined
  /* 群里:这句没 @ 它(它是被别的事叫醒的,比如 Compute 报进度),就不引用——不把你对别人说的话安到它头上 */
  if (conv.kind === 'group' && !last.text.includes(`@${people[who]?.name ?? ''}`)) return undefined
  return last.text ? last : { ...last, text: (last.files ?? []).map((f) => f.name).join('、') }
}
/** 离底部不到这么多就算「在最新」 */
const NEAR_BOTTOM = 80

/* 聊天主区:头部、群公告条、居中阅读栏(消息流 + 输入框,--chat-col 上限 860)、回到最新、有人 @ 你。
   布局几何是之前反馈修出来的(阅读栏居中、回到最新贴输入框上方),e2e/layout、visual、shell-look 会量。 */
export function ChatView() {
  const { conv, active, highlight, selecting, selected, toggleSelected, openSplit, typing, unreadAt, newFrom, isLive, replyingNow } = useApp((s) => ({
    conv: activeConv(s), active: s.active, highlight: s.highlight, selecting: s.selecting, selected: s.selected, toggleSelected: s.toggleSelected,
    openSplit: s.openSplit, typing: s.typing[s.active], unreadAt: s.unreadAt[activeConv(s).id], newFrom: s.newFrom[s.active],
    isLive: live(s), replyingNow: s.replying[s.active],
  }))
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [newCount, setNewCount] = useState(0)
  const lastLen = useRef(0)
  const colRef = useRef<HTMLDivElement>(null)
  /* 贴底:在底部时内容变高(提问卡展开、图片加载、新消息长高)也跟着贴底;用户自己往上翻了就不跟。
     following = 我们主动发起的滚到底还没滚完(平滑滚动途中的 scroll 事件不算用户离开底部) */
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
    // 主动滚到底刚结束时内容又长高了(scrollend 先于 ResizeObserver 回调到达):不是用户离开底部,再追一次
    const done = () => {
      const was = following.current
      following.current = false
      if (was && el.scrollHeight - el.scrollTop - el.clientHeight >= NEAR_BOTTOM) { toBottom(); return }
      onScroll(el)
    }
    // 用户主动滚动(滚轮、触摸、键盘)立刻结束「跟随」
    const userScroll = () => { following.current = false }
    const ro = new ResizeObserver(() => { if (stick.current || following.current) el.scrollTo({ top: 1e7 }) })
    ro.observe(col)
    // 视口自己变矮(顶栏、群资料头部等晚一步长高)时内容不变,也要跟着贴底
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
  /* 新消息:在底部(或是自己发的)就跟着滚,否则攒成「N 条新消息」 */
  useEffect(() => {
    const grew = conv.messages.length - lastLen.current
    const lastMine = (conv.messages[conv.messages.length - 1] as { from?: string })?.from === 'me'
    if (grew > 0 && lastLen.current) { if (atBottom || lastMine) toBottom(); else setNewCount((n) => n + grew) }
    lastLen.current = conv.messages.length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.messages.length])
  useEffect(() => { if (atBottom) setNewCount(0) }, [atBottom])
  useEffect(() => { lastLen.current = 0; setNewCount(0) }, [active])

  const quoteOf = (m: TextMsg | undefined): QuoteRef[] => (m ? [{ msgId: m.id, from: 'me', text: m.text }] : [])
  /* 连上后端:正在回复的每位联系人各一张卡(先开始的在上),卡的 id 跟着联系人走——谁回完只收掉谁那张,别人的卡还是原来那个节点。
     卡里只写宿主推来的真实活动(在看 / 在想 / 在写)和已经多久,不编步骤;演示数据照旧一张 */
  const replying: Msg[] = isLive
    ? (replyingNow ?? []).map((r) => ({ k: 'replying' as const, id: `typing-${r.who}`, from: r.who, quotes: quoteOf(takenBy(conv, r.who)), phase: ACTIVITY[r.what] ?? '在想', mins: 0, steps: [], since: r.since }))
    : typing ? [{ k: 'replying', id: 'typing', from: typing, quotes: quoteOf([...conv.messages].reverse().find((m) => m.k === 'text' && m.from === 'me') as TextMsg | undefined), phase: '在想', mins: 0, steps: ['读了最新几条消息', '判断要不要接这件事'] }] : []
  return (
    <main className="flex min-w-[520px] flex-1 flex-col bg-bg [--chat-col:860px]" data-testid="chat">
      <ChatHeader conv={conv} />
      {conv.kind === 'group' && <TopStrip conv={conv} onOpen={(tab) => openSplit({ t: 'group', id: conv.id, tab })} />}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} data-scroll="chat" onScroll={(e) => onScroll(e.currentTarget)} className="scroll-thin h-full overflow-y-auto" style={{ ['--avatar-ring' as string]: 'var(--bg)' }}>
          <div ref={colRef} className="mx-auto w-full max-w-[var(--chat-col)] px-6 pb-3 pt-1" data-testid="chat-column">
            <MessageList msgs={withUnreadDivider(conv, unreadAt, newFrom)} highlight={highlight} selecting={selecting} selected={selected} onSelect={toggleSelected} conv={conv.id} />
            {replying.length > 0 && <div data-testid="typing"><MessageList msgs={replying} conv={active} /></div>}
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

