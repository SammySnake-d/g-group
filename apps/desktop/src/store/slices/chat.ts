import { people, type Conversation, type Msg, type PersonId, type QuoteRef } from '@/data'
import { reactLive, sendAsLive } from '@/api/wire/chat-ops'
import { scheduleDraftSave } from '@/api/wire/drafts'
import { live, liveCtx } from '@/api/wire/live'
import { seqOf } from '@/api/wire/messages'
import { markReadLive, openDmLive, updateRoomLive } from '@/api/wire/rooms'
import { broken } from '@/mut'
import { boot, clock, later, uid } from '../boot'
import { focusComposer, scrollToMsg } from '../dom'
import { firstUnreadId } from '../select'
import { rankIn } from '../reads'
import { lens, type Slice } from '../state'

type TextMsg = Extract<Msg, { k: 'text' }>
type Draft = string | ((d: string) => string)

export interface ChatCtx {
  convs: Conversation[]
  active: string
  reactions: Record<string, Record<string, PersonId[]>>
  typing: Record<string, PersonId | null>
  pushMsg: (m: import('@/data').Msg, convId: string) => void
  openConv: (id: string) => void
  openDm: (id: PersonId) => void
  mention: (id: PersonId) => void
  addQuote: (q: QuoteRef) => void
  react: (msgId: string, emoji: string) => void
  jump: (msgId: string) => void
  setDisp: (msgId: string, d: import('@/data').Disp | undefined) => void
  sendAs: (convId: string, text: string) => void
  setSelecting: (on: boolean) => void
  markRead: (convId: string) => void
  renameConv: (convId: string, title: string) => void
  editing: string | null
  setEditing: (id: string | null) => void
  reedit: (text: string) => void
  putCommand: (name: string) => void
  quoteExternal: (lines: { who: string; text: string }[], app: string) => void
}
export const CHAT_CTX_KEYS = ['convs', 'active', 'reactions', 'typing', 'pushMsg', 'openConv', 'openDm', 'mention', 'addQuote', 'react', 'jump', 'setDisp', 'sendAs', 'setSelecting', 'markRead', 'renameConv', 'editing', 'setEditing', 'reedit', 'putCommand', 'quoteExternal'] as const satisfies readonly (keyof ChatCtx)[]

export type ChatSlice = ChatCtx & {
  drafts: Record<string, string>
  quotes: Record<string, QuoteRef[]>
  highlight: string | null
  selecting: boolean
  selected: Set<string>
  /** 打开会话那一刻记住它有几条未读,用来画「以下是新消息」分隔线(#1240) */
  unreadAt: Record<string, number>
  setActive: (id: string) => void
  setConvs: (v: Conversation[] | ((cs: Conversation[]) => Conversation[])) => void
  openFromList: (id: string) => void
  setDraft: (v: Draft) => void
  removeQuote: (x: QuoteRef) => void
  toggleSelected: (id: string) => void
  say: (cid: string, from: PersonId, text: string, delay?: number, extra?: Partial<TextMsg>) => void
  /** AC-46 已读位置:只由宿主推进、只进不退 */
  advanceRead: (cid: string, who: PersonId, upto?: string) => void
  replyingSince: Record<string, number>
  setReplying: (who: PersonId, roomId: string | null, activity: string) => void
  putReactions: (m: Record<string, Record<string, PersonId[]>>) => void
  newFrom: Record<string, string | null>
  setUnreadAt: (m: Record<string, number>) => void
  restoreDraft: (cid: string, text: string, quotes: QuoteRef[]) => void
  replyingWhat: Record<string, string>
}

export const createChatSlice: Slice<ChatSlice> = (set, get) => {
  const L = lens(set)
  const setTyping = (cid: string, who: PersonId | null) => L.typing((t) => ({ ...t, [cid]: who }))
  return {
    convs: [],
    active: boot.conv,
    reactions: {},
    typing: {},
    drafts: {},
    quotes: {},
    highlight: null,
    selecting: false,
    selected: new Set(),
    editing: null,
    unreadAt: {},
    newFrom: {},
    replyingSince: {},
    replyingWhat: {},

    pushMsg: (m, cid) => {
      L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, messages: [...c.messages, m] } : c)))
      /* #2273 U80:「每 N 条消息醒一次」只数真人和助手说的话,不数系统灰字 */
      if (m.k === 'text' || m.k === 'file') get().countMessage(m, cid)
    },
    advanceRead: (cid, who, upto) => {
      const at = clock()
      L.convs((cs) => cs.map((c) => {
        if (c.id !== cid || !c.members.includes(who)) return c
        const ids = c.messages.filter((m) => 'id' in m).map((m) => (m as { id: string }).id)
        const to = upto ?? ids[ids.length - 1]
        const cur = c.reads?.[who] ?? []
        const last = cur[cur.length - 1]
        const rank = rankIn(ids)
        if (!to || (last && rank(last.upto) >= rank(to))) return c
        return { ...c, reads: { ...c.reads, [who]: [...cur, { upto: to, at }] } }
      }))
    },
    /* US9-Model:起草时只亮输入状态,不刷屏。D09.3 第 4 条(v3.17,#3035):宿主把消息交进联系人这一轮(亮出「正在回复」)的那一刻,
       就把它的 read_seq 推到这条——接走即已读;read_seq 只用于显示,这一轮失败也不退回 */
    say: (cid, from, text, delay = 900, extra) => {
      /* 坏实现(埋雷 AC-46-5):等回复落盘才记已读(旧 A 支),接走后、回复前回执仍是未读 */
      setTyping(cid, from)
      if (!broken('AC-46-5')) get().advanceRead(cid, from)
      later(() => {
        setTyping(cid, null)
        if (broken('AC-46-5')) get().advanceRead(cid, from)
        get().pushMsg({ k: 'text', id: 'r-' + uid(), from, text, ...extra }, cid)
      }, delay)
    },

    openConv: (id) => set({ panoOpen: false, section: 'chat', active: id, stack: [] }),
    setActive: (active) => set({ active }),
    setConvs: (v) => L.convs((cs) => (typeof v === 'function' ? v(cs) : v)),
    openFromList: (id) => {
      /* 连上后端:锚住打开这一刻的第一条未读,画「以下是新消息」(#1240) */
      if (live(get())) {
        const c = get().convs.find((x) => x.id === id)
        if (c) set((s) => ({ newFrom: { ...s.newFrom, [id]: firstUnreadId(c, c.unread ?? 0) } }))
      }
      set({ active: id }); get().markRead(id); get().setSelecting(false)
    },
    openDm: (id) => {
      const dm = get().convs.find((c) => c.kind === 'dm' && c.members.includes(id))
      if (dm) { set({ section: 'chat', active: dm.id, stack: [] }); return }
      if (live(get())) { void openDmLive(liveCtx(get, set), id); return }
      const nid = 'dm-' + id
      L.convs((cs) => [...cs, { id: nid, kind: 'dm', title: people[id].name, members: ['me', id], time: '刚刚', messages: [{ k: 'sys', id: 'n' + uid(), text: `你和 ${people[id].name} 的私聊，和群里的记录互不相通` }] }])
      set({ section: 'chat', active: nid, stack: [] })
    },
    markRead: (cid) => {
      L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, unread: 0 } : c)))
      const last = live(get()) ? get().convs.find((c) => c.id === cid)?.messages.reduce((n, m) => Math.max(n, ('id' in m && seqOf(m.id)) || 0), 0) : 0
      if (last) markReadLive(liveCtx(get, set), cid, last)
    },
    renameConv: (cid, title) => {
      if (live(get())) { void updateRoomLive(liveCtx(get, set), cid, { title }, `群名改成「${title}」`); return }
      L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, title } : c)))
    },

    setDraft: (v) => {
      const a = get().active
      L.drafts((d) => ({ ...d, [a]: typeof v === 'function' ? v(d[a] ?? '') : v }))
      /* 连上后端:草稿按会话存到后端,重启也还在(AC-24) */
      if (live(get())) scheduleDraftSave(liveCtx(get, set), a)
    },
    restoreDraft: (cid, text, quotes) => {
      L.drafts((d) => ({ ...d, [cid]: text }))
      L.quotes((all) => ({ ...all, [cid]: quotes }))
    },
    setReplying: (who, roomId, activity) => set((s) => {
      const typing = { ...s.typing }
      for (const [cid, p] of Object.entries(typing)) if (p === who && cid !== roomId) typing[cid] = null
      if (!roomId) return { typing }
      const same = s.typing[roomId] === who
      typing[roomId] = who
      return { typing, replyingSince: same ? s.replyingSince : { ...s.replyingSince, [roomId]: Date.now() }, replyingWhat: { ...s.replyingWhat, [roomId]: activity } }
    }),
    putReactions: (m) => L.reactions((r) => ({ ...r, ...m })),
    setUnreadAt: (m) => {
      L.unreadAt((u) => ({ ...u, ...m }))
      const convs = get().convs
      L.newFrom((f) => ({ ...f, ...Object.fromEntries(Object.entries(m).map(([id, n]) => { const c = convs.find((x) => x.id === id); return [id, c ? firstUnreadId(c, n) : null] })) }))
    },
    mention: (id) => {
      set({ section: 'chat', stack: [] })
      get().setDraft((d) => (d && !d.endsWith(' ') ? d + ' ' : d) + '@' + people[id].name + ' ')
      focusComposer()
    },
    reedit: (text) => { get().setDraft(text); focusComposer() },
    putCommand: (name) => { get().setDraft((d) => `/${name} ${d.replace(/^\/[a-z0-9-]+\s*/, '')}`); focusComposer() },
    setEditing: (editing) => set({ editing }),

    addQuote: (qq) => {
      const { active, quotes } = get()
      const cur = quotes[active] ?? []
      const oldReply = cur.find((x) => x.reply)
      if (cur.some((x) => x.msgId === qq.msgId && !!x.reply === !!qq.reply)) return
      const rest = cur.filter((x) => x.msgId !== qq.msgId).map((x) => (qq.reply ? { ...x, reply: false } : x))
      L.quotes((all) => ({ ...all, [active]: qq.reply ? [qq, ...rest] : [...rest, qq] }))
      if (live(get()) && !qq.reply) scheduleDraftSave(liveCtx(get, set), active)
      if (qq.reply) {
        get().setDraft((d) => {
          let s = d
          if (oldReply && oldReply.from !== 'me') s = s.replace('@' + people[oldReply.from].name + ' ', '')
          if (!broken('AC-37') && qq.from !== 'me' && !s.includes('@' + people[qq.from].name)) s = '@' + people[qq.from].name + ' ' + s
          return s
        })
      }
      focusComposer()
    },
    removeQuote: (x) => {
      const a = get().active
      L.quotes((all) => ({ ...all, [a]: (all[a] ?? []).filter((y) => y.msgId !== x.msgId) }))
      if (x.reply && x.from !== 'me') get().setDraft((d) => d.replace('@' + people[x.from].name + ' ', ''))
      else if (live(get())) scheduleDraftSave(liveCtx(get, set), a)
    },
    quoteExternal: (lines, app) => {
      const a = get().active
      L.quotes((all) => ({ ...all, [a]: [...(all[a] ?? []), ...lines.map((l, i) => ({ msgId: 'ext-' + uid() + i, from: 'wang', text: `${l.who}：${l.text}`, ext: app }))] }))
      focusComposer()
    },

    react: (msgId, e) => live(get()) ? void reactLive(liveCtx(get, set), msgId, e) : L.reactions((r) => {
      const cur = { ...(r[msgId] ?? {}) }
      const who = cur[e] ?? []
      cur[e] = who.includes('me') ? who.filter((w) => w !== 'me') : [...who, 'me']
      if (!cur[e].length) delete cur[e]
      return { ...r, [msgId]: cur }
    }),
    jump: (msgId) => {
      const owner = get().convs.find((c) => c.messages.some((m) => 'id' in m && m.id === msgId))
      if (owner) set({ section: 'chat', active: owner.id, stack: [] })
      setTimeout(() => {
        scrollToMsg(msgId)
        set({ highlight: msgId })
        setTimeout(() => set({ highlight: null }), 1800)
      }, 80)
    },
    setDisp: (msgId, d) => L.convs((cs) => cs.map((c) => ({ ...c, messages: c.messages.map((m) => (m.k === 'text' && m.id === msgId ? { ...m, disp: d } : m)) }))),
    sendAs: (cid, text) => {
      if (live(get())) { void sendAsLive(liveCtx(get, set), cid, text); return }
      get().pushMsg({ k: 'text', id: 'me-' + uid(), from: 'me', text }, cid)
      const target = Object.values(people).find((p) => text.includes('@' + p.name))
      if (target && !target.human) get().say(cid, target.id, '收到，我看一下。', 1000)
    },

    setSelecting: (on) => set(on ? { selecting: true } : { selecting: false, selected: new Set() }),
    toggleSelected: (id) => set((s) => {
      const n = new Set(s.selected)
      if (n.has(id)) n.delete(id); else n.add(id)
      return { selected: n }
    }),
  }
}
