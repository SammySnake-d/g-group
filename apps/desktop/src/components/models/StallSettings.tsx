import * as Collapsible from '@animate-ui/react/primitives/radix-ui/collapsible'
import { ChevronRight } from 'lucide-react'
import { resolveStall, type StallOverride } from '@g-group/ui-core'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { CM } from './constants'
import { FieldSwitch } from './FieldSwitch'

/** 高级 · 卡死判定(U92):默认收起,摘要里写着现在的阈值;展开后可按联系人单独设 */
export function StallSettings({ name, stall, error, open, onOpenChange, onChange }: {
  name: string
  stall: StallOverride | null
  error: string | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onChange: (v: StallOverride | null) => void
}) {
  const r = resolveStall(stall ?? undefined)
  const num = (v: string) => (v === '' ? Number.NaN : Number(v))
  const shown = (n: number | undefined) => (n !== undefined && Number.isFinite(n) ? n : '')
  return (
    <Collapsible.Root open={open} onOpenChange={onOpenChange} className="mt-3 border-t border-line pt-2">
      <Collapsible.Trigger asChild>
        <Button data-testid="cm-adv" variant="ghost" size="xs" className="group -ml-2 h-auto min-h-7 whitespace-normal py-1 text-left text-[12.5px] active:scale-100">
          <ChevronRight aria-hidden className="transition-transform duration-fast ease-out group-data-[state=open]:rotate-90" />{CM.advTitle}
          <span className="ml-1 font-normal tabular-nums text-fg-3">一轮 {r.turnMinutes.value} 分钟无进展判失败 · 首字节等 {r.firstByteSeconds.value} 秒{stall ? '（单独设）' : '（默认）'}</span>
        </Button>
      </Collapsible.Trigger>
      <Collapsible.Content data-testid="cm-stall">
        <div className="space-y-2 pb-1 pl-5 pt-1">
          <p className="max-w-[72ch] text-[12px] leading-relaxed text-fg-3">{CM.stallDesc}</p>
          <Field layout="inline" label={`为 ${name} 单独设`} hint={stall ? CM.stallOwnHint : CM.stallDefaultHint}>
            <FieldSwitch data-testid="stall-own" checked={!!stall} onCheckedChange={(v) => onChange(v ? { turnMinutes: r.turnMinutes.value, firstByteSeconds: r.firstByteSeconds.value } : null)} />
          </Field>
          {stall && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
              <label className="flex items-center gap-2">一轮无进展
                <Input data-testid="stall-turn" type="number" min={1} size="sm" invalid={!!error} value={shown(stall.turnMinutes)} onChange={(e) => onChange({ ...stall, turnMinutes: num(e.target.value) })}
                  className="w-20 text-right font-mono tabular-nums" />分钟
              </label>
              <label className="flex items-center gap-2">首字节等待
                <Input data-testid="stall-first" type="number" min={1} size="sm" invalid={!!error} value={shown(stall.firstByteSeconds)} onChange={(e) => onChange({ ...stall, firstByteSeconds: num(e.target.value) })}
                  className="w-20 text-right font-mono tabular-nums" />秒
              </label>
            </div>
          )}
          {error && <div data-testid="stall-error" role="alert" className="text-[12px] text-err">{error}</div>}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
