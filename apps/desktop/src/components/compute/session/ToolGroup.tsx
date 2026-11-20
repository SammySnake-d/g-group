import * as Disclosure from '@animate-ui/react/primitives/radix-ui/collapsible'
import { digest, formatDuration, toolKind, type ToolCallView, type ToolEvent, type TranscriptBlock } from '@g-group/ui-core'
import { Chip } from '@/components/ui/chip'
import { cn } from '@/lib/utils'
import { COPY, toolMix } from '../constants'
import { Caret, DiffStat, KindIcon, Mono, rowTrigger, type IconTone } from '../parts'


type ToolsBlock = Extract<TranscriptBlock, { type: 'tools' }>

const toneOf = (e: ToolEvent): IconTone => (e.status === 'failed' ? 'err' : e.status === 'running' ? 'active' : 'dim')

function groupKind(b: ToolsBlock) {
  const failed = b.calls.find((c) => c.event.status === 'failed' && !c.recovered)
  return (failed ?? b.calls[b.calls.length - 1]!).kind
}

const MIN_SHOWN_MS = 1000

export function ToolGroup({ block }: { block: ToolsBlock }) {
  const n = block.calls.length
  const unrecovered = block.failed - block.recovered
  return (
    <Disclosure.Root data-testid="tool-group" data-calls={n} data-failed={block.failed || undefined} className="-mx-2 min-w-0">
      <Disclosure.Trigger className={cn(rowTrigger, 'px-2 py-[3px] text-[12px]')} data-testid="tool-group-toggle">
        <KindIcon kind={groupKind(block)} tone={block.running ? 'active' : unrecovered > 0 ? 'err' : 'dim'} />
        <span className="shrink-0 text-fg-2" data-testid="tool-group-count">{COPY.calls(n)}</span>
        <span className="min-w-0 truncate text-fg-3">· {toolMix(block.tally)}</span>
        {block.tally.added + block.tally.removed > 0 && <DiffStat added={block.tally.added} removed={block.tally.removed} />}
        {block.failed > 0 && (
          <Chip size="xs" tone={unrecovered > 0 ? 'err' : 'warm'} data-testid="tool-group-failed">{COPY.failedCalls(block.failed, block.recovered)}</Chip>
        )}
        {block.running && <span className="spin-ring" aria-label={COPY.calls(n)} />}
        <Caret />
      </Disclosure.Trigger>
      <Disclosure.Content>
        <div className="space-y-px pb-1 pl-[25px] pr-1 pt-0.5" data-testid="tool-group-calls">
          {block.calls.map((c) => <ToolCallRow key={c.event.id} call={c} />)}
        </div>
      </Disclosure.Content>
    </Disclosure.Root>
  )
}

function ToolCallRow({ call }: { call: ToolCallView }) {
  const e = call.event
  const failed = e.status === 'failed'
  const result = digest(e.output)
  const detail = Boolean(e.input || e.output)
  const changes = e.changes ?? []
  const added = changes.reduce((s, c) => s + c.added, 0)
  const removed = changes.reduce((s, c) => s + c.removed, 0)
  return (
    <Disclosure.Root data-testid="tool-call" data-status={e.status} data-attempt={call.attempt} className="min-w-0">
      <Disclosure.Trigger disabled={!detail} className={cn(rowTrigger, '-ml-1 px-1 py-[2px] disabled:cursor-default disabled:hover:bg-transparent')}>
        <KindIcon kind={call.kind} tone={toneOf(e)} />
        <span className="shrink-0 font-code text-[11px] text-fg-3">{e.name}</span>
        <span className={cn('min-w-0 max-w-[65%] truncate font-code text-[11px]', failed ? 'text-err' : 'text-fg-2')}>{e.summary}</span>
        {!failed && result && <span className="min-w-0 flex-1 basis-0 truncate text-[11px] text-fg-3" data-testid="tool-call-result">· {result}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {changes.length > 0 && <DiffStat added={added} removed={removed} />}
          {call.attempt > 1 && <Chip size="xs" tone={failed ? 'err' : 'warm'}>{COPY.attempt(call.attempt)}</Chip>}
          {failed && call.attempt === 1 && <Chip size="xs" tone="err">{COPY.failed}</Chip>}
          {e.durationMs !== undefined && e.durationMs >= MIN_SHOWN_MS && <span className="font-code text-[11px] tabular-nums text-fg-3">{formatDuration(e.durationMs)}</span>}
          {e.status === 'running' && <span className="spin-ring" aria-hidden />}
          {detail && <Caret />}
        </span>
      </Disclosure.Trigger>
      {/* 失败直接露出错误一句，不用点开 */}
      {failed && result && <div className="pb-0.5 pl-[19px] font-code text-[11px] text-err/90" data-testid="tool-call-error">{result}</div>}
      {detail && (
        <Disclosure.Content>
          <div className="mb-1 ml-[15px] mt-0.5 min-w-0 divide-y divide-line overflow-hidden rounded-md bg-fg/[0.04]" data-testid="tool-call-detail">
            {e.input && (
              <div className="px-2 py-1.5">
                <div className="mb-0.5 text-[11px] text-fg-3">{toolKind(e.name) === 'command' ? COPY.command : COPY.input}</div>
                <Mono text={e.input} />
              </div>
            )}
            {e.output && (
              <div className="px-2 py-1.5">
                <div className="mb-0.5 text-[11px] text-fg-3">{COPY.output}</div>
                <Mono text={e.output} className={failed ? 'text-err' : 'text-fg-2'} />
              </div>
            )}
          </div>
        </Disclosure.Content>
      )}
    </Disclosure.Root>
  )
}
