// 会话接线:rooms.list 全量读 → 会话列表;room.updated / room.removed 增量更新。
// 写:开私聊(rooms.openDm)、建群(rooms.createGroup)、拉人(rooms.addMembers),都以后端回包为准写回会话列表。
// 合同里没有的(群主/管理员身份、关联会话、工作区、禁言)不填,界面按「没有」显示。
import type { RoomView } from '@g-group/api-contract'
import { people, type Conversation, type PersonId } from '@/data'
import { loadMessages, mergeReads, msgId } from './messages'
import { actionId, clockOf, defineWiring, read, selfId, type WireCtx } from './types'

/** 会话最后活动时间(合同 updatedAt),会话列表按它从新到旧排 */
const lastAt = new Map<string, string>()
const byRecent = (cs: Conversation[]) => [...cs].sort((a, b) => (lastAt.get(b.id) ?? '').localeCompare(lastAt.get(a.id) ?? ''))

/** 合同的会话 → 界面的会话。你自己换成 'me' 排第一;消息和联系人的已读位置不在这里(消息接线写),换元信息时原样保留 */
export function toConversation(r: RoomView, userId: string, prev?: Conversation): Conversation {
  const ids = r.members.map((m) => (m.kind === 'user' && m.id === userId ? 'me' : m.id))
  /* 还没登记的成员(联系人没读到 / 已删除)先不列:界面各处按 id 查人,查不到会出错 */
  const members: PersonId[] = ['me', ...ids.filter((m) => m !== 'me' && !!people[m])]
  return {
    id: r.id, kind: r.kind, title: r.title, members,
    time: clockOf(r.updatedAt), pinned: r.pinned, muted: r.muted, unread: r.unread,
    ...(r.tempComputeSlots ? { tempCompute: { max: r.tempComputeSlots } } : {}),
    messages: prev?.messages ?? [],
    /* 已读位置:重启前的由 memberReads 补上,之后的由 receipt.updated 推进(只进不退);置顶消息以后端为准 */
    ...((r.memberReads ?? prev?.reads) ? { reads: mergeReads(prev?.reads, r.memberReads, r.id, userId) } : {}),
    ...(r.pinnedSeqs?.length ? { pins: r.pinnedSeqs.map((s) => msgId(r.id, s)) } : {}),
  }
}

/** 写回一个会话(新的加进来,旧的换元信息),按最后活动排序。正开着的会话不显示未读。返回它是不是新出现的 */
export function upsertRoom(w: WireCtx, r: RoomView): boolean {
  lastAt.set(r.id, r.updatedAt)
  const me = selfId(w)
  const { convs, active } = w.get()
  const known = convs.some((c) => c.id === r.id)
  const view = r.id === active ? { ...r, unread: 0 } : r
  w.get().setConvs((cs) => byRecent(known ? cs.map((c) => (c.id === r.id ? toConversation(view, me, c) : c)) : [...cs, toConversation(view, me)]))
  return !known
}

/** 新出现的会话:写进列表并补读它已有的消息(在这之前到的消息事件因为找不到会话被跳过了) */
async function addRoom(w: WireCtx, r: RoomView) {
  if (!upsertRoom(w, r)) return
  try { await loadMessages(w, r.id) } catch (e) { w.get().toast(`「${r.title}」的消息没读到：${e instanceof Error ? e.message : String(e)}`) }
}

export const roomsWiring = defineWiring({
  entity: '会话',
  load: async (w) => {
    const { rooms } = await read(w, 'rooms.list', {})
    const me = selfId(w)
    for (const r of rooms) lastAt.set(r.id, r.updatedAt)
    const prev = new Map(w.get().convs.map((c) => [c.id, c]))
    const list = byRecent(rooms.map((r) => toConversation(r, me, prev.get(r.id))))
    w.get().setConvs(list)
    /* 启动参数里的会话(演示数据的 id)在后端不存在:停在最近的那个 */
    if (list[0] && !list.some((c) => c.id === w.get().active)) w.get().setActive(list[0].id)
  },
  on: {
    'room.updated': (ev, w) => void addRoom(w, ev.room),
    'room.removed': (ev, w) => {
      lastAt.delete(ev.roomId)
      w.get().setConvs((cs) => cs.filter((c) => c.id !== ev.roomId))
    },
  },
})

const why = (e: { message: string }) => e.message

/** 开私聊:已有就是原来那个;切过去 */
export async function openDmLive(w: WireCtx, contactId: PersonId) {
  const r = await w.call('rooms.openDm', { contactId })
  if (!r.ok) { w.get().toast(`没打开私聊：${why(r.error)}`); return }
  await addRoom(w, r.value)
  w.get().openConv(r.value.id)
}

/** 建群并拉进选中的联系人;选了临时算力就再设上。建好切过去 */
export async function createGroupLive(w: WireCtx, title: string, ids: PersonId[], pool?: number) {
  const r = await w.call('rooms.createGroup', { clientActionId: actionId(), title, members: ids.map((id) => ({ kind: 'contact' as const, id })) })
  if (!r.ok) { w.get().toast(`没建成群：${why(r.error)}`); return }
  await addRoom(w, r.value)
  w.get().openConv(r.value.id)
  if (!pool) return
  const u = await w.call('rooms.update', { roomId: r.value.id, tempComputeSlots: pool })
  if (u.ok) upsertRoom(w, u.value)
  else w.get().toast(`群临时算力没设上：${why(u.error)}`)
}

/** 拉人进群:成员以回包为准 */
export async function addMembersLive(w: WireCtx, roomId: string, ids: PersonId[]) {
  const r = await w.call('rooms.addMembers', { roomId, members: ids.map((id) => ({ kind: 'contact' as const, id })) })
  if (!r.ok) { w.get().toast(`没拉进群：${why(r.error)}`); return }
  upsertRoom(w, r.value)
}

/** 你在这个会话里读到了第几条(只影响你自己的未读数) */
export function markReadLive(w: WireCtx, roomId: string, seq: number) {
  void w.call('rooms.markRead', { roomId, seq })
}
