/* ============ 设置页 ·「默认」一节(D07.4 规则 1/2/6;验收 AC-51) ============
   改全局默认先预检影响:会动到哪几位联系人、哪些会失配;失配修好才能保存,不会自动换成别的模型。 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowRightLeft, Check, ChevronRight } from 'lucide-react'
import { planDefaults, type Fix } from '@g-group/ui-core'
import { useApp } from '@/ctx'
import { collapse, rise } from '@/config/motion'
import { Button } from '@/components/ui/button'
import { Field, NativeSelect } from '@/components/ui/field'
import { EFFORT_LIST, HARNESS_LIST, harnessLabel, modelContacts, toContactModels, type ModelSettings } from '@/modelConfig'
import { DEFAULTS, DEFAULT_FIELDS, DEFAULT_FIELD_LABEL, type DefaultField } from './constants'
import { fixLabel } from './logic'
import { DefaultsImpact } from './DefaultsImpact'
import { ModelOverview } from './ModelOverview'
import { BatchReplace } from './BatchReplace'
import { FieldSwitch } from './FieldSwitch'

const ROW = 'flex min-h-11 flex-col justify-center px-4 py-1.5'
const SEL = 'w-[168px]'

export function GlobalModelDefaults() {
  const { modelSettings: s, modelsRev, saveModels } = useApp()
  const [draft, setDraft] = useState<ModelSettings>(s)
  const [fixes, setFixes] = useState<Fix[]>([])
  const [savedN, setSavedN] = useState<number | null>(null)
  const [batch, setBatch] = useState(false)
  const impactRef = useRef<HTMLDivElement>(null)
  useEffect(() => { setDraft(s); setFixes([]) }, [modelsRev]) // 任何一处保存过都从新的全局默认重新开始

  const contacts = modelContacts().map(toContactModels)
  const plan = planDefaults(contacts, s, draft, fixes)
  const changed = DEFAULT_FIELDS.filter((k) => draft[k] !== s[k])
  const dirty = changed.length > 0 || fixes.length > 0
  const setField = (k: DefaultField, v: string) => { setDraft((d) => ({ ...d, [k]: v })); setSavedN(null) }
  const addFix = (f: Fix) => setFixes((fs) => [...fs.filter((x) => x.contactId !== f.contactId), f])
  const save = () => {
    if (!plan.canSave) return
    const settings: Partial<ModelSettings> = Object.fromEntries(changed.map((k) => [k, draft[k]]))
    const why = changed.map((k) => `${DEFAULT_FIELD_LABEL[k]}改成 ${draft[k]}`).join('、')
    saveModels({
      settings,
      contacts: plan.patched.map((c) => {
        const f = fixes.find((x) => x.contactId === c.id)!
        return { id: c.id, patch: { harness: c.harness, computeModel: c.computeModel }, note: `${why || '全局默认改动'}时为它${fixLabel(f, s)}，下一轮生效` }
      }),
      toast: DEFAULTS.savedToast,
    })
    setSavedN(plan.affected.length)
  }
  const computeWhere = (s.models.find((m) => m.id === draft.defaultComputeModel)?.harnesses ?? []).map(harnessLabel).join(' / ') || '没有 Harness'

  return (
    <>
      <div className="mx-3 mb-3" data-testid="model-defaults">
        <div className="flex items-center px-1 pb-1.5 pt-2 text-[12px] font-medium text-fg-3"><span className="flex-1">{DEFAULTS.section}</span></div>
        <div className="overflow-hidden rounded-xl bg-hover/60 [&>*+*]:border-t [&>*+*]:border-line">
          <Field layout="inline" className={ROW} label={DEFAULT_FIELD_LABEL.defaultComputeModel} hint={`继承全局的联系人用它（${computeWhere} 能跑）`}>
            <NativeSelect aria-label={DEFAULT_FIELD_LABEL.defaultComputeModel} data-testid="def-compute" value={draft.defaultComputeModel} onChange={(e) => setField('defaultComputeModel', e.target.value)} className={SEL} invalid={!!plan.defaultsMismatch}>
              {s.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </NativeSelect>
          </Field>
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
              <DefaultsImpact ref={impactRef} plan={plan} s={s} fixes={fixes} onFix={addFix} onUndoFix={(f) => setFixes((fs) => fs.filter((x) => x !== f))}
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
