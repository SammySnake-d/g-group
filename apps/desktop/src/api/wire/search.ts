// 搜索接线(AC-25):连上后端时在这个会话的全部历史里找(search.messages),不只是已经读进来的最近一页;结果带后端的真实序号。
// 点结果跳回原消息:那条没读进来,就先按序号读到它(messages.list 的 aroundSeq),再把它到已读进来那一段之间的补齐(afterSeq 往后翻),
// 聊天里始终是连着的一段。隔得太远补不齐、或者那条已被撤下,就如实说做不到——不往聊天里放一段中间缺着却看不出来的历史。
import type { MessageView, SearchHit } from '@g-group/api-contract'
import { msgId, putMessages, seqOf } from './messages'
import type { WireCtx } from './types'

export type { SearchHit }

/** 一页搜索结果的条数 */
const SEARCH_PAGE = 30
/** 跳回去时先读以那条为中心的一页;再往后一页页补,最多补这么多页 */
const AROUND = 200
const FILL = 500
const FILL_PAGES = 4

export type SearchResult = { ok: true; hits: SearchHit[]; next: string | null } | { ok: false; error: string }

/** 在一个会话里搜(按时间倒序);cursor 是上一页给的,取更早的一页 */
export async function searchLive(w: WireCtx, roomId: string, query: string, cursor?: string | null): Promise<SearchResult> {
  const r = await w.call('search.messages', { query, roomId, limit: SEARCH_PAGE, ...(cursor ? { cursor } : {}) })
  return r.ok ? { ok: true, hits: r.value.hits, next: r.value.nextCursor } : { ok: false, error: r.error.message }
}

const loadedSeqs = (w: WireCtx, roomId: string) =>
  (w.get().convs.find((c) => c.id === roomId)?.messages ?? []).flatMap((m) => { const s = 'id' in m ? seqOf(m.id) : null; return s === null ? [] : [s] })

/** 让一条消息出现在聊天里:已经读进来的直接用;没读进来的按序号读到它。成功给它在界面里的 id,做不到给原因 */
export async function revealLive(w: WireCtx, roomId: string, seq: number): Promise<{ ok: true; id: string } | { ok: false; why: string }> {
  const id = msgId(roomId, seq)
  const shown = () => !!w.get().convs.find((c) => c.id === roomId)?.messages.some((m) => 'id' in m && m.id === id)
  if (shown()) return { ok: true, id }
  if (!w.get().convs.some((c) => c.id === roomId)) return { ok: false, why: '这个会话已经不在了' }
  const around = await w.call('messages.list', { roomId, aroundSeq: seq, limit: AROUND })
  if (!around.ok) return { ok: false, why: around.error.message }
  const views: MessageView[] = [...around.value.messages]
  /* 已读进来的那一段从哪条开始(本地还没回包的不算);补到够着它为止 */
  const loaded = loadedSeqs(w, roomId)
  const first = loaded.length ? Math.min(...loaded) : null
  const reached = (last: number) => first !== null && last >= first
  let last = views.at(-1)?.seq ?? seq
  let more = around.value.hasMoreAfter ?? false
  for (let i = 0; more && !reached(last) && i < FILL_PAGES; i++) {
    const page = await w.call('messages.list', { roomId, afterSeq: last, limit: FILL })
    if (!page.ok) return { ok: false, why: page.error.message }
    const got = page.value.messages
    if (!got.length) { more = false; break }
    views.push(...got)
    last = got[got.length - 1]!.seq
    more = page.value.hasMore
  }
  if (more && !reached(last)) return { ok: false, why: `#${seq} 离现在太远：它和已经读进来的消息之间还隔着 ${FILL * FILL_PAGES} 多条，聊天里暂时翻不到那么早` }
  putMessages(w, roomId, views)
  return shown() ? { ok: true, id } : { ok: false, why: `#${seq} 已经被撤下，聊天里不再显示` }
}
