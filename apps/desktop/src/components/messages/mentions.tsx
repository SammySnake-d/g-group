import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { people } from '@/data'
import { MentionDot } from '@/components/Receipt'

/** 正文里的 @名字:别人消息里 @你 用暖色底标出来;你发的消息里每个被 @ 的联系人后面挂一个已读小点(AC-46) */
export function renderText(text: string, mine: boolean, msgId?: string) {
  const names = Object.values(people).map((p) => p.name).sort((a, b) => b.length - a.length)
  const re = new RegExp('@(' + names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + '|我)', 'g')
  const out: ReactNode[] = []
  let last = 0
  for (const mt of text.matchAll(re)) {
    out.push(text.slice(last, mt.index))
    const isMe = mt[1] === '39impacts' || mt[1] === '我'
    out.push(<span key={mt.index} className={cn('font-semibold', !mine && (isMe ? 'rounded bg-warm-soft px-0.5 text-warm' : 'text-fg'))}>@{mt[1]}</span>)
    const pid = Object.values(people).find((p) => p.name === mt[1])?.id
    if (mine && msgId && pid && !isMe) out.push(<MentionDot key={'d' + mt.index} msgId={msgId} who={pid} />)
    last = (mt.index ?? 0) + mt[0].length
  }
  out.push(text.slice(last))
  return out
}
