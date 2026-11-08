/* Helper 在聊天里被 @ 时的回复:普通消息 + 读了什么 + 确认卡(#1353:在哪叫就在哪答) */
import { useState } from 'react'
import { Check } from 'lucide-react'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import type { TextMsg } from '../types'

export function HelperExtra({ m }: { m: TextMsg }) {
  const { addTasks, createGroup, active } = useApp()
  const [done, setDone] = useState(false)
  const h = m.helper!
  const confirm = () => {
    setDone(true)
    if (h.card!.kind === 'csv') addTasks(active, h.card!.lines)
    else if (h.card!.kind === 'group') createGroup('外部聊天记录接入', ['claude', 'argon'], '来自「模型助手群聊」：Helper 按你的要求另开的群，带了 3 条背景')
  }
  return (
    <div className="mt-1 w-[340px] max-w-full" data-testid={`helper-reply-${m.id}`}>
      {h.card && (
        <div className="rounded-xl border border-line bg-elev p-3">
          <ul className="space-y-0.5 text-[13px]">{h.card.lines.map((l) => <li key={l}>· {l}</li>)}</ul>
          {done ? <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-ok"><Check className="h-4 w-4" />已完成</div> : (
            <div className="mt-2.5 flex gap-2">
              <Button data-testid="helper-inline-confirm" variant="primary" className="flex-1" onClick={(e) => { e.stopPropagation(); confirm() }}>确认</Button>
              <Button variant="secondary" className="flex-1" onClick={(e) => { e.stopPropagation(); setDone(true) }}>取消</Button>
            </div>
          )}
        </div>
      )}
      <div className="mt-1 text-[11.5px] text-fg-3">{h.scope} · 其他助手看得到这条，但不会照着去操作软件</div>
    </div>
  )
}
