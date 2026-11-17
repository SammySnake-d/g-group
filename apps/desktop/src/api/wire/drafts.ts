// 输入框草稿接线(AC-24、AC-37 ②):按会话持久化,切窗口与重启都不丢。草稿不是消息,不送达任何联系人。
// 读:连上后端时每个会话 drafts.get(在消息之后读,引用按消息补出作者与原文);draft.updated(另一个窗口、发送回执)按 draftVer 合并。
// 写:输入框文字、引用一变就记下要存,停手 400ms 后 drafts.save(按 draftVer 做 CAS);版本对不上就以服务端当前版本为底再存一次。
import type { DraftBody, DraftView } from '@g-group/api-contract'
import { people, type QuoteRef } from '@/data'
import { msgId, seqOf } from './messages'
import type { WireCtx } from './types'

const SAVE_DELAY_MS = 400
/** 每个会话已知的最新草稿版本(存成功的或服务端推来的) */
const known = new Map<string, number>()
/** 正在存的那一版:它自己的 draft.updated 回声不当成别处的改动 */
const inflight = new Map<string, number>()
/** 上一次存进去的内容,没变就不存 */
const lastBody = new Map<string, string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** 界面上的草稿(文字 + 引用)→ 合同的草稿内容 */
function bodyOf(w: WireCtx, roomId: string, ver: number): DraftBody {
  const s = w.get()
  const text = s.drafts[roomId] ?? ''
  const quotes = (s.quotes[roomId] ?? []).filter((q) => !q.ext && seqOf(q.msgId) !== null)
  const reply = quotes.find((q) => q.reply)
  const replyAuthorId = reply && reply.from !== 'me' && reply.from !== 'helper' ? reply.from : null
  return {
    text,
    replyToSeq: reply ? seqOf(reply.msgId) : null,
    replyAuthorId,
    quotedSeqs: [...new Set(quotes.map((q) => seqOf(q.msgId) as number))],
    mentions: replyAuthorId && text.includes('@' + (people[replyAuthorId]?.name ?? '\u0000')) ? [{ id: replyAuthorId, source: 'auto' }] : [],
    draftVer: ver,
  }
}
const sameBody = (b: Pick<DraftBody, 'text' | 'replyToSeq' | 'replyAuthorId' | 'quotedSeqs' | 'mentions'>) => JSON.stringify([b.text, b.replyToSeq, b.replyAuthorId, b.quotedSeqs, b.mentions.map((m) => [m.id, m.source])])

/** 输入框或引用变了:停手一会儿再存 */
export function scheduleDraftSave(w: WireCtx, roomId: string) {
  const t = timers.get(roomId)
  if (t) clearTimeout(t)
  timers.set(roomId, setTimeout(() => { timers.delete(roomId); void saveDraft(w, roomId) }, SAVE_DELAY_MS))
}

async function saveDraft(w: WireCtx, roomId: string, retried = false) {
  const base = known.get(roomId) ?? 0
  const body = bodyOf(w, roomId, base + 1)
  if (lastBody.get(roomId) === sameBody(body)) return
  inflight.set(roomId, body.draftVer)
  const r = await w.call('drafts.save', { roomId, expectedVer: base, draft: body })
  inflight.delete(roomId)
  if (r.ok) { known.set(roomId, r.value.draftVer); lastBody.set(roomId, sameBody(body)); return }
  /* 别处(另一个窗口、发送回执)先改过:以它的版本为底,把这里正在打的再存一次——你眼前的输入框为准 */
  const cur = (r.error.detail as { current?: DraftView } | undefined)?.current
  if (r.error.code === 'conflict' && cur && !retried) { known.set(roomId, cur.draftVer); await saveDraft(w, roomId, true); return }
  console.warn(`[wire] 草稿没存上(${roomId}):${r.error.message}`)
}

/** 服务端的草稿 → 界面的文字与引用(引用在已读进来的消息里找作者和原文;找不到的不编) */
function adopt(w: WireCtx, d: DraftView) {
  const conv = w.get().convs.find((c) => c.id === d.roomId)
  if (!conv) return
  const quotes: QuoteRef[] = d.quotedSeqs.flatMap((s) => {
    const m = conv.messages.find((x) => 'id' in x && x.id === msgId(d.roomId, s))
    if (!m || m.k !== 'text') return []
    return [{ msgId: m.id, from: m.from, text: m.text, ...(s === d.replyToSeq ? { reply: true } : {}) }]
  })
  known.set(d.roomId, d.draftVer)
  lastBody.set(d.roomId, sameBody(d))
  w.get().restoreDraft(d.roomId, d.text, quotes)
}

/** 连上后端时读各会话的草稿 */
export async function loadDrafts(w: WireCtx, roomIds: readonly string[]) {
  await Promise.allSettled(roomIds.map(async (roomId) => {
    const r = await w.call('drafts.get', { roomId })
    if (!r.ok || r.value.draftVer <= (known.get(roomId) ?? 0)) return
    /* 这次启动里你已经在这个会话打了字:以眼前的为准 */
    if ((w.get().drafts[roomId] ?? '') !== '' || (w.get().quotes[roomId] ?? []).length) return
    adopt(w, r.value)
  }))
}

/** 别处改了草稿(另一个窗口、发送回执清掉已发的那一版):比已知的新才换上 */
export function onDraftUpdated(w: WireCtx, d: DraftView) {
  if (d.draftVer <= Math.max(known.get(d.roomId) ?? 0, inflight.get(d.roomId) ?? 0)) return
  adopt(w, d)
}
