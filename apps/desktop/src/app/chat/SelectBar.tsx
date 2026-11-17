import { Forward } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Conversation, Msg } from '@/data'
import { useApp } from '@/store'

type TextMsg = Extract<Msg, { k: 'text' }>

/** 多选模式下替换输入框:引用、删除(只删你这边)、合并转发 */
export function SelectBar({ conv }: { conv: Conversation }) {
  const { selected, setSelecting, addQuote, deleteMsgs, push, active } = useApp((s) => ({ selected: s.selected, setSelecting: s.setSelecting, addQuote: s.addQuote, deleteMsgs: s.deleteMsgs, push: s.push, active: s.active }))
  const n = selected.size
  const quote = () => {
    conv.messages.filter((m): m is TextMsg => m.k === 'text' && selected.has(m.id)).forEach((m) => addQuote({ msgId: m.id, from: m.from, text: m.text }))
    setSelecting(false)
  }
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3" data-testid="select-bar">
      <span className="text-[13.5px] text-fg-2">已选 <span className="tabular-nums">{n}</span> 条</span>
      {/* 删除离常用操作远一点(Fitts:危险操作别和常用的挨着);删了能在提示条上撤销 */}
      <Button data-testid="select-delete" variant="danger" size="md" className="px-3 text-[13px]" disabled={!n} onClick={() => { deleteMsgs([...selected]); setSelecting(false) }}>删除</Button>
      <div className="flex-1" />
      <Button variant="ghost" size="md" className="px-3 text-[13px] font-normal text-fg" onClick={() => setSelecting(false)}>取消</Button>
      <Button data-testid="select-quote" variant="secondary" size="md" className="px-3 text-[13px]" disabled={!n} onClick={quote}>引用这 {n} 条</Button>
      <Button data-testid="select-forward" variant="primary" size="md" className="px-3.5 text-[13px]" disabled={!n} onClick={() => push({ t: 'forwardPick', from: active, msgIds: [...selected] }, true)}><Forward />合并转发</Button>
    </div>
  )
}
