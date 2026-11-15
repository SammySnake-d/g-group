// 群公告接线(AC-55,U86/U97):每个群的有效公告(新的在前)和各联系人装配到第几版写在会话上(conv.notices / conv.loaded),
// 群资料「公告」页、顶栏公告条都读它。全量读在会话之后;room.updated(公告增删改、联系人一轮装配完,后端都会推)时重读那个群。
// 写:发布(announcements.add)、改(announcements.update,带版本,被别人改过就刷新)、撤下(announcements.remove,带版本)。
import type { AnnouncementView } from '@g-group/api-contract'
import type { Conversation, Notice } from '@/data'
import { actionId, defineWiring, read, type WireCtx } from './types'

const pad = (n: number) => String(n).padStart(2, '0')
/** 公告时间:今天只写时:分,别的日子写月/日 时:分 */
function whenOf(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** 合同的公告 → 界面的公告;公告只有你能发,发布人写「你」 */
export const toNotice = (a: AnnouncementView): Notice => ({ id: a.id, text: a.text, by: '你', at: whenOf(a.updatedAt), ver: a.version })

/** 各联系人装配到的版本:{ 联系人: { 公告 id: 版本 } } */
export function loadedOf(list: readonly AnnouncementView[]): NonNullable<Conversation['loaded']> {
  const out: Record<string, Record<string, number>> = {}
  for (const a of list) for (const x of a.assembled ?? []) (out[x.contactId] ??= {})[a.id] = x.version
  return out
}

const put = (w: WireCtx, roomId: string, list: readonly AnnouncementView[]) =>
  w.get().setConvs((cs) => cs.map((c) => (c.id === roomId ? { ...c, notices: list.map(toNotice), loaded: loadedOf(list) } : c)))

/** 读一个群的公告(新的在前)写回会话 */
export async function loadNotices(w: WireCtx, roomId: string) {
  const { announcements } = await read(w, 'announcements.list', { roomId, order: 'created-desc' })
  put(w, roomId, announcements)
}

/* room.updated 来得很密(每条消息都推):同一个群在途时只再补读一次 */
const inflight = new Map<string, Promise<void>>()
const again = new Set<string>()
function refresh(w: WireCtx, roomId: string) {
  if (inflight.has(roomId)) { again.add(roomId); return }
  const p = loadNotices(w, roomId).catch(() => undefined).finally(() => {
    inflight.delete(roomId)
    if (again.delete(roomId)) refresh(w, roomId)
  })
  inflight.set(roomId, p)
}

export const noticesWiring = defineWiring({
  entity: '群公告',
  load: async (w) => {
    const groups = w.get().convs.filter((c) => c.kind === 'group')
    await Promise.all(groups.map((c) => loadNotices(w, c.id)))
  },
  on: {
    'room.updated': (ev, w) => {
      if (ev.room.kind !== 'group') return
      const cur = w.get().convs.find((c) => c.id === ev.room.id)
      /* 没公告、也没变成有公告的群不用读;有公告的群可能是某位联系人刚装配了新版本 */
      if (!(ev.room.announcementCount ?? 0) && !(cur?.notices?.length ?? 0)) return
      refresh(w, ev.room.id)
    },
  },
})

const why = (e: { message: string }) => e.message

/** 发布一条(不覆盖已有的) */
export async function addNoticeLive(w: WireCtx, roomId: string, text: string) {
  const r = await w.call('announcements.add', { roomId, clientActionId: actionId(), text })
  if (!r.ok) { w.get().toast(`公告没发布：${why(r.error)}`); return }
  w.get().toast('已发布。助手下次接活前，软件会把它装配进上下文')
  await loadNotices(w, roomId).catch(() => undefined)
}

/** 改一条:带着你看到的版本;别人先改过就不覆盖,刷新成最新的让你再看 */
export async function editNoticeLive(w: WireCtx, roomId: string, id: string, text: string, ver: number) {
  const r = await w.call('announcements.update', { announcementId: id, text, expectedVersion: ver })
  if (!r.ok) w.get().toast(r.error.code === 'conflict' ? '这条公告刚被改过，已刷新到最新版，没有覆盖' : `公告没改成：${why(r.error)}`)
  await loadNotices(w, roomId).catch(() => undefined)
}

/** 撤下一条:不再显示,助手下一轮也不再装配它 */
export async function removeNoticeLive(w: WireCtx, roomId: string, id: string, ver: number) {
  const r = await w.call('announcements.remove', { announcementId: id, expectedVersion: ver })
  if (!r.ok) w.get().toast(r.error.code === 'conflict' ? '这条公告刚被改过，已刷新到最新版，没有撤下' : `公告没撤下：${why(r.error)}`)
  else w.get().toast('已撤下。助手下一轮不再装配它')
  await loadNotices(w, roomId).catch(() => undefined)
}
