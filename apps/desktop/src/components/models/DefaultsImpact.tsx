import { forwardRef } from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import type { Fix, planDefaults } from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { people } from '@/data'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { harnessLabel, type ModelSettings } from '@/modelConfig'
import { DEFAULTS, type DefaultField } from './constants'
import { fixLabel, mismatchText } from './logic'
import { MismatchFix } from './MismatchFix'

type Plan = ReturnType<typeof planDefaults>
const name = (id: string) => people[id]?.name ?? id

/** 改全局默认的影响预览:会动到谁(前后值)、谁会失配(两条修复路径)、只影响新建联系人的字段;修好才能保存 */
export const DefaultsImpact = forwardRef<HTMLDivElement, {
  plan: Plan
  s: ModelSettings
  fixes: Fix[]
  onFix: (f: Fix) => void
  onUndoFix: (f: Fix) => void
  onSetField: (k: DefaultField, v: string) => void
  onCancel: () => void
  onSave: () => void
}>(({ plan, s, fixes, onFix, onUndoFix, onSetField, onCancel, onSave }, ref) => {
  const left = plan.mismatched.length + (plan.defaultsMismatch ? 1 : 0)
  return (
    <div ref={ref} data-testid="defaults-impact" className="mt-2 rounded-xl border border-line bg-bg p-3 text-[12.5px]">
      <div className="flex items-baseline gap-2">
        <div data-testid="impact-count" className="font-semibold">{plan.affected.length ? `会影响 ${plan.affected.length} 位联系人` : DEFAULTS.noneAffected}</div>
        {plan.mismatched.length > 0 && <Chip tone="err" size="xs">{plan.mismatched.length} 位失配</Chip>}
      </div>
      {plan.affected.length > 0 && <div className="mb-1.5 text-[11.5px] text-fg-3">{DEFAULTS.affectedHint}</div>}
      <div className="space-y-1">
        {plan.affected.map((a) => (
          <div key={a.contactId} data-testid={`impact-row-${a.contactId}`} className={cn('rounded-lg px-2 py-1.5', a.mismatch ? 'bg-err-soft' : 'bg-hover/60')}>
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 font-medium">{a.name}</span>
              <span className="min-w-0 truncate font-mono text-[11.5px] tabular-nums text-fg-2">
                {a.changed.map((f) => `${a.before[f].value} → ${a.after[f].value}`).join('，')}
              </span>
            </div>
            {a.mismatch && (
              <div className="mt-1.5" data-testid={`impact-mismatch-${a.contactId}`}>
                <div className="flex items-start gap-1 text-err"><AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />{a.name} 用 {harnessLabel(a.mismatch.harness)}，{mismatchText(a.mismatch, s)}。不会自动换，选一条：</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5 pl-[18px]">
                  {a.fixes.map((f) => (
                    <Button key={f.kind} data-testid={`dfix-${f.kind === 'pin-model' ? 'pin' : 'harness'}-${a.contactId}`} variant={f.kind === 'pin-model' ? 'primary' : 'outline'} size="xs" onClick={() => onFix(f)}>
                      {fixLabel(f, s)}{f.kind === 'pin-model' && f.model === a.before.model.value ? '（保持原来的）' : ''}
                    </Button>
                  ))}
                  {!a.fixes.length && <span className="text-fg-2">{DEFAULTS.noCompatible}</span>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {fixes.length > 0 && (
        <div className="mt-2 space-y-1" data-testid="defaults-fixes">
          {fixes.map((f) => (
            <div key={f.contactId} className="flex items-center gap-1.5 text-[12px] text-fg-2">
              <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-run" strokeWidth={2.5} />{name(f.contactId)}：{fixLabel(f, s)}
              <Button variant="ghost" size="xs" className="ml-auto h-6 px-1.5 text-[11.5px] text-fg-3" onClick={() => onUndoFix(f)}>{DEFAULTS.undo}</Button>
            </div>
          ))}
        </div>
      )}
      {plan.defaultsMismatch && (
        <div className="mt-2">
          <MismatchFix compact testid="defaults-combo" m={plan.defaultsMismatch} s={s} prefer={s.defaultComputeModel}
            onPin={(m) => onSetField('defaultComputeModel', m)} onHarness={(h) => onSetField('defaultHarness', h)} />
        </div>
      )}
      {plan.newContactsOnly.length > 0 && <div data-testid="impact-new-only" className="mt-2 text-[11.5px] text-fg-3">{plan.newContactsOnly.map((k) => (k === 'defaultHarness' ? '默认 Harness' : '默认说话模型')).join('、')}只用于之后新建的联系人，已有联系人各自存了自己的。</div>}
      <div className="mt-3 flex items-center gap-2 border-t border-line pt-2.5">
        <span role={plan.canSave ? undefined : 'alert'} className={cn('flex-1 text-[12px] tabular-nums', plan.canSave ? 'text-fg-3' : 'text-err')}>{plan.canSave ? '' : `还有 ${left} 处对不上，修好才能保存`}</span>
        <Button data-testid="defaults-cancel" variant="ghost" size="sm" onClick={onCancel}>{DEFAULTS.cancel}</Button>
        <Button data-testid="defaults-save" variant="primary" size="sm" className="px-4" disabled={!plan.canSave} onClick={onSave}>{DEFAULTS.save}</Button>
      </div>
    </div>
  )
})
DefaultsImpact.displayName = 'DefaultsImpact'
