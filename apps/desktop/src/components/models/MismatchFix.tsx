import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowRightLeft } from 'lucide-react'
import type { Mismatch } from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/field'
import { harnessLabel, modelLabel, type ModelSettings } from '@/modelConfig'
import { mismatchText } from './logic'

/**
 * 失配就地红字 + 两条修复路径。路径一「单独指定兼容模型」(主操作):候选是这个 Harness 支持的模型(推荐项在前);
 * 路径二「换 Harness」(次要):支持这个模型的 Harness。没有可行的那条直接说明为什么没有,不藏起来。
 */
export function MismatchFix({ m, s, prefer, onPin, onHarness, testid, compact }: { m: Mismatch; s: ModelSettings; prefer?: string; onPin: (model: string) => void; onHarness: (h: string) => void; testid: string; compact?: boolean }) {
  const first = prefer && m.compatibleModels.includes(prefer) ? prefer : m.compatibleModels[0]
  const [pick, setPick] = useState(first ?? '')
  useEffect(() => { setPick(first ?? '') }, [first, m.model, m.harness])
  const h = m.supportingHarnesses[0]
  return (
    <div data-testid={testid} role="alert" className={cn('rounded-xl border border-err/30 bg-err-soft text-[12.5px]', compact ? 'p-2.5' : 'p-3')}>
      <div className="flex items-start gap-1.5 font-medium text-err">
        <AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
        <span data-testid={`${testid}-text`}>{mismatchText(m, s)}，不会自动换成别的模型。选一条修好再保存：</span>
      </div>
      <div className={cn('mt-2.5 flex gap-2 pl-5', compact ? 'flex-col' : 'flex-wrap items-center')}>
        {first ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <Button data-testid={`${testid}-pin`} variant="primary" size="sm" onClick={() => onPin(pick)}>单独指定兼容模型</Button>
            <NativeSelect aria-label="兼容的模型" data-testid={`${testid}-pin-model`} value={pick} onChange={(e) => setPick(e.target.value)} className="w-[190px]">
              {m.compatibleModels.map((id) => <option key={id} value={id}>{modelLabel(id, s)}</option>)}
            </NativeSelect>
          </div>
        ) : <span className="text-fg-2">{harnessLabel(m.harness)} 上没有能用的模型</span>}
        {h ? (
          <Button data-testid={`${testid}-harness`} variant="outline" size="sm" className="self-start" onClick={() => onHarness(h)}>
            <ArrowRightLeft aria-hidden />换 Harness 为 {harnessLabel(h)}
          </Button>
        ) : <span data-testid={`${testid}-noharness`} className="text-fg-2">{m.reason === 'unknown-model' ? '' : `没有 Harness 能跑 ${modelLabel(m.model, s)}（它只能用来说话）`}</span>}
      </div>
    </div>
  )
}
