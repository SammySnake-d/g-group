/* 气泡行里放什么:按消息种类分派到各自的展示组件 */
import { useApp } from '@/ctx'
import { TextBubble } from './TextBubble'
import { AnswerPill } from './ask/AnswerPill'
import { ComputeLine } from './compute/ComputeLine'
import { BoardCard, FileCard, ForwardCard } from './cards/Attachments'
import { VoteCard } from './cards/VoteCard'
import { SummaryCard } from './cards/SummaryCard'
import { AuthFix } from './cards/AuthFix'
import type { Bodied } from './types'

export function Body({ m }: { m: Bodied }) {
  const { answers } = useApp()
  // 回答提问的那条消息显示成收起的卡片(卡片本身写着回答的是哪个问题)
  if (m.k === 'text') return m.answerTo && answers[m.answerTo] ? <AnswerPill m={m} /> : <TextBubble m={m} />
  if (m.k === 'compute') return <ComputeLine id={m.computeId} />
  if (m.k === 'file') return <FileCard id={m.artifactId} />
  if (m.k === 'board') return <BoardCard id={m.boardId} />
  if (m.k === 'forward') return <ForwardCard m={m} />
  if (m.k === 'vote') return <VoteCard m={m} />
  if (m.k === 'summary') return <SummaryCard m={m} />
  if (m.k === 'authfix') return <AuthFix m={m} />
  return null
}
