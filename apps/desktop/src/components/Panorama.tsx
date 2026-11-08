import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, dutyByConv, dutyDefault, type Compute, type Conversation, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { cronWhen, cronRepeat } from './CronDetail'
import { Avatar, GroupAvatar } from './Avatar'
import { ProcessView } from './Workbench'

type StatKey = 'waiting' | 'running' | 'error' | 'done' | 'cron'
type Scope = 'all' | 'conv' | 'person'
type Sel = { t: 'conv'; conv: string } | { t: 'person'; conv: string; pid: PersonId } | { t: 'compute'; id: string } | null

/** 回到进展时保留筛选、选中和滚动位置（组件会随左侧切换重挂载） */
const saved = { stat: null as StatKey | null, scope: 'all' as Scope, conv: '', person: '', range: 'week' as 'today' | 'week', sel: null as Sel, scrollTop: 0, openDone: [] as string[] }

const NOW = '02:20'

const convLabel = (c: Conversation) => {
  if (c.kind === 'group') return c.title
  const peer = c.members.find((m) => m !== 'me')
  return `与 ${peer ? people[peer].name : c.title} 私聊`
}

function ConvMark({ c, size = 22 }: { c: Conversation; size?: number }) {
  const peer = c.members.find((m) => m !== 'me')
  return c.kind === 'group' ? <GroupAvatar ids={c.members} size={size} /> : <Avatar id={peer ?? 'me'} size={size} status={false} mood="idle" />
}

const stepNo = (c: Compute) => {
  const done = c.steps.filter((s) => s.state === 'done').length
  return `第 ${Math.min(done + 1, c.steps.length)}/共 ${c.steps.length} 步`
}

function counts(list: Compute[]) {
  return { waiting: list.filter((c) => c.status === 'waiting').length, running: list.filter((c) => c.status === 'running').length, error: list.filter((c) => c.status === 'error').length, done: list.filter((c) => c.status === 'done').length }
}

function Summary({ list }: { list: Compute[] }) {
  const n = counts(list)
  const parts: string[] = []
  if (n.waiting) parts.push(`等你 ${n.waiting}`)
  if (n.running) parts.push(`在跑 ${n.running}`)
  if (n.error) parts.push(`出错 ${n.error}`)
  if (!parts.length) parts.push(n.done ? `做完 ${n.done} 个` : '没有在做的事')
  return <div className="truncate text-[12px] text-fg-2">{parts.join(' · ')}</div>
}

export function Panorama() {
  const { computes, convs, crons, checklist, pending, resolve } = useApp()
  const [stat, setStatS] = useState(saved.stat)
  const [scope, setScopeS] = useState(saved.scope)
  const [fConv, setFConvS] = useState(saved.conv)
  const [fPerson, setFPersonS] = useState(saved.person)
  const [range, setRangeS] = useState(saved.range)
  const [sel, setSelS] = useState<Sel>(saved.sel)
  const [openDone, setOpenDoneS] = useState<string[]>(saved.openDone)
  const scroller = useRef<HTMLDivElement>(null)
  const setStat = (v: StatKey | null) => { saved.stat = v; setStatS(v) }
  const setScope = (v: Scope) => { saved.scope = v; setScopeS(v) }
  const setFConv = (v: string) => { saved.conv = v; setFConvS(v) }
  const setFPerson = (v: string) => { saved.person = v; setFPersonS(v) }
  const setRange = (v: 'today' | 'week') => { saved.range = v; setRangeS(v) }
  const setSel = (v: Sel) => { saved.sel = v; setSelS(v) }
  const toggleDone = (k: string) => { const n = openDone.includes(k) ? openDone.filter((x) => x !== k) : [...openDone, k]; saved.openDone = n; setOpenDoneS(n) }
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollTop = saved.scrollTop }, [])

  const all = Object.values(computes)
  const total = counts(all)
  const cronToday = crons.filter((c) => c.day === '今天').length
  const activeConvs = convs.filter((c) => all.some((x) => x.conv === c.id) || checklist.some((t) => t.conv === c.id))
  const bots = Array.from(new Set(all.map((c) => c.owner).concat(checklist.flatMap((t) => (t.who ? [t.who] : [])))))

  const convOk = (id: string) => scope !== 'conv' || !fConv || fConv === id
  const personOk = (id: PersonId) => scope !== 'person' || !fPerson || fPerson === id
  const statOk = (c: Compute) => !stat || stat === 'cron' || c.status === stat

  const tree = useMemo(() => activeConvs.filter((c) => convOk(c.id)).map((c) => {
    const inConv = all.filter((x) => x.conv === c.id)
    const pids = Array.from(new Set(inConv.map((x) => x.owner).concat(checklist.filter((t) => t.conv === c.id && t.who).map((t) => t.who!)))).filter(personOk)
    const persons = pids.map((pid) => ({ pid, list: inConv.filter((x) => x.owner === pid) })).filter((p) => !stat || stat === 'cron' || p.list.some(statOk))
    return { c, inConv, persons }
  }).filter((g) => g.persons.length > 0 || (!stat && scope !== 'person')),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [computes, convs, checklist, scope, fConv, fPerson, stat])

  const stats: { k: StatKey; label: string; n: number; cls: string }[] = [
    { k: 'waiting', label: '等你', n: total.waiting, cls: 'text-warm' },
    { k: 'running', label: '进行中', n: total.running, cls: 'text-run' },
    { k: 'error', label: '出错', n: total.error, cls: 'text-err' },
    { k: 'done', label: '已完成', n: total.done, cls: 'text-fg-3' },
    { k: 'cron', label: '今天的定时', n: cronToday, cls: 'text-fg' },
  ]

  const errPending = (cid: string) => pending.find((p) => p.kind === 'error' && p.computeId === cid)
  const isSel = (s: Sel) => JSON.stringify(s) === JSON.stringify(sel)
  const cronList = crons.filter((r) => convOk(r.conv) && personOk(r.owner) && (range === 'week' || r.day === '今天'))

  return (
    <div className="flex min-w-0 flex-1" data-testid="panorama">
      <main ref={scroller} onScroll={(e) => { saved.scrollTop = e.currentTarget.scrollTop }} className="scroll-thin min-w-0 flex-1 overflow-y-auto">
        <div className="px-7 pb-10 pt-6">
          <h1 className="text-[20px] font-semibold tracking-tight">进展</h1>
          <p className="mt-0.5 text-[13px] text-fg-2">所有群和私聊里，助手在做的事</p>

          <div className="mt-5 grid grid-cols-5 gap-2.5">
            {stats.map((s) => (
              <button key={s.k} data-testid={`pano-stat-${s.k}`} data-on={stat === s.k ? '1' : '0'} onClick={() => setStat(stat === s.k ? null : s.k)}
                className={cn('rounded-xl border px-4 py-3 text-left transition hover:bg-hover', stat === s.k ? 'border-fg/40 bg-sel' : 'border-line',
                  s.k === 'waiting' && s.n > 0 && 'bg-warm-soft', s.k === 'error' && s.n > 0 && 'border-l-2 border-l-err')}>
                <div className={cn('text-[26px] font-semibold leading-none tabular-nums', s.cls)}>{s.n}</div>
                <div className={cn('mt-1.5 flex items-center gap-1 text-[12.5px]', s.k === 'waiting' && s.n > 0 ? 'font-semibold text-warm' : 'text-fg-2')}>
                  {s.k === 'error' && s.n > 0 && <AlertTriangle className="h-3 w-3 text-err" />}
                  {s.k === 'running' && s.n > 0 && <Loader2 className="h-3 w-3 animate-spin text-run" />}
                  {s.label}{stat === s.k && <span className="text-fg-3">· 已筛选</span>}
                </div>
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px]">
            <div className="flex rounded-lg bg-hover p-0.5">
              {([['all', '全部', 'pano-group-all'], ['conv', '按群', 'pano-group-conv'], ['person', '按联系人', 'pano-group-person']] as const).map(([k, l, t]) => (
                <button key={k} data-testid={t} onClick={() => setScope(k)} className={cn('rounded-md px-3 py-1', scope === k ? 'bg-elev font-medium shadow-elev' : 'text-fg-2 hover:text-fg')}>{l}</button>
              ))}
            </div>
            <select data-testid="pano-pick-conv" value={fConv} onChange={(e) => { setFConv(e.target.value); if (e.target.value) setScope('conv') }} className="h-8 rounded-lg border border-line bg-bg px-2 text-[13px]">
              <option value="">所有群和私聊</option>
              {activeConvs.map((c) => <option key={c.id} value={c.id}>{convLabel(c)}</option>)}
            </select>
            <select data-testid="pano-pick-person" value={fPerson} onChange={(e) => { setFPerson(e.target.value); if (e.target.value) setScope('person') }} className="h-8 rounded-lg border border-line bg-bg px-2 text-[13px]">
              <option value="">所有联系人</option>
              {bots.map((p) => <option key={p} value={p}>{people[p].name}</option>)}
            </select>
            <div className="ml-auto flex rounded-lg bg-hover p-0.5">
              {([['today', '今天'], ['week', '本周']] as const).map(([k, l]) => (
                <button key={k} data-testid={`pano-range-${k}`} onClick={() => setRange(k)} className={cn('rounded-md px-3 py-1', range === k ? 'bg-elev font-medium shadow-elev' : 'text-fg-2 hover:text-fg')}>{l}</button>
              ))}
            </div>
          </div>

          <div className="mt-5 grid grid-cols-[220px_220px_1fr] gap-x-8 px-1 text-[12px] font-medium text-fg-3"><span>会话</span><span>联系人</span><span>Compute</span></div>
          <div className="mt-2 space-y-4" data-testid="pano-board">
            {tree.length === 0 && <div className="rounded-xl border border-dashed border-line py-10 text-center text-[13px] text-fg-3">这个筛选下没有事情</div>}
            {tree.map(({ c, inConv, persons }) => (
              <div key={c.id} className="grid grid-cols-[220px_1fr] gap-x-8">
                <button data-testid={`pano-conv-${c.id}`} onClick={() => setSel({ t: 'conv', conv: c.id })}
                  className={cn('relative self-start rounded-xl border bg-elev p-3 text-left transition hover:border-fg-3/50', isSel({ t: 'conv', conv: c.id }) ? 'border-fg/50 ring-1 ring-fg/20' : 'border-line')}>
                  <div className="flex items-center gap-2"><ConvMark c={c} /><span className="truncate text-[14px] font-semibold">{convLabel(c)}</span></div>
                  <div className="mt-1.5"><Summary list={inConv} /></div>
                  {persons.length > 0 && <span className="absolute -right-8 top-6 h-px w-8 bg-line" />}
                </button>
                <div className="relative space-y-2.5 border-l border-line pl-0">
                  {persons.length === 0 && <div className="py-3 pl-4 text-[12.5px] text-fg-3">清单里有事，还没人接</div>}
                  {persons.map(({ pid, list }) => {
                    const shown = list.filter(statOk)
                    const live = shown.filter((x) => x.status !== 'done')
                    const done = shown.filter((x) => x.status === 'done')
                    const key = `${c.id}-${pid}`
                    const open = openDone.includes(key) || stat === 'done'
                    const ps: Sel = { t: 'person', conv: c.id, pid }
                    return (
                      <div key={pid} className="relative grid grid-cols-[220px_1fr] gap-x-8 pl-4">
                        <span className="absolute left-0 top-6 h-px w-4 bg-line" />
                        <button data-testid={`pano-person-${c.id}-${pid}`} onClick={() => setSel(ps)}
                          className={cn('relative self-start rounded-xl border bg-elev p-2.5 text-left transition hover:border-fg-3/50', isSel(ps) ? 'border-fg/50 ring-1 ring-fg/20' : 'border-line')}>
                          <div className="flex items-center gap-2"><Avatar id={pid} size={22} status={false} mood="idle" /><span className="truncate text-[13.5px] font-medium">{people[pid].name}</span></div>
                          <div className="mt-1 truncate text-[12px] text-fg-3">{dutyByConv[c.id]?.[pid] ?? dutyDefault[pid] ?? people[pid].role}</div>
                          <div className="mt-0.5"><Summary list={list} /></div>
                          {shown.length > 0 && <span className="absolute -right-8 top-6 h-px w-8 bg-line" />}
                        </button>
                        <div className="min-w-0 space-y-1.5 border-l border-line pl-4">
                          {shown.length === 0 && <div className="py-2 text-[12px] text-fg-3">认领了清单，还没开始</div>}
                          {live.map((x) => <ComputeCard key={x.id} c={x} sel={isSel({ t: 'compute', id: x.id })} onPick={() => setSel({ t: 'compute', id: x.id })} onRetry={() => { const p = errPending(x.id); if (p) resolve(p.id, 'retry') }} />)}
                          {done.length > 0 && (open
                            ? <>{done.map((x) => <ComputeCard key={x.id} c={x} sel={isSel({ t: 'compute', id: x.id })} onPick={() => setSel({ t: 'compute', id: x.id })} />)}
                                {stat !== 'done' && <button onClick={() => toggleDone(key)} className="flex items-center gap-1 px-2 text-[12px] text-fg-3 hover:text-fg-2"><ChevronDown className="h-3 w-3" />收起做完的</button>}</>
                            : <button data-testid={`pano-done-${key}`} onClick={() => toggleDone(key)} className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-fg-3 hover:bg-hover hover:text-fg-2"><Check className="h-3 w-3" strokeWidth={2.5} />做完 {done.length} 个<ChevronRight className="h-3 w-3" /></button>)}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          <TaskTimeline convOk={convOk} />
          <CronTimeline list={cronList} scope={scope} highlight={stat === 'cron'} />
        </div>
      </main>
      <aside data-testid="pano-detail" className="scroll-thin w-[380px] shrink-0 overflow-y-auto border-l border-line bg-side">
        <Detail sel={sel} />
      </aside>
    </div>
  )
}

function ComputeCard({ c, sel, onPick, onRetry }: { c: Compute; sel: boolean; onPick: () => void; onRetry?: () => void }) {
  const base = 'group flex w-full max-w-[420px] items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition'
  const ring = sel ? 'ring-1 ring-fg/30' : ''
  if (c.status === 'waiting') return (
    <div data-testid={`pano-compute-${c.id}`} onClick={onPick} role="button" className={cn(base, ring, 'cursor-pointer border-warm/40 bg-warm-soft')}>
      <span className="h-2 w-2 shrink-0 rounded-full bg-warm-dot" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{c.title}</span>
      <span className="shrink-0 rounded-md bg-warm px-2 py-0.5 text-[12px] font-medium text-white">等你回复</span>
    </div>
  )
  if (c.status === 'error') return (
    <div data-testid={`pano-compute-${c.id}`} onClick={onPick} role="button" className={cn(base, ring, 'cursor-pointer border-line border-l-2 border-l-err bg-err-soft/40')}>
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-err" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-err">{c.title} · 出错了</span>
      {onRetry && <button data-testid={`pano-retry-${c.id}`} onClick={(e) => { e.stopPropagation(); onRetry() }} className="shrink-0 rounded-md border border-err/40 px-2 py-0.5 text-[12px] font-medium text-err hover:bg-err-soft">重试</button>}
    </div>
  )
  if (c.status === 'running') return (
    <button data-testid={`pano-compute-${c.id}`} onClick={onPick} className={cn(base, ring, 'border-line bg-elev hover:border-fg-3/50')}>
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-run" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{c.title}</span>
      <span className="shrink-0 text-[12px] text-run">{stepNo(c)}</span>
      <span className="shrink-0 text-[12px] text-fg-3">{c.elapsed}</span>
    </button>
  )
  return (
    <button data-testid={`pano-compute-${c.id}`} onClick={onPick} className={cn(base, ring, 'border-transparent py-1 hover:bg-hover')}>
      <Check className="h-3 w-3 shrink-0 text-fg-3" strokeWidth={2.5} />
      <span className="min-w-0 flex-1 truncate text-[12px] text-fg-3">{c.title}{c.status === 'stopped' ? ' · 已停止' : ''}</span>
      <span className="shrink-0 text-[11.5px] text-fg-3">{c.elapsed}</span>
    </button>
  )
}
/* 看绿：正常、同一时间重复的折成一行“每天 08:00 ×3”，出错的永远单独一行（#1286） */
function foldRows(rows: import('@/data').Cron[]) {
  const out: { rows: import('@/data').Cron[] }[] = []
  for (const r of rows) {
    const g = r.state === 'ok' ? out.find((x) => x.rows[0].state === 'ok' && x.rows[0].time === r.time && x.rows[0].repeat === r.repeat) : undefined
    if (g) g.rows.push(r); else out.push({ rows: [r] })
  }
  return out
}
function FoldedCron({ rows, render }: { rows: import('@/data').Cron[]; render: (r: import('@/data').Cron) => React.ReactNode }) {
  const [open, setOpen] = useState(false)
  if (open) return <div>{rows.map((r) => render(r))}<button onClick={() => setOpen(false)} className="text-[12px] text-fg-3 hover:text-fg">收起</button></div>
  return (
    <button data-testid={`pano-cron-fold-${rows[0].time}`} onClick={() => setOpen(true)} className="flex w-full items-center gap-2.5 py-1.5 text-left text-[13px] text-fg-2 hover:text-fg">
      <span className="w-11 shrink-0 tabular-nums">{rows[0].time}</span>
      <span className="flex -space-x-1">{rows.map((r) => <Avatar key={r.id} id={r.owner} size={18} status={false} mood="idle" />)}</span>
      <span className="flex-1">{rows[0].repeat} {rows[0].time} ×{rows.length} · 都正常</span>
      <ChevronRight className="h-3.5 w-3.5 text-fg-3" />
    </button>
  )
}

function CronTimeline({ list, scope, highlight }: { list: import('@/data').Cron[]; scope: Scope; highlight: boolean }) {
  const { convs, openSplit, setPanoOpen } = useApp()
  const days = (['今天', '明天', '本周'] as const).map((d) => ({ d, items: list.filter((r) => r.day === d && r.state !== 'error').sort((a, b) => a.time.localeCompare(b.time)) })).filter((x) => x.items.length)
  const label = (cid: string) => { const c = convs.find((x) => x.id === cid); return c ? convLabel(c) : cid }
  const groupKey = (r: import('@/data').Cron) => (scope === 'person' ? people[r.owner].name : scope === 'conv' ? label(r.conv) : '')
  const Row = (r: import('@/data').Cron) => (
    <div key={r.id} role="button" onClick={() => { setPanoOpen(false); openSplit({ t: 'cron', id: r.id }) }} data-testid={`pano-cron-${r.id}`} className={cn('flex cursor-pointer items-center gap-2.5 rounded-md py-1.5 text-[13px] hover:bg-hover', r.state === 'error' && 'border-l-2 border-l-err pl-2', r.paused && 'opacity-55')}>
      <span className="w-11 shrink-0 tabular-nums text-fg-2">{cronWhen(r)}</span>
      <Avatar id={r.owner} size={18} status={false} mood="idle" />
      <span className={cn('min-w-0 flex-1 truncate', r.state === 'error' ? 'text-err' : r.state === 'skipped' ? 'italic text-fg-3' : '')}>
        {r.state === 'error' && <AlertTriangle className="mr-1 inline h-3 w-3" />}{r.text}
      </span>
      <span className="shrink-0 text-[12px] text-fg-3">{cronRepeat(r)}</span>
      <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[11.5px] text-fg-2">{label(r.conv)}</span>
      {r.last && <span className={cn('w-[180px] shrink-0 truncate text-right text-[12px]', r.state === 'error' ? 'text-err' : r.state === 'skipped' ? 'italic text-fg-3' : 'text-fg-3')}>{r.last}</span>}
    </div>
  )
  return (
    <section data-testid="pano-cron" className={cn('mt-8 rounded-xl border p-4', highlight ? 'border-fg/40' : 'border-line')}>
      <div className="flex items-baseline gap-2"><h2 className="text-[15px] font-semibold">定时</h2><span className="text-[12px] text-fg-3">今天 / 明天 / 本周 · 每条是某个联系人自己的闹钟</span></div>
      {days.length === 0 && <div className="py-4 text-[13px] text-fg-3">这个筛选下没有定时</div>}
      {/* 异常置顶（#1858）：出错的先看，不用在时间轴里找 */}
      {list.some((r) => r.state === 'error') && (
        <div data-testid="pano-cron-errors" className="mt-3 rounded-lg bg-err-soft/50 px-2 py-1">
          <div className="py-0.5 text-[12px] font-medium text-err">要处理 {list.filter((r) => r.state === 'error').length}</div>
          {list.filter((r) => r.state === 'error').map((r) => (
            <button key={'e' + r.id} data-testid={`pano-cron-err-${r.id}`} onClick={() => { setPanoOpen(false); openSplit({ t: 'cron', id: r.id }) }} className="flex w-full items-center gap-2.5 rounded-md py-1.5 text-left text-[13px] hover:bg-hover">
              <span className="w-11 shrink-0 tabular-nums text-fg-2">{cronWhen(r)}</span><Avatar id={r.owner} size={18} status={false} mood="idle" />
              <span className="min-w-0 flex-1 truncate text-err"><AlertTriangle className="mr-1 inline h-3 w-3" />{r.text}</span>
              <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[11.5px] text-fg-2">{label(r.conv)}</span>
              <span className="shrink-0 text-[12px] text-err">{r.last}</span>
            </button>
          ))}
        </div>
      )}
      {days.map(({ d, items }) => {
        const keys = Array.from(new Set(items.map(groupKey)))
        return (
          <div key={d} className="mt-3">
            <div className="mb-1 text-[12px] font-medium text-fg-2">{d}</div>
            {keys.map((k) => {
              const rows = items.filter((r) => groupKey(r) === k)
              const cut = d === '今天' ? rows.findIndex((r) => r.time >= NOW) : -1
              return (
                <div key={k || 'all'} className={cn(k && 'mb-2')}>
                  {k && <div className="py-1 text-[11.5px] text-fg-3">{k}</div>}
                  {foldRows(rows).map((g) => (
                    <div key={g.rows[0].id}>
                      {rows.indexOf(g.rows[0]) === cut && <NowLine />}
                      {g.rows.length > 1 ? <FoldedCron rows={g.rows} render={Row} /> : Row(g.rows[0])}
                    </div>
                  ))}
                  {d === '今天' && cut === -1 && <NowLine />}
                </div>
              )
            })}
          </div>
        )
      })}
    </section>
  )
}

function NowLine() {
  return <div data-testid="pano-now" className="my-1 flex items-center gap-2 text-[11.5px] font-medium text-err"><span className="h-1.5 w-1.5 rounded-full bg-err" />现在 {NOW}<span className="h-px flex-1 bg-err/50" /></div>
}

function Detail({ sel }: { sel: Sel }) {
  const { computes, convs, checklist, crons, openConv, openWorkbench, openSplit, pending, resolve } = useApp()
  const [proc, setProc] = useState<string | null>(null)
  const procKey = sel ? JSON.stringify(sel) : ''
  if (!sel) return <div className="grid h-full place-items-center px-8 text-center text-[13px] text-fg-3"><div><MessageSquare className="mx-auto mb-2 h-5 w-5" />点左边任意一张卡，在这里看详情。<br />不会离开进展。</div></div>
  const convOf = (id: string) => convs.find((c) => c.id === id)
  const OpenConv = ({ id }: { id: string }) => { const c = convOf(id); return c ? <button data-testid="pano-open-conv" onClick={() => openConv(id)} className="h-8 rounded-lg border border-line px-3 text-[13px] hover:bg-hover">打开「{convLabel(c)}」</button> : null }
  const Source = ({ id }: { id: string }) => { const c = convOf(id); return c ? <span className="inline-flex items-center gap-1.5 rounded-md bg-hover px-2 py-0.5 text-[12px] text-fg-2"><ConvMark c={c} size={16} />{convLabel(c)}</span> : null }

  if (sel.t === 'compute') {
    const c = computes[sel.id]
    if (!c) return null
    const acc = pending.find((p) => p.kind === 'accept' && p.computeId === c.id)
    const err = pending.find((p) => p.kind === 'error' && p.computeId === c.id)
    const showProc = proc === procKey
    return (
      <div className="p-5">
        <Source id={c.conv} />
        <h3 className="mt-2 text-[16px] font-semibold leading-snug">{c.title}</h3>
        <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-fg-2"><Avatar id={c.owner} size={16} status={false} mood="idle" />{people[c.owner].name} · {c.elapsed} · {c.model}</div>
        {acc && <div className="mt-3 flex items-center gap-2 rounded-lg bg-warm-soft p-2.5" data-testid="pano-delivered"><span className="flex-1 text-[13px] font-semibold text-warm">做完了，在聊天里 @你了 · 回一句就行</span><button onClick={() => openConv(c.conv)} className="h-7 rounded-md bg-btn px-2.5 text-[12.5px] font-medium text-btn-fg">去回复</button></div>}
        {err && <div className="mt-3 flex items-center gap-2 rounded-lg border-l-2 border-l-err bg-err-soft p-2.5 text-[13px] text-err"><AlertTriangle className="h-3.5 w-3.5" /><span className="flex-1">{c.error ?? '出错了'}</span><button onClick={() => resolve(err.id, 'retry')} className="h-7 rounded-md border border-err/40 px-2 text-[12.5px] font-medium">重试</button></div>}
        <div className="mt-4 text-[12px] font-medium text-fg-3">步骤</div>
        <ol className="mt-1.5 space-y-1">
          {c.steps.map((s, i) => (
            <li key={i} className={cn('flex items-center gap-2 text-[13px]', s.state === 'done' ? 'text-fg-3' : s.state === 'fail' ? 'text-err' : s.state === 'now' ? 'font-medium' : 'text-fg-2')}>
              <span className="w-4 shrink-0 text-center text-[11.5px] tabular-nums text-fg-3">{i + 1}</span>{s.text}
            </li>
          ))}
        </ol>
        {c.result && <><div className="mt-4 text-[12px] font-medium text-fg-3">结果</div><p className="mt-1 text-[13px] leading-relaxed">{c.result}</p></>}
        <div className="mt-5 flex flex-wrap gap-2">
          <button data-testid="pano-show-process" onClick={() => { setProc(showProc ? null : procKey); openSplit({ t: 'compute', id: c.id }) }} className="h-8 rounded-lg bg-btn px-3 text-[13px] font-medium text-btn-fg">{showProc ? '收起过程' : '看过程'}</button>
          <OpenConv id={c.conv} />
        </div>
        {showProc && (
          <div data-testid="pano-process" className="mt-4 rounded-lg border border-line bg-bg p-3">
            <div className="mb-1.5 text-[12px] font-medium text-fg-3">最近的过程</div>
            {c.activity.slice(-5).map((a) => (
              <div key={a.id} className={cn('flex gap-2 py-1 text-[12.5px]', a.kind === 'error' && 'text-err')}><span className="w-10 shrink-0 tabular-nums text-fg-3">{a.at}</span><span className="min-w-0">{a.title}</span></div>
            ))}
            {c.activity.length === 0 && <div className="text-[12.5px] text-fg-3">还没有记录</div>}
          </div>
        )}
      </div>
    )
  }

  if (sel.t === 'person') {
    const list = Object.values(computes).filter((x) => x.owner === sel.pid && x.conv === sel.conv)
    const tasks = checklist.filter((t) => t.conv === sel.conv && t.who === sel.pid)
    const showProc = proc === procKey
    return (
      <div className="p-5">
        <Source id={sel.conv} />
        <div className="mt-3 flex items-center gap-2.5"><Avatar id={sel.pid} size={36} status={false} /><div><div className="text-[15px] font-semibold">{people[sel.pid].name}</div><div className="text-[12.5px] text-fg-2">在这里的分工：{dutyByConv[sel.conv]?.[sel.pid] ?? dutyDefault[sel.pid] ?? people[sel.pid].role}</div></div></div>
        <div className="mt-4 text-[12px] font-medium text-fg-3">手上的事</div>
        <div className="mt-1.5 space-y-1">
          {list.map((x) => <div key={x.id} className={cn('flex items-center gap-2 text-[13px]', x.status === 'done' && 'text-[12px] text-fg-3', x.status === 'error' && 'text-err', x.status === 'waiting' && 'font-semibold text-warm')}><span className="min-w-0 flex-1 truncate">{x.title}</span><span className="shrink-0 text-[12px]">{x.status === 'running' ? stepNo(x) : x.status === 'waiting' ? '等你验收' : x.status === 'error' ? '出错' : '做完'}</span></div>)}
          {tasks.filter((t) => !t.attempts.some((a) => list.some((x) => x.id === a))).map((t) => <div key={t.id} className="text-[13px] text-fg-2">清单：{t.text} · {t.status}</div>)}
          {list.length === 0 && tasks.length === 0 && <div className="text-[13px] text-fg-3">在这里没有手上的事</div>}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <button data-testid="pano-person-process" onClick={() => setProc(showProc ? null : procKey)} className="h-8 rounded-lg bg-btn px-3 text-[13px] font-medium text-btn-fg">{showProc ? '收起过程' : '看完整过程'}</button>
          <button data-testid="pano-open-workbench" onClick={() => openWorkbench(sel.pid)} className="h-8 rounded-lg border border-line px-3 text-[13px] hover:bg-hover">去它的工作台</button>
        </div>
        {showProc && <div className="mt-4 rounded-lg border border-line bg-bg"><ProcessView id={sel.pid} conv={sel.conv} /></div>}
      </div>
    )
  }

  const c = convOf(sel.conv)
  if (!c) return null
  const items = checklist.filter((t) => t.conv === c.id)
  const doneN = items.filter((t) => t.status === '已完成').length
  const cronN = crons.filter((r) => r.conv === c.id).length
  const firstNotice = c.notice?.split(/[\n。]/)[0]
  return (
    <div className="p-5">
      <div className="flex items-center gap-2.5"><ConvMark c={c} size={36} /><div className="text-[15px] font-semibold">{convLabel(c)}</div></div>
      {firstNotice && <><div className="mt-4 text-[12px] font-medium text-fg-3">群公告</div><p className="mt-1 text-[13px] leading-relaxed">{firstNotice}。</p></>}
      <div className="mt-4 text-[12px] font-medium text-fg-3">清单进度</div>
      {items.length ? <>
        <div className="mt-1.5 flex items-center gap-2"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover"><div className="h-full bg-fg-2" style={{ width: `${(doneN / items.length) * 100}%` }} /></div><span className="text-[12.5px] tabular-nums text-fg-2">{doneN}/{items.length}</span></div>
        <div className="mt-2 space-y-0.5">{items.map((t) => <div key={t.id} className={cn('flex justify-between text-[12.5px]', t.status === '已完成' ? 'text-fg-3' : t.status === '待验收' ? 'font-semibold text-warm' : '')}><span className="truncate">{t.text}</span><span className="shrink-0 pl-2">{t.status}</span></div>)}</div>
      </> : <div className="mt-1 text-[13px] text-fg-3">这个聊天没有清单</div>}
      <div className="mt-4 text-[12px] font-medium text-fg-3">定时</div>
      <div className="mt-1 text-[13px]">{cronN ? `这里有 ${cronN} 个定时` : '没有定时'}</div>
      <div className="mt-5"><OpenConv id={c.id} /></div>
    </div>
  )
}

/* U80 / D21：群内任务时间线。每件事一条横线：派活 → 开始 → 汇报 @你 → 验收；节点写明来自哪条消息，点了关掉遮罩、跳回原消息 */
function TaskTimeline({ convOk }: { convOk: (id: string) => boolean }) {
  const { computes, convs, checklist, jump, setPanoOpen } = useApp()
  const list = Object.values(computes).filter((c) => convOk(c.conv) && c.conv.startsWith('g'))
  const label = (cid: string) => { const c = convs.find((x) => x.id === cid); return c ? convLabel(c) : cid }
  const go = (mid?: string) => { if (!mid) return; setPanoOpen(false); setTimeout(() => jump(mid), 60) }
  if (!list.length) return null
  return (
    <section data-testid="pano-tasks" className="mt-8 rounded-xl border border-line p-4">
      <div className="flex items-baseline gap-2"><h2 className="text-[15px] font-semibold">任务时间线</h2><span className="text-[12px] text-fg-3">群里每件事从派活到验收走到了哪 · 点节点回到原消息</span></div>
      <div className="mt-3 space-y-2.5">
        {list.map((c) => {
          const item = checklist.find((x) => x.attempts.includes(c.id))
          const acc = item?.status === '已完成'
          const nodes: { k: string; label: string; msg?: string; state: 'done' | 'now' | 'todo' | 'err' }[] = [
            { k: 'ask', label: '派活', msg: c.askMsg, state: 'done' },
            { k: 'run', label: c.status === 'error' ? '出错' : c.status === 'running' ? '在做' : '做完', state: c.status === 'error' ? 'err' : c.status === 'running' ? 'now' : 'done' },
            { k: 'rep', label: '汇报 @你', msg: c.reportMsg, state: c.reportMsg ? 'done' : 'todo' },
            { k: 'acc', label: acc ? '已验收' : item?.status === '待验收' ? '等你回一句' : '验收', state: acc ? 'done' : c.reportMsg ? 'now' : 'todo' },
          ]
          return (
            <div key={c.id} data-testid={`pano-task-${c.id}`} className="flex items-center gap-3">
              <Avatar id={c.owner} size={20} status={false} mood="idle" />
              <div className="w-[150px] shrink-0"><div className="truncate text-[13px] font-medium">{c.title}</div><div className="truncate text-[11.5px] text-fg-3">{label(c.conv)}</div></div>
              <div className="flex min-w-0 flex-1 items-center">
                {nodes.map((n, i) => (
                  <div key={n.k} className="flex min-w-0 flex-1 items-center">
                    <button data-testid={`pano-task-${c.id}-${n.k}`} disabled={!n.msg} onClick={() => go(n.msg)} title={n.msg ? `回到原消息 #${n.msg}` : undefined}
                      className={cn('flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px]', n.msg && 'hover:bg-hover', n.state === 'done' ? 'text-fg-2' : n.state === 'now' ? 'bg-warm-soft font-medium text-fg' : n.state === 'err' ? 'text-err' : 'text-fg-3/70')}>
                      <span className={cn('h-1.5 w-1.5 rounded-full', n.state === 'done' ? 'bg-fg-3' : n.state === 'now' ? 'bg-warm' : n.state === 'err' ? 'bg-err' : 'border border-fg-3/50')} />{n.label}
                    </button>
                    {i < nodes.length - 1 && <span className={cn('mx-1 h-px min-w-3 flex-1', n.state === 'done' ? 'bg-fg-3/50' : 'bg-line')} />}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
