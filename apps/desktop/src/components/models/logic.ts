/* 模型配置界面的纯逻辑:草稿、比较、变更说明、补丁。判定本身全在 @g-group/ui-core,这里只做界面和它之间的换算。 */
import { resolveStall, type Change, type ContactModels, type Fix, type Mismatch, type ModelSlot, type StallOverride } from '@g-group/ui-core'
import { people, type Person, type PersonId } from '@/data'
import { MODE_LABEL, harnessLabel, modelLabel, type ModelSettings } from '@/modelConfig'
import { REF_LABEL } from './constants'

/** 失配的一句话 */
export const mismatchText = (m: Mismatch, s: ModelSettings) =>
  m.reason === 'unknown-model' ? (m.model ? `模型目录里没有「${m.model}」` : '还没选模型')
  : `${harnessLabel(m.harness)} 这个 Harness 跑不了 ${modelLabel(m.model, s)}`

export const fixLabel = (f: Fix, s: ModelSettings) => (f.kind === 'pin-model' ? `单独指定 ${modelLabel(f.model, s)}` : `换 Harness 为 ${harnessLabel(f.harness)}`)

export const slotText = (slot: ModelSlot) => (slot.mode === 'explicit' ? `单独指定 ${slot.model ?? '（没填）'}` : MODE_LABEL[slot.mode])
export const sameSlot = (a: ModelSlot, b: ModelSlot) => a.mode === b.mode && (a.mode !== 'explicit' || a.model === b.model) && a.effort === b.effort
export const cleanSlot = (mode: ModelSlot['mode'], model: string | undefined, effort: string | undefined): ModelSlot =>
  ({ mode, ...(mode === 'explicit' && model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) })

/* ---------------------------------------------------------------- 联系人草稿 */

export interface Draft { speakingModel: string; harness: string; computeModel: ModelSlot; quota: number; stall: StallOverride | null }
export const fromPerson = (p: Person): Draft => ({ speakingModel: p.model ?? '', harness: p.harness ?? 'claude-code', computeModel: p.computeModel ?? { mode: 'inherit' }, quota: p.computeQuota ?? 1, stall: p.stall ?? null })
export const sameStall = (a: StallOverride | null, b: StallOverride | null) => (a === null || b === null ? a === b : a.turnMinutes === b.turnMinutes && a.firstByteSeconds === b.firstByteSeconds)
export const sameDraft = (a: Draft, b: Draft) => a.speakingModel === b.speakingModel && a.harness === b.harness && sameSlot(a.computeModel, b.computeModel) && a.quota === b.quota && sameStall(a.stall, b.stall)
export const asContact = (id: PersonId, d: Draft): ContactModels => ({ id, name: people[id]?.name ?? id, speakingModel: d.speakingModel, harness: d.harness, computeModel: d.computeModel })

/** 保存时写进私聊记录的变更说明 */
export function changeNote(b: Draft, a: Draft, s: ModelSettings): string {
  const out: string[] = []
  if (b.speakingModel !== a.speakingModel) out.push(`说话模型 ${b.speakingModel} → ${a.speakingModel}`)
  if (b.harness !== a.harness) out.push(`Compute Harness ${harnessLabel(b.harness)} → ${harnessLabel(a.harness)}`)
  if (b.computeModel.mode !== a.computeModel.mode || (a.computeModel.mode === 'explicit' && b.computeModel.model !== a.computeModel.model)) out.push(`Compute 模型 ${slotText(b.computeModel)} → ${slotText(a.computeModel)}`)
  if (b.computeModel.effort !== a.computeModel.effort) out.push(`effort ${b.computeModel.effort ?? `跟全局（${s.defaultEffort}）`} → ${a.computeModel.effort ?? `跟全局（${s.defaultEffort}）`}`)
  if (b.quota !== a.quota) out.push(`最多同时 ${a.quota} 个 Compute`)
  if (!sameStall(b.stall, a.stall)) { const r = resolveStall(a.stall ?? undefined); out.push(`卡死判定 ${r.turnMinutes.value} 分钟 / 首字节 ${r.firstByteSeconds.value} 秒${a.stall ? '（单独设）' : '（默认）'}`) }
  return out.join('；')
}

/* ---------------------------------------------------------------- 批量替换 */

/** 把确认后的变更落成「全局默认补丁 + 每位联系人的补丁」 */
export function toPatches(changes: readonly Change[], contacts: readonly ContactModels[]) {
  const settings: Partial<ModelSettings> = {}
  const byContact = new Map<string, ContactModels>()
  const notes = new Map<string, string[]>()
  for (const ch of changes) {
    if (ch.contactId === null) { (settings as Record<string, string>)[ch.field] = ch.to; continue }
    const cur = byContact.get(ch.contactId) ?? contacts.find((c) => c.id === ch.contactId)!
    let next: ContactModels = cur
    if (ch.field === 'speakingModel') next = { ...cur, speakingModel: ch.to }
    else if (ch.field === 'harness') next = { ...cur, harness: ch.to }
    else {
      const slot = { ...cur.computeModel } as { mode: ModelSlot['mode']; model?: string; effort?: string }
      if (ch.field === 'computeModel.mode') slot.mode = ch.to as ModelSlot['mode']
      if (ch.field === 'computeModel.model') { if (ch.to) slot.model = ch.to; else delete slot.model }
      if (ch.field === 'computeModel.effort') { if (ch.to) slot.effort = ch.to; else delete slot.effort }
      next = { ...cur, computeModel: slot }
    }
    byContact.set(ch.contactId, next)
    notes.set(ch.contactId, [...(notes.get(ch.contactId) ?? []), `${REF_LABEL[ch.field] ?? (ch.field === 'harness' ? 'Compute Harness' : ch.field)} ${ch.from || '（空）'} → ${ch.to || '（空）'}`])
  }
  return { settings, contacts: [...byContact.values()].map((c) => ({ c, note: (notes.get(c.id) ?? []).join('；') })) }
}
