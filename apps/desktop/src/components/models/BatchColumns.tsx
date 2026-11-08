import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { DEFAULTS_KEY, type planReplace, type Resolution } from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { people } from '@/data'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { MODE_LABEL, harnessLabel, modelLabel, type ModelSettings } from '@/modelConfig'
import { BATCH, REF_LABEL } from './constants'
import { mismatchText } from './logic'

type Plan = ReturnType<typeof planReplace>
export const refName = (id: string | null) => (id === null || id === DEFAULTS_KEY ? '全局默认' : people[id]?.name ?? id)
const ITEM = 'rounded-lg bg-bg px-2.5 py-1.5 text-[12.5px] ring-1 ring-line'

/** 预览的一栏:标题 + 计数(冲突栏有冲突时整栏转红) */
function Col({ title, n, testid, children, tone }: { title: string; n: number; testid: string; children: ReactNode; tone?: 'err' }) {
  const hot = tone === 'err' && n > 0
  return (
    <div data-testid={testid} className={cn('flex min-h-[180px] min-w-0 flex-col rounded-xl p-3', hot ? 'bg-err-soft/60 ring-1 ring-err/25' : 'bg-hover/60')}>
      <div className={cn('mb-2 flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold', hot && 'text-err')}>
        <span className="min-w-0 truncate">{title}</span>
        <Chip data-testid={`${testid}-n`} tone={hot ? 'err' : 'neutral'} size="xs" className="font-mono">{n}</Chip>
      </div>
      <div className="space-y-1.5">{n === 0 && <div className="text-[12px] text-fg-3">{BATCH.none}</div>}{children}</div>
    </div>
  )
}

/** 三栏预览:直接写了旧模型的 / 跟着变的 / 兼容冲突(每条冲突给两条处理办法,处理过的可撤销) */
export function BatchColumns({ plan, s, from, to, res, onResolve, onUnresolve }: {
  plan: Plan
  s: ModelSettings
  from: string
  to: string
  res: Record<string, Resolution>
  onResolve: (key: string, r: Resolution) => void
  onUnresolve: (key: string) => void
}) {
  const resLabel = (r: Resolution) => (r.kind === 'keep' ? `保留 ${modelLabel(r.model, s)}（单独指定）` : `换 Harness 为 ${harnessLabel(r.harness)}`)
  return (
    <div className="grid grid-cols-3 gap-2.5">
      <Col title={`直接写了 ${from} 的`} n={plan.explicit.length} testid="br-explicit">
        {plan.explicit.map((r) => (
          <div key={`${r.contactId}-${r.field}`} data-testid={`br-ref-${r.contactId ?? 'defaults'}-${r.field}`} className={ITEM}>
            <span className="font-medium">{refName(r.contactId)}</span><span className="text-fg-2"> · {REF_LABEL[r.field]}</span>
            <div className="truncate font-mono text-[11.5px] text-fg-3">{from} → <span className="text-fg-2">{to}</span></div>
          </div>
        ))}
      </Col>
      <Col title={BATCH.inheritors} n={plan.inheritors.length} testid="br-inheritors">
        {plan.inheritors.map((r) => (
          <div key={r.contactId} data-testid={`br-inh-${r.contactId}`} className={ITEM}>
            <span className="font-medium">{refName(r.contactId)}</span><span className="text-fg-2"> · Compute（{MODE_LABEL[r.via]}）</span>
            <div className="text-[11.5px] text-fg-3">{r.via === 'inherit' ? '全局默认换了，它跟着换' : '说话模型换了，它跟着换'}</div>
          </div>
        ))}
      </Col>
      <Col title={BATCH.conflicts} n={plan.conflicts.length} testid="br-conflicts" tone="err">
        {plan.conflicts.map((c) => {
          const key = c.contactId ?? DEFAULTS_KEY
          return (
            <div key={key} data-testid={`br-conflict-${key}`} className="rounded-lg border border-err/30 bg-elev px-2.5 py-1.5 text-[12.5px]">
              <div><span className="font-medium">{refName(c.contactId)}</span><span className="text-err"> · {mismatchText(c.mismatch, s)}</span></div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {c.fixes.map((f) => (
                  <Button key={f.kind} data-testid={`br-${f.kind === 'pin-model' ? 'keep' : 'harness'}-${key}`} variant={f.kind === 'pin-model' ? 'primary' : 'outline'} size="xs"
                    onClick={() => onResolve(key, f.kind === 'pin-model' ? { kind: 'keep', model: f.model } : { kind: 'harness', harness: f.harness })}>
                    {f.kind === 'pin-model' ? `保留 ${modelLabel(f.model, s)}` : `换 Harness 为 ${harnessLabel(f.harness)}`}
                  </Button>
                ))}
              </div>
            </div>
          )
        })}
        {plan.resolved.map((k) => (
          <div key={k} data-testid={`br-resolved-${k}`} className={cn(ITEM, 'flex items-start gap-1.5')}>
            <Check aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-run" strokeWidth={2.5} />
            <div className="min-w-0 flex-1"><span className="font-medium">{refName(k)}</span><span className="text-fg-2"> · {res[k] ? resLabel(res[k]) : ''}</span></div>
            <Button variant="ghost" size="xs" className="h-6 shrink-0 px-1.5 text-[11.5px] text-fg-3" onClick={() => onUnresolve(k)}>{BATCH.undo}</Button>
          </div>
        ))}
      </Col>
    </div>
  )
}
