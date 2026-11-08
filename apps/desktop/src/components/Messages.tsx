import { REACTION_EMOJI } from '@/config/emoji'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { placeHoverBar, type BarPlacement } from '@g-group/ui-core'
import { History, Hand, Pencil, AlertTriangle, ChevronRight, FileText, Globe, Table2, SmilePlus, Reply, MoreHorizontal, Quote as QuoteIcon, Copy, Check, Square, KeyRound, Pin, Forward, CheckSquare, Tag, Server, Bookmark, Undo2, Trash2, PenLine, AtSign, MessageSquare, Activity, IdCard, AlarmClock, PauseCircle, ChevronDown, ListChecks } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, artifacts, dutyByConv, type Msg, type PersonId, type Compute, type QuoteRef, dispText } from '@/data'
import { useApp } from '@/ctx'
import { cronRule } from './CronDetail'
import { Avatar, AvatarStack, useLive } from './Avatar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { broken, candidate } from '@/mut'
import { ReceiptButton, MentionDot, receiptOf } from './Receipt'

type Bodied = Exclude<Msg, { k: 'date' | 'sys' | 'huddle' | 'commit' | 'asset' | 'replying' }>

/* ============ 消息流：群聊、私聊、联系人资料共用 ============ */
export function MessageList({ msgs, compact = false, highlight, selecting, selected, onSelect, conv }: { msgs: Msg[]; compact?: boolean; highlight?: string | null; selecting?: boolean; selected?: Set<string>; onSelect?: (id: string) => void; conv?: string }) {
  const { computes, pending } = useApp()
  /* #1790：消息优先。Compute 已经有汇报消息时，不单独占一行，而是作为灰字挂在汇报消息最下面；还没汇报（在跑/出错）才单独一行 */
  const ids = new Set(msgs.map((x) => ('id' in x ? x.id : '')))
  const trailOf: Record<string, string> = {}
  for (const c of Object.values(computes)) if (c.reportMsg && ids.has(c.reportMsg)) trailOf[c.reportMsg] = c.id
  const folded = new Set(Object.values(trailOf))
  msgs = msgs.filter((x) => !(x.k === 'compute' && folded.has(x.computeId)))
  return (
    <div className="flex flex-col">
      {msgs.map((m, i) => {
        if (m.k === 'date') return <div key={'d' + i} className="select-none py-3 text-center text-xs text-fg-3">{m.text}</div>
        if (m.k === 'sys') return <SysLine key={m.id} m={m} />
        if (m.k === 'huddle') return <HuddleLine key={m.id} m={m} conv={conv ?? ''} />
        if (m.k === 'commit') return <CommitLine key={m.id} m={m} />
        if (m.k === 'asset') return <AssetLine key={m.id} m={m} />
        if (m.k === 'replying') return <ReplyingCard key={m.id} m={m} />
        const prev = msgs[i - 1]
        /* #1796 合并还是拆开：同一个人、同一件事、5 分钟内连着说 → 合并在一个头像下（间距 2px）。
           以下任一成立就拆开，重新露出名字和时间（间距 16px）：带引用；上一条挂着要你回答的选项或做完的过程（那是一个回合的结尾）；隔了 5 分钟以上 */
        const mins = (t?: string) => (t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : NaN)
        const ends = (x: Msg) => 'id' in x && (pending.some((p) => 'ask' in p && p.ask === x.id) || !!trailOf[x.id])
        const same = (x?: Msg) => !!x && 'from' in x && x.from === m.from && !(x.k === 'text' && x.quotes?.length) && !(m.k === 'text' && m.quotes?.length)
          && !ends(x) && !(x.k === 'text' && m.k === 'text' && mins(m.at) - mins(x.at) > 5)
        const row = (
          <Row key={m.id} m={m} first={!same(prev)} compact={compact} highlight={highlight === m.id} selecting={selecting} checked={selected?.has(m.id)} onSelect={onSelect} trail={trailOf[m.id]}>
            <Body m={m} />
          </Row>
        )
        return compact || selecting ? row : <MsgMenu key={m.id} m={m}>{row}</MsgMenu>
      })}
    </div>
  )
}

function Row({ m, first, compact, highlight, selecting, checked, onSelect, trail, children }: { m: Bodied; first: boolean; compact: boolean; highlight: boolean; selecting?: boolean; checked?: boolean; onSelect?: (id: string) => void; trail?: string; children: ReactNode }) {
  const from = m.from
  const mine = from === 'me'
  const av = compact ? 26 : 32
  const { answers } = useApp()
  // 回答消息显示成收起的卡片,卡片本身就写着回答的是哪个问题,不再叠一层引用
  const quotes = m.k === 'text' && !(m.answerTo && answers[m.answerTo]) ? m.quotes : undefined
  return (
    <div
      id={'m-' + m.id}
      data-hl={highlight ? '1' : undefined}
      data-msg={m.id}
      data-from={'from' in m ? m.from : undefined}
      onClick={selecting ? () => onSelect?.(m.id) : undefined}
      className={cn('group/row relative -mx-2 flex items-start gap-2.5 rounded-xl px-2 py-[1px] transition-colors duration-700', first && 'mt-4', /^(me-|h|c-|s)[a-z0-9]{6}$/.test(m.id) && 'msg-new', mine && 'flex-row-reverse', highlight && 'bg-warm-soft', selecting && 'cursor-pointer hover:bg-hover/60', checked && 'bg-sel/70')}
    >
      {selecting && (
        <span className={cn('mb-2 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border', checked ? 'border-me bg-me text-me-fg' : 'border-fg-3')}>{checked && <Check className="h-3 w-3" strokeWidth={3} />}</span>
      )}
      {!mine && (
        <div className="shrink-0 pt-0.5" style={{ width: av }}>
          {first && (
            <PersonMenu id={from}>
              <button data-testid={`avatar-${from}-${m.id}`} className="block rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"><Avatar id={from} size={av} status={false} /></button>
            </PersonMenu>
          )}
        </div>
      )}
      <div className={cn('relative flex min-w-0 flex-col', compact ? 'max-w-[88%]' : 'max-w-[min(680px,78%)]', mine ? 'items-end' : 'items-start')}>
        {first && !mine && (
          <div className="mb-1 ml-0.5 flex items-center gap-1.5 text-[12.5px]">
            <span className="font-semibold text-fg">{people[from]?.name}</span>
            {from === 'helper' ? <span className="rounded bg-warm-soft px-1 text-[10.5px] font-medium text-warm">软件助手 · 只听你的</span> : !people[from]?.human && <span className="rounded bg-hover px-1 text-[10.5px] text-fg-3">助手</span>}
            {m.k === 'text' && m.at && <span className="text-[11.5px] text-fg-3">{m.at}</span>}
          </div>
        )}
        {quotes && quotes.length > 0 && <SentQuotes quotes={quotes} mine={mine} />}
        {/* AC-46 / D09.3：你发的消息在气泡外侧底边挂一个回执按钮（你的消息靠右，外侧就是左边），不另占一行（原则 57） */}
        {/* 悬浮工具条挂在气泡本身上(#719:要贴着消息,不能相对整列漂) */}
        {mine && m.k === 'text' ? (
          <div className="relative flex max-w-full items-end" data-anchor={m.id}>
            <span className="absolute -left-[24px] bottom-[2px]" data-testid={`receipt-slot-${m.id}`}><ReceiptButton msgId={m.id} /></span>
            {children}
            {!compact && !selecting && <HoverBar m={m} mine={mine} reserve={28} />}
          </div>
        ) : (
          <div className="relative max-w-full" data-anchor={m.id}>
            {children}
            {!compact && !selecting && <HoverBar m={m} mine={mine} reserve={0} />}
          </div>
        )}
        {m.k === 'text' && m.helper && <HelperExtra m={m} />}
        {m.k === 'text' && <QuickReplies msgId={m.id} />}
        {m.k === 'text' && m.tag && <TaskTag msgId={m.id} tag={m.tag} />}
        {/* #1839 空间是珍惜资源：过程灰字和表情共用气泡下的一行，灰字靠左、表情靠右下角，不各占一行 */}
        {m.k === 'text' && m.cron && <CronTrail m={m} mine={mine} />}
        {/* 我的消息：交代和表情并成一行（表情靠左、交代靠右），不各占一行（原则 57）。#2862 起表情只是普通回应，已读看气泡外侧的回执按钮 */}
        {m.k === 'text' && m.disp && candidate('D23') && !trail ? (
          <div className="mt-0.5 flex min-w-0 items-center justify-end gap-2 self-stretch" data-testid={`foot-${m.id}`}>
            <Reactions msgId={m.id} mine={mine} inline />
            <DispLine m={m} />
          </div>
        ) : trail ? (
          <div className="mt-1 flex min-w-0 items-center gap-2 self-stretch" data-testid={`foot-${m.id}`}>
            <div className="min-w-0 flex-1" data-testid={`trail-${m.id}`}><ComputeLine id={trail} /></div>
            <Reactions msgId={m.id} mine={mine} inline />
          </div>
        ) : <Reactions msgId={m.id} mine={mine} />}
      </div>
    </div>
  )
}

/* 已发消息的引用：放在气泡外、上方，用作者色竖条 + 头像区分；不和正文同色（回应 #1194 图二） */
function SentQuotes({ quotes, mine }: { quotes: QuoteRef[]; mine: boolean }) {
  const { jump } = useApp()
  return (
    <div className={cn('mb-1 flex max-w-full flex-col gap-1', mine ? 'items-end' : 'items-start')} data-testid="sent-quotes">
      {quotes.map((q) => {
        const p = people[q.from]
        return (
          <button
            key={q.msgId}
            onClick={(e) => { e.stopPropagation(); if (!q.ext) jump(q.msgId) }}
            title={q.ext ? `来自${q.ext}，只当参考` : '跳到原消息'}
            className="group/q flex max-w-full items-center gap-2 rounded-xl border border-line bg-quote py-1 pl-1.5 pr-2.5 text-left text-[12.5px] text-fg-2 transition hover:border-fg-3/40 hover:text-fg"
          >
            <span className="h-4 w-[3px] shrink-0 rounded-full" style={{ background: p?.color ?? '#999' }} />
            {q.ext ? <span className="grid h-4 w-4 shrink-0 place-items-center rounded bg-hover text-[9px] font-semibold">{q.ext[0]}</span> : <Avatar id={q.from} size={16} status={false} mood="idle" />}
            {q.reply && <Reply className="h-3 w-3 shrink-0 text-fg-3" />}
            <span className="shrink-0 font-medium text-fg">{q.ext ? q.text.split('：')[0] : p?.name}</span>
            <span className="min-w-0 truncate">{q.ext ? q.text.split('：').slice(1).join('：') : q.text}</span>
          </button>
        )
      })}
    </div>
  )
}

/* US7：补充要求挂在哪件事上，挂错了可以改挂 */
function TaskTag({ msgId, tag }: { msgId: string; tag: { task: string; state: string } }) {
  const { computes, retag, openSplit } = useApp()
  const c = computes[tag.task]
  const options = Object.values(computes).filter((x) => x.status !== 'done')
  return (
    <div className="mt-1 flex items-center gap-1 text-[11.5px] text-fg-3" data-testid={`tag-${msgId}`}>
      <Tag className="h-3 w-3" />
      {c ? <button onClick={() => openSplit({ t: 'compute', id: c.id })} className="hover:text-fg">归到「{c.title}」· {tag.state}</button> : <span>没归到任何一件事 · 当闲聊</span>}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild><button data-testid={`retag-${msgId}`} className="rounded px-1 text-fg-2 hover:bg-hover hover:text-fg">改挂</button></DropdownMenuTrigger>
        <DropdownMenuContent className="w-64 rounded-xl border-line bg-elev p-1 shadow-elev">
          {options.map((o) => <DropdownMenuItem key={o.id} className="rounded-lg" onSelect={() => retag(msgId, o.id)}>{o.title}</DropdownMenuItem>)}
          <DropdownMenuSeparator className="bg-line" />
          <DropdownMenuItem className="rounded-lg" onSelect={() => retag(msgId, null)}>不归到任何事（当闲聊）</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/* 悬停：表情 / 回复 / 引用 / 更多。你发的文字消息左下外侧挂着已读回执（AC-46），工具条再往左让开 28px，不盖住它 */
const EMOJI = REACTION_EMOJI
function HoverBar({ m, mine, reserve }: { m: Bodied; mine: boolean; reserve: number }) {
  const { react, addQuote, setSelecting, push, active, recall } = useApp()
  const text = m.k === 'text' ? m.text.replace(/^@\S+\s/, '') : m.k === 'compute' ? '[Compute]' : m.k === 'file' ? '[文件]' : m.k === 'board' ? '[任务板]' : '[转发]'
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<BarPlacement | null>(null)
  // 每次鼠标进入这一行时按气泡和可视区的实际位置重新算(滚动、窗口宽度变化后也贴着)
  useEffect(() => {
    const bar = ref.current
    const anchor = bar?.parentElement
    const row = anchor?.closest('[data-msg]')
    if (!bar || !anchor || !row) return
    const place = () => {
      const scroller = anchor.closest('[data-scroll]') ?? document.documentElement
      const b = scroller.getBoundingClientRect()
      const a = anchor.getBoundingClientRect()
      setPos(placeHoverBar(a, { width: bar.offsetWidth, height: bar.offsetHeight }, { left: b.left, top: b.top, right: Math.min(b.right, window.innerWidth), bottom: Math.min(b.bottom, window.innerHeight) }, mine, reserve))
    }
    row.addEventListener('mouseenter', place)
    row.addEventListener('focusin', place)
    return () => { row.removeEventListener('mouseenter', place); row.removeEventListener('focusin', place) }
  }, [mine, reserve])
  return (
    <div ref={ref} data-testid={`hoverbar-${m.id}`} data-side={pos?.side} style={pos ? { left: pos.x, top: pos.y } : { left: mine ? undefined : '100%', right: mine ? '100%' : undefined, top: 2 }}
      className="pointer-events-none absolute z-10 flex items-center gap-0.5 whitespace-nowrap rounded-full border border-line bg-elev p-0.5 opacity-0 shadow-elev transition-opacity duration-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100 has-[[data-state=open]]:opacity-100">
      <Popover>
        <PopoverTrigger asChild>
          <button className="grid h-7 w-7 place-items-center rounded-full text-fg-2 hover:bg-hover hover:text-fg" title="表情"><SmilePlus className="h-4 w-4" strokeWidth={1.75} /></button>
        </PopoverTrigger>
        <PopoverContent side="top" className="flex w-auto gap-0.5 rounded-full border-line bg-elev p-1 shadow-elev">
          {EMOJI.map((e) => <button key={e} onClick={() => react(m.id, e)} className="grid h-8 w-8 place-items-center rounded-full text-[18px] transition hover:scale-110 hover:bg-hover">{e}</button>)}
        </PopoverContent>
      </Popover>
      <button data-testid={`reply-${m.id}`} onClick={() => addQuote({ msgId: m.id, from: m.from, text, reply: true })} className="grid h-7 w-7 place-items-center rounded-full text-fg-2 hover:bg-hover hover:text-fg" title="回复（引用并 @ 作者）"><Reply className="h-4 w-4" strokeWidth={1.75} /></button>
      <button data-testid={`quote-${m.id}`} onClick={() => addQuote({ msgId: m.id, from: m.from, text })} className="grid h-7 w-7 place-items-center rounded-full text-fg-2 hover:bg-hover hover:text-fg" title="引用（可以连续加多条）"><QuoteIcon className="h-[15px] w-[15px]" strokeWidth={1.75} /></button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button data-testid={`more-${m.id}`} className="grid h-7 w-7 place-items-center rounded-full text-fg-2 hover:bg-hover hover:text-fg"><MoreHorizontal className="h-4 w-4" strokeWidth={1.75} /></button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40 rounded-xl border-line bg-elev p-1 shadow-elev">
          <DropdownMenuItem className="rounded-lg"><Copy className="mr-2 h-4 w-4" />复制</DropdownMenuItem>
          <DropdownMenuItem className="rounded-lg" onSelect={() => push({ t: 'forwardPick', from: active, msgIds: [m.id] }, true)}><Forward className="mr-2 h-4 w-4" />转发</DropdownMenuItem>
          <DropdownMenuItem data-testid={`multi-${m.id}`} className="rounded-lg" onSelect={() => setSelecting(true)}><CheckSquare className="mr-2 h-4 w-4" />多选</DropdownMenuItem>
          {mine && <DropdownMenuSeparator className="bg-line" />}
          {mine && <DropdownMenuItem className="rounded-lg text-err focus:text-err" onSelect={() => recall(m.id)}>撤回</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/* 右键菜单（QQ 桌面版习惯）：复制 / 回复 / 引用 / 转发 / 多选 / 撤回 */
function MsgMenu({ m, children }: { m: Bodied; children: ReactNode }) {
  const { addQuote, setSelecting, push, active, recall, react, toast, pinMsg, deleteMsg, setEditing, reedit, setRewindAsk } = useApp()
  const mine = m.from === 'me'
  const text = m.k === 'text' ? m.text.replace(/^@\S+\s/, '') : m.k === 'compute' ? '[Compute]' : '[文件]'
  return (
    <ContextMenu>
      {/* Row 是自定义组件，不转发事件；包一层 div 让右键真的落在这条消息上（自审：v4 之前右键菜单从没弹出过） */}
      <ContextMenuTrigger asChild><div>{children}</div></ContextMenuTrigger>
      <ContextMenuContent className="w-44 rounded-xl border-line bg-elev p-1 shadow-elev" data-testid="ctx-menu">
        <div className="flex gap-0.5 px-1 pb-1">{['👍', '❤️', '😂', '👀', '🎉'].map((e) => <ContextMenuItem key={e} onSelect={() => react(m.id, e)} className="grid h-8 w-8 place-items-center rounded-lg p-0 text-[17px]">{e}</ContextMenuItem>)}</div>
        <ContextMenuSeparator className="bg-line" />
        <ContextMenuItem data-testid="ctx-reply" className="rounded-lg" onSelect={() => addQuote({ msgId: m.id, from: m.from, text, reply: true })}><Reply className="mr-2 h-4 w-4" />回复</ContextMenuItem>
        <ContextMenuItem data-testid="ctx-copy" className="rounded-lg" onSelect={() => { navigator.clipboard?.writeText(text).catch(() => {}); toast('已复制') }}><Copy className="mr-2 h-4 w-4" />复制</ContextMenuItem>
        <ContextMenuItem data-testid="ctx-forward" className="rounded-lg" onSelect={() => push({ t: 'forwardPick', from: active, msgIds: [m.id] }, true)}><Forward className="mr-2 h-4 w-4" />转发</ContextMenuItem>
        <ContextMenuItem data-testid="ctx-fav" className="rounded-lg" onSelect={() => toast('已收藏，在「文件 › 收藏」里')}><Bookmark className="mr-2 h-4 w-4" />收藏</ContextMenuItem>
        <ContextMenuItem data-testid="ctx-multi" className="rounded-lg" onSelect={() => setSelecting(true)}><CheckSquare className="mr-2 h-4 w-4" />多选</ContextMenuItem>
        <ContextMenuItem data-testid="ctx-quote" className="rounded-lg" onSelect={() => addQuote({ msgId: m.id, from: m.from, text })}><QuoteIcon className="mr-2 h-4 w-4" />引用</ContextMenuItem>
        {active.startsWith('g') && <ContextMenuItem data-testid="ctx-pin" className="rounded-lg" onSelect={() => pinMsg(active, m.id)}><Pin className="mr-2 h-4 w-4" />置顶</ContextMenuItem>}
        {active.startsWith('dm-') && <ContextMenuItem data-testid="ctx-rewind" className="rounded-lg" onSelect={() => setRewindAsk(m.id)}><History className="mr-2 h-4 w-4" />回到这里</ContextMenuItem>}
        <ContextMenuSeparator className="bg-line" />
        {mine && m.k === 'text' && <ContextMenuItem data-testid="ctx-edit" className="rounded-lg" onSelect={() => { setEditing(m.id); reedit(m.text) }}><Pencil className="mr-2 h-4 w-4" />编辑</ContextMenuItem>}
        {mine && <ContextMenuItem data-testid="ctx-recall" className="rounded-lg" onSelect={() => recall(m.id)}><Undo2 className="mr-2 h-4 w-4" />撤回</ContextMenuItem>}
        <ContextMenuItem data-testid="ctx-delete" className="rounded-lg text-err focus:text-err" onSelect={() => deleteMsg(m.id)}><Trash2 className="mr-2 h-4 w-4" />删除（只在你这边）</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function SysLine({ m }: { m: Extract<Msg, { k: 'sys' }> }) {
  const { reedit, unrewind } = useApp()
  return (
    <div data-msg={m.id} data-testid={m.rewind ? 'rewind-line' : undefined} className="py-1.5 text-center text-xs text-fg-3">
      {m.text}
      {m.rewind && <button data-testid={`rewind-undo-${m.id}`} onClick={() => unrewind(m.id)} className="ml-1.5 text-me hover:underline">恢复</button>}
      {m.recalled && <button data-testid={`reedit-${m.id}`} onClick={() => reedit(m.recalled!)} className="ml-1.5 text-me hover:underline">重新编辑</button>}
    </div>
  )
}

function Reactions({ msgId, mine, inline }: { msgId: string; mine: boolean; inline?: boolean }) {
  const { reactions, react } = useApp()
  const r = reactions[msgId]
  if (!r || !Object.keys(r).length) return null
  return (
    <div className={cn('flex flex-wrap gap-1', inline ? 'shrink-0' : cn('mt-1', mine ? 'justify-end' : 'ml-1'))}>
      {Object.entries(r).map(([e, who], ri) => {
        const meIn = who.includes('me')
        return (
          <Tooltip key={e} delayDuration={200}>
            <TooltipTrigger asChild>
              <button data-testid={`reaction-${msgId}-${ri}`} onClick={() => react(msgId, e)} className={cn('flex h-6 items-center gap-1 rounded-full border px-1.5 text-[12px] transition', meIn ? 'border-fg-3/50 bg-sel' : 'border-line bg-elev hover:bg-hover')}>
                <span className="text-[13px] leading-none">{e}</span>
                <span className="flex -space-x-1">{who.slice(0, 3).map((w) => <Avatar key={w} id={w} size={14} status={false} mood="idle" />)}</span>
                {who.length > 3 && <span className="text-fg-2">{who.length}</span>}
              </button>
            </TooltipTrigger>
            <TooltipContent data-testid={`reaction-tip-${msgId}`} className="rounded-lg border-0 bg-fg px-2 py-1 text-xs text-bg">{who.map((w) => (w === 'me' ? '你' : people[w].name)).join('、')}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

/* 点头像：查看资料 / 从群聊私信（只在群里）/ 私聊 / @他 */
export function PersonMenu({ id, children, side = 'top' }: { id: PersonId; children: ReactNode; side?: 'top' | 'left' | 'right' | 'bottom' }) {
  const { push, openDm, mention, convs, active, poke, silence, openWorkbench, openContact } = useApp()
  const p = people[id]
  const live = useLive(id)
  const conv = convs.find((c) => c.id === active)
  const silenced = !!conv?.silenced?.[id]
  if (id === 'me' || !p) return <>{children}</>
  const liveText = { idle: '空闲', running: '在干活', waiting: '在等你', error: '遇到问题' }[live]
  const inGroup = conv?.kind === 'group' && !p.human
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={side} sideOffset={6} className="w-64 rounded-2xl border-line bg-elev p-1.5 shadow-elev" data-testid="person-menu">
        <div className="flex items-center gap-3 px-2 pb-2.5 pt-1.5">
          <Avatar id={id} size={40} />
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold">{p.name}</div>
            <div className="truncate text-[12px] text-fg-2">{(conv && dutyByConv[conv.id]?.[id]) ? `本群分工：${dutyByConv[conv.id][id]}` : p.role} · {liveText}</div>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-1 px-1 pb-1">
          {[
            { t: 'menu-at', l: '@它', I: AtSign, run: () => mention(id), show: true },
            { t: 'menu-dm', l: '私聊', I: MessageSquare, run: () => openDm(id), show: !p.human },
            { t: 'menu-process', l: '看过程', I: Activity, run: () => openContact(id, active, 'process'), show: !p.human },
            { t: 'menu-split', l: '资料', I: IdCard, run: () => openContact(id, active), show: !p.human },
          ].filter((x) => x.show).map((x) => (
            <DropdownMenuItem key={x.t} data-testid={x.t} onSelect={x.run} className="flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[12px] text-fg-2 focus:text-fg">
              <x.I className="h-[18px] w-[18px]" strokeWidth={1.7} />{x.l}
            </DropdownMenuItem>
          ))}
        </div>
        {!p.human && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="menu-more" className="rounded-lg text-[13px] text-fg-2">更多</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52 rounded-xl border-line bg-elev p-1 shadow-elev">
              <DropdownMenuItem data-testid="menu-detail" className="rounded-lg" onSelect={() => openContact(id, active, 'talks')}>它和别的助手说了什么</DropdownMenuItem>
              {inGroup && <DropdownMenuItem data-testid="menu-inner" className="rounded-lg" onSelect={() => push({ t: 'inner', id, conv: active }, true)}>从群聊私信</DropdownMenuItem>}
              <DropdownMenuItem data-testid="menu-workbench" className="rounded-lg" onSelect={() => openWorkbench(id)}>去工作台管理</DropdownMenuItem>
              {inGroup && <DropdownMenuItem data-testid="menu-poke" className="rounded-lg" onSelect={() => poke(id)}>拍一拍</DropdownMenuItem>}
              {inGroup && <DropdownMenuItem data-testid="menu-silence" className="rounded-lg" onSelect={() => silence(active, id)}>{silenced ? '解除禁言' : '禁言 30 分钟'}</DropdownMenuItem>}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Body({ m }: { m: Bodied }) {
  const { answers } = useApp()
  if (m.k === 'text') return m.answerTo && answers[m.answerTo] ? <AnswerPill m={m} /> : <TextBubble m={m} />
  if (m.k === 'compute') return <ComputeLine id={m.computeId} />
  if (m.k === 'file') return <FileCard id={m.artifactId} />
  if (m.k === 'board') return <BoardCard id={m.boardId} />
  if (m.k === 'forward') return <ForwardCard m={m} />
  if (m.k === 'vote') return <VoteCard m={m} />
  if (m.k === 'summary') return <SummaryCard m={m} />
  if (m.k === 'authfix') return <AuthFix m={m} />
  return null
}

/* C-US23 投票：每位助手投票附理由，你拍板 */
function VoteCard({ m }: { m: Extract<Msg, { k: 'vote' }> }) {
  const { decideVote } = useApp()
  const total = Object.keys(m.votes).length
  return (
    <div data-testid={`vote-${m.id}`} className="w-[360px] max-w-full rounded-2xl border border-line bg-elev p-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2"><span className="rounded bg-hover px-1.5 text-[11px] text-fg-2">投票</span><span className="text-[14px] font-semibold">{m.title}</span></div>
      <div className="mt-2 space-y-1.5">
        {m.options.map((o, i) => {
          const who = Object.entries(m.votes).filter(([, v]) => v.opt === i)
          const pct = total ? (who.length / total) * 100 : 0
          return (
            <div key={i} className={cn('relative overflow-hidden rounded-lg border px-2.5 py-1.5', m.decided === i ? 'border-me' : 'border-line')}>
              <div className="absolute inset-y-0 left-0 bg-me/10" style={{ width: pct + '%' }} />
              <div className="relative flex items-center gap-2 text-[13px]">
                <span className="flex-1 font-medium">{o}</span>
                <span className="flex -space-x-1">{who.map(([p]) => <Avatar key={p} id={p} size={16} status={false} mood="idle" />)}</span>
                <span className="w-6 text-right text-[12px] text-fg-3">{who.length}</span>
                {m.decided === undefined && <button data-testid={`decide-${m.id}-${i}`} onClick={() => decideVote(m.id, i)} className="rounded-md bg-btn px-2 py-0.5 text-[11.5px] font-medium text-btn-fg">就这个</button>}
                {m.decided === i && <Check className="h-4 w-4 text-me" />}
              </div>
              {who.map(([p, v]) => <div key={p} className="relative mt-0.5 text-[11.5px] text-fg-2">{people[p].name}：{v.why}</div>)}
            </div>
          )
        })}
      </div>
      <div className="mt-2 text-[11.5px] text-fg-3">{m.decided === undefined ? `${total} 位助手投了票，由你拍板` : `你选了「${m.options[m.decided]}」，已写进群协作手册`}</div>
    </div>
  )
}

/* C-US25 未读总结：每条带来源可跳 */
/* AC-35⑤：凭据失效时外发立即阻断，联系人在群里发一条红字修复卡；点「重新授权」恢复 */
function AuthFix({ m }: { m: Extract<Msg, { k: 'authfix' }> }) {
  const { reauthPlugin } = useApp()
  return (
    <div data-testid={`authfix-${m.plugin}`} data-fixed={m.fixed ? '1' : undefined} className={cn('flex items-center gap-2 rounded-[14px] border px-3 py-2 text-[13.5px]', m.fixed ? 'border-line text-fg-3' : 'border-err/40 bg-err/5 text-err')}>
      <AlertTriangle className="h-4 w-4 shrink-0" /><span className="flex-1">{m.fixed ? '已重新授权，外发恢复' : m.text}</span>
      {!m.fixed && <button data-testid={`authfix-go-${m.plugin}`} onClick={() => reauthPlugin(m.plugin)} className="shrink-0 rounded-md bg-err px-2.5 py-1 text-[12.5px] font-medium text-white">重新授权</button>}
    </div>
  )
}

function SummaryCard({ m }: { m: Extract<Msg, { k: 'summary' }> }) {
  const { jump, summarize, active } = useApp()
  return (
    <div data-testid={`summary-${m.id}`} data-expired={m.expired ? '1' : undefined} className={cn('w-[380px] max-w-full rounded-2xl border border-line bg-elev p-3', m.expired && 'opacity-60')}>
      <div className="flex items-center gap-2 text-[13.5px] font-semibold"><span className="flex-1">{m.title}</span>
        {m.expired && <span className="flex shrink-0 items-center gap-1.5 text-[12px] font-normal text-fg-3">已过期 · 有条消息被撤回
          <button data-testid={`summary-redo-${m.id}`} onClick={() => summarize(active)} className="text-me hover:underline">重新总结</button></span>}
      </div>
      <ul className="mt-1.5 space-y-1">{m.items.map((it, i) => <li key={i} className="flex gap-1.5 text-[13px] leading-relaxed"><span className="text-fg-3">·</span><span className="flex-1">{it.text}{it.ref && <button onClick={(e) => { e.stopPropagation(); jump(it.ref!) }} className="ml-1 text-[12px] text-me hover:underline">原消息</button>}</span></li>)}</ul>
    </div>
  )
}

export function renderText(text: string, mine: boolean, msgId?: string) {
  const names = Object.values(people).map((p) => p.name).sort((a, b) => b.length - a.length)
  const re = new RegExp('@(' + names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + '|我)', 'g')
  const out: ReactNode[] = []
  let last = 0
  for (const mt of text.matchAll(re)) {
    out.push(text.slice(last, mt.index))
    const isMe = mt[1] === '39impacts' || mt[1] === '我'
    out.push(<span key={mt.index} className={cn('font-semibold', !mine && (isMe ? 'rounded bg-warm-soft px-0.5 text-warm' : 'text-fg'))}>@{mt[1]}</span>)
    const pid = Object.values(people).find((p) => p.name === mt[1])?.id
    if (mine && msgId && pid && !isMe) out.push(<MentionDot key={'d' + mt.index} msgId={msgId} who={pid} />)
    last = (mt.index ?? 0) + mt[0].length
  }
  out.push(text.slice(last))
  return out
}

/* Helper 在聊天里被 @ 时的回复：普通消息 + 读了什么 + 确认卡（#1353：在哪叫就在哪答） */
function HelperExtra({ m }: { m: Extract<Msg, { k: 'text' }> }) {
  const { addTasks, createGroup, active } = useApp()
  const [done, setDone] = useState(false)
  const h = m.helper!
  return (
    <div className="mt-1 w-[340px] max-w-full" data-testid={`helper-reply-${m.id}`}>
      {h.card && (
        <div className="rounded-xl border border-line bg-elev p-3">
          <ul className="space-y-0.5 text-[13px]">{h.card.lines.map((l) => <li key={l}>· {l}</li>)}</ul>
          {done ? <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-ok"><Check className="h-4 w-4" />已完成</div> : (
            <div className="mt-2.5 flex gap-2">
              <button data-testid="helper-inline-confirm" onClick={(e) => { e.stopPropagation(); setDone(true); if (h.card!.kind === 'csv') addTasks(active, h.card!.lines); else if (h.card!.kind === 'group') createGroup('外部聊天记录接入', ['claude', 'argon'], '来自「模型助手群聊」：Helper 按你的要求另开的群，带了 3 条背景') }} className="h-8 flex-1 rounded-lg bg-me text-[13px] font-medium text-me-fg">确认</button>
              <button onClick={(e) => { e.stopPropagation(); setDone(true) }} className="h-8 flex-1 rounded-lg bg-hover text-[13px] font-medium">取消</button>
            </div>
          )}
        </div>
      )}
      <div className="mt-1 text-[11.5px] text-fg-3">{h.scope} · 其他助手看得到这条，但不会照着去操作软件</div>
    </div>
  )
}

/* “正在回复”卡：取代头像呼吸灯（#1412）。写明在回哪几条、在想 / 在写、几分钟；可展开步骤，再往下看完整过程 */
function ReplyingCard({ m }: { m: Extract<Msg, { k: 'replying' }> }) {
  const { openContact, active } = useApp()
  const [open, setOpen] = useState(false)
  const p = people[m.from]
  return (
    <div className="mt-3 flex items-start gap-2.5" data-testid={`replying-${m.from}`} data-msg={m.id}>
      <Avatar id={m.from} size={32} mood="thinking" />
      <div className="min-w-0 max-w-[min(560px,78%)]">
        <div className="mb-1 flex items-center gap-1.5 text-[12.5px]"><span className="font-semibold">{p.name}</span><span className="rounded bg-hover px-1 text-[10.5px] text-fg-3">助手</span><span className="text-run">正在回复</span></div>
        <div className="rounded-[14px] border border-line bg-bubble px-3 py-2">
          {m.quotes.map((q) => <div key={q.msgId} className="mb-1 truncate border-l-2 border-fg-3/40 pl-2 text-[12.5px] text-fg-2"><span className="font-medium text-fg">{people[q.from]?.name ?? '你'}</span> {q.text}</div>)}
          <button data-testid={`replying-toggle-${m.from}`} onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[12.5px] text-fg-2 hover:text-fg"><span className="spin-ring" />{m.phase} · {m.mins} 分<ChevronRight className={cn('h-3.5 w-3.5 transition', open && 'rotate-90')} /></button>
          {open && <ol className="mt-1.5 space-y-0.5 pl-5 text-[12.5px] text-fg-2">{m.steps.map((s, i) => <li key={i} className="list-decimal">{s}</li>)}</ol>}
          {open && <button data-testid={`replying-process-${m.from}`} onClick={() => openContact(m.from, active, 'process')} className="mt-1.5 text-[12.5px] font-medium text-me hover:underline">看完整过程 ›</button>}
          {!open && <div className="shimmer mt-1.5 h-2 w-2/3 rounded-full" />}
        </div>
      </div>
    </div>
  )
}

/* 快捷回复（#1560）：决定是共享的上下文，所以点了就以你的名义在群里发一条“回复”，所有人都看得到。
   照 mirasim / Telegram 的 reply keyboard：选项贴在提问那条消息下面，是几颗轻按钮，不是一张卡。
   数字键 1-9 选、Enter 发推荐项；也可以直接在输入框里打字回答。答完按钮就消失，留下的是那条回复消息。 */
/* A2UI 提问卡片(#823:参照 mirasim 可折叠的卡片,不做成一排气泡——选项一长就难看)。
   挂在提问那条消息下面:标题 + 状态 + 折叠;选项短的排成一行小按钮,长的每项占一整行(圆点 + 可换行文字)。
   点了以普通消息发出(U98:回复就是回答,不另造验收组件);答完卡片收起成「标题 · 你选了什么」,点开还能看全部选项。 */
const isShort = (opts: string[]) => opts.length <= 3 && opts.every((o) => o.length <= 8)

export function QuickReplies({ msgId }: { msgId: string }) {
  const { pending, resolve, addQuote, convs, answers } = useApp()
  const findMsg = (id: string) => { for (const c of convs) { const m = c.messages.find((x) => x.k === 'text' && x.id === id); if (m) return m as Extract<Msg, { k: 'text' }> } }
  const p = pending.find((x) => (x.kind === 'choice' && x.ask === msgId) || (x.kind === 'proposal' && x.ask === msgId))
  const done = answers[msgId]
  const [open, setOpen] = useState<boolean | null>(null)
  if (!p && !done) return null
  const stale = p?.kind === 'choice' ? p.stale : undefined
  const title = p && (p.kind === 'choice' || p.kind === 'proposal') ? p.title : done!.title
  const opts: { label: string; primary?: boolean; run?: () => void }[] =
    !p ? done!.options.map((o) => ({ label: o }))
    : p.kind === 'choice' ? p.options.map((o, i) => ({ label: o, primary: i === (p.recommend ?? -1), run: () => resolve(p.id, 'pick', i) }))
    : p.kind === 'proposal' && p.gate ? [{ label: '同意，改吧', primary: true, run: () => resolve(p.id, 'ok') }, { label: '先别改', run: () => resolve(p.id, 'no') }]
    : p.kind === 'proposal' ? [{ label: '同意', primary: true, run: () => resolve(p.id, 'ok') }, { label: '先不改', run: () => resolve(p.id, 'no') }]
    : []
  const live = !!p && !stale
  const expanded = open ?? live
  const short = isShort(opts.map((o) => o.label))
  return (
    <div data-testid={`ask-${msgId}`} data-state={live ? 'open' : stale ? 'stale' : 'answered'} data-expanded={expanded ? '1' : '0'} onClick={(e) => e.stopPropagation()}
      className="fade-up mb-1 mt-1.5 w-[min(560px,100%)] overflow-hidden rounded-2xl border border-line bg-elev shadow-soft">
      <button type="button" data-testid={`ask-${msgId}-head`} onClick={() => setOpen(!expanded)} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-hover/50">
        <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg', live ? 'bg-brand-soft text-brand' : 'bg-hover text-fg-3')}><ListChecks className="h-4 w-4" strokeWidth={1.9} /></span>
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-[13.5px] font-semibold', !live && 'text-fg-2')}>{title}</span>
          {!expanded && done && <span data-testid={`ask-${msgId}-picked`} className="block truncate text-[12.5px] text-fg"><Check className="mr-1 inline h-3.5 w-3.5 -translate-y-px text-ok" strokeWidth={2.5} />{done.picked}</span>}
        </span>
        <span data-testid={`ask-${msgId}-status`} className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11.5px]', live ? 'bg-warm-soft font-medium text-warm' : stale ? 'border border-dashed border-fg-3/50 text-fg-3' : 'bg-hover text-fg-2')}>
          {live ? '等你选' : stale ? '已过期 · 未执行' : `你 ${done?.at ?? ''} · 已选`}
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-fg-3 transition', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div className="border-t border-line px-3.5 pb-3 pt-2.5" data-testid={`ask-${msgId}-body`}>
          {stale && <div className="mb-2 text-[12px] text-fg-3">你后面改了前提，这几个选项不再执行。</div>}
          <div className={cn(short ? 'flex flex-wrap gap-2' : 'flex flex-col gap-1.5')} data-layout={short ? 'chips' : 'rows'}>
            {opts.map((o, i) => {
              const picked = done?.picked === o.label
              const can = live && !!o.run
              return short ? (
                <button key={o.label} type="button" data-testid={`quick-${msgId}-${i}`} disabled={!can} onClick={o.run}
                  className={cn('flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[13px] transition active:scale-[.97] disabled:cursor-default', picked ? 'border-fg bg-fg text-bg' : o.primary && can ? 'border-me/50 bg-me/[.08] font-medium text-me hover:bg-me/[.14]' : 'border-line text-fg hover:border-fg-3/60 hover:bg-hover', !can && !picked && 'opacity-60 hover:bg-transparent', stale && 'line-through')}>
                  {picked && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}{o.label}
                </button>
              ) : (
                <button key={o.label} type="button" data-testid={`quick-${msgId}-${i}`} disabled={!can} onClick={o.run}
                  className={cn('group/o flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left text-[13.5px] leading-[1.55] transition disabled:cursor-default', picked ? 'border-fg/70 bg-hover' : 'border-line hover:border-fg-3/50 hover:bg-hover/70', !can && !picked && 'opacity-60 hover:border-line hover:bg-transparent', stale && 'line-through')}>
                  <span className={cn('mt-[3px] grid h-4 w-4 shrink-0 place-items-center rounded-full border', picked ? 'border-fg bg-fg text-bg' : 'border-fg-3/70 group-hover/o:border-fg-2')}>{picked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}</span>
                  <span className="min-w-0 flex-1 break-words">{o.label}</span>
                  {o.primary && can && <span className="mt-px shrink-0 rounded-md bg-me/10 px-1.5 text-[11px] font-medium text-me">推荐</span>}
                </button>
              )
            })}
          </div>
          {live && (
            <button type="button" data-testid={`quick-${msgId}-own`} onClick={() => { const m = findMsg(msgId); if (m) addQuote({ msgId, from: m.from, text: m.text.replace(/^@\S+\s/, ''), reply: true }) }}
              className="mt-2 flex items-center gap-1 rounded-md px-1 text-[12.5px] text-fg-2 transition hover:text-fg" title="引用这条并 @ 它，你自己写回答">
              <PenLine className="h-3.5 w-3.5" strokeWidth={1.75} />都不是，自己回答
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** 你对提问的回答:显示成收起的卡片(标题 + 你选的),点开看全部选项。正文仍是普通消息,联系人照常读 */
function AnswerPill({ m }: { m: Extract<Msg, { k: 'text' }> }) {
  const { answers, jump } = useApp()
  const a = m.answerTo ? answers[m.answerTo] : undefined
  const [open, setOpen] = useState(false)
  if (!a) return null
  return (
    <div data-testid={`answer-${m.id}`} data-expanded={open ? '1' : '0'} className="w-[min(420px,100%)] overflow-hidden rounded-2xl border border-mine/25 bg-elev shadow-soft">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-mine text-mine-fg"><ListChecks className="h-4 w-4" strokeWidth={1.9} /></span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{a.title}</span>
        <span className="max-w-[45%] shrink-0 truncate text-[13.5px] font-semibold text-fg">{a.picked}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-fg-3 transition', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-1 border-t border-line px-3 pb-2.5 pt-2" data-testid={`answer-${m.id}-body`}>
          {a.options.map((o) => (
            <div key={o} className={cn('flex items-start gap-2 text-[13px] leading-[1.5]', o === a.picked ? 'font-medium text-fg' : 'text-fg-3')}>
              <span className={cn('mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border', o === a.picked ? 'border-fg bg-fg text-bg' : 'border-fg-3/60')}>{o === a.picked && <Check className="h-2 w-2" strokeWidth={3.5} />}</span>{o}
            </div>
          ))}
          <button type="button" onClick={() => jump(m.answerTo!)} className="pt-1 text-[12px] text-me hover:underline">看原来的提问</button>
        </div>
      )}
    </div>
  )
}

function TextBubble({ m }: { m: Extract<Msg, { k: 'text' }> }) {
  const { computes, openSplit } = useApp()
  const mine = m.from === 'me'
  const long = m.text.length > 160 || m.text.split('\n').length > 4
  const [open, setOpen] = useState(false)
  /* AC-40⑦ / U88：联系人同时做几件事时，汇报开头带这件事的短名；点了看那件事 */
  const tk = m.task && candidate('U88') && !broken('AC-40-7') ? computes[m.task] : undefined
  return (
    <div className={cn('break-words rounded-[18px] px-3.5 py-[7px] text-[14.5px] leading-[1.6]', mine ? 'bg-mine text-mine-fg' : 'border border-theirs-line bg-theirs text-fg shadow-soft')}>
      {tk?.short && <button data-testid={`short-${m.id}`} onClick={(e) => { e.stopPropagation(); openSplit({ t: 'compute', id: tk.id }) }} className="mr-1.5 inline-flex h-[20px] translate-y-[-1px] items-center rounded-md bg-hover px-1.5 align-middle text-[12px] font-medium text-fg-2 hover:text-fg">{tk.short}</button>}
      <span className={cn('whitespace-pre-wrap', long && !open && 'line-clamp-3')}>{renderText(m.text.replace(tk?.short ? new RegExp('^' + tk.short + '[：:]\\s*') : /^$/, ''), mine, m.id)}</span>
      {m.edited && <span data-testid={`edited-${m.id}`} className={cn('ml-1.5 text-[11.5px]', mine ? 'text-me-fg/70' : 'text-fg-3')}>已编辑</span>}
      {m.byHelper && <span className="mt-0.5 block text-[11px] text-me-fg/75">由 Helper 代你发出</span>}
      {m.shot && <button data-testid={`shot-${m.id}`} onClick={(e) => { e.stopPropagation(); openSplit({ t: 'compute', id: m.shot!.compute, view: 'preview' }) }} className="mt-1.5 flex w-[220px] flex-col overflow-hidden rounded-lg border border-line bg-bg text-left">
        <span className="flex h-[86px] items-center justify-center bg-hover text-[12px] text-fg-3">短信验证码 · ● ● ● ● ● ●</span>
        <span className="truncate px-2 py-1 text-[11.5px] text-fg-2">{m.shot.title}</span>
      </button>}
      {long && <button data-testid={`expand-${m.id}`} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }} className={cn('mt-0.5 block text-[12.5px] font-medium', mine ? 'text-me-fg/80' : 'text-me')}>{open ? '收起' : '展开全文'}</button>}
    </div>
  )
}

/* ============ Compute：在聊天里只占一行，点开在右侧分屏看 ============ */
export const statusText = (c: Compute) => (c.status === 'done' ? c.result ?? '已完成' : c.status === 'error' ? '出错了' : c.status === 'stopped' ? '已停止' : c.status === 'waiting' ? '做完了，等你回复' : c.phase)

/** 状态的样子（概念卡第 13 张）：每种至少两个特征不同，不只靠颜色。等你=橙实心圆，出错=红三角，进行中=绿转环，做完=灰对勾 */
export function StatusDot({ c, className }: { c: Compute; className?: string }) {
  if (c.status === 'done') return <Check className={cn('h-3.5 w-3.5 text-fg-3', className)} strokeWidth={2.5} />
  if (c.status === 'error') return <AlertTriangle className={cn('h-3.5 w-3.5 text-err', className)} strokeWidth={2.25} />
  if (c.status === 'stopped') return <Square className={cn('h-3 w-3 fill-fg-3 text-fg-3', className)} />
  if (c.status === 'running') return <span className={cn('spin-ring', className)} aria-label="进行中" />
  return <span className={cn('inline-block h-2.5 w-2.5 rounded-full bg-warm-dot ring-2 ring-warm-dot/25', className)} aria-label="等你" />
}

export function ComputeLine({ id }: { id: string }) {
  const { computes, openSplit, resolve, pending, takeHuman, returnHuman, hitCaptcha, declineHuman, convs } = useApp()
  let c = computes[id]
  if (!c) return null
  /* 坏实现（埋雷 AC-46-4）：派活那条消息全读了，就把任务当成做完。AC-46⑥：已读不等于已落实，做完没有只看任务本身 */
  if (broken('AC-46-4') && c.askMsg && c.status === 'running') {
    const cv = convs.find((x) => x.id === c.conv); const am = cv?.messages.find((x) => 'id' in x && x.id === c.askMsg) as { text?: string } | undefined
    const rc = cv && receiptOf(cv, c.askMsg, 'me', am?.text ?? '')
    if (rc && rc.read.length && !rc.unread.length) c = { ...c, status: 'done', result: '已完成' }
  }
  const done = c.steps.filter((s) => s.state === 'done').length
  const err = pending.find((p) => p.kind === 'error' && p.computeId === id)
  const open = (e: React.MouseEvent) => { e.stopPropagation(); openSplit({ t: 'compute', id }) }
  /* AC-14 停滞：在跑但超过 10 分钟没动静，换成黄色一行写明多久没动、卡在哪一步；联系人会自己出来 @你 */
  if (!broken('AC-14') && c.status === 'running' && (c.idleMin ?? 0) >= 10) return (
    <button data-testid={`compute-line-${id}`} data-state="stalled" onClick={open} className="flex max-w-full items-center gap-1.5 rounded-full bg-warm-soft py-0.5 pl-2 pr-2.5 text-left text-[12.5px]">
      <PauseCircle className="h-3.5 w-3.5 shrink-0 text-warm" /><span className="truncate font-medium">{c.title}</span>
      <span className="shrink-0 text-warm">· {c.idleMin} 分钟没动静 · 卡在「{c.steps.find((x) => x.state === 'now')?.text}」</span>
    </button>
  )
  /* C-US15：卡在只有人能过的一步，原地交给你；接手后小窗打开，过了点交还 */
  if (c.status === 'running' && c.needsHuman) return (
    <div data-testid={`compute-line-${id}`} data-state="human" className="flex max-w-full items-center gap-2 rounded-full bg-warm-soft py-0.5 pl-2 pr-1 text-[12.5px]">
      <Hand className="h-3.5 w-3.5 shrink-0 text-warm" /><button onClick={open} className="min-w-0 truncate text-left font-medium hover:underline">{c.title}</button>
      <span className="shrink-0 text-warm">· {c.needsHuman.taken ? '你在操作' : c.needsHuman.what + '，要你来'}</span>
      {c.needsHuman.taken
        ? <button data-testid={`human-return-${id}`} onClick={(e) => { e.stopPropagation(); returnHuman(id) }} className="h-6 shrink-0 rounded-full bg-me px-2.5 text-[12px] font-medium text-me-fg">交还给 {people[c.owner].name}</button>
        : <><button data-testid={`human-take-${id}`} onClick={(e) => { e.stopPropagation(); takeHuman(id) }} className="h-6 shrink-0 rounded-full bg-btn px-2.5 text-[12px] font-medium text-btn-fg">我来输入</button>
          <button data-testid={`human-decline-${id}`} onClick={(e) => { e.stopPropagation(); declineHuman(id) }} className="h-6 shrink-0 rounded-full px-2 text-[12px] text-fg-2 hover:bg-hover">不做了</button></>}
    </div>
  )
  if (c.status === 'error') return (
    <div data-testid={`compute-line-${id}`} data-state="error" onClick={open} className="flex max-w-full cursor-pointer items-center gap-2 border-l-2 border-err py-1 pl-2.5 pr-1 text-[13px]">
      <StatusDot c={c} />
      <button onClick={open} className="min-w-0 truncate text-left font-semibold text-err hover:underline">{c.title}</button>
      <span className="min-w-0 truncate text-err/90">{c.error ?? '出错了'}</span>
      {/* AC-36：失败原地给三条路：重试 / 换个模型 / 跳过这一步（跳过后汇报里写明跳过了什么） */}
      {err && <button data-testid={`retry-${id}`} onClick={(e) => { e.stopPropagation(); resolve(err.id, 'retry') }} className="ml-1 flex h-7 shrink-0 items-center gap-1 rounded-lg border border-err/40 px-2 text-[12.5px] font-medium text-err hover:bg-err-soft">重试</button>}
      {err && !broken('AC-36') && <button data-testid={`switch-${id}`} onClick={(e) => { e.stopPropagation(); resolve(err.id, 'switch') }} className="flex h-7 shrink-0 items-center rounded-lg px-2 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg">换个模型</button>}
      {err && !broken('AC-36') && <button data-testid={`skip-${id}`} onClick={(e) => { e.stopPropagation(); resolve(err.id, 'skip') }} className="flex h-7 shrink-0 items-center rounded-lg px-2 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg">跳过</button>}
    </div>
  )
  if (c.status === 'done') return (
    <button data-testid={`compute-line-${id}`} data-state="done" onClick={open} className="flex max-w-full items-center gap-1.5 truncate rounded-full py-0.5 pl-2 pr-2 text-left text-[12px] text-fg-3 transition hover:bg-hover">
      <StatusDot c={c} className="h-3 w-3" /><span className="truncate">{c.title}</span><span className="shrink-0">· {c.result ?? '已完成'}</span>
    </button>
  )
  return (
    <button data-testid={`compute-line-${id}`} data-state={c.status} data-cver={c.cver ?? 1} onClick={open} className="group/c -ml-0.5 flex max-w-full items-center gap-2 truncate rounded-full py-1 pl-2.5 pr-2 text-left text-[13px] text-fg-2 transition hover:bg-hover">
      <StatusDot c={c} />
      <span className="truncate font-medium text-fg">{c.title}</span>
      <span className="shrink-0 text-run" data-testid={`compute-phase-${id}`}>{c.status === 'stopped' ? '已停止' : c.phase}</span>
      {c.status === 'running' && <span className="shrink-0 text-fg-3">第 {Math.min(done + 1, c.steps.length)}/{c.steps.length} 步 · {c.elapsed}</span>}
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-3 transition group-hover/c:translate-x-0.5" />
      {id === 'logs' && c.status === 'running' && <span data-testid="demo-captcha" role="button" onClick={(e) => { e.stopPropagation(); hitCaptcha(id) }} className="ml-1 shrink-0 rounded px-1.5 text-[11.5px] text-fg-3 hover:bg-hover hover:text-fg">演示：遇到验证码</span>}
    </button>
  )
}

export function ArtifactIcon({ kind, className }: { kind: 'doc' | 'page' | 'sheet' | 'asset'; className?: string }) {
  const I = kind === 'doc' ? FileText : kind === 'page' ? Globe : kind === 'asset' ? Server : Table2
  return <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-hover text-fg-2', className)}><I className="h-[18px] w-[18px]" strokeWidth={1.75} /></div>
}

function FileCard({ id }: { id: string }) {
  const { openSplit } = useApp()
  const a = artifacts.find((x) => x.id === id)!
  return (
    <button data-testid={`file-card-${id}`} onClick={(e) => { e.stopPropagation(); openSplit({ t: 'artifact', id }) }} className="flex w-[300px] max-w-full items-center gap-3 rounded-2xl border border-line bg-elev p-2.5 pr-3 text-left transition hover:border-fg-3/40">
      <ArtifactIcon kind={a.kind} />
      <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{a.name}</div><div className="text-[12px] text-fg-2">{a.meta}</div></div>
    </button>
  )
}

/* US1 任务认领板：群里每个人都能看到谁领了什么 */
function BoardCard({ id }: { id: string }) {
  const { boards, openSplit } = useApp()
  const b = boards[id]
  const claimed = b.rows.filter((r) => r.who).length
  return (
    <button data-testid={`board-${id}`} onClick={(e) => { e.stopPropagation(); openSplit({ t: 'artifact', id: 'a3' }) }} className="w-[340px] max-w-full rounded-2xl border border-line bg-elev p-3 text-left transition hover:border-fg-3/40">
      <div className="flex items-center gap-2"><Table2 className="h-4 w-4 text-fg-2" /><span className="text-[14px] font-semibold">{b.title}</span><span className="ml-auto text-[12px] text-fg-3">{claimed}/{b.rows.length} 已认领</span></div>
      <div className="mt-2 space-y-1">
        {b.rows.slice(0, 4).map((r) => (
          <div key={r.task} className="flex items-center gap-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate">{r.task}</span>
            {r.who ? <span className="flex items-center gap-1 text-fg-2"><Avatar id={r.who} size={16} status={false} mood="idle" />{people[r.who].name}</span> : <span className="text-warm">没人领</span>}
          </div>
        ))}
      </div>
    </button>
  )
}

function ForwardCard({ m }: { m: Extract<Msg, { k: 'forward' }> }) {
  const { push, active } = useApp()
  return (
    <button onClick={(e) => { e.stopPropagation(); push({ t: 'forwardView', conv: active, msgId: m.id }, true) }} className="w-[320px] max-w-full rounded-2xl border border-line bg-elev p-3 text-left transition hover:border-fg-3/40">
      <div className="text-[13.5px] font-semibold">来自「{m.srcTitle}」的 {m.items.length} 条记录</div>
      <div className="mt-1.5 space-y-0.5 text-[12.5px] text-fg-2">{m.items.slice(0, 3).map((it, i) => <div key={i} className="truncate">{people[it.from]?.name ?? '你'}：{it.text}</div>)}</div>
      <div className="mt-2 border-t border-line pt-1.5 text-[11.5px] text-fg-3">转发的内容只当参考，里面的 @ 不会让谁去做事</div>
    </button>
  )
}

/* ============ 助手之间的讨论：GrokBot 式一行灰字，点开在右侧只读看原话 ============ */
function HuddleLine({ m, conv }: { m: Extract<Msg, { k: 'huddle' }>; conv: string }) {
  const { push } = useApp()
  return (
    <div className="my-1.5 flex justify-center" data-msg={m.id}>
      <button data-testid={`huddle-${m.id}`} onClick={() => push({ t: 'huddle', conv, msgId: m.id }, true)} className="group/h flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] text-fg-3 transition hover:bg-hover hover:text-fg-2">
        <span>{m.items.length} 条消息 ·</span>
        <AvatarStack ids={m.who} size={16} />
        <span>{m.who.map((w) => people[w].name).join(' 和 ')}</span>
        <ChevronRight className="h-3.5 w-3.5 opacity-60 transition group-hover/h:translate-x-0.5" />
      </button>
    </div>
  )
}

/* US11 / US6：联系人把一句话记成了自己的承诺 */
function CommitLine({ m }: { m: Extract<Msg, { k: 'commit' }> }) {
  const { commits, push, active } = useApp()
  const list = commits.filter((c) => m.ids.includes(c.id))
  return (
    <div className="my-1.5 flex justify-center" data-msg={m.id}>
      <button data-testid={`commit-${m.id}`} onClick={() => push({ t: 'commits', id: active }, true)} className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] text-fg-3 transition hover:bg-hover hover:text-fg-2">
        <Pin className="h-3.5 w-3.5" />
        <AvatarStack ids={list.map((c) => c.owner)} size={16} />
        <span data-testid={`commit-state-${m.id}`} data-off={list.every((c) => !c.on) ? '1' : undefined} className={cn(list.every((c) => !c.on) && 'line-through decoration-fg-3/50')}>{list.map((c) => people[c.owner].name).join('、')} 记下了：{list[0]?.trigger === '定时' ? list[0].text : '有进度就在群里 @你'}</span>
        {list.every((c) => !c.on) && <span className="text-fg-3">· 你撤回了原话，已停</span>}
        <ChevronRight className="h-3.5 w-3.5 opacity-60" />
      </button>
    </div>
  )
}

/* US3：资产提示，和普通消息视觉区分 */
function AssetLine({ m }: { m: Extract<Msg, { k: 'asset' }> }) {
  const { openSplit } = useApp()
  return (
    <div className="my-2 flex justify-center" data-msg={m.id}>
      <button data-testid={`asset-${m.id}`} onClick={() => openSplit({ t: 'artifact', id: m.assetId })} className="flex max-w-[90%] items-center gap-2 rounded-xl border border-dashed border-fg-3/40 bg-side px-3 py-1.5 text-[12.5px] text-fg-2 hover:border-fg-3/70 hover:text-fg">
        <KeyRound className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{m.text}</span>
        <span className="shrink-0 font-medium text-fg">查看</span>
      </button>
    </div>
  )
}

export function Tip({ label, children, side }: { label: string; children: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
    <Tooltip delayDuration={350}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="rounded-lg border-0 bg-fg px-2 py-1 text-xs text-bg">{label}</TooltipContent>
    </Tooltip>
  )
}

export function useSelection() {
  const [sel, setSel] = useState<Set<string>>(new Set())
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return { sel, toggle, clear: () => setSel(new Set()) }
}

/* #1858：定时发出的消息、或“记成定时”的确认消息，底部挂一行灰字，点了在分栏打开那个定时 */
function CronTrail({ m, mine }: { m: Extract<Msg, { k: 'text' }>; mine: boolean }) {
  const { crons, openSplit } = useApp()
  const c = crons.find((x) => x.id === m.cron)
  if (!c) return <div className="mt-0.5 text-[12px] text-fg-3" data-testid={`cron-trail-${m.id}`}>⏰ 这个定时已删除</div>
  return (
    <button data-testid={`cron-trail-${m.id}`} onClick={(e) => { e.stopPropagation(); openSplit({ t: 'cron', id: c.id }) }} className={cn('mt-0.5 flex items-center gap-1 rounded-full py-0.5 pl-1.5 pr-2 text-[12px] text-fg-3 transition hover:bg-hover hover:text-fg-2', mine && 'self-end')}>
      <AlarmClock className="h-3 w-3" />{m.cronNew ? '已记成定时' : '来自定时'} · {cronRule(c)}{c.paused ? ' · 已暂停' : ''}<ChevronRight className="h-3 w-3 opacity-60" />
    </button>
  )
}

/* U87 / D23 / AC-40：每条交给助手的消息都要有交代，挂在你那条消息底部一行灰字。
   已做 ↗ / 在做 ↗ / 记下了 / 合并到「x」↗ / 被后面那条替代 ↗ / 知道了；交代不对，点「改」一句话改掉 */
function DispLine({ m }: { m: Extract<Msg, { k: 'text' }> }) {
  const { setDisp, openSplit, jump, computes, crons } = useApp()
  const d = m.disp!
  const refName = d.refKind === 'compute' ? computes[d.ref!]?.title : d.refKind === 'cron' ? (() => { const c = crons.find((x) => x.id === d.ref); return c ? `${cronRule(c)} 的定时` : '' })() : ''
  const go = () => (d.refKind === 'compute' ? openSplit({ t: 'compute', id: d.ref! }) : d.refKind === 'cron' ? openSplit({ t: 'cron', id: d.ref! }) : d.ref && jump(d.ref))
  const short = (t?: string) => (t && t.length > 10 ? t.slice(0, 10) + '…' : t)
  const label = d.kind === 'merged' ? `合并到「${short(refName) || '…'}」` : d.kind === 'superseded' ? '被后面那条替代' : d.kind === 'doing' && refName ? `在做「${short(refName)}」` : d.kind === 'done' && refName ? `已做「${short(refName)}」` : dispText[d.kind]
  const tone = d.kind === 'superseded' ? 'line-through decoration-fg-3/50' : ''
  return (
    <div data-testid={`disp-${m.id}`} data-kind={d.kind} className="flex min-w-0 items-center gap-1 text-[11.5px] text-fg-3">
      <span title={people[d.by].name} className="inline-flex"><Avatar id={d.by} size={13} status={false} mood="idle" /></span>
      {d.ref ? <button onClick={(e) => { e.stopPropagation(); go() }} className={cn('hover:text-fg-2 hover:underline', tone)}>{label} ↗</button> : <span className={tone}>{label}</span>}
      {d.note && <span className="max-w-[240px] truncate" title={d.note}>· {d.note}</span>}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild><button data-testid={`disp-edit-${m.id}`} onClick={(e) => e.stopPropagation()} className="rounded px-1 text-fg-3 opacity-70 hover:bg-hover hover:text-fg hover:opacity-100">改</button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 rounded-xl border-line bg-elev p-1 shadow-elev">
          <div className="px-2 py-1 text-[11.5px] text-fg-3">交代不对？告诉 {people[d.by].name} 这条该怎么算</div>
          {(['doing', 'committed', 'noted'] as const).map((k) => <DropdownMenuItem key={k} data-testid={`disp-set-${m.id}-${k}`} className="rounded-lg" onSelect={() => setDisp(m.id, { by: d.by, kind: k, ref: k === 'doing' ? d.ref : undefined, refKind: k === 'doing' ? d.refKind : undefined })}>{k === 'doing' ? '这是要做的事，去做' : k === 'committed' ? '记下来，以后照这个做' : '只是说一下，知道就行'}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
