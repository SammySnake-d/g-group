// 联系人工作台接线:改职责(bio)、预设(persona)、能用的技能和工具(computeAssets)、Compute 个数(computeSlots)走 contacts.update,
// 以回包和 contact.updated 为准;预设读 contacts.profile;「完整过程」读这位联系人的运行台账 runs.list(只读)。
// 合同里没有的(按群分工、卡死判定单独设、性格、记忆)这里不写,界面在连着后端时如实关着。
import type { CapabilityLibraryView, ContactView, ParamsOf, RunView } from '@g-group/api-contract'
import type { Person, PersonId } from '@/data'
import { call } from '../backend'
import { toPerson } from './contacts'
import { modelParams } from './settings'
import { defineWiring, type WireCtx } from './types'

export type ComputeAsset = ContactView['computeAssets'][number]
/** 工作台改联系人的一处:界面字段 + 合同里才有的预设、能力清单 */
export type PersonPatch = Partial<Person> & { persona?: string; computeAssets?: ComputeAsset[] }

/** 合同里能存的那几项 → contacts.update 的参数;给的全是合同里没有的项时为空 */
function personParams(p: PersonPatch): Omit<ParamsOf<'contacts.update'>, 'contactId'> {
  const models = modelParams(p)
  const touchesModel = 'speakingModel' in models || 'harness' in models || 'computeModel' in models
  return {
    ...(p.role !== undefined ? { bio: p.role } : {}),
    ...(p.persona !== undefined ? { persona: p.persona } : {}),
    ...(p.computeAssets ? { computeAssets: p.computeAssets } : {}),
    ...models,
    ...(touchesModel ? { confirmAffected: true } : {}),
  }
}

/** 改联系人设置:成功按回包更新联系人、提示「已保存」;被拒提示原因、返回 false(界面据此回到原值) */
export async function updatePersonLive(w: WireCtx, id: PersonId, patch: PersonPatch): Promise<boolean> {
  const params = personParams(patch)
  if (!Object.keys(params).length) { w.get().toast('没有改动：这一项合同里没有，存不进后端'); return false }
  const r = await w.call('contacts.update', { contactId: id, ...params })
  if (!r.ok) { w.get().toast(`没保存上：${r.error.message}`); return false }
  w.get().upsertContact(toPerson(r.value))
  w.get().toast('已保存')
  return true
}

type Read<T> = { ok: true; value: T } | { ok: false; message: string }
const wrap = async <T,>(p: Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>): Promise<Read<T>> => {
  const r = await p
  return r.ok ? { ok: true, value: r.value } : { ok: false, message: r.error.message }
}

/** 预设原文(contacts.profile 的 persona) */
export const personaLive = async (id: PersonId): Promise<Read<string>> => {
  const r = await wrap(call('contacts.profile', { contactId: id }))
  return r.ok ? { ok: true, value: r.value.persona } : r
}
/** 联系人现在勾着的能力(带 kind,写回时原样保留 script 类) */
export const assetsLive = async (id: PersonId): Promise<Read<ComputeAsset[]>> => {
  const r = await wrap(call('contacts.get', { contactId: id }))
  return r.ok ? { ok: true, value: r.value.computeAssets } : r
}
/** 全局能力库:可勾选的 skill 与 MCP */
export const libraryLive = (): Promise<Read<CapabilityLibraryView>> => wrap(call('capabilities.list', {}))
/** 这位联系人的运行台账;从某个群打开时只看这个群 */
export const runsLive = async (id: PersonId, roomId?: string): Promise<Read<RunView[]>> => {
  const r = await wrap(call('runs.list', { contactId: id, ...(roomId ? { roomId } : {}), limit: 200 }))
  return r.ok ? { ok: true, value: r.value.runs } : r
}

/* run.updated:工作台「完整过程」开着时据此重读(只通知,不存状态) */
const runListeners = new Set<(r: RunView) => void>()
export function onRunUpdated(fn: (r: RunView) => void): () => void {
  runListeners.add(fn)
  return () => { runListeners.delete(fn) }
}

export const processWiring = defineWiring({
  entity: '联系人运行台账',
  load: async () => {},
  on: { 'run.updated': (ev) => { for (const fn of runListeners) fn(ev.run) } },
})
