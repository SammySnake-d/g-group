import { useState, type ReactNode } from 'react'
import { Plus, ChevronRight, ChevronDown, Megaphone, ListChecks, Clock, Puzzle, Search, Pin, FolderGit2, BookOpen, Link2, Cpu, Copy, Sparkles, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, artifacts, dutyByConv, poolUsed, type Conversation, type Msg } from '@/data'
import { useApp } from '@/ctx'
import { TaskForm } from './CronDetail'
import { GroupCrons } from './CronList'
import { cronFailed } from '@/cronView'
import { Avatar, useLive } from './Avatar'
import { PersonMenu, Tip } from './Messages'
import { drag, startDrag, endDrag } from '@/drag'
import { broken } from '@/mut'

/* QQ 式群聊右侧常驻栏：群公告（就地编辑）→ 在做的事 → 群成员（身份 + 状态，点头像出菜单） */
type GTab = 'members' | 'notice' | 'list' | 'cron' | 'plugin' | 'tools'
/* 群资料分栏（#1651）：不再常驻右栏。从标题栏的成员头像组 / 群资料按钮打开，和联系人详情共用右侧分栏位置；
   只有一层页签，每页占满分栏高度，不留空白（#1593）。 */
export function GroupPane({ id, initial }: { id: string; initial?: GTab }) {
  const { convs } = useApp()
  const conv = convs.find((c) => c.id === id)
  if (!conv) return null
  return <GroupSide conv={conv} initial={initial} />
}
const lastTab: Record<string, GTab> = {}
function GroupSide({ conv, initial }: { conv: Conversation; initial?: GTab }) {
  const { computes, openSplit, push, commits, playbook, summarize, checklist, crons, plugins, claimTask, addTask, setSection, pulse, jump, addMembers, removeMember } = useApp()
  /* AC-49 拖拽：从左侧联系人拖进来 = 拉进群；把成员拖到底部「移出群」 = 移出 */
  const [over, setOver] = useState<null | 'in' | 'dup' | 'out'>(null)
  const [dragging, setDragging] = useState(false)
  const [listOpen, setListOpen] = useState(true)
  const [tab, setTabS] = useState<GTab>(initial ?? lastTab[conv.id] ?? 'members')
  /* 记住每个群上次看的页签：从定时详情等别的分屏标签切回来，还停在原来那页 */
  const setTab = (k: GTab) => { lastTab[conv.id] = k; setTabS(k) }
  const items = checklist.filter((t) => t.conv === conv.id)
  const myCrons = crons.filter((c) => c.conv === conv.id)
  const [addingTask, setAddingTask] = useState(false)
  const myPlugins = plugins.filter((p) => p.installed && p.convs.includes(conv.id))
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const myCommits = commits.filter((c) => c.conv === conv.id && c.on)
  const roleOrder = (m: string) => (conv.roles?.[m] === 'owner' ? 0 : conv.roles?.[m] === 'admin' ? 1 : people[m].human ? 3 : 2)
  const members = [...conv.members].sort((a, b) => roleOrder(a) - roleOrder(b)).filter((m) => !q || people[m].name.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="group-side">

      {/* 本群：清单 / 定时 / 插件 / 工具 收进一个分页，同一时刻只展开一块（QQ 右栏只放公告和成员，其余点进去看；#1560 右侧太挤） */}
      <section className="flex min-h-0 flex-1 flex-col" data-testid="side-tabs">
        <div role="tablist" className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-line px-3 pt-1">
          {([['members', `成员 ${conv.members.length}`], ['notice', `公告 ${(conv.notices ?? []).length || (conv.notice ? 1 : 0)}`], ['list', `清单 ${items.filter((t) => t.status === '已完成').length}/${items.length}`], ['cron', `定时 ${myCrons.length}`], ['plugin', `插件 ${myPlugins.length}`], ['tools', '工具']] as const).map(([k, l]) => (
            <button key={k} data-testid={`side-tab-${k}`} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('relative h-8 rounded-md px-2.5 text-[12.5px] transition', tab === k ? 'font-semibold text-fg' : 'text-fg-2 hover:text-fg')}>
              {l}{k === 'list' && items.some((t) => t.status === '待验收') && <span className="absolute right-0.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warm-dot" />}
              {k === 'cron' && myCrons.some(cronFailed) && <span className="absolute right-0.5 top-1.5 h-1.5 w-1.5 rounded-full bg-err" />}
              {tab === k && <span className="absolute inset-x-2.5 -bottom-px h-[2px] rounded-full bg-fg" />}
            </button>
          ))}
        </div>
        <div key={tab} className="fade-up scroll-thin min-h-0 flex-1 overflow-y-auto pb-2 pt-1">
              {tab === 'notice' && <NoticeBlock conv={conv} />}
              {tab === 'list' && <>
      {/* 群清单：属于群（#1246）。业务状态，不照搬 Compute（Astra） */}
      <section className="px-2 pb-2 pt-1" data-testid="side-checklist" id="side-checklist">
        <div className="mb-1 flex items-center"><button onClick={() => setListOpen((o) => !o)} className="flex min-w-0 flex-1 items-center px-2 text-left"><span className="flex-1 text-[13px] font-semibold">群清单</span><span className="text-[12px] text-fg-3">{items.filter((t) => t.status === '已完成').length}/{items.length} 完成</span><ChevronRight className={cn('ml-1 h-3.5 w-3.5 text-fg-3 transition', listOpen && 'rotate-90')} /></button><button data-testid="side-task-add" onClick={() => setAddingTask(true)} className="ml-1 flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-[12px] text-fg-2 hover:bg-hover hover:text-fg"><Plus className="h-3.5 w-3.5" />新建</button></div>
        {addingTask && <div className="px-1 pb-2"><TaskForm conv={conv.id} onDone={(t) => { if (t) addTask(t); setAddingTask(false) }} /></div>}
        {listOpen && items.filter((t) => t.status !== '已完成').map((t) => (
          <div key={t.id} data-testid={`task-${t.id}`} data-status={t.status} className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5', t.status === '待验收' && 'bg-warm-soft')}>
            <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border', t.status === '待验收' ? 'border-warm bg-warm-dot/30' : t.status === '进行中' ? 'border-run' : 'border-fg-3/60')}>{t.status === '进行中' && <span className="spin-ring !h-2.5 !w-2.5 !border" />}</span>
            <div className="min-w-0 flex-1">
              <div className={cn('truncate text-[12.5px]', t.status === '待验收' && 'font-semibold')}>{t.text}</div>
              {t.desc && <div data-testid={`task-desc-${t.id}`} className="truncate text-[11.5px] text-fg-2" title={t.desc}>{t.desc}</div>}
              <div className={cn('truncate text-[11px]', t.status === '待验收' ? 'text-warm' : 'text-fg-3')}>{t.status === '待认领' ? (t.suggest ? `待认领 · 推荐 ${people[t.suggest].name}（${t.why}）` : '待认领') : `${t.status} · ${people[t.who!].name}`}{t.attempts.length > 0 && t.status === '进行中' && ` · ${computes[t.attempts[0]]?.phase ?? ''}`}</div>
            </div>
            {t.status === '待认领' && t.suggest && <button data-testid={`task-claim-${t.id}`} onClick={() => claimTask(t.id, t.suggest!)} className="shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] text-fg-2 hover:bg-hover hover:text-fg">让它领</button>}
            {t.status === '待验收' && t.attempts[0] && <button onClick={() => openSplit({ t: 'compute', id: t.attempts[0] })} className="shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] text-fg-2 hover:bg-hover hover:text-fg">看过程</button>}
          </div>
        ))}
        {listOpen && items.some((t) => t.status === '已完成') && <div className="px-2 py-1 text-[11.5px] text-fg-3">✓ 已完成 {items.filter((t) => t.status === '已完成').length} 项</div>}
      </section>

              </>}
              {tab === 'cron' && <GroupCrons conv={conv} />}
              {tab === 'plugin' && <>
      {/* 本群插件：挂在这个聊天上的（概念卡第 4 张） */}
      <section className="px-2 pb-2 pt-1" data-testid="side-plugins">
        <div className="mb-1 flex items-center px-2"><span className="flex-1 text-[13px] font-semibold">本群插件</span><button data-testid="side-plugin-add" onClick={() => setSection('plugins')} className="text-[12px] text-fg-3 hover:text-fg">添加 ›</button></div>
        <div className="flex flex-wrap gap-1.5 px-2">
          {myPlugins.map((p) => <span key={p.id} title={p.desc} className="flex items-center gap-1.5 rounded-full border border-line py-0.5 pl-0.5 pr-2 text-[12px]"><span className="grid h-5 w-5 place-items-center rounded-full text-[10px] font-semibold text-white" style={{ background: p.color }}>{p.letter}</span>{p.name}<span className="text-fg-3">{p.kind === 'source' ? '取' : p.kind === 'outbound' ? '发' : '面板'}</span></span>)}
          {myPlugins.length === 0 && <span className="text-[12px] text-fg-3">没有挂插件</span>}
        </div>
      </section>
      {/* #2273 U80：动向时间线插件挂在本群时，在这里展开；每段点了回到它总结的那段消息 */}
      {myPlugins.some((p) => p.id === 'p-pulse') && (() => {
        const list = pulse.filter((x) => x.conv === conv.id)
        const cr = crons.find((c) => c.conv === conv.id && c.trigger.kind === 'messages')
        return (
          <section className="px-2 pb-3 pt-1" data-testid="side-pulse">
            <div className="mb-1.5 flex items-center px-2"><span className="flex-1 text-[13px] font-semibold">动向时间线</span>
              {cr && cr.trigger.kind === 'messages' && <button data-testid="side-pulse-rule" onClick={() => openSplit({ t: 'cron', id: cr.id })} className="text-[11.5px] text-fg-3 hover:text-fg">{people[cr.owner].name} · 每 {cr.trigger.n} 条一段 · 已 {cr.trigger.seen}/{cr.trigger.n} ›</button>}
            </div>
            <ol className="ml-3 border-l border-line pl-3">
              {[...list].reverse().map((x) => (
                <li key={x.id} data-testid={`pulse-${x.id}`} className="relative pb-2">
                  <span className="absolute -left-[16.5px] top-[6px] h-2 w-2 rounded-full border-2 border-elev bg-fg-3/60" />
                  <button onClick={() => jump(x.from)} className="block w-full rounded-md px-1 py-0.5 text-left hover:bg-hover">
                    <span className="mr-1.5 text-[11px] tabular-nums text-fg-3">{x.at}</span>
                    <span className="text-[12.5px] leading-snug text-fg-2">{x.text}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )
      })()}

              </>}
              {tab === 'tools' && <>
      {/* 群工具：QQ 群应用的位置，换成 agent 群需要的 */}
      <section className="grid grid-cols-4 gap-1 px-2 py-2" data-testid="side-tools">
        {[
          { I: Sparkles, l: '总结未读', a: () => summarize(conv.id), t: 'tool-summary' },
          { I: BookOpen, l: `协作手册`, a: () => push({ t: 'playbook', id: conv.id }, true), t: 'tool-playbook', n: playbook.length },
          { I: FileText, l: '群文件', a: () => push({ t: 'files', id: conv.id }, true), t: 'tool-files', n: artifacts.filter((a) => a.conv === conv.id).length },
          { I: FolderGit2, l: '工作区', a: () => push({ t: 'workspace', id: conv.id }, true), t: 'tool-workspace' },
          { I: Link2, l: '关联会话', a: () => push({ t: 'links', id: conv.id }, true), t: 'tool-links', n: conv.links?.length },
          { I: Pin, l: '记下的事', a: () => push({ t: 'commits', id: conv.id }, true), t: 'tool-commits', n: myCommits.length },
          { I: Cpu, l: '临时算力', a: () => push({ t: 'pool', id: conv.id }, true), t: 'tool-compute', sub: conv.tempCompute ? `${poolUsed(computes, conv.id)}/${conv.tempCompute.max}` : undefined },
          { I: Copy, l: '复制团队', a: () => push({ t: 'clone', id: conv.id }, true), t: 'tool-clone' },
        ].map((x) => (
          <button key={x.l} data-testid={x.t} onClick={x.a} className="relative flex flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[11.5px] text-fg-2 hover:bg-hover hover:text-fg">
            <x.I className="h-[18px] w-[18px]" strokeWidth={1.6} />
            <span className="truncate">{x.l}</span>
            {(x.n || x.sub) ? <span className="absolute right-1.5 top-0.5 text-[10px] text-fg-3">{x.sub ?? x.n}</span> : null}
          </button>
        ))}
      </section>

              </>}
              {tab === 'members' && <>
        <div className="mb-1 flex items-center px-4 pt-1.5">
          {searching ? (
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => !q && setSearching(false)} placeholder="搜成员" className="h-7 min-w-0 flex-1 rounded-md bg-side px-2 text-[12.5px] outline-none" />
          ) : <span className="flex-1 text-[12px] text-fg-3">{conv.members.filter((m) => !people[m].human).length} 位助手 · {conv.members.filter((m) => people[m].human).length} 位成员</span>}
          <button onClick={() => setSearching((x) => !x)} className="ml-1 grid h-7 w-7 place-items-center rounded text-fg-3 hover:bg-hover hover:text-fg"><Search className="h-3.5 w-3.5" /></button>
        </div>
        <div data-testid="side-members-drop" data-over={over ?? ''} className={cn('mx-2 rounded-lg px-0 transition-colors', over === 'in' && 'bg-me/10 ring-1 ring-me/40', over === 'dup' && 'bg-hover')} style={{ ['--avatar-ring' as string]: 'var(--bg)' }}
          onDragOver={(e) => { if (drag.from !== 'contact' || !drag.who) return; e.preventDefault(); setOver(conv.members.includes(drag.who) && !broken('AC-49-3') ? 'dup' : 'in') }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null) }}
          onDrop={(e) => { e.preventDefault(); const w = drag.who; const ok = over === 'in'; setOver(null); endDrag(); if (w && ok && !broken('AC-49-1')) addMembers(conv.id, [w]) }}>
          {(over === 'in' || over === 'dup') && drag.who && <div data-testid="side-drop-hint" className={cn('px-2 py-1.5 text-[12px]', over === 'in' ? 'text-me' : 'text-fg-3')}>{over === 'in' ? `松手把 ${people[drag.who].name} 拉进群` : `${people[drag.who].name} 已经在群里`}</div>}
          {members.map((m) => <MemberRow key={m} id={m} role={conv.roles?.[m]} silenced={!!conv.silenced?.[m]} duty={dutyByConv[conv.id]?.[m]}
            onDrag={(on) => setDragging(on)} />)}
        </div>
        {dragging && !broken('AC-49-2') && (
          <div data-testid="side-drop-out" data-over={over === 'out' ? '1' : '0'} className={cn('mx-3 mt-2 grid h-11 place-items-center rounded-lg border border-dashed text-[12.5px] transition-colors', over === 'out' ? 'border-err bg-err/10 text-err' : 'border-line text-fg-3')}
            onDragOver={(e) => { if (drag.from !== 'member') return; e.preventDefault(); setOver('out') }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); const w = drag.who; setOver(null); setDragging(false); endDrag(); if (w && w !== 'me') removeMember(conv.id, w) }}>
            拖到这里移出群（它借的群算力会先停下归还）
          </div>
        )}
              </>}
        </div>
      </section>
    </div>
  )
}

function MemberRow({ id, role, silenced, duty, onDrag }: { id: string; role?: 'owner' | 'admin'; silenced?: boolean; duty?: string; onDrag?: (on: boolean) => void }) {
  const p = people[id]
  const live = useLive(id)
  const liveText = { idle: '', running: '在干活', waiting: '等你', error: '出错' }[live]
  const liveCls = { idle: '', running: 'text-run', waiting: 'text-warm', error: 'text-err' }[live]
  const row = (
    <button data-testid={`side-member-${id}`} draggable={id !== 'me'} onDragStart={(e) => { startDrag(e, id as never, 'member'); onDrag?.(true) }} onDragEnd={() => { endDrag(); onDrag?.(false) }} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left transition-colors hover:bg-hover">
      <Avatar id={id} size={28} />
      <span className="min-w-0 flex-1 truncate text-[13px]">{id === 'me' ? `${p.name}（你）` : p.name}{duty && <span className="ml-1.5 text-[11.5px] text-fg-3">{duty}</span>}</span>
      {silenced && <span className="rounded bg-hover px-1.5 text-[10.5px] text-fg-3">禁言中</span>}
      {liveText && <span className={cn('text-[11px]', liveCls)}>{liveText}</span>}
      {role === 'owner' && <span className="rounded bg-warm-soft px-1.5 text-[10.5px] font-medium text-warm">群主</span>}
      {role === 'admin' && <span className="rounded bg-me/10 px-1.5 text-[10.5px] font-medium text-me">管理员</span>}
      {!p.human && !role && <span className="rounded bg-hover px-1.5 text-[10.5px] text-fg-3">助手</span>}
    </button>
  )
  return id === 'me' ? row : <PersonMenu id={id} side="left">{row}</PersonMenu>
}

/* 群公告（#1566 #1593 #1618）：
   - 像 QQ：可以有多条，右栏只露置顶那条的前几行；「全部 N 条」展开成列表，每条可展开全文；没有公告时只有标题和「+」，不占空间。
   - 不像 mirasim：mirasim 的置顶只给人看；这里的公告由软件装配进每个助手接活前的上下文，所以每条都标出各助手装配到了哪一版。
     写「已装配」，不写「已遵守」——装配是软件做的、可核对；遵守与否要看它干的活。 */
function NoticeBlock({ conv }: { conv: Conversation }) {
  const { setNotice, editNotice, toast } = useApp()
  const list = conv.notices ?? (conv.notice ? [{ id: 'n0', text: conv.notice, by: conv.noticeBy ?? '', at: '', ver: 1, top: true }] : [])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [ev, setEv] = useState('')
  const [full, setFull] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [v, setV] = useState('')
  const bots = conv.members.filter((m) => !people[m]?.human)
  const top = list.find((n) => n.top) ?? list[0]
  const loadedOf = (n: { id: string; ver: number }) => bots.map((b) => ({ b, v: conv.loaded?.[b]?.[n.id] })).map((x) => ({ ...x, ok: x.v === n.ver }))
  const Loaded = ({ n }: { n: { id: string; ver: number } }) => {
    const L = loadedOf(n); const ok = L.filter((x) => x.ok).length
    return (
      <Tip label={L.map((x) => `${people[x.b].name}：${x.v ? `已装配 v${x.v}${x.ok ? '' : `（当前 v${n.ver}，下次接活时更新）`}` : '还没装配'}`).join('\n')}>
        <span data-testid={`notice-loaded-${n.id}`} className={cn('inline-flex items-center gap-1', ok < L.length && 'text-warm')}>
          <span className="flex -space-x-1">{L.map((x) => <span key={x.b} className={cn('rounded-full ring-2 ring-bg', !x.ok && 'opacity-35 grayscale')}><Avatar id={x.b} size={14} status={false} /></span>)}</span>
          {ok}/{L.length} 已装配 v{n.ver}
        </span>
      </Tip>
    )
  }
  const publish = () => { const t = v.trim(); if (!t) return; setNotice(conv.id, t); toast('已发布。助手下次接活前，软件会把它装配进上下文'); setAdding(false); setV('') }
  return (
    <section className="border-b border-line px-4 pb-3 pt-3" data-testid="notice-block" data-count={list.length}>
      <div className="flex h-7 items-center">
        <button onClick={() => list.length > 1 && setOpen(!open)} className="flex flex-1 items-center gap-1 text-left text-[14px] font-semibold" data-testid="notice-title">
          群公告{list.length > 1 && <span className="text-[12px] font-normal text-fg-3">{list.length}</span>}
          {list.length > 1 && <ChevronRight className={cn('h-3.5 w-3.5 text-fg-3 transition-transform', open && 'rotate-90')} />}
        </button>
        <Tip label="发布新公告"><button data-testid="notice-add" onClick={() => setAdding(true)} className="grid h-7 w-7 place-items-center rounded-md text-fg-2 hover:bg-hover hover:text-fg"><Plus className="h-4 w-4" /></button></Tip>
      </div>
      {adding && (
        <div className="fade-up mt-1.5">
          <textarea data-testid="notice-input" autoFocus value={v} onChange={(e) => setV(e.target.value)} rows={3} maxLength={600} placeholder="写一条公告（1–600 字）。发布后每个助手接活前都会装配它" className="w-full resize-none rounded-lg border border-line bg-side px-2.5 py-2 text-[13px] leading-relaxed outline-none focus:border-fg-3" />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <span className="flex-1 text-[11.5px] text-fg-3">{v.length}/600</span>
            <button onClick={() => setAdding(false)} className="h-7 rounded-md px-2.5 text-[12.5px] text-fg-2 hover:bg-hover">取消</button>
            <button data-testid="notice-save" disabled={!v.trim()} onClick={publish} className="h-7 rounded-md bg-me px-3 text-[12.5px] font-medium text-me-fg disabled:opacity-40">发布</button>
          </div>
        </div>
      )}
      {!top ? null : !open ? (
        <button data-testid="notice-text" onClick={() => list.length > 1 ? setOpen(true) : setFull(full ? null : top.id)} className="mt-0.5 block w-full rounded-lg text-left">
          <p className={cn('whitespace-pre-wrap text-[13px] leading-[1.65] text-fg-2', full !== top.id && 'line-clamp-3')}>{top.top && list.length > 1 && <span className="mr-1 rounded bg-warm-soft px-1 text-[10.5px] font-medium text-warm">置顶</span>}{top.text}</p>
          <div className="mt-1 flex items-center gap-2 text-[11.5px] text-fg-3"><span>{top.by} · {top.at}</span><span className="flex-1" /><Loaded n={top} /></div>
        </button>
      ) : (
        <ul className="fade-up -mx-1.5 mt-1 max-h-[340px] space-y-1 overflow-y-auto" data-testid="notice-list">
          {list.map((n) => (
            <li key={n.id} data-testid={`notice-${n.id}`} className="rounded-lg px-1.5 py-1.5 hover:bg-hover">
              <div className="mb-0.5 flex items-center gap-1.5 text-[11.5px] text-fg-3">
                {n.top && <span className="rounded bg-warm-soft px-1 text-[10.5px] font-medium text-warm">置顶</span>}
                <span className="truncate">{n.by} · {n.at}</span>
              </div>
              <p className={cn('whitespace-pre-wrap text-[13px] leading-[1.6] text-fg', full !== n.id && 'line-clamp-2')}>{n.text}</p>
              <div className="mt-1 flex items-center text-[11.5px] text-fg-3">
                {n.text.length > 40 && <button data-testid={`notice-more-${n.id}`} onClick={() => setFull(full === n.id ? null : n.id)} className="text-me hover:underline">{full === n.id ? '收起' : '展开'}</button>}
                <button data-testid={`notice-edit-${n.id}`} onClick={() => { setEditing(n.id); setEv(n.text) }} className="ml-2 text-fg-2 hover:text-fg">改</button>
                <span className="flex-1" /><Loaded n={n} />
              </div>
              {editing === n.id && (
                <div className="mt-1.5" data-testid={`notice-editor-${n.id}`}>
                  <textarea data-testid={`notice-edit-input-${n.id}`} autoFocus value={ev} onChange={(e) => setEv(e.target.value)} rows={3} maxLength={600} className="w-full resize-none rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[13px] leading-[1.6] outline-none focus:border-fg-3" />
                  <div className="mt-1 flex justify-end gap-1.5">
                    <button onClick={() => setEditing(null)} className="h-7 rounded-md px-2.5 text-[12.5px] hover:bg-hover">取消</button>
                    <button data-testid={`notice-edit-save-${n.id}`} disabled={!ev.trim() || ev.trim() === n.text} onClick={() => { editNotice(conv.id, n.id, ev.trim()); setEditing(null) }} className="h-7 rounded-md bg-me px-3 text-[12.5px] font-medium text-me-fg disabled:opacity-40">改到 v{n.ver + 1}</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* 聊天顶部只留一行（#1651 第 2 条）：左边是公告/置顶的轮换条（1/N 切换，点开看全部），右边是本群的清单、定时、插件小胶囊。
   之前是标题 52 + 清单 32 + 置顶 45 = 129px 三条叠着；现在标题 + 这一行 ≈ 90px。
   公告和置顶在同一条里，用图标区分：喇叭 = 群公告（装配给助手），图钉 = 置顶消息（只给人看）。 */
export function TopStrip({ conv, onOpen }: { conv: Conversation; onOpen: (tab: GTab) => void }) {
  const { checklist, crons, plugins, jump } = useApp()
  type Item = { k: 'notice'; id: string; text: string; ver: number; loaded: string } | { k: 'pin'; id: string; text: string; who: string }
  const notices = conv.notices ?? (conv.notice ? [{ id: 'n0', text: conv.notice, by: conv.noticeBy ?? '', at: '', ver: 1, top: true }] : [])
  const bots = conv.members.filter((m) => !people[m]?.human)
  const items: Item[] = [
    ...notices.map((n) => ({ k: 'notice' as const, id: n.id, text: n.text.split('\n')[0], ver: n.ver, loaded: `${bots.filter((b) => conv.loaded?.[b]?.[n.id] === n.ver).length}/${bots.length}` })),
    ...(conv.pins ?? []).map((pid) => { const m = conv.messages.find((x) => x.k === 'text' && x.id === pid) as Extract<Msg, { k: 'text' }> | undefined; return m ? { k: 'pin' as const, id: pid, text: m.text, who: people[m.from].name } : null }).filter(Boolean) as Item[],
  ]
  const [i, setI] = useState(0)
  const it = checklist.filter((t) => t.conv === conv.id)
  const done = it.filter((t) => t.status === '已完成').length
  const wait = it.filter((t) => t.status === '待验收').length
  const myCrons = crons.filter((c) => c.conv === conv.id)
  const cronErr = myCrons.some(cronFailed)
  const myPlugins = plugins.filter((p) => p.installed && p.convs.includes(conv.id))
  const cur = items[i % Math.max(1, items.length)]
  const Chip = ({ testid, onClick, children, tone }: { testid: string; onClick: () => void; children: ReactNode; tone?: 'warm' | 'err' }) => (
    <button data-testid={testid} onClick={onClick} className={cn('flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors', tone === 'warm' ? 'bg-warm-soft text-warm hover:brightness-95' : tone === 'err' ? 'bg-err/10 text-err hover:bg-err/15' : 'text-fg-2 hover:bg-hover hover:text-fg')}>{children}</button>
  )
  return (
    <div data-testid="top-strip" className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-3">
      {cur ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {items.length > 1 && <span className="flex h-6 w-[3px] shrink-0 flex-col gap-[2px]">{items.map((_, j) => <span key={j} className={cn('flex-1 rounded-full transition-colors', j === i % items.length ? 'bg-me' : 'bg-fg-3/30')} />)}</span>}
          <button data-testid="strip-text" onClick={() => (cur.k === 'pin' ? jump(cur.id) : onOpen('notice'))} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-hover/60">
            {cur.k === 'notice' ? <Megaphone className="h-3.5 w-3.5 shrink-0 text-warm" /> : <Pin className="h-3.5 w-3.5 shrink-0 text-fg-3" />}
            <span key={cur.id} className="fade-up min-w-0 truncate text-[12.5px]">
              {cur.k === 'notice' ? <><span className="font-medium text-fg">群公告</span><span className="text-fg-2">：{cur.text}</span></> : <><span className="font-medium text-fg">{cur.who}</span><span className="text-fg-2">：{cur.text}</span></>}
            </span>
            {cur.k === 'notice' && <span data-testid="strip-loaded" className="shrink-0 text-[11px] text-fg-3">{cur.loaded} 已装配 v{cur.ver}</span>}
          </button>
          {items.length > 1 && <button data-testid="strip-next" onClick={() => setI((x) => (x + 1) % items.length)} className="flex h-7 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-[11.5px] tabular-nums text-fg-3 hover:bg-hover hover:text-fg" title="下一条">{(i % items.length) + 1}/{items.length}<ChevronDown className="h-3 w-3" /></button>}
        </div>
      ) : (
        <button data-testid="strip-empty" onClick={() => onOpen('notice')} className="flex flex-1 items-center gap-1.5 px-1 text-[12.5px] text-fg-3 hover:text-fg"><Megaphone className="h-3.5 w-3.5" />还没有群公告<Plus className="h-3.5 w-3.5" /></button>
      )}
      <span className="mx-1 h-4 w-px shrink-0 bg-line" />
      {it.length > 0 && <Chip testid="strip-list" onClick={() => onOpen('list')} tone={wait ? 'warm' : undefined}><ListChecks className="h-3.5 w-3.5" />清单 {done}/{it.length}{wait > 0 && <span className="font-medium">· {wait} 待验收</span>}</Chip>}
      {myCrons.length > 0 && <Chip testid="strip-cron" onClick={() => onOpen('cron')} tone={cronErr ? 'err' : undefined}><Clock className="h-3.5 w-3.5" />定时 {myCrons.length}</Chip>}
      {myPlugins.length > 0 && <Chip testid="strip-plugin" onClick={() => onOpen('plugin')}><Puzzle className="h-3.5 w-3.5" />插件 {myPlugins.length}</Chip>}
    </div>
  )
}

/* 标题栏的成员头像组：最多叠 5 个，点开在右侧分栏看成员（#1651 第 1 条：5 个人不值得常驻一整栏） */
export function MemberStack({ conv, onOpen }: { conv: Conversation; onOpen: () => void }) {
  const ms = conv.members.filter((m) => m !== 'me')
  return (
    <Tip label={`群成员 ${conv.members.length}：${conv.members.map((m) => people[m].name).join('、')}`}>
      <button data-testid="member-stack" onClick={onOpen} className="flex h-8 items-center gap-1.5 rounded-full py-1 pl-1 pr-2 hover:bg-hover" style={{ ['--avatar-ring' as string]: 'var(--bg)' }}>
        <span className="flex -space-x-1.5">{ms.slice(0, 5).map((m) => <span key={m} className="rounded-full ring-2 ring-bg"><Avatar id={m} size={22} status={false} /></span>)}</span>
        <span className="text-[12px] tabular-nums text-fg-2">{conv.members.length}</span>
      </button>
    </Tip>
  )
}
