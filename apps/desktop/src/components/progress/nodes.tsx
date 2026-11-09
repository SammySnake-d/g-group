import { forwardRef, type ReactNode } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, CornerUpLeft, MessagesSquare } from 'lucide-react'
import {
  aggregate, bucketOf, formatClock, formatSpan, stallMinutes,
  type BoardBox, type BoardFact, type BoardLeaf, type BoardRoot, type GroupHint, type LayoutMore, type SubUnit,
} from '@g-group/ui-core'
import { Button, type ButtonProps } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { people } from '@/data'
import { Avatar, GroupAvatar } from '../Avatar'
import { DM_SOURCE, FOLD, MORE, REASON_TEXT, SUB_KIND_LABEL } from './copy'

/*
  看板节点:结构、样式、悬停、折叠照 mirasim「会话全景」(SR / NR / CR 组件);外观在 board.css。
  可点的节点都用 Button 原语(按下回馈、焦点环),去掉它的底色和尺寸变体,由 board.css 按 mirasim 画。
*/

export const BoardButton = forwardRef<HTMLButtonElement, ButtonProps>(({ className, ...props }, ref) => (
  <Button ref={ref} variant={null} size={null} shape={null} className={cn('bd-press', className)} {...props} />
))
BoardButton.displayName = 'BoardButton'

export type Hov = { onMouseEnter: () => void; onMouseLeave: () => void; onFocus: () => void; onBlur: () => void }
/** mirasim Da:悬停时链上的亮、其余变淡 */
export const litAttrs = (id: string, lit: Set<string> | null) => ({
  'data-lit': lit?.has(id) ? '' : undefined,
  'data-dim': lit && !lit.has(id) ? '' : undefined,
})
export const pos = (b: BoardBox) => ({ left: b.x, top: b.y, width: b.w, height: b.h })

/** 人 / 对话节点副标题「N 个 · N 等你 · N 失败」:按等你 → 失败 → 在跑最多带两项,全文在悬停提示里 */
function PersonSub({ xs }: { xs: readonly BoardFact[] }) {
  const a = aggregate(xs)
  const parts = ([['wait', '等你'], ['failed', '失败'], ['run', '在跑']] as const).filter(([k]) => a[k] > 0).slice(0, 2)
  const full = `${a.all} 个 Compute${a.wait ? `，${a.wait} 个等你` : ''}${a.failed ? `，${a.failed} 个失败` : ''}${a.run ? `，${a.run} 个在跑` : ''}`
  return (
    <span className="bd-person-sub" title={full}>
      {a.all} 个
      {parts.map(([k, t]) => <span key={k} data-group={k}> · {a[k]} {t}</span>)}
    </span>
  )
}

const name = (id: string) => people[id]?.name ?? id

export function RootNode({ root, box, lit, id, hov, onClick }: { root: BoardRoot; box: BoardBox; lit: Set<string> | null; id: string; hov: Hov; onClick: () => void }) {
  const conv = root.conv
  const face = !conv ? <Avatar id={root.person!} size={34} /> : conv.kind === 'group' ? <GroupAvatar ids={[...conv.members]} size={34} /> : <Avatar id={conv.members[0] ?? root.leaves[0]!.person} size={34} />
  return (
    <BoardButton className="bd-person" style={pos(box)} data-testid={`pano-root-${conv?.id ?? root.person}`} onClick={onClick} {...hov} {...litAttrs(id, lit)}>
      {face}
      <span className="bd-person-text">
        <span className="bd-person-name">{conv ? conv.name : name(root.person!)}</span>
        <PersonSub xs={root.all} />
      </span>
    </BoardButton>
  )
}

export function ContactNode({ root, leaf, box, lit, id, hov, onClick }: { root: BoardRoot; leaf: BoardLeaf; box: BoardBox; lit: Set<string> | null; id: string; hov: Hov; onClick: () => void }) {
  return (
    <BoardButton className="bd-person" style={pos(box)} data-testid={`pano-contact-${root.conv?.id}/${leaf.person}`} onClick={onClick} {...hov} {...litAttrs(id, lit)}>
      <Avatar id={leaf.person} size={30} />
      <span className="bd-person-text">
        <span className="bd-person-name">{name(leaf.person)}</span>
        <PersonSub xs={root.all.filter((x) => x.unit.owner === leaf.person)} />
      </span>
    </BoardButton>
  )
}

export function HintNode({ hint, box, lit, id, onClick }: { hint: GroupHint; box: BoardBox; lit: Set<string> | null; id: string; onClick: () => void }) {
  const who = hint.owner ? `${name(hint.owner)} 的 ` : ''
  return (
    <BoardButton className="bd-hint" style={pos(box)} data-testid={`pano-hint-${hint.conv}`} onClick={onClick} {...litAttrs(id, lit)}
      title={`${who}${hint.count} 个 Compute 因同一原因失败：${REASON_TEXT[hint.reason]}（${hint.upstream}）`}>
      <AlertTriangle aria-hidden />
      <span>{hint.count} 个同因失败：{REASON_TEXT[hint.reason]}</span>
    </BoardButton>
  )
}

function stateWord(f: BoardFact, now: number): string | null {
  const u = f.unit
  switch (f.group) {
    case 'run': return u.state === 'queued' ? '排队中' : `运行中 · 已跑 ${formatSpan(now - u.startedAt)}`
    case 'wait': return `等你回答 · ${formatSpan(now - u.lastProgressAt)}`
    case 'failed': return `失败 · ${REASON_TEXT[u.reason ?? 'unknown']}`
    case 'stopped': return '已停止'
    case 'done': return null // mirasim:完成的不写状态字
  }
}

/** 卡片第二行的事实:来源、模型、轮数、用时、最后进展、上游;按状态挑,没有花费(#877) */
function cardFacts(f: BoardFact, now: number, byContact: boolean): ReactNode[] {
  const u = f.unit
  const ran = (u.endedAt ?? now) - u.startedAt
  const out: ReactNode[] = []
  // 来源消息 #seq(D21#3):mirasim 写「↩#seq」,这里用图标代替字符箭头
  const seq = u.seq ? <span className="bd-seq" title={`来源消息 #${u.seq}`}><CornerUpLeft aria-hidden />#{u.seq}</span> : null
  if (byContact) out.push(<span key="src" className="bd-fact bd-fact-who"><MessagesSquare aria-hidden /><span>{f.conv.kind === 'group' ? f.conv.name : DM_SOURCE}</span>{seq}</span>)
  else if (seq) out.push(<span key="seq" className="bd-fact">{seq}</span>)
  switch (f.group) {
    case 'run': {
      if (u.state === 'queued') { out.push(<span key="q" className="bd-fact bd-fact-soft">{u.queuedBehind}</span>); break }
      const stall = stallMinutes(u, now, u.threshold?.minutes)
      if (stall !== null) out.push(<span key="st" className="bd-fact" data-group="wait">已 {stall} 分钟无进展</span>)
      out.push(<span key="m" className="bd-fact">{u.model}</span>, <span key="t" className="bd-fact">{u.turns} 轮</span>, <span key="at" className="bd-fact">{formatClock(u.startedAt, now)} 开始 · 最近 {formatClock(u.lastProgressAt, now)}</span>)
      break
    }
    case 'wait':
      out.push(<span key="ask" className="bd-fact bd-fact-soft" data-group="wait">问你：{u.asking}</span>, <span key="t" className="bd-fact">{u.turns} 轮</span>)
      break
    case 'failed':
      out.push(<span key="d" className="bd-fact">用时 {formatSpan(ran)}</span>, <span key="l" className="bd-fact">最后进展 {formatClock(u.lastProgressAt, now)}</span>,
        <span key="up" className="bd-fact bd-fact-soft">{u.upstream}{u.threshold?.custom ? ` · 按单独设的 ${u.threshold.minutes} 分判` : ''}</span>)
      break
    case 'stopped':
      out.push(<span key="d" className="bd-fact">用时 {formatSpan(ran)}</span>, <span key="e" className="bd-fact">{formatClock(u.endedAt ?? u.lastProgressAt, now)} 你停的</span>)
      break
    case 'done':
      out.push(<span key="m" className="bd-fact">{u.model}</span>, <span key="t" className="bd-fact">{u.turns} 轮</span>, <span key="d" className="bd-fact">用时 {formatSpan(ran)}</span>, <span key="e" className="bd-fact">{formatClock(u.endedAt ?? u.lastProgressAt, now)} 完成</span>)
      break
  }
  return out
}

export function Card({ id, f, box, now, byContact, lit, hov, onClick }: { id: string; f: BoardFact; box: BoardBox; now: number; byContact: boolean; lit: Set<string> | null; hov: Hov; onClick: () => void }) {
  const u = f.unit
  const word = stateWord(f, now)
  return (
    <BoardButton className="bd-card" style={pos(box)} data-group={f.group} data-testid={`pano-compute-${u.id}`} onClick={onClick} {...hov} {...litAttrs(id, lit)}>
      <span className="bd-card-top">
        <span className="bd-dot" data-group={f.group} data-live={u.state === 'running' ? '' : undefined} aria-hidden />
        <span className="bd-card-face"><Avatar id={u.owner} size={16} /></span>
        <span className="bd-card-title">{u.title}</span>
        {word && <span className="bd-card-state">{word}</span>}
      </span>
      <span className="bd-card-facts">{cardFacts(f, now, byContact)}</span>
    </BoardButton>
  )
}

export function Inside({ id, item, box, now, lit, hov, onClick }: { id: string; item: SubUnit; box: BoardBox; now: number; lit: Set<string> | null; hov: Hov; onClick: () => void }) {
  const g = bucketOf(item)
  const tail = g === 'failed' ? (item.state === 'orphaned' ? '已收掉' : '失败') : formatSpan((item.endedAt ?? now) - item.startedAt)
  return (
    <BoardButton className="bd-inside" data-kind={item.kind} style={pos(box)} data-testid={`pano-sub-${item.id}`} title={item.reasonRaw} onClick={onClick} {...hov} {...litAttrs(id, lit)}>
      <span className="bd-dot" data-group={g} data-live={item.state === 'running' ? '' : undefined} aria-hidden />
      <span className="bd-inside-label">{item.title}</span>
      <span className="bd-inside-sub" data-group={g === 'failed' ? 'failed' : undefined}>{SUB_KIND_LABEL[item.kind]} · {tail}</span>
    </BoardButton>
  )
}

/** 折叠:没展开时是「还有 N 个」;展开后「收起」吸在可视区底部,点了把列表顶部滚回视野(mirasim CR) */
export function More({ m, onUnfold, onFold }: { m: LayoutMore; onUnfold: () => void; onFold: (el: HTMLElement) => void }) {
  if (m.unfold) {
    return (
      <BoardButton className="bd-more" style={pos(m.box)} data-testid={`pano-more-${m.key}`} aria-expanded={false} onClick={onUnfold}>
        {MORE(m.n)}<ChevronDown aria-hidden />
      </BoardButton>
    )
  }
  return (
    <span className="bd-fold" style={{ left: m.box.x, top: m.from, width: m.box.w, height: m.box.y + m.box.h - m.from }}>
      <span className="bd-fold-pin">
        <BoardButton className="bd-more" style={{ height: m.box.h }} data-testid={`pano-more-${m.key}`} aria-expanded onClick={(e) => onFold(e.currentTarget)}>
          {FOLD}<ChevronUp aria-hidden />
        </BoardButton>
      </span>
    </span>
  )
}

/** 收起后把被折叠那一列的顶部滚回可视区(mirasim CR 的 scrollBack) */
export function scrollBack(el: HTMLElement) {
  const fold = el.closest('.bd-fold'), sc = el.closest('.bd-scroll')
  if (!fold || !sc) return
  const head = sc.querySelector('.bd-cols')?.getBoundingClientRect().height ?? 0
  const o = sc.getBoundingClientRect().top + head + 8 - fold.getBoundingClientRect().top
  if (o > 0) sc.scrollTop -= o
}
