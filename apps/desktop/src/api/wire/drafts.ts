// 输入框草稿接线(AC-24、AC-37 ②):按会话持久化,切窗口与重启都不丢。草稿不是消息,不送达任何联系人。
import type { DraftBody, DraftView } from '@g-group/api-contract'
import { people, type QuoteRef } from '@/data'
import { msgId, seqOf } from './messages'
import type { WireCtx } from './types'

const SAVE_DELAY_MS = 400
const known = new Map<string, number>()
const inflight = new Map<string, number>()
const lastBody = new Map<string, string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

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
  const cur = (r.error.detail as { current?: DraftView } | undefined)?.current
  if (r.error.code === 'conflict' && cur && !retried) { known.set(roomId, cur.draftVer); await saveDraft(w, roomId, true); return }
  console.warn(`[wire] 草稿没存上(${roomId}):${r.error.message}`)
}

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

export async function loadDrafts(w: WireCtx, roomIds: readonly string[]) {
  await Promise.allSettled(roomIds.map(async (roomId) => {
    const r = await w.call('drafts.get', { roomId })
    if (!r.ok || r.value.draftVer <= (known.get(roomId) ?? 0)) return
    if ((w.get().drafts[roomId] ?? '') !== '' || (w.get().quotes[roomId] ?? []).length) return
    adopt(w, r.value)
  }))
}

export function onDraftUpdated(w: WireCtx, d: DraftView) {
  if (d.draftVer <= Math.max(known.get(d.roomId) ?? 0, inflight.get(d.roomId) ?? 0)) return
  adopt(w, d)
}
