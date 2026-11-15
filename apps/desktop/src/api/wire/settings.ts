// 模型设置接线:settings.get 全量读 → 模型切片(全局默认 + 模型目录)。合同里没有设置的事件:写完以回包为准,批量替换后重读一遍。
// 写(界面都先展示过影响,所以带 confirmAffected):联系人的模型字段 → contacts.update;全局默认 → settings.update;
// 把 X 批量换成 Y → models.batchReplace {apply:true}。失败就提示原因、返回 false,界面不标「已保存」。
import { EFFORTS, HARNESSES, type ParamsOf, type SettingsView } from '@g-group/api-contract'
import { people, type Person, type PersonId } from '@/data'
import { liveCatalog, usedModels, type ModelSettings } from '@/modelConfig'
import { toPerson } from './contacts'
import { actionId, defineWiring, read, type WireCtx } from './types'

type Harness = (typeof HARNESSES)[number]
type Effort = (typeof EFFORTS)[number]
const asHarness = (h: string | undefined): Harness | undefined => (HARNESSES as readonly string[]).includes(h ?? '') ? (h as Harness) : undefined
const asEffort = (e: string | undefined): Effort | undefined => (EFFORTS as readonly string[]).includes(e ?? '') ? (e as Effort) : undefined

/** 合同的设置 → 界面的模型配置(时区不归这里管) */
export const toModelSettings = ({ timezone: _tz, ...s }: SettingsView): ModelSettings => liveCatalog(s, usedModels())

export const settingsWiring = defineWiring({
  entity: '模型设置',
  load: async (w) => { w.get().setModelSettings(toModelSettings(await read(w, 'settings.get', {}))) },
  on: {},
})

type ContactUpdate = Omit<ParamsOf<'contacts.update'>, 'contactId'>

/** 界面联系人字段里跟模型有关的那几项 → contacts.update 的参数(只带给了的) */
export function modelParams(p: Partial<Person>): ContactUpdate {
  const harness = asHarness(p.harness)
  const slot = p.computeModel
  const effort = asEffort(slot?.effort)
  return {
    ...(p.model !== undefined ? { speakingModel: p.model } : {}),
    ...(harness ? { harness } : {}),
    ...(slot ? { computeModel: { mode: slot.mode, ...(slot.mode === 'explicit' && slot.model ? { model: slot.model } : {}), ...(effort ? { effort } : {}) } } : {}),
    ...(p.computeQuota !== undefined ? { computeSlots: p.computeQuota } : {}),
  }
}

/** 全局默认里能写的四项(模型目录不在这里改) */
function settingsParams(s: Partial<ModelSettings>): ParamsOf<'settings.update'> {
  const harness = asHarness(s.defaultHarness)
  const effort = asEffort(s.defaultEffort)
  return {
    ...(harness ? { defaultHarness: harness } : {}),
    ...(s.defaultSpeakingModel ? { defaultSpeakingModel: s.defaultSpeakingModel } : {}),
    ...(s.defaultComputeModel ? { defaultComputeModel: s.defaultComputeModel } : {}),
    ...(effort ? { defaultEffort: effort } : {}),
  }
}

/** 重读一遍设置(批量替换会改全局默认,合同里没有设置的事件) */
async function reloadSettings(w: WireCtx) {
  const r = await w.call('settings.get', {})
  if (r.ok) w.get().setModelSettings(toModelSettings(r.value))
}

/**
 * 一次模型写入。batch 给了:先整批交给 models.batchReplace(后端只改全局默认和直接写了 X 的联系人),
 * contacts / settings 里只放后端那一步不会做的(界面上处理冲突时选的「保持原模型 / 换 Harness」),批量之后再写。
 * 联系人逐位写,写好的立刻按回包更新;任何一步被拒就停下并提示,返回 false。
 */
export async function saveModelsLive(w: WireCtx, s: { settings?: Partial<ModelSettings>; contacts?: { id: PersonId; patch: Partial<Person> }[]; batch?: { from: string; to: string } }): Promise<boolean> {
  const fail = (what: string, msg: string) => { w.get().toast(`${what}没保存上：${msg}`); return false }
  if (s.batch) {
    const r = await w.call('models.batchReplace', { clientActionId: actionId(), from: s.batch.from, to: s.batch.to, apply: true, confirmAffected: true })
    if (!r.ok) return fail(`把 ${s.batch.from} 换成 ${s.batch.to} `, r.error.message)
    await reloadSettings(w)
    if (!r.value.applied) return fail(`把 ${s.batch.from} 换成 ${s.batch.to} `, '后端没有应用')
  }
  for (const c of s.contacts ?? []) {
    const params = modelParams(c.patch)
    if (!Object.keys(params).length) continue
    const r = await w.call('contacts.update', { contactId: c.id, ...params, confirmAffected: true })
    if (!r.ok) return fail(`${people[c.id]?.name ?? '联系人'} 的模型设置`, r.error.message)
    w.get().upsertContact(toPerson(r.value))
  }
  const sp = s.settings ? settingsParams(s.settings) : {}
  if (Object.keys(sp).length) {
    const r = await w.call('settings.update', { ...sp, confirmAffected: true })
    if (!r.ok) return fail('全局默认', r.error.message)
    w.get().setModelSettings(toModelSettings(r.value))
  }
  return true
}
