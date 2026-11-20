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

export function Body({ m, compact = false }: { m: Bodied; compact?: boolean }) {
  const { answers } = useApp()
  if (m.k === 'text') {
    if (m.answerTo && answers[m.answerTo]) return <AnswerPill m={m} />
    if (!m.files?.length) return <TextBubble m={m} />
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
