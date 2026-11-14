// 群模板(复制团队)接线:
//   读——第 2 步每位联系人的预设(contacts.profile 的 persona,只读展示);群规直接用公告接线写在会话上的 conv.notices。
//   写——「创建新群」= rooms.createGroup 建群 + 逐条 announcements.add 把选中的公告按原来的先后发布过去,都以后端回包为准:
//        群没建成就提示原因、什么都不变;群建好了但有公告没带过去,如实说有几条、为什么。
// 协作手册合同里没有(用户定以后再定),不带。
import type { PersonId } from '@/data'
import { loadNotices } from './notices'
import { createGroupLive } from './rooms'
import { actionId, type WireCtx } from './types'

/** 一位联系人的预设读到哪一步了 */
export type Persona = { state: 'ok'; text: string } | { state: 'error'; reason: string }

/** 读一位联系人的预设(人设原文) */
export async function personaLive(w: WireCtx, contactId: PersonId): Promise<Persona> {
  const r = await w.call('contacts.profile', { contactId })
  return r.ok ? { state: 'ok', text: r.value.persona } : { state: 'error', reason: r.error.message }
}

/** 建新群(建好切过去)并把选中的公告逐条发布过去。返回新群 id;群没建成返回 null(已提示) */
export async function cloneGroupLive(w: WireCtx, title: string, ids: PersonId[], notices: string[]): Promise<string | null> {
  const roomId = await createGroupLive(w, title, ids)
  if (!roomId) return null
  let failed = 0
  let reason = ''
  for (const text of notices) {
    const r = await w.call('announcements.add', { roomId, clientActionId: actionId(), text })
    if (!r.ok) { failed += 1; if (!reason) reason = r.error.message }
  }
  /* 新群的公告以后端读回来的为准 */
  await loadNotices(w, roomId).catch(() => undefined)
  const done = notices.length - failed
  w.get().toast(failed ? `新群建好了，但 ${notices.length} 条公告里有 ${failed} 条没带过去：${reason}` : done ? `新群建好了，带过去 ${done} 条公告` : '新群建好了')
  return roomId
}
