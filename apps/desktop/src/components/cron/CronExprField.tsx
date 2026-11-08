/* 按时间重复:预设芯片 + 自定义 cron 表达式。表达式区是主角——
   大号等宽输入、右侧人话;下面一把逐段尺子,光标在哪段哪段亮,哪段错哪段红;再下面是接下来几次和时区。 */
import { useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { CRON_FIELDS, CRON_PRESETS, CUSTOM_PRESET, cronPresetId, describeCron, formatRunAt, localZoneLabel, nextRuns, parseCron } from '@g-group/ui-core'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { cn } from '@/lib/utils'
import { EDITOR } from './constants'
import { tokenAt } from './util'

/** 预设芯片(照 mirasim 自动化编辑器的 preset):细边胶囊;选中 = 强调色细边 + 淡底 + 加粗 */
export const pillCls = (on: boolean) => cn('h-[30px] px-3 text-[12.5px] font-normal shadow-none', on ? 'border-me/55 bg-me/10 font-semibold text-fg hover:bg-me/10' : 'bg-transparent text-fg-2')

export function CronExprField({ expr, setExpr, custom, setCustom, now }: { expr: string; setExpr: (v: string) => void; custom: boolean; setCustom: (v: boolean) => void; now: Date }) {
  const exprRef = useRef<HTMLInputElement>(null)
  const [caret, setCaret] = useState<number | null>(null)
  const parsed = parseCron(expr)
  const tokens = expr.trim().split(/\s+/).filter(Boolean)
  const badField = !parsed.ok ? parsed.error.field : null
  const activeField = tokenAt(expr, caret)
  const activePreset = custom ? CUSTOM_PRESET : cronPresetId(expr)
  const upcoming = parsed.ok ? nextRuns(expr, now, 5) : []
  const trackCaret = (el: HTMLInputElement) => setCaret(el.selectionStart)
  return (
    <div data-testid="cron-editor-cron">
      <div className="flex flex-wrap gap-1.5">
        {CRON_PRESETS.map((p) => (
          <Button key={p.id} data-testid={`cron-preset-${p.id}`} aria-pressed={activePreset === p.id} variant="outline" size={null} shape="pill"
            onClick={() => { setExpr(p.expr); setCustom(false) }} className={pillCls(activePreset === p.id)}>{p.label}</Button>
        ))}
        <Button data-testid={`cron-preset-${CUSTOM_PRESET}`} aria-pressed={activePreset === CUSTOM_PRESET} variant="outline" size={null} shape="pill"
          onClick={() => { setCustom(true); exprRef.current?.focus(); exprRef.current?.select() }}
          className={cn(pillCls(activePreset === CUSTOM_PRESET), activePreset !== CUSTOM_PRESET && 'border-dashed')}>{EDITOR.custom}</Button>
      </div>

      <div className={cn('mt-3 flex items-center gap-3 rounded-xl border bg-bg pl-3.5 pr-3 transition-[border-color,box-shadow] duration-fast ease-out',
        parsed.ok ? 'border-line focus-within:border-fg-3 focus-within:ring-2 focus-within:ring-ring/25' : 'border-err focus-within:ring-2 focus-within:ring-err/25')}>
        <span className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-fg-3">{EDITOR.exprLabel}</span>
        <input ref={exprRef} data-testid="cron-editor-expr" value={expr} spellCheck={false} autoComplete="off" aria-invalid={!parsed.ok} aria-label="cron 表达式"
          onChange={(e) => { setExpr(e.target.value); setCustom(false); trackCaret(e.currentTarget) }}
          onSelect={(e) => trackCaret(e.currentTarget)} onBlur={() => setCaret(null)}
          className="h-11 min-w-0 flex-1 bg-transparent font-mono text-[16px] tracking-wide text-fg outline-none" />
        {parsed.ok && <span data-testid="cron-editor-desc" className="min-w-0 shrink truncate text-[13px] font-medium text-fg">{describeCron(expr)}</span>}
      </div>

      {/* 逐段尺子:每段的写法对着它的名字 */}
      <div className="mt-2 grid grid-cols-5 gap-1.5" aria-hidden>
        {CRON_FIELDS.map((f, i) => {
          const bad = badField === i + 1
          const active = !bad && activeField === i
          return (
            <div key={f.name} data-testid={`cron-editor-field-${i + 1}`} data-bad={bad || undefined} data-active={active || undefined}
              className={cn('min-w-0 rounded-lg px-1.5 py-1.5 text-center transition-[background-color,color,box-shadow] duration-fast ease-out',
                bad ? 'bg-err-soft text-err ring-1 ring-err/40' : active ? 'bg-elev text-fg ring-1 ring-fg-3/40' : 'bg-hover/70 text-fg-2')}>
              <div className="truncate font-code text-[13px] font-medium">{tokens[i] ?? '·'}</div>
              <div className="mt-0.5 truncate text-[10.5px] tabular-nums opacity-80">{f.name} {f.min}–{f.max}</div>
            </div>
          )
        })}
      </div>

      {!parsed.ok ? (
        <div data-testid="cron-editor-error" role="alert" className="mt-2.5 flex items-start gap-1.5 text-[12.5px] text-err"><AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />{parsed.error.message}</div>
      ) : (
        <div className="mt-2.5 flex items-baseline gap-2 text-[12.5px]">
          <span className="shrink-0 text-fg-3">{EDITOR.upcoming}</span>
          <div data-testid="cron-preview" className="flex min-w-0 flex-wrap gap-1">
            {upcoming.map((d, i) => (
              <Chip key={d.getTime()} data-testid={`cron-preview-${i}`} variant="outline" size="sm"
                className={cn('bg-elev tabular-nums', i === 0 ? 'border-fg-3/40 text-fg' : 'font-normal text-fg-2')}>{formatRunAt(d, now)}</Chip>
            ))}
          </div>
        </div>
      )}
      <div data-testid="cron-editor-zone" className="mt-2 text-[11.5px] text-fg-3">{EDITOR.zone} · {localZoneLabel(now)}</div>
    </div>
  )
}
