// 消息接线:每个会话 messages.list 读最近一页 → 会话的消息;message.appended / message.updated 增量写回。
// 写:发送(messages.send,带 clientActionId)。先乐观显示一条,回包或事件到了按 clientActionId 换成后端那条,不重复。
// 消息 id = 会话 id#seq:全局唯一、重读也不变。任务卡(task-status)在聊天里画成 Compute 那一行,其余卡片按正文显示。
import type { MessageView } from '@g-group/api-contract'
import { people, type Msg, type PersonId, type QuoteRef } from '@/data'
import { actionId, clockOf, defineWiring, read, selfId, type WireCtx } from './types'

export const msgId = (roomId: string, seq: number) => `${roomId}#${seq}`
/** 后端消息的序号;本地乐观条目、演示消息没有 */
export const seqOf = (id: string): number | null => {
  const m = /#(\d+)$/.exec(id)
  return m ? Number(m[1]) : null
}
/** 乐观显示的那条(还没回包)的 id */
export const localId = (clientActionId: string) => `local-${clientActionId}`

/** 发送人 → 界面里的人:你自己是 'me',Helper 是 'helper',系统消息没有人(画成灰字) */
export function senderOf(s: MessageView['sender'], userId: string): PersonId | null {
  if (s.kind === 'system') return null
  if (s.kind === 'helper') return 'helper'
  return s.kind === 'user' && s.id === userId ? 'me' : s.id
}

/** 合同的消息 → 界面的消息。whoSaid 按序号查被引用那条是谁说的(查不到就不画这条引用,不编作者) */
export function toMsg(v: MessageView, userId: string, whoSaid: (seq: number) => PersonId | undefined = () => undefined): Msg {
  const id = msgId(v.roomId, v.seq)
  const from = senderOf(v.sender, userId)
  const body = v.text || v.card?.title || ''
  if (!from) return { k: 'sys', id, text: body }
  if (v.retracted) return { k: 'sys', id, text: from === 'me' ? '你撤回了一条消息' : `${people[from]?.name ?? ''} 撤回了一条消息` }
  if (v.card?.kind === 'task-status' && v.card.taskId) return { k: 'compute', id, from, computeId: v.card.taskId }
  const quotes: QuoteRef[] = v.quotes.flatMap((q) => {
    const who = q.state === 'ok' ? whoSaid(q.seq) : undefined
    return who ? [{ msgId: msgId(v.roomId, q.seq), from: who, text: q.excerpt, ...(q.seq === v.replyToSeq ? { reply: true } : {}) }] : []
  })
  return { k: 'text', id, from, text: body, at: clockOf(v.at), ...(v.edited ? { edited: true } : {}), ...(quotes.length ? { quotes } : {}) }
}

const idOf = (m: Msg) => ('id' in m ? m.id : '')

/** 合并进一个会话的消息:同 id 换新;settled 里的乐观条目被顶掉;后端消息按序号排,本地还没回包的排在最后 */
export function mergeMsgs(cur: Msg[], incoming: Msg[], settled: readonly string[] = []): Msg[] {
  const drop = new Set(settled)
  const remote = new Map<string, Msg>()
  const local: Msg[] = []
  for (const m of cur) {
    if (drop.has(idOf(m))) continue
    if (seqOf(idOf(m)) === null) local.push(m)
    else remote.set(idOf(m), m)
  }
  for (const m of incoming) remote.set(idOf(m), m)
  const sorted = [...remote.values()].sort((a, b) => (seqOf(idOf(a)) ?? 0) - (seqOf(idOf(b)) ?? 0))
  return [...sorted, ...local]
}

/** 把后端消息写进它的会话。会话还没读到就先不写:room.updated 到了会补读整页 */
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
  }
  const mapped = views.map((v) => toMsg(v, me, (s) => said.get(s)))
  const settled = views.flatMap((v) => (v.clientActionId ? [localId(v.clientActionId)] : []))
  w.get().setConvs((cs) => cs.map((c) => (c.id === roomId ? { ...c, messages: mergeMsgs(c.messages, mapped, settled) } : c)))
}

/** 读一个会话最近一页消息 */
export async function loadMessages(w: WireCtx, roomId: string) {
  const { messages } = await read(w, 'messages.list', { roomId, limit: 200 })
  putMessages(w, roomId, messages)
}

/** 正开着的会话来了别人的新消息:你已经看到了,告诉后端读到这条(只影响你自己的未读数) */
function readIfOpen(w: WireCtx, v: MessageView) {
  if (w.get().active !== v.roomId || senderOf(v.sender, selfId(w)) === 'me') return
  void w.call('rooms.markRead', { roomId: v.roomId, seq: v.seq })
}

export const messagesWiring = defineWiring({
  entity: '消息',
  load: async (w) => {
    const ids = w.get().convs.map((c) => c.id)
    const res = await Promise.allSettled(ids.map((id) => loadMessages(w, id)))
    const bad = res.filter((r) => r.status === 'rejected').length
    if (bad) throw new Error(`${bad} 个会话的消息没读到`)
  },
  on: {
    'message.appended': (ev, w) => { putMessages(w, ev.message.roomId, [ev.message]); readIfOpen(w, ev.message) },
    'message.updated': (ev, w) => putMessages(w, ev.message.roomId, [ev.message]),
    /* 联系人接走消息即已读(宿主推进):你发的消息上的回执跟着变。启动时读不到历史已读位置(要逐条 messages.receipts),只跟后来的 */
    'receipt.updated': (ev, w) => { if (ev.member.kind === 'contact') w.get().advanceRead(ev.roomId, ev.member.id, msgId(ev.roomId, ev.readSeq)) },
  },
})

/** 发送:正文里 @ 到的在场联系人记成 mentions(回复自动带上的那位记 auto);引用和主回复按序号带上。
 *  先乐观显示,回包到了换成后端那条;发不出去就撤下乐观那条、把话放回输入框,并说明原因 */
export async function sendLive(w: WireCtx, roomId: string, text: string, quotes: readonly QuoteRef[]) {
  const conv = w.get().convs.find((c) => c.id === roomId)
  if (!conv) return
  const cid = actionId()
  const reply = quotes.find((q) => q.reply)
  const mentions = conv.members
    .filter((m) => m !== 'me' && !!people[m] && text.includes('@' + people[m].name))
    .map((id) => ({ id, source: reply?.from === id ? ('auto' as const) : ('manual' as const) }))
  const quotedSeqs = quotes.flatMap((q) => { const s = seqOf(q.msgId); return s === null ? [] : [s] })
  const replyToSeq = reply ? seqOf(reply.msgId) : null
  w.get().pushMsg({ k: 'text', id: localId(cid), from: 'me', text, ...(quotes.length ? { quotes: [...quotes] } : {}) }, roomId)
  const r = await w.call('messages.send', {
    roomId, clientActionId: cid, text,
    ...(mentions.length ? { mentions } : {}),
    ...(quotedSeqs.length ? { quotedSeqs } : {}),
    ...(replyToSeq !== null ? { replyToSeq } : {}),
  })
  if (r.ok) { putMessages(w, roomId, [r.value]); return }
  w.get().setConvs((cs) => cs.map((c) => (c.id === roomId ? { ...c, messages: c.messages.filter((m) => idOf(m) !== localId(cid)) } : c)))
  if (w.get().active === roomId && !w.get().drafts[roomId]) w.get().setDraft(text)
  w.get().toast(`没发出去：${r.error.message}`)
}
