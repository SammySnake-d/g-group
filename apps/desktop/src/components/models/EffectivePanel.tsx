import { taskModels, vendorOf, type ComputeResolution, type ContactModels, type Resolved } from '@g-group/ui-core'
import type { Compute } from '@/data'
import { cn } from '@/lib/utils'
import { MODE_LABEL, VENDOR_LABEL, snapshotOfCompute, type ModelSettings } from '@/modelConfig'
import { Chain } from './Chain'
import { CM } from './constants'

/** 右栏:按现在(或保存后)的配置,下一轮实际会用什么、每个值从哪一层来;在跑的任务用的是启动时的快照 */
export function EffectivePanel({ name, cm, s, speaking, compute, allowed, dirty, running }: {
  name: string
  cm: ContactModels
  s: ModelSettings
  speaking: Resolved
  compute: ComputeResolution
  allowed: boolean
  dirty: boolean
  running: Compute[]
}) {
  const vendor = vendorOf(compute.model.value, s.models)
  return (
    <div className="min-w-0 self-start rounded-xl bg-bg p-3 ring-1 ring-line" data-testid="cm-effective">
      <div data-testid="cm-effective-title" className="mb-2 text-[12px] font-medium text-fg-3">{dirty ? CM.effectiveDirty : CM.effectiveClean}</div>
      <div className="space-y-3 text-[12.5px]">
        <div>
          <div data-testid="cm-speaking-summary" className="font-medium">说话 → <code className="font-mono text-[12.5px] font-semibold">{speaking.value || '（没填）'}</code></div>
          <div className="mt-0.5 pl-3 text-[12px]"><Chain r={speaking} testid="chain-speaking" /></div>
        </div>
        <div>
          <div data-testid="cm-summary" className={cn('font-medium', !allowed && 'text-err')}>
            Compute → {MODE_LABEL[compute.mode]} → <code className="font-mono text-[12.5px] font-semibold">{compute.model.value || '（没填）'} · {compute.harness.value} · {compute.effort.value}</code>
          </div>
          <div className="mt-1 space-y-1 pl-3 text-[12px]">
            {([['模型', compute.model, 'chain-model'], ['Harness', compute.harness, 'chain-harness'], ['effort', compute.effort, 'chain-effort']] as const).map(([l, r, t]) => (
              <div key={t} className="flex items-start gap-2"><span className="w-[52px] shrink-0 pt-px text-fg-3">{l}</span><Chain r={r} testid={t} /></div>
            ))}
          </div>
        </div>
        {!allowed && <div data-testid="cm-blocked" className="text-[12px] text-err">这样配，下次开 Compute 会被拦下；{name} 在群里说话不受影响。</div>}
        {allowed && <div className="text-[12px] text-fg-3">复核要换一家：{name} 的产出会交给不是 {VENDOR_LABEL[vendor] ?? vendor} 的模型复核。</div>}
        {running.length > 0 && <RunningNow running={running} cm={cm} s={s} allowed={allowed} dirty={dirty} compute={compute} />}
      </div>
    </div>
  )
}

/** 在跑的任务实际在用的模型(启动时记下,不追溯);配置变了就注明下一轮起用新的 */
function RunningNow({ running, cm, s, allowed, dirty, compute }: { running: Compute[]; cm: ContactModels; s: ModelSettings; allowed: boolean; dirty: boolean; compute: ComputeResolution }) {
  const drift = new Set(running.flatMap((c) => taskModels(snapshotOfCompute(c, s), cm, s).drift.filter((f) => f !== 'effort'))) // 演示数据的 Compute 没记 effort
  return (
    <div data-testid="cm-running" className="border-t border-line pt-2">
      <div className="mb-1 text-[12px] font-medium text-fg-3">{CM.runningTitle}</div>
      <div className="space-y-0.5">
        {running.map((c) => (
          <div key={c.id} data-testid={`cm-running-${c.id}`} className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
            <span className="min-w-0 truncate font-medium">「{c.short ?? c.title}」</span>
            <span className="shrink-0 text-fg-2">{c.model} · {c.harness}</span>
          </div>
        ))}
      </div>
      {allowed && drift.size > 0 && (
        <div data-testid="cm-running-next" className="mt-1 text-[12px] text-warm">
          {dirty ? '保存后，' : ''}{running.length > 1 ? `这 ${running.length} 个任务` : '它'}这一轮照常跑完，下一轮起用 <code className="font-mono">{compute.model.value} · {compute.harness.value}</code>
        </div>
      )}
    </div>
  )
}
