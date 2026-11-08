/* ============ 模型配置：演示用的模型目录与全局默认，以及界面和 ui-core 之间的转换 ============
   形状对齐 @g-group/api-contract 的 SettingsView（defaultHarness / defaultSpeakingModel / defaultComputeModel / defaultEffort / models）
   和 ContactView 的 speakingModel / harness / computeModel。后端没接上时这里是演示数据（左下角标着「演示」）。
   「某个 Harness 支不支持某个模型」只看目录里每个模型声明的 harnesses（D07.4 规则 2：以适配器能力声明为准，不按厂商猜）。 */
import { EFFORTS, HARNESSES, type SettingsView } from '@g-group/api-contract'
import { findModel, type ContactModels, type Hop, type ModelSlot, type ModelSnapshot } from '@g-group/ui-core'
import { people, type Compute, type Person, type PersonId } from './data'

export type Harness = (typeof HARNESSES)[number]
export type Effort = (typeof EFFORTS)[number]
export type ModelSettings = Omit<SettingsView, 'timezone'>

export const HARNESS_LIST: readonly Harness[] = HARNESSES
export const EFFORT_LIST: readonly Effort[] = EFFORTS
export const HARNESS_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }
export const VENDOR_LABEL: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI', deepseek: 'DeepSeek', unknown: '来源未知' }
export const MODE_LABEL: Record<ModelSlot['mode'], string> = { inherit: '继承全局', 'follow-speaking': '跟随说话模型', explicit: '单独指定' }

export const INITIAL_MODEL_SETTINGS: ModelSettings = {
  defaultHarness: 'claude-code',
  defaultSpeakingModel: 'claude-sonnet-5-5',
  defaultComputeModel: 'claude-sonnet-5-5',
  defaultEffort: 'high',
  models: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', vendor: 'anthropic', harnesses: ['claude-code'] },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', vendor: 'anthropic', harnesses: ['claude-code', 'codex'] },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', vendor: 'anthropic', harnesses: ['claude-code', 'codex'] },
    { id: 'gpt-6.1', label: 'GPT-6.1', vendor: 'openai', harnesses: ['codex', 'claude-code'] },
    { id: 'gpt-6', label: 'GPT-6', vendor: 'openai', harnesses: ['codex'] },
    { id: 'gemini-4', label: 'Gemini 4', vendor: 'google', harnesses: ['claude-code', 'codex'] },
    { id: 'gemini-flash', label: 'Gemini Flash', vendor: 'google', harnesses: [] },
    { id: 'grok-5', label: 'Grok 5', vendor: 'xai', harnesses: ['claude-code'] },
    { id: 'deepseek-v4', label: 'DeepSeek V4', vendor: 'deepseek', harnesses: ['claude-code', 'codex'] },
  ],
}

export const harnessLabel = (h: string) => HARNESS_LABEL[h] ?? h
export const modelLabel = (id: string | undefined, s: ModelSettings) => (id ? findModel(id, s.models)?.label ?? id : '没填')
/** 下拉框里一行：名字 · 厂商 · 能在哪些 Harness 上跑 */
export const modelOption = (id: string, s: ModelSettings) => {
  const m = findModel(id, s.models)
  if (!m) return id
  const where = m.harnesses.length ? m.harnesses.map(harnessLabel).join(' / ') : '只能用来说话'
  return `${m.label} · ${VENDOR_LABEL[m.vendor] ?? m.vendor} · ${where}`
}

/** 有模型配置的联系人：助手（不含真人和 Helper） */
export const modelContacts = (): Person[] => Object.values(people).filter((p) => !p.human && p.computeModel && p.harness)

export const toContactModels = (p: Person): ContactModels => ({
  id: p.id,
  name: p.name,
  speakingModel: p.model ?? '',
  harness: p.harness ?? 'claude-code',
  computeModel: p.computeModel ?? { mode: 'inherit' },
})

/** 继承链上的一跳翻成人话 */
const SETTING_LABEL: Record<string, string> = {
  speakingModel: '说话模型', harness: 'Compute Harness', 'computeModel.model': '单独指定的模型', 'computeModel.effort': 'effort',
  defaultComputeModel: 'Compute 模型', defaultEffort: 'effort', model: '模型', effort: 'effort',
}
const LAYER_LABEL: Record<Hop['layer'], string> = { task: '本次任务', contact: '联系人', global: '全局默认' }
/** 一跳拆成「来自哪里」和「取值」：槽位模式这一跳只有说明（继承全局 / 跟随说话模型 / 单独指定），没有具体值 */
export function hopParts(h: Hop): { where: string; value?: string } {
  if (h.setting === 'computeModel.mode') return { where: MODE_LABEL[h.value as ModelSlot['mode']] ?? h.value }
  if (h.setting === 'computeModel.effort' && h.value === 'inherit') return { where: '联系人没单独设' }
  const s = SETTING_LABEL[h.setting] ?? h.setting
  return { where: `${LAYER_LABEL[h.layer]}${/^[A-Za-z]/.test(s) ? ' ' : ''}${s}`, value: h.value || '（没填）' }
}

/** 演示数据里 Compute 记的是展示名（「Claude Opus 5.5」「Claude Code」），按目录换回 id 当作任务的启动快照 */
export function snapshotOfCompute(c: Compute, s: ModelSettings): ModelSnapshot {
  const m = s.models.find((x) => x.label === c.model || x.id === c.model)
  const h = Object.entries(HARNESS_LABEL).find(([, l]) => l === c.harness)?.[0] ?? c.harness
  return { harness: h, model: m?.id ?? c.model, effort: '', vendor: m?.vendor ?? 'unknown' }
}
export const liveComputes = (computes: Record<string, Compute>, owner?: PersonId) =>
  Object.values(computes).filter((c) => (owner === undefined || c.owner === owner) && (c.status === 'running' || c.status === 'waiting'))
