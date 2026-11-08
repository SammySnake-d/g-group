import { cn } from '@/lib/utils'
import { useState } from 'react'
import { SHAPES, SWATCHES } from '@/data'
import { modelLabel } from '@/modelConfig'
import { useApp } from '@/ctx'
import { Bot } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Choice, ChoiceGroup } from './kit/choice'
import { Field, Hint, PageFooter, PageScroll, TextInput, ctaDisabled } from './kit/parts'
import { DEFAULT_SHAPE, DEFAULT_SWATCH_INDEX } from './constants'

/* ---------- 添加联系人:先挑形象和颜色(大头像实时预览),再填名字和擅长什么;模型用全局默认 ---------- */
export function AddContactPage() {
  const { createContact, modelSettings } = useApp()
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [shape, setShape] = useState<string>(DEFAULT_SHAPE)
  const [color, setColor] = useState<string>(SWATCHES[DEFAULT_SWATCH_INDEX])
  const [quota, setQuota] = useState(2)
  return (
    <>
      <PageScroll className="px-4">
        <div className="flex flex-col items-center py-3"><Bot shape={shape} color={color} size={80} follow /></div>
        <ChoiceGroup label="形象" value={shape} onChange={setShape} className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1 pb-2">
          {SHAPES.map((s) => (
            <Choice key={s} value={s} label={s} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl hover:bg-hover data-[state=on]:bg-sel data-[state=on]:ring-1 data-[state=on]:ring-fg-3/60">
              <Bot shape={s} color={color} size={30} still />
            </Choice>
          ))}
        </ChoiceGroup>
        <ChoiceGroup label="颜色" value={color} onChange={setColor} className="flex justify-center gap-1.5 pb-4">
          {SWATCHES.map((c) => (
            <Choice key={c} value={c} label={c} className="h-6 w-6 rounded-full ring-offset-2 ring-offset-elev data-[state=on]:ring-2 data-[state=on]:ring-fg-2">
              <span aria-hidden className="block h-full w-full rounded-full" style={{ background: c }} />
            </Choice>
          ))}
        </ChoiceGroup>
        <Field label="名字"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="比如：设计师" /></Field>
        <Field label="擅长什么" className="mt-3"><TextInput value={role} onChange={(e) => setRole(e.target.value)} placeholder="比如：画界面、做配色" /></Field>
        <div className="mt-4 flex items-center justify-between text-[12.5px] font-medium text-fg-2"><span>最多同时分几个 Compute</span><span className="tabular-nums text-fg">{quota} 个</span></div>
        <Slider value={[quota]} min={1} max={5} step={1} onValueChange={(v) => setQuota(v[0])} className="mt-3" aria-label="最多同时分几个 Compute" />
        <Hint testid="add-model-note" className="mt-3 text-[12px]">说话用全局默认的 {modelLabel(modelSettings.defaultSpeakingModel, modelSettings)}，Compute 继承全局（{modelLabel(modelSettings.defaultComputeModel, modelSettings)}）。加好以后在它的工作台「设置」里改。</Hint>
      </PageScroll>
      <PageFooter>
        <Button variant="primary" size="md" className={cn('w-full', ctaDisabled)} disabled={!name.trim()} onClick={() => createContact({ name: name.trim(), role: role.trim() || '通用助手', shape, color, model: modelSettings.defaultSpeakingModel, quota })}>添加</Button>
      </PageFooter>
    </>
  )
}
