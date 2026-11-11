/* 一条消息的一行:头像列 + 名字行 + 引用 + 气泡(悬停工具条和回执挂在气泡上)+ 气泡下的附属(提问卡片、归属、定时、交代、过程灰字、表情) */
import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people } from '@/data'
import { useApp } from '@/ctx'
import { candidate } from '@/mut'
import { ReceiptButton } from '@/components/Receipt'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { HoverBar } from './HoverBar'
import { PersonMenu } from './PersonMenu'
import { SentQuotes } from './SentQuotes'
import { Reactions } from './Reactions'
import { TaskTag } from './TaskTag'
import { CronTrail } from './CronTrail'
import { DispLine } from './DispLine'
import { AskCard } from './ask/AskCard'
import { HelperExtra } from './cards/HelperExtra'
import * as Concept from '@/concept'
import { ComputeLine } from './compute/ComputeLine'
import type { Bodied } from './types'

type RowProps = { m: Bodied; first: boolean; compact: boolean; highlight: boolean; selecting?: boolean; checked?: boolean; onSelect?: (id: string) => void; trail?: string; children: ReactNode }

/** 新到的消息(本地发出 / 刚收到)进场时轻轻浮起,历史消息不动 */
const isNew = (id: string) => /^(me-|h|c-|s)[a-z0-9]{6}$/.test(id)

export function Row({ m, first, compact, highlight, selecting, checked, onSelect, trail, children }: RowProps) {
  const from = m.from
  const mine = from === 'me'
  const av = compact ? 26 : 32
  const { answers } = useApp()
  // 回答消息显示成收起的卡片,卡片本身就写着回答的是哪个问题,不再叠一层引用
  const quotes = m.k === 'text' && !(m.answerTo && answers[m.answerTo]) ? m.quotes : undefined
  return (
    <div
      id={'m-' + m.id}
      data-hl={highlight ? '1' : undefined}
      data-msg={m.id}
      data-from={'from' in m ? m.from : undefined}
      onClick={selecting ? () => onSelect?.(m.id) : undefined}
      className={cn('group/row relative -mx-2 flex items-start gap-2.5 rounded-xl px-2 py-[1px] transition-colors duration-slow ease-out', first && 'mt-4', isNew(m.id) && 'msg-new', mine && 'flex-row-reverse', highlight && 'bg-warm-soft', selecting && 'cursor-pointer hover:bg-hover/60', checked && 'bg-sel/70')}
    >
      {selecting && (
        <span aria-hidden className={cn('mb-2 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border transition-colors duration-fast ease-out', checked ? 'border-me bg-me text-me-fg' : 'border-fg-3')}>{checked && <Check className="h-3 w-3" strokeWidth={3} />}</span>
      )}
      {!mine && (
        <div className="shrink-0 pt-0.5" style={{ width: av }}>
          {first && (
            <PersonMenu id={from}>
              <Button data-testid={`avatar-${from}-${m.id}`} aria-label={people[from]?.name} variant={null} size={null} shape="pill" className="block"><Concept.GazeAvatar msgId={m.id} id={from} size={av} /></Button>
            </PersonMenu>
          )}
        </div>
      )}
      <div className={cn('relative flex min-w-0 flex-col', compact ? 'max-w-[88%]' : 'max-w-[min(680px,78%)]', mine ? 'items-end' : 'items-start')}>
        {first && !mine && <RowHead m={m} />}
        {quotes && quotes.length > 0 && <SentQuotes quotes={quotes} mine={mine} />}
        {/* AC-46 / D09.3:你发的消息在气泡外侧底边挂一个回执按钮(你的消息靠右,外侧就是左边),不另占一行(原则 57) */}
        {/* 悬浮工具条挂在气泡本身上(#719:要贴着消息,不能相对整列漂;#1032:压在气泡右上角) */}
        {mine && m.k === 'text' ? (
          <div className="relative flex max-w-full items-end" data-anchor={m.id}>
            <span className="absolute -left-[24px] bottom-[2px]" data-testid={`receipt-slot-${m.id}`}><ReceiptButton msgId={m.id} /></span>
            {children}
            {!compact && !selecting && <HoverBar m={m} mine={mine} />}
          </div>
        ) : (
          <div className="relative max-w-full" data-anchor={m.id}>
            {children}
            {!compact && !selecting && <HoverBar m={m} mine={mine} />}
          </div>
        )}
        {m.k === 'text' && m.helper && <HelperExtra m={m} />}
        {m.k === 'text' && <AskCard msgId={m.id} />}
        {m.k === 'text' && m.tag && <TaskTag msgId={m.id} tag={m.tag} />}
        {m.k === 'text' && m.cron && <CronTrail m={m} mine={mine} />}
        <RowFoot m={m} mine={mine} trail={trail} />
      </div>
    </div>
  )
}

/** 名字行:名字 + 身份(软件助手 / 助手)+ 时间。只在一组连续消息的第一条出现 */
function RowHead({ m }: { m: Bodied }) {
  const p = people[m.from]
  return (
    <div className="mb-1 ml-0.5 flex items-center gap-1.5 text-[12.5px]">
      <span className="font-semibold text-fg">{p?.name}</span>
      {m.from === 'helper' ? <Chip tone="warm" size="xs">软件助手 · 只听你的</Chip> : !p?.human && <Chip size="xs" className="font-normal text-fg-3">助手</Chip>}
      {m.k === 'text' && m.at && <span className="text-[11.5px] tabular-nums text-fg-3">{m.at}</span>}
    </div>
  )
}

/** 气泡下那一行。#1839 空间是珍惜资源:过程灰字和表情共用一行,灰字靠左、表情靠右下角;
 *  我的消息:交代和表情并成一行(表情靠左、交代靠右)。#2862 起表情只是普通回应,已读看气泡外侧的回执按钮 */
function RowFoot({ m, mine, trail }: { m: Bodied; mine: boolean; trail?: string }) {
  if (m.k === 'text' && m.disp && candidate('D23') && !trail) return (
    <div className="mt-0.5 flex min-w-0 items-center justify-end gap-2 self-stretch" data-testid={`foot-${m.id}`}>
      <Reactions msgId={m.id} mine={mine} inline />
      <DispLine m={m} />
    </div>
  )
  if (trail) return (
    <div className="mt-1 flex min-w-0 items-center gap-2 self-stretch" data-testid={`foot-${m.id}`}>
      <div className="min-w-0 flex-1" data-testid={`trail-${m.id}`}><ComputeLine id={trail} /></div>
      <Reactions msgId={m.id} mine={mine} inline />
    </div>
  )
  return <Reactions msgId={m.id} mine={mine} />
}
