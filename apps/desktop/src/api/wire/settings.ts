// 模型设置接线：真实后端读回设置，写入走 settings.update / contacts.update。
import { EFFORTS, HARNESSES, type ParamsOf, type SettingsView } from '@g-group/api-contract'
import { people, type Person, type PersonId } from '@/data'
import type { ModelSettings } from '@/modelConfig'
import { shellCall } from '../app-shell'
import { toPerson } from './contacts'
import { defineWiring, read, type WireCtx } from './types'

type Harness = (typeof HARNESSES)[number]
type Effort = (typeof EFFORTS)[number]
const asHarness = (v: string | undefined): Harness | undefined => (HARNESSES as readonly string[]).includes(v ?? '') ? v as Harness : undefined
const asEffort = (v: string | undefined): Effort | undefined => (EFFORTS as readonly string[]).includes(v ?? '') ? v as Effort : undefined
export const toModelSettings = ({ timezone: _timezone, ...s }: SettingsView): ModelSettings => ({ ...s })

function retainCurrent(s: ModelSettings): ModelSettings {
  const models = new Map(s.models.map((m) => [m.id, m]))
  const current = [s.defaultSpeakingModel, s.defaultComputeModel, ...Object.values(people).flatMap((p) => [p.model, p.computeModel?.mode === 'explicit' ? p.computeModel.model : undefined])]
  for (const id of current) if (id && !models.has(id)) models.set(id, { id, label: id, vendor: 'unknown', harnesses: [] })
  return { ...s, models: [...models.values()] }
}

export async function loadModelCatalog(w: WireCtx, view?: SettingsView) {
  const s = toModelSettings(view ?? await read(w, 'settings.get', {}))
  const computeCapabilities = s.models.some((m) => m.harnesses.length > 0)
  // 先撤下演示目录，读取期间也要显示真实生效值。
  w.get().setModelSettings(retainCurrent({ ...s, catalog: { state: 'error', reason: '模型目录正在读取…', computeCapabilities } }))
  const setup = await shellCall('setup.get', {})
  const gateway = setup.ok ? setup.value.gateway : null
  const r = gateway ? await shellCall('setup.models', { baseUrl: gateway.baseUrl }) : null
  if (!r?.ok || !r.value.models.length) {
    const reason = r && !r.ok ? r.error : gateway ? '网关返回了空模型目录' : '尚未接入模型网关'
    w.get().setModelSettings(retainCurrent({ ...s, catalog: { state: 'error', reason: `模型目录不可用：${reason}。请到「模型接入」检查地址和令牌，再重试。`, computeCapabilities } }))
    return
  }
  const known = new Map(s.models.map((m) => [m.id, m]))
  // 网关 /models 只声明模型存在，不伪造它支持哪个 Compute Harness。
  const models = r.value.models.map((m) => ({ ...m, vendor: known.get(m.id)?.vendor ?? 'unknown', harnesses: known.get(m.id)?.harnesses ?? [] }))
  w.get().setModelSettings(retainCurrent({ ...s, models, catalog: { state: 'ready', computeCapabilities } }))
}

export const settingsWiring = defineWiring({
  entity: '模型设置',
  load: loadModelCatalog,
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
    const current = w.get().modelSettings
    w.get().setModelSettings(retainCurrent({ ...toModelSettings(r.value), models: current.models, catalog: current.catalog }))
  }
  return true
}
