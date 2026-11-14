// 模型设置接线：真实后端读回设置，写入走 settings.update / contacts.update。
import { EFFORTS, HARNESSES, type ParamsOf, type SettingsView } from '@g-group/api-contract'
import type { Person, PersonId } from '@/data'
import { INITIAL_MODEL_SETTINGS, type ModelSettings } from '@/modelConfig'
import { toPerson } from './contacts'
import { defineWiring, read, type WireCtx } from './types'

type Harness = (typeof HARNESSES)[number]
type Effort = (typeof EFFORTS)[number]
const asHarness = (v: string | undefined): Harness | undefined => (HARNESSES as readonly string[]).includes(v ?? '') ? v as Harness : undefined
const asEffort = (v: string | undefined): Effort | undefined => (EFFORTS as readonly string[]).includes(v ?? '') ? v as Effort : undefined
export const toModelSettings = ({ timezone: _timezone, ...s }: SettingsView): ModelSettings => ({ ...s, models: s.models.length ? s.models : INITIAL_MODEL_SETTINGS.models })

export const settingsWiring = defineWiring({
  entity: '模型设置',
  load: async (w) => { w.get().setModelSettings(toModelSettings(await read(w, 'settings.get', {}))) },
  on: {},
})

function contactParams(p: Partial<Person>): Omit<ParamsOf<'contacts.update'>, 'contactId'> {
  const h = asHarness(p.harness)
  const slot = p.computeModel
  const effort = asEffort(slot?.effort)
  return { ...(p.model !== undefined ? { speakingModel: p.model } : {}), ...(h ? { harness: h } : {}), ...(slot ? { computeModel: { mode: slot.mode, ...(slot.mode === 'explicit' && slot.model ? { model: slot.model } : {}), ...(effort ? { effort } : {}) } } : {}), ...(p.computeQuota !== undefined ? { computeSlots: p.computeQuota } : {}) }
}

function settingsParams(s: Partial<ModelSettings>): ParamsOf<'settings.update'> {
  const h = asHarness(s.defaultHarness); const e = asEffort(s.defaultEffort)
  return { ...(h ? { defaultHarness: h } : {}), ...(s.defaultSpeakingModel ? { defaultSpeakingModel: s.defaultSpeakingModel } : {}), ...(s.defaultComputeModel ? { defaultComputeModel: s.defaultComputeModel } : {}), ...(e ? { defaultEffort: e } : {}) }
}

export async function saveModelsLive(w: WireCtx, s: { settings?: Partial<ModelSettings>; contacts?: { id: PersonId; patch: Partial<Person> }[] }): Promise<boolean> {
  const fail = (what: string, msg: string) => { w.get().toast(`${what}没保存上：${msg}`); return false }
  for (const c of s.contacts ?? []) {
    const patch = contactParams(c.patch)
    if (!Object.keys(patch).length) continue
    const r = await w.call('contacts.update', { contactId: c.id, ...patch, confirmAffected: true })
    if (!r.ok) return fail(`${c.id} 的模型设置`, r.error.message)
    w.get().upsertContact(toPerson(r.value))
  }
  const patch = settingsParams(s.settings ?? {})
  if (Object.keys(patch).length) {
    const r = await w.call('settings.update', { ...patch, confirmAffected: true })
    if (!r.ok) return fail('全局默认', r.error.message)
    w.get().setModelSettings(toModelSettings(r.value))
  }
  return true
}
