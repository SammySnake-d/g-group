// 你是每个群的群主(U03:用户就是超级管理员);合同里没有的(管理员、关联会话、工作区、禁言)不填,界面按「没有」显示。
import type { RoomView } from '@g-group/api-contract'
import { people, type Conversation, type PersonId } from '@/data'
import { loadMessages, mergeReads, msgId } from './messages'
import { actionId, clockOf, defineWiring, read, selfId, type WireCtx } from './types'

const lastAt = new Map<string, string>()
const byRecent = (cs: Conversation[]) => [...cs].sort((a, b) => (lastAt.get(b.id) ?? '').localeCompare(lastAt.get(a.id) ?? ''))

export function toConversation(r: RoomView, userId: string, prev?: Conversation): Conversation {
  const ids = r.members.map((m) => (m.kind === 'user' && m.id === userId ? 'me' : m.id))
  const members: PersonId[] = ['me', ...ids.filter((m) => m !== 'me' && !!people[m])]
  const leaving = (r.leavingMembers ?? []).map((m) => m.id).filter((m) => members.includes(m))
  return {
    id: r.id, kind: r.kind, title: r.title, members,
    time: clockOf(r.updatedAt), pinned: r.pinned, muted: r.muted, unread: r.unread,
    ...(r.kind === 'group' ? { roles: { me: 'owner' as const } } : {}),
    ...(r.tempComputeSlots ? { tempCompute: { max: r.tempComputeSlots } } : {}),
    ...(leaving.length ? { leaving } : {}),
    messages: prev?.messages ?? [],
    ...((r.memberReads ?? prev?.reads) ? { reads: mergeReads(prev?.reads, r.memberReads, r.id, userId) } : {}),
    ...(r.pinnedSeqs?.length ? { pins: r.pinnedSeqs.map((s) => msgId(r.id, s)) } : {}),
    ...(prev?.notices ? { notices: prev.notices, loaded: prev.loaded } : {}),
  }
}

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
    if (list[0] && !list.some((c) => c.id === w.get().active)) w.get().setActive(list[0].id)
  },
  on: {
    'room.updated': (ev, w) => void addRoom(w, ev.room),
    'room.removed': (ev, w) => {
      lastAt.delete(ev.roomId)
      const { convs, active } = w.get()
      w.get().setConvs((cs) => cs.filter((c) => c.id !== ev.roomId))
      if (active === ev.roomId) {
        const next = convs.find((c) => c.id !== ev.roomId)
        w.set({ stack: [], tabs: [], ...(next ? { active: next.id } : {}) })
      }
    },
  },
})

const why = (e: { message: string }) => e.message

export async function openDmLive(w: WireCtx, contactId: PersonId) {
  const r = await w.call('rooms.openDm', { contactId })
  if (!r.ok) { w.get().toast(`没打开私聊：${why(r.error)}`); return }
  await addRoom(w, r.value)
  w.get().openConv(r.value.id)
}

const recentCreate = new Map<string, { id: string; at: number }>()
function createActionId(title: string, ids: PersonId[]) {
  const key = `${title}|${[...ids].sort().join(',')}`
  const now = Date.now()
  const hit = recentCreate.get(key)
  if (hit && now - hit.at < 10_000) return hit.id
  const id = actionId()
  recentCreate.set(key, { id, at: now })
  return id
}

export async function createGroupLive(w: WireCtx, title: string, ids: PersonId[], pool?: number) {
  const r = await w.call('rooms.createGroup', { clientActionId: createActionId(title, ids), title, members: ids.map((id) => ({ kind: 'contact' as const, id })) })
  if (!r.ok) { w.get().toast(`没建成群：${why(r.error)}`); return }
  await addRoom(w, r.value)
  w.get().openConv(r.value.id)
  if (!pool) return
  const u = await w.call('rooms.update', { roomId: r.value.id, tempComputeSlots: pool })
  if (u.ok) upsertRoom(w, u.value)
  else w.get().toast(`群临时算力没设上：${why(u.error)}`)
}

export async function addMembersLive(w: WireCtx, roomId: string, ids: PersonId[]) {
  const r = await w.call('rooms.addMembers', { roomId, members: ids.map((id) => ({ kind: 'contact' as const, id })) })
  if (!r.ok) { w.get().toast(`没拉进群：${why(r.error)}`); return }
  upsertRoom(w, r.value)
}

export function markReadLive(w: WireCtx, roomId: string, seq: number) {
  void w.call('rooms.markRead', { roomId, seq })
}

export async function updateRoomLive(w: WireCtx, roomId: string, patch: { title?: string; pinned?: boolean; muted?: boolean; tempComputeSlots?: number }, done?: string) {
  const r = await w.call('rooms.update', { roomId, ...patch })
  if (!r.ok) { w.get().toast(`没改成：${why(r.error)}`); return }
  upsertRoom(w, r.value)
  if (done) w.get().toast(done)
}

export const conflictTasks = (e: { code: string; detail?: unknown }): string[] | null => {
  const list = (e.detail as { tasks?: { title?: string }[] } | undefined)?.tasks
  return e.code === 'conflict' && Array.isArray(list) ? list.map((t) => t.title ?? '') : null
}

/** 移出成员(AC-49):有在途任务时后端拒绝并列出,交给界面问你要不要先停下;stopTasks 时先进「移出中」,停稳才真正移出 */
export async function removeMemberLive(w: WireCtx, roomId: string, id: PersonId, stopTasks: boolean): Promise<{ ok: true } | { ok: false; tasks: string[] }> {
  const r = await w.call('rooms.removeMember', { roomId, member: { kind: 'contact', id }, ...(stopTasks ? { stopTasks: true } : {}) })
  if (r.ok) {
    upsertRoom(w, r.value)
    const name = people[id]?.name ?? id
    w.get().toast((r.value.leavingMembers ?? []).some((m) => m.id === id) ? `${name} 在本群的事正在停下，停稳就移出群` : `已把 ${name} 移出群`)
    return { ok: true }
  }
  const tasks = conflictTasks(r.error)
  if (tasks && !stopTasks) return { ok: false, tasks }
  w.get().toast(`没移出：${why(r.error)}`)
  return { ok: true }
}

/** 解散群(U03):有在途任务时后端拒绝并列出,交给界面问你;stopTasks 时先停,停稳后群才移除(room.removed 事件) */
export async function dissolveLive(w: WireCtx, roomId: string, stopTasks: boolean): Promise<{ ok: true } | { ok: false; tasks: string[] }> {
  const title = w.get().convs.find((c) => c.id === roomId)?.title ?? ''
  const r = await w.call('rooms.dissolve', { roomId, ...(stopTasks ? { stopTasks: true } : {}) })
  if (r.ok) {
    w.get().toast(r.value.dissolved ? `已解散「${title}」，群里的定时也一起删了` : `正在停下「${title}」里在做的事，停稳就解散`)
    return { ok: true }
  }
  const tasks = conflictTasks(r.error)
  if (tasks && !stopTasks) return { ok: false, tasks }
  w.get().toast(`没解散：${why(r.error)}`)
  return { ok: true }
}

export async function pokeLive(w: WireCtx, roomId: string, id: PersonId) {
  const r = await w.call('messages.send', { roomId, clientActionId: actionId(), text: `拍了拍 @${people[id]?.name ?? id}`, mentions: [{ id, source: 'manual' }] })
  if (!r.ok) w.get().toast(`没拍到：${why(r.error)}`)
}
