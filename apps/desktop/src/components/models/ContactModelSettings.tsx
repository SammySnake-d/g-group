/* ============ 联系人工作台 · 设置 · 模型(D07.4 规则 1/2/5、U93、U92;验收 R-17、AC-32) ============
   全软件只在两处改模型:这里和设置页「默认」一节。判定全部来自 @g-group/ui-core 的纯函数:生效值和继承链、同一个兼容判定。
   不兼容一律阻断并给两条修复路径,界面上没有任何「自动换一个能用的」分支。 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { applyFix, checkStall, gateCompute, nextTurn, resolveCompute, resolveSpeaking, type Fix, type ModelSlot, type NextTurn } from '@g-group/ui-core'
import { people, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { collapse } from '@/config/motion'
import { Slider } from '@/components/ui/slider'
import { Field, NativeSelect } from '@/components/ui/field'
import { EFFORT_LIST, HARNESS_LIST, VENDOR_LABEL, harnessLabel, liveComputes, modelLabel, modelOption } from '@/modelConfig'
import { CM } from './constants'
import { asContact, changeNote, cleanSlot, fromPerson, sameDraft, type Draft } from './logic'
import { ComputeModeList } from './ComputeModeList'
import { EffectivePanel } from './EffectivePanel'
import { MismatchFix } from './MismatchFix'
import { StallSettings } from './StallSettings'
import { SaveBar } from './SaveBar'

const W = 'w-[230px]'

export function ContactModelSettings({ id }: { id: PersonId }) {
  const { modelSettings: s, modelsRev, saveModels, computes } = useApp()
  const p = people[id]
  const [base, setBase] = useState<Draft>(() => fromPerson(p))
  const [draft, setDraft] = useState<Draft>(base)
  const [notice, setNotice] = useState<NextTurn | null>(null)
  const [adv, setAdv] = useState(!!p.stall)
  /* 别处（全局默认、批量替换）保存过：没改动就跟上新值 */
  useEffect(() => {
    const cur = fromPerson(people[id])
    if (!sameDraft(cur, base)) { setBase(cur); setDraft(cur) }
  }, [modelsRev, id]) // 只在保存过或换了联系人时对一次，不跟着 base 自己变

  const cm = asContact(id, draft)
  const gate = gateCompute('save', cm, s)
  const compute = gate.compute
  const dirty = !sameDraft(draft, base)
  const stallErr = draft.stall ? checkStall(draft.stall) : null
  const canSave = dirty && gate.allowed && !stallErr
  const running = liveComputes(computes, id)
  const set = (patch: Partial<Draft>) => { setDraft((d) => ({ ...d, ...patch })); setNotice(null) }
  const setSlot = (mode: ModelSlot['mode'], model?: string) => set({ computeModel: cleanSlot(mode, model, draft.computeModel.effort) })
  const fix = (f: Fix) => { const c = applyFix(cm, f); set({ harness: c.harness, computeModel: c.computeModel }) }
  const save = () => {
    if (!canSave) return
    const nt = nextTurn(asContact(id, base), cm, s, running.length)
    const note = changeNote(base, draft, s) + (nt ? '，下一轮生效' : '')
    saveModels({ contacts: [{ id, patch: { model: draft.speakingModel, harness: draft.harness, computeModel: draft.computeModel, computeQuota: draft.quota, stall: draft.stall ?? undefined }, note }] })
    setBase(draft)
    setNotice(nt)
  }
  const prevModel = resolveCompute(asContact(id, base), s).model.value
  const modeHint: Record<ModelSlot['mode'], string> = {
    inherit: `用全局默认 Compute 模型，现在是 ${modelLabel(s.defaultComputeModel, s)}`,
    'follow-speaking': `和说话模型一样，现在是 ${modelLabel(draft.speakingModel, s)}`,
    explicit: '另选一个具体模型',
  }

  return (
    <section data-testid="cm-card" className="rounded-xl bg-hover/60 p-4">
      <div className="mb-3 flex items-baseline gap-2">
        <h3 className="flex-1 text-[13px] font-semibold text-fg">{CM.title}</h3>
        <span className="text-[11.5px] text-fg-3">{CM.where}</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* ---- 左：配置 ---- */}
        <div className="min-w-0 space-y-3">
          <Field layout="inline" label={CM.talk} hint={CM.talkHint}>
            <NativeSelect aria-label={CM.talk} data-testid="cm-talk" value={draft.speakingModel} onChange={(e) => set({ speakingModel: e.target.value })} className={W}>
              {s.models.map((m) => <option key={m.id} value={m.id}>{m.label} · {VENDOR_LABEL[m.vendor] ?? m.vendor}</option>)}
            </NativeSelect>
          </Field>
          <div className="border-t border-line pt-3">
            <div className="mb-2 text-[12px] font-medium text-fg-3">{CM.compute}</div>
            <div className="space-y-2.5">
              <Field layout="inline" label={CM.harness}>
                <NativeSelect aria-label="Compute Harness" data-testid="cm-harness" value={draft.harness} onChange={(e) => set({ harness: e.target.value })} className={W}>
                  {HARNESS_LIST.map((h) => <option key={h} value={h}>{harnessLabel(h)}</option>)}
                </NativeSelect>
              </Field>
              <div>
                <div className="mb-1.5 text-[13.5px]">{CM.model}</div>
                <ComputeModeList value={draft.computeModel.mode} hints={modeHint}
                  onPick={(m) => setSlot(m, m === 'explicit' ? compute.model.value || s.defaultComputeModel : undefined)} />
                {draft.computeModel.mode === 'explicit' && (
                  <Field layout="inline" label={CM.explicitModel} hint={CM.explicitHint} className="mt-2">
                    <NativeSelect aria-label="单独指定的 Compute 模型" data-testid="cm-model" value={draft.computeModel.model ?? ''} onChange={(e) => setSlot('explicit', e.target.value)} invalid={!gate.allowed} className={W}>
                      {s.models.map((m) => <option key={m.id} value={m.id}>{modelOption(m.id, s)}</option>)}
                    </NativeSelect>
                  </Field>
                )}
              </div>
              <Field layout="inline" label={CM.effort} hint={CM.effortHint}>
                <NativeSelect aria-label="Compute effort" data-testid="cm-effort" value={draft.computeModel.effort ?? ''} onChange={(e) => set({ computeModel: cleanSlot(draft.computeModel.mode, draft.computeModel.model, e.target.value || undefined) })} className={W}>
                  <option value="">跟全局（{s.defaultEffort}）</option>
                  {EFFORT_LIST.map((e) => <option key={e} value={e}>{e}</option>)}
                </NativeSelect>
              </Field>
              <Field layout="inline" group label={<>最多同时分几个 Compute · <span className="tabular-nums">{draft.quota}</span> 个</>} data-testid="cm-quota">
                <div className={`${W} px-1`}><Slider value={[draft.quota]} min={1} max={5} step={1} onValueChange={(v) => set({ quota: v[0] })} /></div>
              </Field>
            </div>
          </div>
          {gate.mismatch && (
            <MismatchFix testid="cm-mismatch" m={gate.mismatch} s={s} prefer={prevModel}
              onPin={(model) => fix({ kind: 'pin-model', contactId: id, model })} onHarness={(h) => fix({ kind: 'switch-harness', contactId: id, harness: h })} />
          )}
        </div>

        {/* ---- 右：生效值与继承链 ---- */}
        <EffectivePanel name={p.name} cm={cm} s={s} speaking={resolveSpeaking(cm)} compute={compute} allowed={gate.allowed} dirty={dirty} running={running} />
      </div>

      <StallSettings name={p.name} stall={draft.stall} error={stallErr} open={adv} onOpenChange={setAdv} onChange={(v) => set({ stall: v })} />

      <AnimatePresence initial={false}>
        {(dirty || notice) && (
          <motion.div key="save" {...collapse} className="overflow-hidden">
            <SaveBar dirty={dirty} allowed={gate.allowed} stallErr={!!stallErr} canSave={canSave} notice={notice} s={s} cm={cm} name={p.name}
              running={running.map((c) => `${c.model} · ${c.harness}`)} onRevert={() => { setDraft(base); setNotice(null) }} onSave={save} />
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
