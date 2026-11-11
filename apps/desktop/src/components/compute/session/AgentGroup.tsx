import { CornerDownRight } from 'lucide-react'
import * as Acc from '@animate-ui/react/primitives/radix-ui/accordion'
import { formatDuration, groupTranscript, type AgentEvent, type TranscriptBlock } from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { COPY } from '../constants'
import { Caret, Facts, Field } from '../parts'
import { Prose } from './Prose'
import { ToolGroup } from './ToolGroup'

/* 子代理组(mirasim wjt + J2t)：一行汇总「4 个子代理 · 2 个进行中 · 2 个已回来」，下面每个子代理一行——
   左侧一条细竖线（在跑时绿），行底是很淡的靛蓝（mirasim 用 info 色 7%，这里换成我们表示「可点」的 me），
   右侧等宽的「后台运行中 · 44 个调用 · 10m19s」。不放 token(#877)。展开看任务、过程、结果，用 Animate UI 的 Accordion。 */

type AgentsBlock = Extract<TranscriptBlock, { type: 'agents' }>

export function AgentGroup({ block }: { block: AgentsBlock }) {
  const head = [COPY.agents(block.agents.length), block.running ? COPY.agentsRunning(block.running) : '', block.done ? COPY.agentsBack(block.done) : '', block.failed ? COPY.agentsFailed(block.failed) : '']
  return (
    <div className="min-w-0 space-y-1" data-testid="agent-group">
      <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] tabular-nums text-fg-3">
        {block.running ? <span className="spin-ring" aria-hidden /> : <CornerDownRight aria-hidden className="size-3 shrink-0" />}
        <span className="truncate">{head.filter(Boolean).join(' · ')}</span>
      </div>
      <Acc.Root type="multiple" className="space-y-1">
        {block.agents.map((a) => <AgentRow key={a.id} agent={a} />)}
      </Acc.Root>
    </div>
  )
}

function AgentRow({ agent: a }: { agent: AgentEvent }) {
  const running = a.status === 'running'
  const failed = a.status === 'failed'
  const facts = [
    ...(running ? [{ key: 'status', text: COPY.agentRunning }] : failed ? [{ key: 'status', text: COPY.agentFailed, className: 'text-err' }] : []),
    ...(a.calls > 0 ? [{ key: 'calls', text: COPY.calls(a.calls) }] : []),
    { key: 'time', text: formatDuration(a.durationMs) },
  ]
  const trail = a.trail?.length ? groupTranscript(a.trail).filter((b) => b.type === 'tools') : []
  return (
    <Acc.Item value={a.id} className="relative min-w-0 pl-3" data-testid="agent-row" data-status={a.status}>
      <span aria-hidden className={cn('absolute bottom-2 left-[2px] top-2 w-px', running ? 'bg-run/45' : 'bg-line')} />
      <Acc.Header className="min-w-0">
        <Acc.Trigger className={cn('group/disc flex w-full min-w-0 items-center gap-1.5 rounded-lg bg-me/[0.07] px-2 py-1 text-left transition-colors duration-fast ease-out hover:bg-me/[0.11] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60')}>
          <CornerDownRight aria-hidden strokeWidth={2.2} className={cn('size-[13px] shrink-0', running ? 'text-run' : failed ? 'text-err' : 'text-fg-3')} />
          <span className={cn('min-w-0 flex-1 truncate text-[12px]', running ? 'text-fg-2' : 'text-fg-2/80')}>{a.label}</span>
          <Facts items={facts} className="ml-2" />
          <Caret />
        </Acc.Trigger>
      </Acc.Header>
      <Acc.Content>
        <div className="space-y-0.5 pb-1 pt-0.5" data-testid="agent-detail">
          <Field label={COPY.brief}><p className="text-[12px] leading-relaxed text-fg-2">{a.brief}</p></Field>
          {trail.length > 0 && (
            <Field label={COPY.trail} count={a.trail?.length}>
              <div className="pl-2">{trail.map((b) => b.type === 'tools' && <ToolGroup key={b.key} block={b} />)}</div>
            </Field>
          )}
          {a.result && <Field label={COPY.result}><Prose text={a.result} size="sm" /></Field>}
        </div>
      </Acc.Content>
    </Acc.Item>
  )
}
