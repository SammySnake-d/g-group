// 已读位置的先后比较(AC-46):连上后端时消息 id 是「会话#序号」,已读位置按序号比——
import { seqOf } from '@/api/wire/messages'

export function rankIn(ids: readonly string[]): (id: string) => number {
  const at = new Map(ids.map((id, i) => [id, i]))
  return (id) => seqOf(id) ?? at.get(id) ?? -1
}
