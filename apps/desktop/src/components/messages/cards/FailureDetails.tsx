import { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { useApp } from '@/store'
import type { TextMsg } from '../types'

/** 失败原因来自宿主，不把发出消息当作模型已回答；入口只打开设置，不自动换模或重发。 */
export function FailureDetails({ m }: { m: TextMsg }) {
  const openWorkbench = useApp((s) => s.openWorkbench)
  const [expanded, setExpanded] = useState(false)
  const card = m.card
  if (!card || card.kind !== 'failure') return null
  const lines = card.body.split('\n').filter(Boolean)
  const summary = lines.find((line) => line.startsWith('修法:')) ?? lines[0] ?? card.title
  const retry = card.actions.find((action) => action.id === 'retry')
  return <div data-testid={`failure-details-${m.id}`} className="mt-1 w-[min(560px,100%)] rounded-xl border border-err/25 bg-err-soft/40 px-3 py-2 text-[12.5px]" onClick={(e) => e.stopPropagation()}>
    <p className="whitespace-pre-wrap break-words text-err">{summary}</p>
    <div className="mt-1 flex items-center gap-2">
      <Button label={expanded ? '收起原因' : '查看完整原因'} variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} />
      {card.state === 'open' && !card.taskId && <Button label="换模型" data-testid={`failure-model-${m.id}`} variant="secondary" size="sm" onClick={() => openWorkbench(m.from, 'settings')} />}
    </div>
    {expanded && <pre data-testid={`failure-raw-${m.id}`} className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-fg-2">{card.body}</pre>}
    {card.state === 'open' && !card.taskId && retry && <p className="mt-1 text-[11.5px] text-fg-3">换好模型后，回到这条消息点「{retry.label}」。</p>}
  </div>
}
