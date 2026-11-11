// 已读位置的先后比较(AC-46):连上后端时消息 id 是「会话#序号」,已读位置按序号比——
// 宿主推到的位置可能落在编辑/撤回事件、你删掉的或还没读进来的消息上,不在列表里也照样能比;演示数据按列表里的先后比。
import { seqOf } from '@/api/wire/messages'

/** 一个会话里消息 id 的先后:有序号用序号,没有就用在列表里的位置 */
export function rankIn(ids: readonly string[]): (id: string) => number {
  const at = new Map(ids.map((id, i) => [id, i]))
  return (id) => seqOf(id) ?? at.get(id) ?? -1
}
