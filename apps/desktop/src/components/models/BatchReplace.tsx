import { TextInput } from '@astryxdesign/core/TextInput'
/* ============ 批量替换(D07.4 规则 6) ============
   把 X 换成 Y:先预览会动到哪些地方(直接引用 / 跟着变 / 兼容冲突),冲突处理完才能确认;固定在别的模型上的不动,在途任务按启动快照跑完。 */
import { useState } from 'react'
import { confirmReplace, planReplace, resolveCompute, type Resolution } from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { useApp } from '@/ctx'
import { live } from '@/api/wire/live'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/field'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal'
import { liveCatalog, liveComputes, modelContacts, modelOption, snapshotOfCompute, toContactModels } from '@/modelConfig'
import { BATCH } from './constants'
import { toPatches } from './logic'
import { BatchColumns, refName } from './BatchColumns'

export function BatchReplace({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} testid="batch-dialog" width={920} title={BATCH.title} description={BATCH.desc}
      onEscapeKeyDown={(e) => e.stopPropagation()}>
      <BatchBody onClose={onClose} />
    </Modal>
  )
}

/** 对话框内容:每次打开重新从「最常用的那个模型」开始(关掉就卸载,状态不留) */
function BatchBody({ onClose }: { onClose: () => void }) {
  const { modelSettings: s, computes, saveModels, isLive } = useApp((st) => ({ modelSettings: st.modelSettings, computes: st.computes, saveModels: st.saveModels, isLive: live(st) }))
  const contacts = modelContacts().map(toContactModels)
  const used = s.models.filter((m) => m.id === s.defaultComputeModel || m.id === s.defaultSpeakingModel || contacts.some((c) => c.speakingModel === m.id || resolveCompute(c, s).model.value === m.id))
  const [from, setFrom] = useState(used[0]?.id ?? s.models[0]?.id ?? '')
  const [to, setTo] = useState(() => s.models.find((m) => m.id !== from)?.id ?? '')
  const [res, setRes] = useState<Record<string, Resolution>>({})
  const [otherTo, setOtherTo] = useState(false)
  const [saving, setSaving] = useState(false)
  const effective = isLive ? liveCatalog(s, [from, to]) : s
  const tasks = liveComputes(computes).map((c) => ({ id: c.id, model: snapshotOfCompute(c, effective).model, label: `「${c.short ?? c.title}」` }))
  const input = { contacts, defaults: effective, from, to, tasks, resolutions: res }
  const plan = planReplace(input)
  const pickFrom = (v: string) => { setFrom(v); setRes({}); if (v === to) setTo(s.models.find((m) => m.id !== v)?.id ?? '') }
  const confirm = async () => {
    const r = confirmReplace(input)
    if (!r.ok || saving) return
    const { settings, contacts: patches } = toPatches(r.changes, contacts)
    setSaving(true)
    try {
      const ok = await saveModels({
      ...(isLive ? { batch: { from, to } } : {}),
      settings,
      contacts: patches.map(({ c, note }) => ({ id: c.id, patch: { model: c.speakingModel, harness: c.harness, computeModel: c.computeModel }, note: `批量把 ${from} 换成 ${to}：${note}，下一轮生效` })),
      toast: `已把 ${from} 换成 ${to}`,
    })
      if (ok) onClose()
    } finally { setSaving(false) }
  }
  const blockedWhy = plan.problem ?? (plan.conflicts.length ? `还有 ${plan.conflicts.length} 处冲突，先选怎么处理` : plan.explicit.length ? '' : `没有地方直接用了 ${from}`)
  return (
    <>
      <ModalBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
          把<NativeSelect aria-label="要换掉的模型" data-testid="br-from" value={from} onChange={(e) => pickFrom(e.target.value)} className="w-[200px]">{used.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</NativeSelect>
          换成<NativeSelect aria-label="换成的模型" data-testid="br-to" value={otherTo ? '__other__' : to} onChange={(e) => { if (e.target.value === '__other__') { setOtherTo(true); setTo('') } else { setOtherTo(false); setTo(e.target.value); setRes({}) } }} className="w-[260px]">{effective.models.filter((m) => m.id !== from).map((m) => <option key={m.id} value={m.id}>{modelOption(m.id, effective)}</option>)}<option value="__other__">填别的模型 id…</option></NativeSelect>
          {otherTo && <><TextInput data-testid="br-to-other" label="模型 ID" isLabelHidden size="sm" containerClassName="min-w-0 flex-1" value={to} placeholder="模型 ID" onChange={(value) => setTo(value)} /><Button data-testid="br-to-other-ok" size="xs" variant="secondary" onClick={() => setOtherTo(false)}>确定</Button></>}
        </div>
        <BatchColumns plan={plan} s={effective} from={from} to={to} res={res}
          onResolve={(k, r) => setRes((x) => ({ ...x, [k]: r }))} onUnresolve={(k) => setRes((x) => { const n = { ...x }; delete n[k]; return n })} />
        <div data-testid="br-untouched" className="space-y-0.5 text-[12px] text-fg-3">
          {plan.pinnedElsewhere.length > 0 && <div>固定在别的模型上的 {plan.pinnedElsewhere.map((i) => refName(i)).join('、')} 不动。</div>}
          <div data-testid="br-inflight">{plan.inFlight.length ? `在途 ${plan.inFlight.length} 个任务（${tasks.filter((t) => plan.inFlight.includes(t.id)).map((t) => t.label).join('、')}）按启动时的 ${from} 跑完，快照和历史不改。` : `没有按 ${from} 在跑的任务。`}</div>
        </div>
      </ModalBody>
      <ModalFooter>
        <span data-testid="br-why" role={blockedWhy ? 'alert' : undefined} className={cn('min-w-0 flex-1 text-[12.5px] tabular-nums', blockedWhy ? 'text-err' : 'text-fg-2')}>{blockedWhy || `确认后改 ${plan.explicit.length} 处直接引用，${plan.inheritors.length} 位继承者跟着变，下一轮生效。`}</span>
        <Button variant="ghost" size="md" onClick={onClose}>{BATCH.cancel}</Button>
        <Button data-testid="br-confirm" variant="primary" size="md" disabled={!plan.canConfirm || saving || !from.trim() || !to.trim()} onClick={confirm}>{saving ? '保存中…' : BATCH.confirm}</Button>
      </ModalFooter>
    </>
  )
}
