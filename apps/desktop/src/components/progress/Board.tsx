import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  boardFacts, countFacts, filterFacts, groupBoard, groupHints, layoutBoard, lineage,
  type BoardFilter, type BoardWorld,
} from '@g-group/ui-core'
import { EmptyState } from '@/components/ui/section'
import { Button } from '@/components/ui/button'
import { BoardHead } from './BoardHead'
import { COLUMN, EMPTY, RANGE_LABEL, TILE_LABEL } from './copy'
import { panelMemory as memory } from './memory'
import { Card, ContactNode, HintNode, Inside, More, RootNode, scrollBack, type Hov } from './nodes'
import type { Target } from './useJump'
import './board.css'

/*
  进展全景看板:四级 对话(群聊 / 私聊)→ 联系人(仅群聊)→ Compute → 子代理 / 子对话 / 后台任务(#806),
  结构、样式、悬停、折叠、自适应布局照 mirasim「会话全景」(#872、#877);和它不同的只有两点:
  ① 单击就跳到真实入口(mirasim 单击开右侧检视、双击才打开);② 不显示花费 / 额度。
  纯逻辑(分组排序、过滤、群级提示、布局、血缘)在 @g-group/ui-core 的 board.ts。
*/

/** mirasim sj:看板滚动区宽度,布局按它自适应 */
function useWidth(ref: React.RefObject<HTMLDivElement | null>) {
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const f = () => setW(el.clientWidth)
    f()
    const ro = new ResizeObserver(f)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

export function Board({ world, onJump }: { world: BoardWorld; onJump: (t: Target) => void }) {
  const [filter, setFilter] = useState<BoardFilter>(memory.filter)
  const [unfolded, setUnfolded] = useState<Set<string>>(memory.unfolded)
  const [hover, setHover] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const width = useWidth(scroller)
  const set = (p: Partial<BoardFilter>) => { const f = { ...filter, ...p }; memory.filter = f; setFilter(f) }
  const unfold = (k: string, on: boolean) => setUnfolded((s) => {
    const n = new Set(s)
    if (on) n.add(k); else n.delete(k)
    memory.unfolded = n
    return n
  })
  const isOpen = useMemo(() => (k: string) => unfolded.has(k), [unfolded])

  const all = useMemo(() => boardFacts(world), [world])
  const scoped = useMemo(() => filterFacts(all, filter, world), [all, filter, world])
  const counts = useMemo(() => countFacts(scoped), [scoped])
  const shown = useMemo(() => (filter.bucket === 'all' ? scoped : scoped.filter((x) => x.group === filter.bucket)), [scoped, filter.bucket])
  const roots = useMemo(() => groupBoard(shown, filter.groupBy, isOpen, groupHints(shown)), [shown, filter.groupBy, isOpen])
  const L = useMemo(() => {
    if (width <= 0) return null
    const q = filter.query.trim().toLowerCase()
    return layoutBoard(roots, width, isOpen, (s) => q !== '' && s.title.toLowerCase().includes(q))
  }, [roots, width, isOpen, filter.query])
  const lit = useMemo(() => (L ? lineage(L.links, hover) : null), [L, hover])

  // 再打开时恢复上次的滚动位置
  const ready = L !== null
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && ready) { el.scrollTop = memory.scroll.top; el.scrollLeft = memory.scroll.left }
  }, [ready])

  const hov = (id: string): Hov => ({ onMouseEnter: () => setHover(id), onMouseLeave: () => setHover(null), onFocus: () => setHover(id), onBlur: () => setHover(null) })
  const byContact = filter.groupBy === 'contact'
  const now = world.now
  const ownerOf = (cid: string) => world.computes.find((c) => c.id === cid)

  /** 各类节点按 id 备好,再按布局给的深度优先顺序渲染:Tab 顺着「对话 → 联系人 → Compute → 子任务」走 */
  const nodes = new Map<string, ReactNode>()
  if (L) {
    for (const { id, root, box } of L.roots) nodes.set(id, <RootNode key={id} id={id} root={root} box={box} lit={lit} hov={hov(id)}
      onClick={() => onJump(root.conv ? { kind: 'conv', conv: root.conv.id } : { kind: 'person', person: root.person! })} />)
    for (const { id, hint, box } of L.hints) nodes.set(id, <HintNode key={id} id={id} hint={hint} box={box} lit={lit} onClick={() => onJump({ kind: 'conv', conv: hint.conv })} />)
    for (const { id, root, leaf, box } of L.contacts) nodes.set(id, <ContactNode key={id} id={id} root={root} leaf={leaf} box={box} lit={lit} hov={hov(id)}
      onClick={() => onJump({ kind: 'contact', conv: root.conv!.id, person: leaf.person })} />)
    for (const { id, fact, box } of L.cards) nodes.set(id, <Card key={id} id={id} f={fact} box={box} now={now} byContact={byContact} lit={lit} hov={hov(id)}
      onClick={() => onJump({ kind: 'compute', conv: fact.unit.conv, person: fact.unit.owner, compute: fact.unit.id, askMsg: fact.group === 'wait' ? fact.unit.askMsg : undefined })} />)
    for (const { id, owner, item, box } of L.inside) nodes.set(id, <Inside key={id} id={id} item={item} box={box} now={now} lit={lit} hov={hov(id)}
      onClick={() => { const u = ownerOf(owner); if (u) onJump({ kind: 'compute', conv: u.conv, person: u.owner, compute: u.id }) }} />)
    for (const m of L.more) nodes.set(`m:${m.key}`, <More key={m.key} m={m} onUnfold={() => unfold(m.key, true)} onFold={(el) => { scrollBack(el); unfold(m.key, false) }} />)
  }

  return (
    <section className="bd-board" data-testid="pano-board" aria-label="进展全景">
      <BoardHead filter={filter} counts={counts} set={set} />
      <div className="bd-body">
        <div className="bd-scroll" ref={scroller} data-testid="pano-canvas" onScroll={(e) => { memory.scroll = { top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft } }}>
          {L && roots.length > 0 && (
            <>
              <div className="bd-cols" style={{ width: L.width }} aria-hidden>
                <span style={{ left: L.columns.root }}>{byContact ? COLUMN.contact : COLUMN.room}</span>
                {L.columns.contact !== null && <span style={{ left: L.columns.contact }}>{COLUMN.contact}</span>}
                <span style={{ left: L.columns.cards }}>{COLUMN.cards} · {shown.length}</span>
                {L.columns.inside !== null && <span style={{ left: L.columns.inside }} data-testid="pano-col-inside">{COLUMN.inside}</span>}
              </div>
              <div className="bd-canvas" style={{ width: L.width, height: L.height }}>
                <svg className="bd-links" width={L.width} height={L.height} aria-hidden>
                  {L.links.map((k) => (
                    <path key={k.id} d={k.d} className="bd-link" data-group={k.group} data-more={k.more ? '' : undefined}
                      data-lit={lit?.has(k.id) ? '' : undefined} data-dim={lit && !lit.has(k.id) ? '' : undefined} />
                  ))}
                </svg>
                {L.order.map((id) => nodes.get(id))}
              </div>
            </>
          )}
          {L && roots.length === 0 && (
            <EmptyState className="bd-empty" title={<span data-testid="pano-empty">{EMPTY.title}</span>}
              hint={[RANGE_LABEL[filter.range], filter.bucket !== 'all' ? TILE_LABEL[filter.bucket] : '', filter.query ? `搜「${filter.query}」` : ''].filter(Boolean).join(' · ')}
              action={<Button variant="outline" size="xs" onClick={() => set({ range: 'all', bucket: 'all', query: '' })}>{EMPTY.reset}</Button>} />
          )}
        </div>
      </div>
    </section>
  )
}
