/* ============ 消息流:群聊、私聊、联系人资料共用 ============ */
import type { Msg } from '@/data'
import { useApp } from '@/ctx'
import { Row } from './Row'
import { Body } from './Body'
import { MsgMenu } from './MsgMenu'
import { continuesPrev, foldComputeTrails } from './grouping'
import { repeatsPrevQuote } from './quoteRuns'
import type { Bodied } from './types'
import { DateLine, SysLine, HuddleLine, CommitLine, AssetLine } from './lines/SysLines'
import { ReplyingCard } from './cards/ReplyingCard'

type Props = { msgs: Msg[]; compact?: boolean; highlight?: string | null; selecting?: boolean; selected?: Set<string>; onSelect?: (id: string) => void; conv?: string }

export function MessageList({ msgs: all, compact = false, highlight, selecting, selected, onSelect, conv }: Props) {
  const { computes, pending } = useApp()
  const { list: msgs, trailOf } = foldComputeTrails(all, computes)
  /** 一个回合的结尾:挂着要你回答的选项,或者下面挂着做完的过程 */
  const endsTurn = (x: Msg) => 'id' in x && (pending.some((p) => 'ask' in p && p.ask === x.id) || !!trailOf[x.id])
  /* 同一个人连着说、引用的是同一条:后面几句不重复画引用,相同引用不再拆开头像组。 */
  const sameQuote = msgs.map((m, i) => 'from' in m && m.k !== 'replying' && repeatsPrevQuote(msgs, i, m as Bodied))
  return (
    <div className="flex flex-col">
      {msgs.map((m, i) => {
        if (m.k === 'date') return <DateLine key={'d' + i} text={m.text} />
        if (m.k === 'sys') return <SysLine key={m.id} m={m} />
        if (m.k === 'huddle') return <HuddleLine key={m.id} m={m} conv={conv ?? ''} />
        if (m.k === 'commit') return <CommitLine key={m.id} m={m} />
        if (m.k === 'asset') return <AssetLine key={m.id} m={m} />
        if (m.k === 'replying') return <ReplyingCard key={m.id} m={m} />
        const row = (
          <Row key={m.id} m={m} first={!continuesPrev(msgs[i - 1], m, endsTurn, sameQuote[i])} hideQuotes={sameQuote[i]} compact={compact} highlight={highlight === m.id} selecting={selecting} checked={selected?.has(m.id)} onSelect={onSelect} trail={trailOf[m.id]}>
            <Body m={m} compact={compact} />
          </Row>
        )
        return compact || selecting ? row : <MsgMenu key={m.id} m={m}>{row}</MsgMenu>
      })}
    </div>
  )
}
