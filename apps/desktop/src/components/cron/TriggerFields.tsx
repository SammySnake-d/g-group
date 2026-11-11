/* 其余三种叫醒方式:只跑一次(本地时刻)/ 每 N 条消息 / 某件事发生(数据源插件 + 条件) */
import type { ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { formatRunAt, localZoneLabel, parseLocalDateTime, toLocalDateTime } from '@g-group/ui-core'
import type { PluginInfo } from '@/pluginInfo'
import { Input, SelectMenu } from '@/components/ui/field'
import { EDITOR } from './constants'

export function TriggerError({ children }: { children: ReactNode }) {
  return <div data-testid="cron-editor-error" role="alert" className="flex items-center gap-1.5 text-[12.5px] text-err"><AlertCircle className="h-3.5 w-3.5 shrink-0" />{children}</div>
}

export function OnceField({ at, setAt, err, now }: { at: string; setAt: (v: string) => void; err: string | null; now: Date }) {
  const when = parseLocalDateTime(at)
  return (
    <div data-testid="cron-editor-once-box">
      <Input data-testid="cron-editor-once" type="datetime-local" value={at} min={toLocalDateTime(now)} onChange={(e) => setAt(e.target.value)}
        invalid={!!err} size="lg" aria-label="醒来的时刻" className="w-auto font-mono tabular-nums" />
      <div className="mt-2">
        {err ? <TriggerError>{err}</TriggerError>
          : <div className="text-[12.5px] text-fg-2">{EDITOR.onceWill} <span data-testid="cron-preview-0" className="font-medium tabular-nums text-fg">{when ? formatRunAt(when, now) : ''}</span> {EDITOR.onceTail}</div>}
      </div>
      <div className="mt-2 text-[11.5px] text-fg-3">{EDITOR.zone} · {localZoneLabel(now)}</div>
    </div>
  )
}

export function MessagesField({ n, setN, err }: { n: number; setN: (v: number) => void; err: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-2">
      {EDITOR.msgHead}
      <Input data-testid="cron-editor-n" type="number" min={1} max={1000} value={Number.isNaN(n) ? '' : n} onChange={(e) => setN(e.target.valueAsNumber)}
        invalid={!!err} size="sm" aria-label="每多少条消息" className="w-20 px-2 text-center font-mono tabular-nums" />
      {EDITOR.msgTail}
      {err && <div className="w-full"><TriggerError>{err}</TriggerError></div>}
    </div>
  )
}

export function EventField({ sources, source, setSource, cond, setCond, err }: { sources: PluginInfo[]; source: string; setSource: (v: string) => void; cond: string; setCond: (v: string) => void; err: string | null }) {
  return (
    <div className="space-y-2">
      {sources.length === 0 ? (
        <div className="text-[12.5px] text-fg-3">{EDITOR.noSource}</div>
      ) : (
        <SelectMenu testid="cron-editor-source" label={EDITOR.sourcePh} placeholder={EDITOR.sourcePh} value={source} onChange={setSource}
          options={sources.map((p) => ({ value: p.id, label: p.name, hint: p.desc }))} />
      )}
      <Input data-testid="cron-editor-cond" value={cond} onChange={(e) => setCond(e.target.value)} placeholder={EDITOR.condPh} aria-label="叫醒的条件" />
      {err && <TriggerError>{err}</TriggerError>}
      <div className="text-[11.5px] text-fg-3">{EDITOR.eventNote}</div>
    </div>
  )
}
