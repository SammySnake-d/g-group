// 消息 id = 会话 id#seq:全局唯一、重读也不变。任务卡(task-status)照设计画成两样:联系人说的那句(派活记录的正文)
// 其余卡片按正文显示。转发来的画成转发卡,附件画在气泡下;私聊回退撤下的消息不再显示,回退那条记成一行灰字。
import type { MessageView, MemberRef } from '@g-group/api-contract'
import { people, type Msg, type PersonId, type QuoteRef, type ReadMarks } from '@/data'
import { loadDrafts, onDraftUpdated } from './drafts'
import { cardFields, syncCards } from './cards'
import { actionId, clockOf, defineWiring, read, selfId, type WireCtx } from './types'

export const msgId = (roomId: string, seq: number) => `${roomId}#${seq}`
export const seqOf = (id: string): number | null => {
  const m = /#(\d+)(?:~c)?$/.exec(id)
  return m ? Number(m[1]) : null
}
export const localId = (clientActionId: string) => `local-${clientActionId}`
const ATTACH_ONLY = /^\[附件 \d+ 个\]$/

/** 你撤回的消息原文:只留在这台机器的内存里,给「重新编辑」用;后端撤回后不再给原文 */
export const recalledText = new Map<string, string>()
const rewoundSeen = new Map<string, Set<number>>()

export function senderOf(s: MessageView['sender'], userId: string): PersonId | null {
  if (s.kind === 'system') return null
  if (s.kind === 'helper') return 'helper'
  return s.kind === 'user' && s.id === userId ? 'me' : s.id
}
const memberOf = (m: MemberRef, userId: string): PersonId => (m.kind === 'user' && m.id === userId ? 'me' : m.id)

export function toMsgs(v: MessageView, userId: string, whoSaid: (seq: number) => PersonId | undefined = () => undefined): Msg[] {
  /* 私聊回退撤下的:记录还在,但不再显示、不再是当前上下文(AC-48) */
  if (v.rewound) return []
  const m = toMsg(v, userId, whoSaid)
  if (v.card?.kind !== 'task-status' || !v.card.taskId || m.k !== 'text') return [m]
  return [m, { k: 'compute', id: `${m.id}~c`, from: m.from, computeId: v.card.taskId }]
}

function toMsg(v: MessageView, userId: string, whoSaid: (seq: number) => PersonId | undefined): Msg {
  const id = msgId(v.roomId, v.seq)
  const from = senderOf(v.sender, userId)
  const body = v.text || v.card?.title || ''
  if (!from) return { k: 'sys', id, text: body }
  if (v.retracted) {
    const was = from === 'me' ? recalledText.get(id) : undefined
    return { k: 'sys', id, text: from === 'me' ? '你撤回了一条消息' : `${people[from]?.name ?? ''} 撤回了一条消息`, ...(was ? { recalled: was } : {}) }
  }
  if (v.command?.name === 'rewind' && from === 'me') return rewindLine(v, id)
  if (v.forward) {
    return { k: 'forward', id, from, srcTitle: v.forward.fromTitle, items: v.forward.items.map((x) => ({ from: senderOf(x.sender, userId) ?? 'me', text: x.text })) }
  }
  const quotes: QuoteRef[] = v.quotes.flatMap((q) => {
    const who = q.state === 'ok' ? whoSaid(q.seq) : undefined
    return who ? [{ msgId: msgId(v.roomId, q.seq), from: who, text: q.excerpt, ...(q.seq === v.replyToSeq ? { reply: true } : {}) }] : []
  })
  const files = v.attachments.length ? { files: v.attachments.map((a) => ({ ref: a.ref, name: a.name, mime: a.mime, bytes: a.bytes })) } : {}
  const text = v.attachments.length && ATTACH_ONLY.test(body) ? '' : body
  return { k: 'text', id, from, text, at: clockOf(v.at), ...(v.edited ? { edited: true } : {}), ...(quotes.length ? { quotes } : {}), ...files, ...cardFields(v) }
}

function rewindLine(v: MessageView, id: string): Msg {
  const to = v.replyToSeq ?? 0
  const q = v.quotes.find((x) => x.seq === to)
  const gone = [...(rewoundSeen.get(v.roomId) ?? [])].filter((s) => s > to && s < v.seq).length
  const head = q?.excerpt ? `「${q.excerpt.replace(/^@\S+\s/, '').slice(0, 14)}${q.excerpt.length > 14 ? '…' : ''}」` : '这一条'
  return { k: 'sys', id, text: `你把聊天退回到${head}，${gone ? `之后 ${gone} 条已撤下，` : '之后的消息已撤下，'}对方从这里接着聊`, rewind: true }
}

const idOf = (m: Msg) => ('id' in m ? m.id : '')

export function mergeMsgs(cur: Msg[], incoming: Msg[], settled: readonly string[] = []): Msg[] {
  const drop = new Set(settled)
  const remote = new Map<string, Msg>()
  const local: Msg[] = []
  for (const m of cur) {
    if (drop.has(idOf(m))) continue
    if (seqOf(idOf(m)) === null) local.push(m)
    else remote.set(idOf(m), m)
  }
  for (const m of incoming) {
    const old = remote.get(idOf(m))
    remote.set(idOf(m), old?.k === 'text' && m.k === 'text' && old.tag && !m.tag ? { ...m, tag: old.tag } : m)
  }
  const sorted = [...remote.values()].sort((a, b) => (seqOf(idOf(a)) ?? 0) - (seqOf(idOf(b)) ?? 0) || Number(idOf(a).endsWith('~c')) - Number(idOf(b).endsWith('~c')))
  return [...sorted, ...local]
}

function reactionsOf(v: MessageView, userId: string): Record<string, PersonId[]> {
  return Object.fromEntries(v.reactions.filter((r) => r.by.length).map((r) => [r.emoji, r.by.map((m) => memberOf(m, userId))]))
}

export function putMessages(w: WireCtx, roomId: string, views: readonly MessageView[]) {
  const conv = w.get().convs.find((c) => c.id === roomId)
  if (!conv || !views.length) return
  const me = selfId(w)
  const said = new Map<number, PersonId>()
  for (const m of conv.messages) {
    const s = seqOf(idOf(m))
    if (s !== null && 'from' in m) said.set(s, m.from)
  }
  for (const v of views) {
    const f = senderOf(v.sender, me)
    if (f) said.set(v.seq, f)
    if (v.rewound) {
      const set = rewoundSeen.get(roomId) ?? new Set<number>()
      set.add(v.seq)
      rewoundSeen.set(roomId, set)
    }
  }
  const mapped = views.flatMap((v) => toMsgs(v, me, (s) => said.get(s)))
  const settled = views.flatMap((v) => [
    ...(v.clientActionId ? [localId(v.clientActionId)] : []),
    ...(v.rewound ? [msgId(roomId, v.seq), `${msgId(roomId, v.seq)}~c`] : []),
  ])
  w.get().setConvs((cs) => cs.map((c) => (c.id === roomId ? { ...c, messages: mergeMsgs(c.messages, mapped, settled) } : c)))
  syncCards(w, roomId)
  w.get().putReactions(Object.fromEntries(views.map((v) => [msgId(roomId, v.seq), reactionsOf(v, me)])))
}

export async function loadMessages(w: WireCtx, roomId: string) {
  const { messages } = await read(w, 'messages.list', { roomId, limit: 200 })
  putMessages(w, roomId, messages)
}

export function mergeReads(prev: ReadMarks | undefined, reads: readonly { member: MemberRef; readSeq: number }[] | undefined, roomId: string, userId: string): ReadMarks | undefined {
  if (!reads?.length) return prev
  const out: ReadMarks = { ...prev }
  for (const r of reads) {
    const who = memberOf(r.member, userId)
    const cur = out[who] ?? []
    const last = cur[cur.length - 1]
    if (last && (seqOf(last.upto) ?? -1) >= r.readSeq) continue
    out[who] = [...cur, { upto: msgId(roomId, r.readSeq), at: '' }]
  }
  return out
}

function readIfOpen(w: WireCtx, v: MessageView) {
  if (w.get().active !== v.roomId || senderOf(v.sender, selfId(w)) === 'me') return
  void w.call('rooms.markRead', { roomId: v.roomId, seq: v.seq })
}

const REPLYING = new Set(['reading', 'thinking', 'replying'])

export const messagesWiring = defineWiring({
  entity: '消息',
  load: async (w) => {
    const ids = w.get().convs.map((c) => c.id)
    const res = await Promise.allSettled(ids.map((id) => loadMessages(w, id)))
    w.get().setUnreadAt(Object.fromEntries(w.get().convs.map((c) => [c.id, c.unread ?? 0])))
    const open = w.get().active
    if (w.get().convs.find((c) => c.id === open)?.unread) w.get().markRead(open)
    await loadDrafts(w, ids)
    const bad = res.filter((r) => r.status === 'rejected').length
    if (bad) throw new Error(`${bad} 个会话的消息没读到`)
  },
  on: {
    'message.appended': (ev, w) => { putMessages(w, ev.message.roomId, [ev.message]); readIfOpen(w, ev.message) },
    'message.updated': (ev, w) => putMessages(w, ev.message.roomId, [ev.message]),
    'receipt.updated': (ev, w) => { if (ev.member.kind === 'contact') w.get().advanceRead(ev.roomId, ev.member.id, msgId(ev.roomId, ev.readSeq)) },
    'contact.activity': (ev, w) => {
      const on = !!ev.roomId && REPLYING.has(ev.activity)
      w.get().setReplying(ev.contactId, on ? ev.roomId : null, ev.activity)
    },
    'draft.updated': (ev, w) => onDraftUpdated(w, ev.draft),
  },
})

export async function sendLive(w: WireCtx, roomId: string, text: string, quotes: readonly QuoteRef[], attachments: readonly { ref: string; name: string; mime: string; bytes: number }[] = []) {
  const conv = w.get().convs.find((c) => c.id === roomId)
  if (!conv) return
  const cid = actionId()
  const reply = quotes.find((q) => q.reply)
  const mentions = conv.members
    .filter((m) => m !== 'me' && !!people[m] && text.includes('@' + people[m].name))
    .map((id) => ({ id, source: reply?.from === id ? ('auto' as const) : ('manual' as const) }))
  const quotedSeqs = quotes.flatMap((q) => { const s = seqOf(q.msgId); return s === null ? [] : [s] })
  const replyToSeq = reply ? seqOf(reply.msgId) : null
  w.get().pushMsg({ k: 'text', id: localId(cid), from: 'me', text, ...(quotes.length ? { quotes: [...quotes] } : {}), ...(attachments.length ? { files: [...attachments] } : {}) }, roomId)
  const r = await w.call('messages.send', {
    roomId, clientActionId: cid, text,
    ...(mentions.length ? { mentions } : {}),
    ...(quotedSeqs.length ? { quotedSeqs } : {}),
    ...(replyToSeq !== null ? { replyToSeq } : {}),
    ...(attachments.length ? { attachments: attachments.map((a) => a.ref) } : {}),
  })
  if (r.ok) { putMessages(w, roomId, [r.value]); return }
  w.get().setConvs((cs) => cs.map((c) => (c.id === roomId ? { ...c, messages: c.messages.filter((m) => idOf(m) !== localId(cid)) } : c)))
  if (text && w.get().active === roomId && !w.get().drafts[roomId]) w.get().setDraft(text)
  w.get().toast(`没发出去：${r.error.message}`)
}
