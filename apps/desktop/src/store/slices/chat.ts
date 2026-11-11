// 会话与消息切片:会话列表、当前会话、消息写入、已读、正在输入、草稿与引用、多选。
import { convs0, people, reactions0, type Msg, type PersonId, type QuoteRef } from '@/data'
import { broken } from '@/mut'
import { boot, clock, later, uid } from '../boot'
import { DRAFTS0 } from '../demo'
import { provFixture } from '@/components/files/fixtures'
import { focusComposer, scrollToMsg } from '../dom'
import { lens, type Slice } from '../state'
import type { Ctx } from '../types'

type TextMsg = Extract<Msg, { k: 'text' }>
type Draft = string | ((d: string) => string)

export type ChatSlice = Pick<Ctx, 'convs' | 'active' | 'reactions' | 'typing' | 'pushMsg' | 'openConv' | 'openDm' | 'mention' | 'addQuote' | 'react' | 'jump' | 'setDisp'
  | 'sendAs' | 'setSelecting' | 'markRead' | 'renameConv' | 'editing' | 'setEditing' | 'reedit' | 'putCommand' | 'quoteExternal'> & {
  /** 每个会话各自的草稿和待发引用(切走再回来还在) */
  drafts: Record<string, string>
  quotes: Record<string, QuoteRef[]>
  /** 跳到某条消息后短暂高亮 */
  highlight: string | null
  selecting: boolean
  selected: Set<string>
  /** 打开会话那一刻记住它有几条未读,用来画「以下是新消息」分隔线(#1240) */
  unreadAt: Record<string, number>
  setActive: (id: string) => void
  /** 从列表点开一个会话:切过去、清未读、退出多选 */
  openFromList: (id: string) => void
  /** 改当前会话的草稿 */
  setDraft: (v: Draft) => void
  removeQuote: (x: QuoteRef) => void
  toggleSelected: (id: string) => void
  /** 联系人回话:先「正在输入」,再出消息 */
  say: (cid: string, from: PersonId, text: string, delay?: number, extra?: Partial<TextMsg>) => void
  /** AC-46 已读位置:只由宿主推进、只进不退 */
  advanceRead: (cid: string, who: PersonId, upto?: string) => void
}

export const createChatSlice: Slice<ChatSlice> = (set, get) => {
  const L = lens(set)
  const setTyping = (cid: string, who: PersonId | null) => L.typing((t) => ({ ...t, [cid]: who }))
  return {
    convs: provFixture(boot.provFixture, convs0),
    active: boot.conv,
    reactions: reactions0,
    typing: {},
    drafts: DRAFTS0,
    quotes: {},
    highlight: null,
    selecting: false,
    selected: new Set(),
    editing: null,
    unreadAt: Object.fromEntries(convs0.map((c) => [c.id, c.unread ?? 0])),

    pushMsg: (m, cid) => {
      L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, messages: [...c.messages, m] } : c)))
      /* #2273 U80:「每 N 条消息醒一次」只数真人和助手说的话,不数系统灰字 */
      if (m.k === 'text' || m.k === 'file') get().countMessage(m, cid)
    },
    /** upto 省略 = 推到这个会话当前最后一条;at = 推进的时刻(第一次越过某条消息就是它的读到时间) */
    advanceRead: (cid, who, upto) => {
      const at = clock()
      L.convs((cs) => cs.map((c) => {
        if (c.id !== cid || !c.members.includes(who)) return c
        const ids = c.messages.filter((m) => 'id' in m).map((m) => (m as { id: string }).id)
        const to = upto ?? ids[ids.length - 1]
        const cur = c.reads?.[who] ?? []
        const last = cur[cur.length - 1]
        if (!to || (last && ids.indexOf(last.upto) >= ids.indexOf(to))) return c
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
    openFromList: (id) => { set({ active: id }); get().markRead(id); get().setSelecting(false) },
    openDm: (id) => {
      const dm = get().convs.find((c) => c.kind === 'dm' && c.members.includes(id))
      if (dm) { set({ section: 'chat', active: dm.id, stack: [] }); return }
      const nid = 'dm-' + id
      L.convs((cs) => [...cs, { id: nid, kind: 'dm', title: people[id].name, members: ['me', id], time: '刚刚', messages: [{ k: 'sys', id: 'n' + uid(), text: `你和 ${people[id].name} 的私聊，和群里的记录互不相通` }] }])
      set({ section: 'chat', active: nid, stack: [] })
    },
    markRead: (cid) => L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, unread: 0 } : c))),
    renameConv: (cid, title) => L.convs((cs) => cs.map((c) => (c.id === cid ? { ...c, title } : c))),

    setDraft: (v) => {
      const a = get().active
      L.drafts((d) => ({ ...d, [a]: typeof v === 'function' ? v(d[a] ?? '') : v }))
    },
    mention: (id) => {
      set({ section: 'chat', stack: [] })
      get().setDraft((d) => (d && !d.endsWith(' ') ? d + ' ' : d) + '@' + people[id].name + ' ')
      focusComposer()
    },
    reedit: (text) => { get().setDraft(text); focusComposer() },
    putCommand: (name) => { get().setDraft((d) => `/${name} ${d.replace(/^\/[a-z0-9-]+\s*/, '')}`); focusComposer() },
    setEditing: (editing) => set({ editing }),

    /* US13:回复 = 引用 + 自动 @ 作者;引用可连加多条;再点回复时旧的主回复降为普通引用,自动 @ 跟着换人 */
    addQuote: (qq) => {
      const { active, quotes } = get()
      const cur = quotes[active] ?? []
      const oldReply = cur.find((x) => x.reply)
      if (cur.some((x) => x.msgId === qq.msgId && !!x.reply === !!qq.reply)) return
      const rest = cur.filter((x) => x.msgId !== qq.msgId).map((x) => (qq.reply ? { ...x, reply: false } : x))
      L.quotes((all) => ({ ...all, [active]: qq.reply ? [qq, ...rest] : [...rest, qq] }))
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
    },
    quoteExternal: (lines, app) => {
      const a = get().active
      L.quotes((all) => ({ ...all, [a]: [...(all[a] ?? []), ...lines.map((l, i) => ({ msgId: 'ext-' + uid() + i, from: 'wang', text: `${l.who}：${l.text}`, ext: app }))] }))
      focusComposer()
    },

    react: (msgId, e) => L.reactions((r) => {
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
