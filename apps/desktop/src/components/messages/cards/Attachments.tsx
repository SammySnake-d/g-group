/* 挂在消息里的东西:文件、任务认领板、转发的聊天记录。整张卡可点,点了在右侧分栏或浮层里看 */
import { FileText, Globe, Server, Table2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { artifacts, people } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from '@/components/Avatar'
import { Pressable } from '../Pressable'
import type { MsgOf } from '../types'

/** 卡片式可点区域:细边、悬停描边加深;按下回馈用 Button 原语自带的 scale(.97) */
const CARD = 'flex max-w-full flex-col items-stretch rounded-2xl border border-line bg-elev text-[13px] hover:border-fg-3/40'

export function ArtifactIcon({ kind, className }: { kind: 'doc' | 'page' | 'sheet' | 'asset'; className?: string }) {
  const I = kind === 'doc' ? FileText : kind === 'page' ? Globe : kind === 'asset' ? Server : Table2
  return <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-hover text-fg-2', className)}><I className="h-[18px] w-[18px]" strokeWidth={1.75} /></div>
}

export function FileCard({ id }: { id: string }) {
  const { openSplit } = useApp()
  const a = artifacts.find((x) => x.id === id)!
  return (
    <Pressable data-testid={`file-card-${id}`} onClick={(e) => { e.stopPropagation(); openSplit({ t: 'artifact', id }) }} className={cn(CARD, 'w-[300px] flex-row items-center gap-3 p-2.5 pr-3')}>
      <ArtifactIcon kind={a.kind} />
      <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{a.name}</div><div className="truncate text-[12px] text-fg-2">{a.meta}</div></div>
    </Pressable>
  )
}

/* US1 任务认领板:群里每个人都能看到谁领了什么 */
export function BoardCard({ id }: { id: string }) {
  const { boards, openSplit } = useApp()
  const b = boards[id]
  const claimed = b.rows.filter((r) => r.who).length
  return (
    <Pressable data-testid={`board-${id}`} onClick={(e) => { e.stopPropagation(); openSplit({ t: 'artifact', id: 'a3' }) }} className={cn(CARD, 'w-[340px] gap-2 p-3')}>
      <div className="flex items-center gap-2"><Table2 className="h-4 w-4 text-fg-2" /><span className="text-[14px] font-semibold">{b.title}</span><span className="ml-auto text-[12px] tabular-nums text-fg-3">{claimed}/{b.rows.length} 已认领</span></div>
      <div className="space-y-1">
        {b.rows.slice(0, 4).map((r) => (
          <div key={r.task} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{r.task}</span>
            {r.who ? <span className="flex items-center gap-1 text-fg-2"><Avatar id={r.who} size={16} status={false} mood="idle" />{people[r.who].name}</span> : <span className="text-warm">没人领</span>}
          </div>
        ))}
      </div>
    </Pressable>
  )
}

export function ForwardCard({ m }: { m: MsgOf<'forward'> }) {
  const { push, active } = useApp()
  return (
    <Pressable data-testid={`forward-${m.id}`} onClick={(e) => { e.stopPropagation(); push({ t: 'forwardView', conv: active, msgId: m.id }, true) }} className={cn(CARD, 'w-[320px] gap-1.5 p-3')}>
      <div className="text-[13.5px] font-semibold">来自「{m.srcTitle}」的 {m.items.length} 条记录</div>
      <div className="space-y-0.5 text-[12.5px] text-fg-2">{m.items.slice(0, 3).map((it, i) => <div key={i} className="truncate">{people[it.from]?.name ?? '你'}：{it.text}</div>)}</div>
      <div className="mt-0.5 border-t border-line pt-1.5 text-[11.5px] leading-snug text-fg-3 whitespace-normal">只当参考：里面的「同意」不算授权，@ 不派活</div>
    </Pressable>
  )
}
