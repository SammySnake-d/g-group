import { AtSign, Check, Square, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { COPY } from '../constants'
import { Facts } from '../parts'
import type { ComputeState } from '../StatusChip'

/* 底部两条：
   ① 状态行（mirasim 回合尾的「◌ 1h08m · 21.2% · 212.4k」）：只留用时、轮数、调用数、后台任务——上下文占比、token、花费按 #877 不放；
   ② 只读条：Compute 不在群里说话(AC-03)，要改要求去找派它的联系人；这里不是输入框，是「回群里 @XX」。 */

function StateIcon({ state }: { state: ComputeState }) {
  if (state.key === 'stopping') return <Square aria-hidden className="size-3 shrink-0 fill-fg-3 text-fg-3" />
  if (state.key === 'running' || state.key === 'stalled' || state.key === 'human') return <span className="spin-ring" aria-hidden />
  if (state.tone === 'err') return <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-err" />
  if (state.key === 'stopped') return <Square aria-hidden className="size-3 shrink-0 fill-fg-3 text-fg-3" />
  return <Check aria-hidden className="size-3.5 shrink-0 text-fg-3" strokeWidth={2.5} />
}

export function SessionFooter({ state, elapsed, turns, calls, agents, background, owner, dm, readonly = true, onTalk }: {
  state: ComputeState; elapsed: string; turns: number; /** 不知道(后端没有工具调用级记录)就不给,状态行不写调用数 */ calls?: number; agents: number; background: number; owner: string; dm: boolean; readonly?: boolean; onTalk?: () => void
}) {
  const facts = [
    { key: 'time', text: elapsed },
    { key: 'turns', text: COPY.turns(turns) },
    ...(calls !== undefined ? [{ key: 'calls', text: COPY.calls(calls) }] : []),
    ...(agents > 0 ? [{ key: 'agents', text: COPY.agents(agents) }] : []),
    ...(background > 0 && state.key !== 'stopping' ? [{ key: 'bg', text: COPY.backgroundN(background) }] : []),
  ]
  /* 停止说明单独一段,窄分屏里换到下一行,不被截掉 */
  const note = state.key === 'stopping' ? `${COPY.stopping} ${COPY.stoppingHint}` : state.key === 'stopped' ? `${COPY.stopped} · ${COPY.stoppedScope}` : ''
  return (
    <footer className="shrink-0 border-t border-line">
      <div className={cn('flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 px-4 pt-2', !readonly && 'pb-2')} data-testid="session-statusline">
        <StateIcon state={state} />
        <Facts items={facts} className="text-[11.5px]" />
        {note && <span className="min-w-0 text-[11.5px] text-fg-2">{note}</span>}
      </div>
      {readonly && <div className="flex min-w-0 items-center gap-2 px-4 pb-2.5 pt-1.5" data-testid="session-readonly">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3">{COPY.readonly(owner)}</span>
        <Button variant="secondary" size="xs" shape="pill" onClick={onTalk} disabled={!onTalk} data-testid="session-talk">
          <AtSign />
          {COPY.talk(dm, owner)}
        </Button>
      </div>}
    </footer>
  )
}
