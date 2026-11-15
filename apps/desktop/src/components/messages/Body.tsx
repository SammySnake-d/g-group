/* 气泡行里放什么:按消息种类分派到各自的展示组件 */
import { useApp } from '@/ctx'
import { cn } from '@/lib/utils'
import { MsgFiles } from './cards/MsgFiles'
import { TextBubble } from './TextBubble'
import { AnswerPill } from './ask/AnswerPill'
import { ComputeLine } from './compute/ComputeLine'
import { ComputeCardFor } from './compute/ComputeCardFor'
import { BoardCard, FileCard, ForwardCard } from './cards/Attachments'
import { VoteCard } from './cards/VoteCard'
import { SummaryCard } from './cards/SummaryCard'
import { AuthFix } from './cards/AuthFix'
import type { Bodied } from './types'

/** compact:完整过程面板这类只读的紧凑消息流,Compute 显示成卡片;聊天里是一行 */
export function Body({ m, compact = false }: { m: Bodied; compact?: boolean }) {
  const { answers } = useApp()
  // 回答提问的那条消息显示成收起的卡片(卡片本身写着回答的是哪个问题)
  if (m.k === 'text') {
    if (m.answerTo && answers[m.answerTo]) return <AnswerPill m={m} />
    if (!m.files?.length) return <TextBubble m={m} />
    /* 带附件:有话先画气泡,附件卡排在下面;只有附件就只画卡 */
    return (
      <div className={cn('flex flex-col gap-1.5', m.from === 'me' ? 'items-end' : 'items-start')}>
        {m.text && <TextBubble m={m} />}
        <MsgFiles m={m} />
      </div>
    )
  }
  if (m.k === 'compute') return compact ? <ComputeCardFor id={m.computeId} /> : <ComputeLine id={m.computeId} />
  if (m.k === 'file') return <FileCard id={m.artifactId} />
  if (m.k === 'board') return <BoardCard id={m.boardId} />
  if (m.k === 'forward') return <ForwardCard m={m} />
  if (m.k === 'vote') return <VoteCard m={m} />
  if (m.k === 'summary') return <SummaryCard m={m} />
  if (m.k === 'authfix') return <AuthFix m={m} />
  return null
}
