import type { ReactNode } from 'react'
import type { Conversation } from '@/data'
import { Avatar } from '@/components/Avatar'
import { ListItem } from '@/components/ui/list-row'

/* 选一个会话的条目(关联会话、转发到):头像 + 会话名 + 「私聊 / 群聊 · N 人」 */
export function ConvItem({ c, onClick, testid, trailing }: { c: Conversation; onClick: () => void; testid: string; trailing?: ReactNode }) {
  return (
    <ListItem
      data-testid={testid}
      onClick={onClick}
      media={<Avatar id={c.kind === 'dm' ? c.members.find((m) => m !== 'me')! : 'me'} size={32} status={false} />}
      title={c.title}
      subtitle={<span className="tabular-nums">{c.kind === 'dm' ? '私聊' : `群聊 · ${c.members.length} 人`}</span>}
      trailing={trailing}
    />
  )
}
