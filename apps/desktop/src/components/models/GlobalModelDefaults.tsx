import { TextInput } from '@astryxdesign/core/TextInput'
/* ============ 设置页 ·「默认」一节(D07.4 规则 1/2/6;验收 AC-51) ============
   改全局默认先预检影响:会动到哪几位联系人、哪些会失配;失配修好才能保存,不会自动换成别的模型。 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowRightLeft, Check, ChevronRight } from 'lucide-react'
import { planDefaults, type Fix } from '@g-group/ui-core'
import { useApp } from '@/ctx'
import { live } from '@/api/wire/live'
import { collapse, rise } from '@/config/motion'
import { Button } from '@/components/ui/button'
import { Field, NativeSelect } from '@/components/ui/field'
import { EFFORT_LIST, HARNESS_LIST, harnessLabel, liveCatalog, modelContacts, toContactModels, usedModels, whereRuns, type ModelSettings } from '@/modelConfig'
import { DEFAULTS, DEFAULT_FIELDS, DEFAULT_FIELD_LABEL, type DefaultField } from './constants'
import { fixLabel } from './logic'
import { DefaultsImpact } from './DefaultsImpact'
import { ModelOverview } from './ModelOverview'
import { BatchReplace } from './BatchReplace'
import { FieldSwitch } from './FieldSwitch'

const ROW = 'flex min-h-11 flex-col justify-center px-4 py-1.5'
const SEL = 'w-[168px]'
const OTHER = '__other__'

export function GlobalModelDefaults() {
  const { modelSettings: s, modelsRev, saveModels, isLive } = useApp((st) => ({ modelSettings: st.modelSettings, modelsRev: st.modelsRev, saveModels: st.saveModels, isLive: live(st) }))
  const [draft, setDraft] = useState<ModelSettings>(s)
  const [fixes, setFixes] = useState<Fix[]>([])
  const [savedN, setSavedN] = useState<number | null>(null)
  const [batch, setBatch] = useState(false)
  const [otherCompute, setOtherCompute] = useState(false)
  const [saving, setSaving] = useState(false)
  const impactRef = useRef<HTMLDivElement>(null)
  useEffect(() => { setDraft(s); setFixes([]) }, [modelsRev]) // 任何一处保存过都从新的全局默认重新开始

  const contacts = modelContacts().map(toContactModels)
  const effective = isLive ? liveCatalog(draft, usedModels()) : draft
  const plan = planDefaults(contacts, s, effective, fixes)
  const changed = DEFAULT_FIELDS.filter((k) => draft[k] !== s[k])
  const dirty = changed.length > 0 || fixes.length > 0
  const setField = (k: DefaultField, v: string) => { setDraft((d) => ({ ...d, [k]: v })); setSavedN(null) }
  const addFix = (f: Fix) => setFixes((fs) => [...fs.filter((x) => x.contactId !== f.contactId), f])
  const save = async () => {
    if (!plan.canSave || saving || !draft.defaultSpeakingModel.trim() || !draft.defaultComputeModel.trim()) return
    const settings: Partial<ModelSettings> = Object.fromEntries(changed.map((k) => [k, draft[k]]))
    const why = changed.map((k) => `${DEFAULT_FIELD_LABEL[k]}改成 ${draft[k]}`).join('、')
    setSaving(true)
    try {
      const ok = await saveModels({
      settings,
      contacts: plan.patched.map((c) => {
        const f = fixes.find((x) => x.contactId === c.id)!
        return { id: c.id, patch: { harness: c.harness, computeModel: c.computeModel }, note: `${why || '全局默认改动'}时为它${fixLabel(f, s)}，下一轮生效` }
      }),
      toast: DEFAULTS.savedToast,
    })
      if (ok) setSavedN(plan.affected.length)
    } finally { setSaving(false) }
  }
  const computeWhere = whereRuns(draft.defaultComputeModel, effective)

  return (
    <>
      <div className="mx-3 mb-3" data-testid="model-defaults">
        <div className="flex items-center px-1 pb-1.5 pt-2 text-[12px] font-medium text-fg-3"><span className="flex-1">{DEFAULTS.section}</span></div>
        <div className="overflow-hidden rounded-xl bg-hover/60 [&>*+*]:border-t [&>*+*]:border-line">
          <Field layout="inline" className={ROW} label={DEFAULT_FIELD_LABEL.defaultComputeModel} hint={`继承全局的联系人用它（${computeWhere}）`}>
            <NativeSelect aria-label={DEFAULT_FIELD_LABEL.defaultComputeModel} data-testid="def-compute" value={otherCompute ? OTHER : draft.defaultComputeModel} onChange={(e) => e.target.value === OTHER ? (setOtherCompute(true), setField('defaultComputeModel', '')) : (setOtherCompute(false), setField('defaultComputeModel', e.target.value))} className={SEL} invalid={!!plan.defaultsMismatch}>
              {s.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              {draft.defaultComputeModel && !s.models.some((m) => m.id === draft.defaultComputeModel) && <option value={draft.defaultComputeModel}>{draft.defaultComputeModel} · 目录里没声明</option>}
              <option value={OTHER}>填别的模型 id…</option>
            </NativeSelect>
          </Field>
          {otherCompute && <div className="flex gap-1.5 px-4 pb-2"><TextInput data-testid="def-compute-other" label="模型 ID" isLabelHidden size="sm" containerClassName="min-w-0 flex-1" value={draft.defaultComputeModel} placeholder="模型 ID" onChange={(value) => setField('defaultComputeModel', value)} /><Button data-testid="def-compute-other-ok" size="xs" variant="secondary" onClick={() => setOtherCompute(false)}>确定</Button></div>}
          <Field layout="inline" className={ROW} label={DEFAULT_FIELD_LABEL.defaultEffort} hint={DEFAULTS.effortHint}>
            <NativeSelect aria-label={DEFAULT_FIELD_LABEL.defaultEffort} data-testid="def-effort" value={draft.defaultEffort} onChange={(e) => setField('defaultEffort', e.target.value)} className={SEL}>
              {EFFORT_LIST.map((e) => <option key={e} value={e}>{e}</option>)}
            </NativeSelect>
          </Field>
          <Field layout="inline" className={ROW} label={DEFAULT_FIELD_LABEL.defaultHarness} hint={DEFAULTS.harnessHint}>
            <NativeSelect aria-label={DEFAULT_FIELD_LABEL.defaultHarness} data-testid="def-harness" value={draft.defaultHarness} onChange={(e) => setField('defaultHarness', e.target.value)} className={SEL} invalid={!!plan.defaultsMismatch}>
              {HARNESS_LIST.map((h) => <option key={h} value={h}>{harnessLabel(h)}</option>)}
            </NativeSelect>
          </Field>
          <Field layout="inline" className={ROW} label={DEFAULT_FIELD_LABEL.defaultSpeakingModel} hint={DEFAULTS.talkHint}>
            <NativeSelect aria-label={DEFAULT_FIELD_LABEL.defaultSpeakingModel} data-testid="def-talk" value={draft.defaultSpeakingModel} onChange={(e) => setField('defaultSpeakingModel', e.target.value)} className={SEL}>
              {s.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              {draft.defaultSpeakingModel && !s.models.some((m) => m.id === draft.defaultSpeakingModel) && <option value={draft.defaultSpeakingModel}>{draft.defaultSpeakingModel} · 目录里没声明</option>}
            </NativeSelect>
          </Field>
          <Field layout="inline" className={ROW} label={DEFAULTS.review}><FieldSwitch defaultChecked /></Field>
          <Button data-testid="open-batch" variant="ghost" size="md" onClick={() => setBatch(true)}
            className="h-auto min-h-11 w-full justify-start gap-3 rounded-none px-4 text-left text-[14px] font-normal text-fg active:scale-100">
            <ArrowRightLeft aria-hidden className="text-fg-2" /><span className="flex-1">{DEFAULTS.batch}</span><span className="text-[12.5px] text-fg-2">{DEFAULTS.batchHint}</span><ChevronRight aria-hidden className="text-fg-3" />
          </Button>
        </div>

        <AnimatePresence initial={false}>
          {dirty && (
            <motion.div key="impact" {...collapse} className="overflow-hidden"
              onAnimationComplete={() => { if (dirty) impactRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }}>
              {/* 一改就把影响预览滚进视野，不让用户以为改完就生效了 */}
              <DefaultsImpact ref={impactRef} plan={plan} saving={saving} s={effective} fixes={fixes} onFix={addFix} onUndoFix={(f) => setFixes((fs) => fs.filter((x) => x !== f))}
                onSetField={setField} onCancel={() => { setDraft(s); setFixes([]) }} onSave={save} />
            </motion.div>
          )}
        </AnimatePresence>
        {!dirty && savedN !== null && (
          <motion.div data-testid="defaults-saved" role="status" initial={rise.initial} animate={rise.animate} className="mt-2 flex items-start gap-2 rounded-xl bg-run-soft px-3 py-2 text-[12.5px]">
            <Check aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-run" strokeWidth={2.5} />
            <span>已保存。{savedN ? `受影响的 ${savedN} 位联系人下一轮生效，` : ''}正在跑的这一轮不打断。</span>
          </motion.div>
        )}
      </div>

      <ModelOverview contacts={contacts} s={s} />
      <BatchReplace open={batch} onClose={() => setBatch(false)} />
    </>
  )
}
