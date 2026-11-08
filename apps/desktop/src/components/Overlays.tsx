import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X, Plus, ArrowUp, Check, ChevronRight, Search, Bell, LogOut, Sparkles, ChevronLeft, Link2, Unlink, Forward, Send, Puzzle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { artifacts, people, sources, SHAPES, SWATCHES, MODELS, GLOBAL_MODEL, vendorOf, innerLog, agentTalks, type PersonId, type Msg } from '@/data'
import { ProcessView } from './Workbench'
import { CloneFlow } from './CloneFlow'
import { useApp, type Page } from '@/ctx'
import { Avatar, Bot, useLive } from './Avatar'
import { MessageList, ComputeLine, renderText, ArtifactIcon } from './Messages'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Slider } from '@/components/ui/slider'
import { broken, candidate } from '@/mut'

export function pageTitle(p: Page, convs: { id: string; title: string }[]): string {
  const ct = (id: string) => convs.find((c) => c.id === id)?.title ?? ''
  switch (p.t) {
    case 'person': return people[p.id]?.name ?? '资料'
    case 'personModel': return '模型'
    case 'personTools': return '技能和工具'
    case 'inner': return `${people[p.id].name} · 在${ct(p.conv)}`
    case 'detail': return `${people[p.id].name} · 对话细节`
    case 'talk': return '助手之间的对话'
    case 'workspace': return '工作区'
    case 'pins': return '置顶消息'
    case 'members': return '群成员'
    case 'files': return '群文件'
    case 'group': return '群设置'
    case 'pool': return '本群临时算力'
    case 'links': return '关联的会话'
    case 'linkPick': return '选要关联的会话'
    case 'playbook': return '群协作手册'
    case 'commits': return '大家记下的事'
    case 'clone': return '复制这个团队'
    case 'search': return '查找聊天记录'
    case 'huddle': return '助手之间的讨论'
    case 'forwardView': return '转发的记录'
    case 'forwardPick': return '转发到'
    case 'helper': return 'Helper'
    case 'settings': return '设置'
    case 'addContact': return '添加联系人'
    case 'newGroup': return '发起群聊'
    case 'sources': return '外部来源'
    case 'source': return sources.find((s) => s.id === p.id)?.app ?? '外部来源'
    case 'process': return `${people[p.id].name} · 完整过程`
    case 'cron': return '定时'
    case 'task': return '清单项'
  }
}

/* ============ 右侧浮层：一摞页面。返回 / 关闭 / Esc 都只退一层；点浮层外面才全部收起 ============ */
export function FloatPanel({ stack, width, onResize }: { stack: Page[]; width: number; onResize: (w: number) => void }) {
  const { back, convs } = useApp()
  if (!stack.length) return null
  const top = stack[stack.length - 1]
  const prev = stack[stack.length - 2]
  const drag = (e: React.PointerEvent) => {
    e.preventDefault()
    const sx = e.clientX, sw = width
    const mv = (ev: PointerEvent) => onResize(Math.max(340, Math.min(720, sw - (ev.clientX - sx))))
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); document.body.style.cursor = '' }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
  }
  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 z-30 flex p-2.5 pl-0">
      <aside data-testid="float" data-page={top.t} className="slide-in pointer-events-auto relative flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-elev shadow-[0_24px_64px_-12px_rgb(0_0_0/0.28),0_2px_6px_rgb(0_0_0/0.06)]" style={{ width }}>
        <div onPointerDown={drag} data-testid="float-resize" title="拖动调宽" className="group/r absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize"><span className="absolute inset-y-6 left-0.5 w-[3px] rounded-full opacity-0 transition group-hover/r:bg-fg-3/40 group-hover/r:opacity-100" /></div>
        <div className="flex h-12 shrink-0 items-center gap-1 px-2.5">
          {prev && (
            <button data-testid="float-back" onClick={back} className="flex h-8 max-w-[45%] items-center gap-0.5 rounded-lg pl-1 pr-2 text-[13px] text-fg-2 hover:bg-hover hover:text-fg">
              <ChevronLeft className="h-[18px] w-[18px] shrink-0" /><span className="truncate">{pageTitle(prev, convs)}</span>
            </button>
          )}
          <div className={cn('min-w-0 flex-1 truncate text-[14.5px] font-semibold', !prev && 'pl-1.5')}>{prev ? '' : pageTitle(top, convs)}</div>
          <button data-testid="float-close" onClick={back} title={prev ? `关闭，回到「${pageTitle(prev, convs)}」` : '关闭（Esc）'} className="grid h-8 w-8 place-items-center rounded-lg text-fg-2 hover:bg-hover hover:text-fg"><X className="h-[18px] w-[18px]" /></button>
        </div>
        {prev && top.t !== 'person' && <div className="-mt-1 px-4 pb-1 text-[16px] font-semibold tracking-tight">{pageTitle(top, convs)}</div>}
        <PageBody p={top} />
      </aside>
    </div>
  )
}

function PageBody({ p }: { p: Page }) {
  switch (p.t) {
    case 'person': return <PersonPage id={p.id} />
    case 'personModel': return <ModelPage id={p.id} />
    case 'personTools': return <ToolsPage id={p.id} />
    case 'inner': return <InnerPage id={p.id} conv={p.conv} />
    case 'detail': return <DetailPage id={p.id} conv={p.conv} tab={p.tab} />
    case 'talk': return <TalkPage id={p.id} />
    case 'workspace': return <WorkspacePage id={p.id} />
    case 'pins': return <PinsPage id={p.id} />
    case 'members': return <GroupPage id={p.id} />
    case 'files': return <FilesPage id={p.id} />
    case 'group': return <GroupPage id={p.id} />
    case 'pool': return <PoolPage id={p.id} />
    case 'links': return <LinksPage id={p.id} />
    case 'linkPick': return <LinkPickPage id={p.id} />
    case 'playbook': return <PlaybookPage id={p.id} />
    case 'commits': return <CommitsPage id={p.id} />
    case 'clone': return <CloneFlow id={p.id} />
    case 'search': return <SearchPage id={p.id} />
    case 'huddle': return <HuddlePage conv={p.conv} msgId={p.msgId} />
    case 'forwardView': return <ForwardViewPage conv={p.conv} msgId={p.msgId} />
    case 'forwardPick': return <ForwardPickPage from={p.from} msgIds={p.msgIds} />
    case 'helper': return <HelperPage />
    case 'settings': return <SettingsPage />
    case 'addContact': return <AddContactPage />
    case 'newGroup': return <NewGroupPage />
    case 'sources': return <SourcesPage />
    case 'source': return <SourcePage id={p.id} />
    case 'process': return <ProcessView id={p.id} conv={p.conv} />
    case 'cron': return null
    case 'task': return <ProcessView id={'claude'} />
  }
}

function Row({ label, value, onClick, children, testid }: { label: ReactNode; value?: ReactNode; onClick?: () => void; children?: ReactNode; testid?: string }) {
  const C = onClick ? 'button' : 'div'
  return (
    <C data-testid={testid} onClick={onClick} className={cn('flex min-h-11 w-full items-center gap-3 px-4 text-left text-[14px]', onClick && 'hover:bg-hover')}>
      <span className="flex-1">{label}</span>
      {value && <span className="text-fg-2">{value}</span>}
      {children}
      {onClick && <ChevronRight className="h-4 w-4 text-fg-3" />}
    </C>
  )
}

function Group({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mx-3 mb-3">
      {title && <div className="flex items-center px-1 pb-1.5 pt-2 text-[12px] font-medium text-fg-3"><span className="flex-1">{title}</span>{right}</div>}
      <div className="overflow-hidden rounded-xl bg-hover/60 [&>*+*]:border-t [&>*+*]:border-line">{children}</div>
    </div>
  )
}

const Scroll = ({ children, className }: { children: ReactNode; className?: string }) => <div className={cn('scroll-thin flex-1 overflow-y-auto pb-4', className)} style={{ ['--avatar-ring' as string]: 'var(--elev)' }}>{children}</div>

/* ---------- 联系人资料 ---------- */
function PersonPage({ id }: { id: PersonId }) {
  const { computes, convs, openDm, mention, push, active } = useApp()
  const p = people[id]
  const live = useLive(id)
  const liveText = { idle: '空闲', running: '在干活', waiting: '在等你', error: '遇到问题' }[live]
  const liveCls = { idle: 'text-fg-3', running: 'text-run', waiting: 'text-warm', error: 'text-err' }[live]
  const mine = Object.values(computes).filter((c) => c.owner === id)
  const liveC = mine.filter((c) => c.status !== 'done')
  const groups = convs.filter((c) => c.kind === 'group' && c.members.includes(id))
  const conv = convs.find((c) => c.id === active)
  return (
    <Scroll>
      <div className="flex flex-col items-center pb-4 pt-1 text-center" data-testid={`person-${id}`}>
        <Avatar id={id} size={76} follow status={false} />
        <div className="mt-2.5 text-[18px] font-semibold tracking-tight">{p.name}</div>
        <div className="mt-0.5 text-[13px] text-fg-2">{p.role}{!p.human && <> · <span className={liveCls}>{liveText}</span></>}</div>
        <div className="mt-3.5 flex gap-2">
          {!p.human && <button data-testid="person-dm" onClick={() => openDm(id)} className="h-8 rounded-full bg-me px-4 text-[13px] font-medium text-me-fg hover:opacity-90">私聊</button>}
          {!p.human && conv?.kind === 'group' && conv.members.includes(id) && <button data-testid="person-inner" onClick={() => push({ t: 'inner', id, conv: active })} className="h-8 rounded-full bg-hover px-4 text-[13px] font-medium hover:bg-sel">从群聊私信</button>}
          <button onClick={() => mention(id)} className="h-8 rounded-full bg-hover px-4 text-[13px] font-medium hover:bg-sel">@{p.human ? 'TA' : '他'}</button>
        </div>
      </div>
      {!p.human && (
        <Group title={liveC.length ? `手上的事 · ${liveC.length}` : '手上的事'}>
          {liveC.length ? liveC.map((c) => <div key={c.id} className="px-2 py-1"><ComputeLine id={c.id} /></div>) : <div className="px-4 py-3 text-[13px] text-fg-3">现在没有在做的事</div>}
        </Group>
      )}
      {p.model && (
        <Group title="设置">
          <Row testid="person-model" label="说话用的模型" value={p.model} onClick={() => push({ t: 'personModel', id })} />
          <Row label="干活用的模型" value={p.computeModel === 'inherit' ? '跟全局默认' : p.computeModel === 'follow' ? '跟说话模型一样' : p.computeModel} onClick={() => push({ t: 'personModel', id })} />
          <Row label="最多同时分几个 Compute" value={`${p.computeQuota} 个`} onClick={() => push({ t: 'personModel', id })} />
          <Row testid="person-tools" label="能用的技能和工具" value={`${p.tools?.filter((t) => t.on).length} 个`} onClick={() => push({ t: 'personTools', id })} />
          {p.focus && <Row label="专职" value={p.focus} />}
        </Group>
      )}
      {groups.length > 0 && (
        <Group title={`在的群 · ${groups.length}`}>
          {groups.map((g) => <Row key={g.id} label={g.title} value={`${g.members.length} 人`} onClick={() => push({ t: 'group', id: g.id })} />)}
        </Group>
      )}
      {p.today && (
        <Group title="花费">
          <Row label="今天" value={p.today} />
          <Row label="本月" value={p.month} />
        </Group>
      )}
    </Scroll>
  )
}

/* AC-32：说话模型 / Compute 模型三态（继承全局、跟说话模型、单独指定） */
function ModelPage({ id }: { id: PersonId }) {
  const { updatePerson } = useApp()
  const p = people[id]
  const [talk, setTalk] = useState(p.model!)
  const [cm, setCm] = useState(p.computeModel ?? 'inherit')
  const [quota, setQuota] = useState(p.computeQuota ?? 1)
  const effective = cm === 'inherit' ? GLOBAL_MODEL : cm === 'follow' ? talk : cm
  return (
    <Scroll className="px-1">
      <Group title="说话用的模型（在群里聊天、判断要不要接活）">
        {MODELS.map((m) => <Row key={m} testid={`model-${m}`} label={m} value={<span className="text-[12px]">{vendorOf(m)}</span>} onClick={() => { if (m !== talk) updatePerson(id, { model: m }, `说话模型 ${talk} → ${m}`); setTalk(m) }}>{talk === m && <Check className="h-4 w-4" />}</Row>)}
      </Group>
      <Group title="Compute 用的模型（干活）">
        {[{ k: 'inherit', l: `跟全局默认（现在是 ${GLOBAL_MODEL}）` }, { k: 'follow', l: `跟说话模型一样（${talk}）` }].map((o) => <Row key={o.k} label={o.l} onClick={() => setCm(o.k)}>{cm === o.k && <Check className="h-4 w-4" />}</Row>)}
        <Row label="单独指定" value={!['inherit', 'follow'].includes(cm) ? cm : undefined} onClick={() => setCm('Claude Opus 5.5')}>{!['inherit', 'follow'].includes(cm) && <Check className="h-4 w-4" />}</Row>
      </Group>
      <p className="mx-4 -mt-1 mb-3 text-[12px] text-fg-3">实际用：{effective}。复核要换一家：{p.name} 的产出会交给不是 {vendorOf(effective)} 的模型复核。</p>
      <Group title={`最多同时分几个 Compute · ${quota} 个`}>
        <div className="px-4 py-4"><Slider value={[quota]} min={1} max={5} step={1} onValueChange={(v) => setQuota(v[0])} /></div>
      </Group>
    </Scroll>
  )
}

/* AC-29：联系人能力默认隔离，白名单勾选 */
function ToolsPage({ id }: { id: PersonId }) {
  const p = people[id]
  const [tools, setTools] = useState(p.tools ?? [])
  return (
    <Scroll className="px-1">
      <p className="mx-4 mb-2 text-[12.5px] text-fg-3">只有勾上的能被 {p.name} 和它分出的 Compute 用到。本机装的其他技能和工具默认不给。</p>
      <Group title="技能">{tools.filter((t) => t.kind === 'skill').map((t) => <Row key={t.name} label={t.name}><Switch checked={t.on} onCheckedChange={(v) => setTools((ts) => ts.map((x) => (x.name === t.name ? { ...x, on: v } : x)))} /></Row>)}</Group>
      <Group title="工具">{tools.filter((t) => t.kind === 'mcp').map((t) => <Row key={t.name} label={t.name}><Switch checked={t.on} onCheckedChange={(v) => setTools((ts) => ts.map((x) => (x.name === t.name ? { ...x, on: v } : x)))} /></Row>)}</Group>
    </Scroll>
  )
}

/* ---------- US10-View 从群聊私信：看他在这个群里怎么安排活；在这里说话 = 在群里 @他 ---------- */
function InnerComposer({ id, conv }: { id: PersonId; conv: string }) {
  const { sendAs, convs } = useApp()
  const [t, setT] = useState('')
  const p = people[id]
  const cname = convs.find((x) => x.id === conv)?.title ?? ''
  const go = () => { const v = t.trim(); if (!v) return; sendAs(conv, `@${p.name} ${v}`); setT('') }
  return (
    <div className="border-t border-line p-3">
      <div className="flex items-end gap-2 rounded-2xl border border-line bg-bg px-3 py-2 focus-within:border-fg-3/50">
        <span className="shrink-0 pb-[3px] text-[13.5px] font-medium text-me">@{p.name}</span>
        <textarea data-testid="inner-input" rows={1} value={t} onChange={(e) => setT(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go() } }}
          placeholder="说点什么" className="max-h-28 min-h-[22px] flex-1 resize-none bg-transparent text-[13.5px] leading-[22px] outline-none placeholder:text-fg-3" />
        <button data-testid="inner-send" onClick={go} disabled={!t.trim()} className="shrink-0 rounded-full px-2.5 py-1 text-[12.5px] font-medium text-me disabled:text-fg-3">发送</button>
      </div>
      <div className="mt-1.5 px-1 text-[11.5px] text-fg-3">发在「{cname}」里，大家都看得到</div>
    </div>
  )
}

function InnerPage({ id, conv }: { id: PersonId; conv: string }) {
  const { computes, convs, typing } = useApp()
  const p = people[id]
  const c = convs.find((x) => x.id === conv)!
  const log = (innerLog[id] ?? []).filter((l) => l.conv === conv)
  const mine = Object.values(computes).filter((x) => x.owner === id && x.conv === conv)
  const said = c.messages.filter((m) => (m.k === 'text' && (m.from === id || (m.from === 'me' && m.text.includes('@' + p.name)))) || (m.k === 'compute' && m.from === id)) as Msg[]
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView() }, [said.length])
  return (
    <>
      <Scroll className="px-4" >
        <div className="mb-3 flex items-center gap-3 rounded-xl bg-hover/60 p-3" data-testid="inner">
          <Avatar id={id} size={36} />
          <div className="min-w-0 flex-1 text-[12.5px] text-fg-2">这里和群聊是同一份记录：只显示和 {p.name} 有关的消息，加上它平时不在群里说的安排过程。在这里说的话会发到群里，等于在群里 @它。</div>
        </div>
        {mine.length > 0 && (
          <div className="mb-3">
            <div className="mb-1 text-[12px] font-medium text-fg-3">它在这个群里分出的 Compute</div>
            {mine.map((x) => <div key={x.id}><ComputeLine id={x.id} /></div>)}
          </div>
        )}
        <div className="mb-1 text-[12px] font-medium text-fg-3">它怎么安排的</div>
        <ol className="mb-4 border-l border-line pl-3">
          {log.map((l, i) => (
            <li key={i} className="relative pb-2.5 text-[13px] leading-relaxed">
              <span className="absolute -left-[16.5px] top-[7px] h-2 w-2 rounded-full border-2 border-elev bg-fg-3/60" />
              <span className="mr-2 text-[11.5px] text-fg-3">{l.at}</span>{renderText(l.text, false)}
            </li>
          ))}
          {!log.length && <li className="text-[13px] text-fg-3">还没有安排记录</li>}
        </ol>
        <div className="mb-1 text-[12px] font-medium text-fg-3">群里和它有关的消息</div>
        <MessageList msgs={said} compact conv={conv} />
        {typing[conv] === id && <div className="ml-9 mt-1 text-[12px] text-fg-3">{p.name} 正在输入…</div>}
        <div ref={end} />
      </Scroll>
      {/* U46（#2273）：侧边栏里说话 = 在群里 @它。消息只有一份，发在群里，这里因为带 @它 也看得到 */}
      <InnerComposer id={id} conv={conv} />
    </>
  )
}

/* ---------- 群资料 ---------- */
function GroupPage({ id }: { id: string }) {
  const { convs, push, setConvFlag, renameConv, leaveConv, clearHistory, closeAll } = useApp()
  const g = convs.find((c) => c.id === id)
  const [confirm, setConfirm] = useState<null | 'leave' | 'dissolve' | 'clear'>(null)
  const [editT, setEditT] = useState(false)
  const [tv, setTv] = useState(g?.title ?? '')
  if (!g) return null
  const owner = g.roles?.me === 'owner'
  return (
    <Scroll>
      <div className="px-5 pb-4 pt-1">
        {editT ? (
          <form onSubmit={(e) => { e.preventDefault(); if (tv.trim()) renameConv(id, tv.trim()); setEditT(false) }}><input autoFocus value={tv} onChange={(e) => setTv(e.target.value)} onBlur={() => { if (tv.trim()) renameConv(id, tv.trim()); setEditT(false) }} className="h-9 w-full rounded-lg border border-line bg-bg px-2.5 text-[16px] font-semibold outline-none" /></form>
        ) : <button data-testid="group-rename" onClick={() => setEditT(true)} className="group/t flex items-center gap-1.5 text-left text-[18px] font-semibold tracking-tight">{g.title}<span className="text-[12px] font-normal text-fg-3 opacity-0 group-hover/t:opacity-100">改名</span></button>}
        <div className="text-[13px] text-fg-2">{g.members.length} 人</div>
      </div>
      {/* AC-50（#925）：成员、公告、关联/记下/手册、复制团队只在右侧群资料（head-side）一处；这里只剩群设置 */}
      <Group>
        {broken('AC-50-1') && <Row testid="group-search" label="查找聊天记录" onClick={() => push({ t: 'search', id })}><Search className="h-4 w-4 text-fg-3" /></Row>}
        <Row label="置顶聊天"><Switch data-testid="gp-pin" checked={!!g.pinned} onCheckedChange={(v) => setConvFlag(id, 'pinned', v)} /></Row>
        <Row label="消息免打扰"><Bell className="hidden" /><Switch data-testid="gp-mute" checked={!!g.muted} onCheckedChange={(v) => setConvFlag(id, 'muted', v)} /></Row>
        <Row testid="group-clear" label={<span className="text-err">清空聊天记录</span>} onClick={() => setConfirm('clear')} />
      </Group>
      <Group>
        {confirm ? (
          <div className="space-y-2 p-3" data-testid="leave-confirm">
            <div className="text-[13px] text-fg-2">{confirm === 'clear' ? '只清掉你自己看到的聊天记录。助手的记忆、清单、定时和文件都不受影响，别人也照样看得到。' : confirm === 'dissolve' ? `解散后所有人都没有这个群了，群里的 ${''}定时也会一起停。聊天记录和文件不会删，还能在「文件」里找到。` : '退出后你看不到这个群的新消息，助手们还在群里，它们的定时照常跑。'}</div>
            <div className="flex gap-2">
              <button onClick={() => setConfirm(null)} className="h-9 flex-1 rounded-lg bg-hover text-[13px] font-medium">取消</button>
              <button data-testid="leave-confirm-go" onClick={() => { if (confirm === 'clear') { clearHistory(id); setConfirm(null); closeAll() } else leaveConv(id, confirm === 'dissolve') }} className="h-9 flex-1 rounded-lg bg-err text-[13px] font-medium text-white">{confirm === 'clear' ? '清空' : confirm === 'dissolve' ? '解散' : '退出'}</button>
            </div>
          </div>
        ) : (
          <>
            {owner && <button data-testid="group-dissolve" onClick={() => setConfirm('dissolve')} className="flex h-11 w-full items-center justify-center gap-1.5 text-[14px] text-err hover:bg-hover">解散群聊</button>}
            <button data-testid="group-leave" onClick={() => setConfirm('leave')} className="flex h-11 w-full items-center justify-center gap-1.5 text-[14px] text-err hover:bg-hover"><LogOut className="h-4 w-4" />退出群聊</button>
          </>
        )}
      </Group>
    </Scroll>
  )
}

/* ---------- US2 会话关联 ---------- */
function LinksPage({ id }: { id: string }) {
  const { convs, push, unlinkConv, openConv } = useApp()
  const g = convs.find((c) => c.id === id)!
  const links = (g.links ?? []).map((l) => convs.find((c) => c.id === l)!).filter(Boolean)
  return (
    <Scroll className="px-1">
      <p className="mx-4 mb-3 text-[12.5px] leading-relaxed text-fg-3">默认每个会话的记录互不相通：群里的助手看不到你和它的私聊。关联之后，这里的助手回答时可以参考被关联会话的记录。取消关联后不再参考，已经转发过的内容不受影响。</p>
      <Group title={`已关联 · ${links.length}`}>
        {links.map((l) => (
          <div key={l.id} className="flex items-center gap-3 px-4 py-2.5">
            <Link2 className="h-4 w-4 text-fg-3" />
            <button onClick={() => openConv(l.id)} className="min-w-0 flex-1 truncate text-left text-[14px] hover:underline">{l.title}</button>
            <button data-testid={`unlink-${l.id}`} onClick={() => unlinkConv(id, l.id)} className="flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-fg-2 hover:bg-hover hover:text-err"><Unlink className="h-3.5 w-3.5" />取消</button>
          </div>
        ))}
        {!links.length && <div className="px-4 py-3 text-[13px] text-fg-3">还没有关联任何会话</div>}
      </Group>
      <div className="mx-3"><button data-testid="link-add" onClick={() => push({ t: 'linkPick', id })} className="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-fg-3/50 text-[13.5px] text-fg-2 hover:bg-hover hover:text-fg"><Plus className="h-4 w-4" />关联一个会话</button></div>
    </Scroll>
  )
}
function LinkPickPage({ id }: { id: string }) {
  const { convs, linkConv, back } = useApp()
  const g = convs.find((c) => c.id === id)!
  const list = convs.filter((c) => c.id !== id && !(g.links ?? []).includes(c.id))
  return (
    <Scroll className="px-2">
      {list.map((c) => (
        <button key={c.id} data-testid={`linkpick-${c.id}`} onClick={() => { linkConv(id, c.id); back() }} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-hover">
          <Avatar id={c.kind === 'dm' ? c.members.find((m) => m !== 'me')! : 'me'} size={32} status={false} />
          <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{c.title}</div><div className="text-[12px] text-fg-2">{c.kind === 'dm' ? '私聊' : `群聊 · ${c.members.length} 人`}</div></div>
        </button>
      ))}
    </Scroll>
  )
}

/* ---------- US11 / US6 承诺 ---------- */
function CommitsPage({ id }: { id: string }) {
  const { commits, jump, convs } = useApp()
  const list = commits.filter((c) => c.conv === id)
  return (
    <Scroll className="px-1">
      <p className="mx-4 mb-3 text-[12.5px] leading-relaxed text-fg-3">你在群里说的话，每个助手会自己判断和自己有没有关系，有关就记成自己要做的事。绑定的任务都做完后自动失效。</p>
      {list.map((c) => (
        <div key={c.id} className="mx-3 mb-2 rounded-xl bg-hover/60 p-3">
          <div className="flex items-center gap-2"><Avatar id={c.owner} size={22} status={false} /><span className="text-[13.5px] font-medium">{people[c.owner].name}</span><span className="rounded-full bg-elev px-2 py-0.5 text-[11.5px] text-fg-2">{c.trigger}</span>{c.next && <span className="text-[11.5px] text-fg-3">下次 {c.next}</span>}</div>
          <div className="mt-1.5 text-[13.5px]">{c.text}</div>
          <button onClick={() => jump(c.srcMsg)} className="mt-1 text-[12px] text-fg-3 hover:text-fg">来自你的这句话 ↗</button>
        </div>
      ))}
      {!list.length && <div className="px-4 text-[13px] text-fg-3">这个群里还没有人记下什么</div>}
      <p className="mx-4 mt-2 text-[12px] text-fg-3">在{convs.find((c) => c.id === id)?.title}里说“别汇报了”或“取消每天的总结”，对应的助手会撤掉。</p>
    </Scroll>
  )
}

/* ---------- US14 群协作手册 ---------- */
function PlaybookPage({ id: _id }: { id: string }) {
  const { playbook } = useApp()
  const kinds = ['分工', '交接', '纠正落点', '可信度'] as const
  const scopeText = { project: '只限本项目', team: '这个团队通用', global: '到哪都通用' }
  return (
    <Scroll className="px-1">
      <p className="mx-4 mb-3 text-[12.5px] leading-relaxed text-fg-3">大家在这个群里磨出来的配合方式。每条都写明来自哪句话。助手定期复盘提修改，你同意后才生效。</p>
      {kinds.map((k) => {
        const list = playbook.filter((p) => p.kind === k)
        if (!list.length) return null
        return (
          <Group key={k} title={k}>
            {list.map((p) => (
              <div key={p.id} className="px-4 py-2.5">
                <div className="text-[13.5px] leading-relaxed">{p.text}</div>
                <div className="mt-1 flex gap-2 text-[11.5px] text-fg-3"><span className={cn('rounded px-1.5', p.scope === 'project' ? 'bg-warm-soft text-warm' : 'bg-elev')}>{scopeText[p.scope]}</span><span>来自 {p.src}</span></div>
              </div>
            ))}
          </Group>
        )
      })}
    </Scroll>
  )
}

/* ---------- US14 净室克隆 ---------- */
/* ---------- 查找聊天记录（AC-25：每条带 #seq 可跳转） ---------- */
function SearchPage({ id }: { id: string }) {
  const { convs, jump, closeAll } = useApp()
  const [q, setQ] = useState('飞书')
  const g = convs.find((c) => c.id === id)!
  /* AC-25：每条结果带 #seq，点了跳回原消息并高亮；AC-08：撤回的消息变成系统行，原文不再被搜到 */
  const seqOf = (mid: string) => g.messages.filter((m) => 'id' in m).findIndex((m) => 'id' in m && m.id === mid) + 1
  const hits = (broken('AC-25') ? [] : g.messages.filter((m) => m.k === 'text' && q && m.text.includes(q))) as Extract<Msg, { k: 'text' }>[]
  return (
    <>
      <div className="px-3 pb-2"><input data-testid="search-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" className="h-9 w-full rounded-lg bg-hover px-3 text-[14px] outline-none" /></div>
      <Scroll className="px-2">
        {hits.map((m) => (
          <button key={m.id} data-testid={`search-hit-${m.id}`} onClick={() => { jump(m.id); closeAll() }} className="flex w-full gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-hover">
            <Avatar id={m.from} size={26} status={false} />
            <div className="min-w-0 flex-1"><div className="text-[12px] text-fg-2">{people[m.from].name} · #{seqOf(m.id)}</div><div className="line-clamp-2 text-[13.5px]">{m.text}</div></div>
          </button>
        ))}
        {!hits.length && <div className="px-3 py-6 text-center text-[13px] text-fg-3">没找到</div>}
      </Scroll>
    </>
  )
}

/* ---------- GrokBot 式讨论：只读看原话，结论在群里 ---------- */
function HuddlePage({ conv, msgId }: { conv: string; msgId: string }) {
  const { convs, jump, closeAll, addQuote } = useApp()
  const c = convs.find((x) => x.id === conv)!
  const m = c.messages.find((x) => 'id' in x && x.id === msgId) as Extract<Msg, { k: 'huddle' }>
  return (
    <>
      <Scroll className="px-4">
        <div className="mb-3 flex items-center gap-2 text-[12.5px] text-fg-2" data-testid="huddle-page">
          {m.who.map((w) => <span key={w} className="flex items-center gap-1"><Avatar id={w} size={18} status={false} mood="idle" />{people[w].name}</span>)}
          <span className="text-fg-3">· {m.items.length} 条 · 只读</span>
        </div>
        <MessageList msgs={m.items.map((it) => ({ k: 'text', id: it.id, from: it.from, text: it.text }))} compact />
      </Scroll>
      <div className="flex gap-2 border-t border-line p-3">
        <button onClick={() => { addQuote({ msgId: m.conclusion, from: m.who[1] ?? m.who[0], text: '讨论结论', reply: true }); closeAll() }} className="h-9 flex-1 rounded-lg bg-hover text-[13px] font-medium hover:bg-sel">回复这次讨论</button>
        <button data-testid="huddle-conclusion" onClick={() => { jump(m.conclusion); closeAll() }} className="h-9 flex-1 rounded-lg bg-me text-[13px] font-medium text-me-fg">看群里的结论</button>
      </div>
    </>
  )
}

/* ---------- US2 转发 ---------- */
function ForwardPickPage({ from, msgIds }: { from: string; msgIds: string[] }) {
  const { convs, forward, closeAll } = useApp()
  const src = convs.find((c) => c.id === from)!
  return (
    <Scroll className="px-2">
      <p className="mx-2.5 mb-2 text-[12.5px] text-fg-3">把「{src.title}」里选中的 {msgIds.length} 条转过去。对方只看到这几条，看不到原会话的其他内容。</p>
      {convs.filter((c) => c.id !== from).map((c) => (
        <button key={c.id} data-testid={`fwd-${c.id}`} onClick={() => { forward(from, msgIds, c.id); closeAll() }} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-hover">
          <Avatar id={c.kind === 'dm' ? c.members.find((m) => m !== 'me')! : 'me'} size={32} status={false} />
          <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{c.title}</div><div className="text-[12px] text-fg-2">{c.kind === 'dm' ? '私聊' : `群聊 · ${c.members.length} 人`}</div></div>
          <Forward className="h-4 w-4 text-fg-3" />
        </button>
      ))}
    </Scroll>
  )
}
function ForwardViewPage({ conv, msgId }: { conv: string; msgId: string }) {
  const { convs } = useApp()
  const m = convs.find((c) => c.id === conv)!.messages.find((x) => 'id' in x && x.id === msgId) as Extract<Msg, { k: 'forward' }>
  return (
    <Scroll className="px-4">
      <div className="mb-2 text-[12.5px] text-fg-3">来自「{m.srcTitle}」· 只读</div>
      <MessageList msgs={m.items.map((it, i) => ({ k: 'text', id: 'fv' + i, from: it.from, text: it.text }))} compact />
    </Scroll>
  )
}

/* ---------- Helper ---------- */
type HMsg = { from: 'me' | 'helper'; text: string; card?: { title: string; lines: string[]; action: () => void; done?: boolean } }
function HelperPage() {
  const ctx = useApp()
  const conv = ctx.convs.find((c) => c.id === ctx.active)
  const [msgs, setMsgs] = useState<HMsg[]>([{ from: 'helper', text: '你好，我是 Helper。手动能做的事都可以跟我说：拉人、建联系人、导入任务表、设提醒、关联会话、接外部来源。' }])
  const [v, setV] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs.length])
  const say = (t: string) => {
    setMsgs((m) => [...m, { from: 'me', text: t }])
    setTimeout(() => {
      let reply: HMsg
      if (/拉|加/.test(t) && /Grok/i.test(t)) reply = { from: 'helper', text: '好，确认一下：', card: { title: `把 Grok 拉进「${conv?.title}」`, lines: ['Grok 只看得到之后的新消息'], action: () => ctx.addMembers(ctx.active, ['grok'], 'helper') } }
      else if (/CSV|csv|任务表|任务板/.test(t)) reply = { from: 'helper', text: '读到 4 行任务。确认一下：', card: { title: `在「${conv?.title}」建任务认领板`, lines: ['登录页深色 / 首页性能 / 飞书接入方案 / 设计规范', '建好后我在群里 @所有人 认领'], action: () => ctx.importBoard(ctx.active) } }
      else if (/关联/.test(t)) reply = { from: 'helper', text: '好，确认一下：', card: { title: `把「Claude Code」私聊关联到「${conv?.title}」`, lines: ['群里的助手回答时可以参考那段私聊', '随时可以在群资料里取消'], action: () => ctx.linkConv(ctx.active, 'dm-claude') } }
      else if (/联系人|助手/.test(t)) { reply = { from: 'helper', text: '我打开了新建联系人，你填名字和擅长的事就行。' }; setTimeout(() => ctx.push({ t: 'addContact' }), 500) }
      else reply = { from: 'helper', text: '收到。这个原型里我演示了：拉人、导入任务表、关联会话、新建联系人。' }
      setMsgs((m) => [...m, reply])
    }, 500)
  }
  const chips = ['把 Grok 拉进这个群', '导入这个 CSV 做成任务板', '把我和 Claude Code 的私聊关联进来', '新建一个联系人']
  return (
    <>
      <div className="flex items-center gap-2 px-4 pb-2"><Bot shape="lightbulb" color="#f8a01c" size={20} /><span className="rounded-full bg-hover px-2 py-0.5 text-[11.5px] text-fg-2">在：{conv?.title}</span></div>
      <div className="scroll-thin flex-1 space-y-2.5 overflow-y-auto px-4 pb-3">
        {msgs.map((m, i) => (
          <div key={i} className={cn('flex flex-col', m.from === 'me' ? 'items-end' : 'items-start')}>
            <div className={cn('max-w-[86%] rounded-[16px] px-3 py-1.5 text-[14px] leading-relaxed', m.from === 'me' ? 'bg-me text-me-fg' : 'bg-hover')}>{m.text}</div>
            {m.card && (
              <div className="mt-1.5 w-[86%] rounded-xl border border-line p-3" data-testid="helper-card">
                <div className="text-[14px] font-semibold">{m.card.title}</div>
                <ul className="mt-1 space-y-0.5 text-[12.5px] text-fg-2">{m.card.lines.map((l) => <li key={l}>· {l}</li>)}</ul>
                {m.card.done ? <div className="mt-2.5 flex items-center gap-1.5 text-[13px] text-ok"><Check className="h-4 w-4" />已完成</div> : (
                  <div className="mt-2.5 flex gap-2">
                    <button data-testid="helper-confirm" onClick={() => { m.card!.action(); setMsgs((x) => x.map((y, j) => (j === i ? { ...y, card: { ...y.card!, done: true } } : y))) }} className="h-8 flex-1 rounded-lg bg-me text-[13px] font-medium text-me-fg">确认</button>
                    <button onClick={() => setMsgs((x) => x.filter((_, j) => j !== i))} className="h-8 flex-1 rounded-lg bg-hover text-[13px] font-medium">取消</button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="px-3 pb-3">
        <div className="no-scrollbar mb-2 flex gap-1.5 overflow-x-auto">{chips.map((c) => <button key={c} data-testid="helper-chip" onClick={() => say(c)} className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg">{c}</button>)}</div>
        <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) { say(v.trim()); setV('') } }} className="flex items-center gap-2 rounded-full bg-hover pl-4 pr-1">
          <Sparkles className="h-4 w-4 shrink-0 text-fg-3" />
          <input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="想让软件做什么？" className="h-10 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-3" />
          <button disabled={!v.trim()} className="grid h-8 w-8 place-items-center rounded-full bg-me text-me-fg disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
        </form>
      </div>
    </>
  )
}

/* ---------- 设置 ---------- */
function SettingsPage() {
  const { dark, setDark, debug, setDebug, push, setSection, closeAll } = useApp()
  return (
    <Scroll>
      <div className="mx-3 mb-3 flex items-center gap-3 rounded-xl bg-hover/60 p-3">
        <Avatar id="me" size={44} />
        <div className="flex-1"><div className="text-[15px] font-semibold">39impacts</div><div className="text-[12.5px] text-fg-2">本月共花费 ¥85.30</div></div>
      </div>
      <Group title="外观">
        <div className="flex gap-2 p-3">
          {[{ k: false, l: '浅色' }, { k: true, l: '深色' }].map((o) => (
            <button key={o.l} onClick={() => setDark(o.k)} className={cn('flex-1 rounded-lg border p-2 text-[13px]', dark === o.k ? 'border-fg bg-bg font-medium' : 'border-line text-fg-2')}>
              <div className={cn('mb-1.5 h-10 rounded-md', o.k ? 'bg-[#1b1b1d]' : 'bg-[#f2f2f4]')} />{o.l}
            </button>
          ))}
        </div>
      </Group>
      <Group title="默认">
        <Row label="全局默认模型" value={GLOBAL_MODEL} onClick={() => {}} />
        <Row label="复核必须换一家模型"><Switch defaultChecked /></Row>
      </Group>
      <Group title="通知">
        <Row label="有事等我时提醒"><Switch defaultChecked /></Row>
        <Row label="出错时提醒"><Switch defaultChecked /></Row>
      </Group>
      <Group title="插件">
        <Row testid="settings-plugins" label={<span className="flex items-center gap-2"><Puzzle className="h-4 w-4 text-fg-2" />插件中心</span>} value="市场、安装、更新" onClick={() => { setSection('plugins'); closeAll() }} />
      </Group>
      <Group title="连接">
        <Row label="外部来源" value="已连 2 个" onClick={() => push({ t: 'sources' })} />
        <Row label="模型服务" value="3 个" onClick={() => {}} />
      </Group>
      <Group title="高级"><Row label="调试模式"><Switch checked={debug} onCheckedChange={setDebug} /></Row></Group>
      <p className="px-6 text-[12px] leading-relaxed text-fg-3">调试模式会在 Compute 里显示内部编号等排查信息，平时不需要打开。</p>
    </Scroll>
  )
}

/* ---------- 添加联系人 ---------- */
function AddContactPage() {
  const { createContact } = useApp()
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [shape, setShape] = useState('cat')
  const [color, setColor] = useState('#ec4899')
  const [model, setModel] = useState('Claude Sonnet 5.5')
  const [quota, setQuota] = useState(2)
  return (
    <>
      <Scroll className="px-4">
        <div className="flex flex-col items-center py-3"><Bot shape={shape} color={color} size={80} follow /></div>
        <div className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1 pb-2">
          {SHAPES.map((s) => <button key={s} onClick={() => setShape(s)} className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', shape === s ? 'bg-sel ring-1 ring-fg-3/60' : 'hover:bg-hover')}><Bot shape={s} color={color} size={30} still /></button>)}
        </div>
        <div className="flex justify-center gap-1.5 pb-4">{SWATCHES.map((c) => <button key={c} onClick={() => setColor(c)} className={cn('h-6 w-6 rounded-full ring-offset-2 ring-offset-elev', color === c && 'ring-2 ring-fg-2')} style={{ background: c }} />)}</div>
        <label className="block text-[12.5px] font-medium text-fg-2">名字</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="比如：设计师" className="mt-1 h-10 w-full rounded-lg border border-line bg-bg px-3 text-[14px] outline-none focus:border-fg-3" />
        <label className="mt-3 block text-[12.5px] font-medium text-fg-2">擅长什么</label>
        <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="比如：画界面、做配色" className="mt-1 h-10 w-full rounded-lg border border-line bg-bg px-3 text-[14px] outline-none focus:border-fg-3" />
        <label className="mt-3 block text-[12.5px] font-medium text-fg-2">说话用的模型</label>
        <div className="mt-1 flex flex-wrap gap-1.5">{MODELS.slice(0, 6).map((m) => <button key={m} onClick={() => setModel(m)} className={cn('rounded-lg border px-2.5 py-1 text-[12.5px]', model === m ? 'border-fg bg-sel' : 'border-line text-fg-2 hover:bg-hover')}>{m}</button>)}</div>
        <div className="mt-4 flex items-center justify-between text-[12.5px] font-medium text-fg-2"><span>最多同时分几个 Compute</span><span className="text-fg">{quota} 个</span></div>
        <Slider value={[quota]} min={1} max={5} step={1} onValueChange={(v) => setQuota(v[0])} className="mt-3" />
        <p className="mt-3 text-[12px] text-fg-3">Compute 用的模型默认跟全局（{GLOBAL_MODEL}），之后可在资料里改。</p>
      </Scroll>
      <div className="border-t border-line p-3">
        <button disabled={!name.trim()} onClick={() => createContact({ name: name.trim(), role: role.trim() || '通用助手', shape, color, model, quota })} className="h-10 w-full rounded-xl bg-me text-[14px] font-medium text-me-fg disabled:bg-hover disabled:text-fg-3">添加</button>
      </div>
    </>
  )
}

/* ---------- 发起群聊 ---------- */
function NewGroupPage() {
  const { createGroup, closeAll } = useApp()
  const [title, setTitle] = useState('')
  const [pick, setPick] = useState<Record<string, boolean>>({})
  const [pool, setPoolN] = useState(0)
  const list = Object.values(people).filter((p) => p.id !== 'me' && p.id !== 'helper')
  const ids = Object.keys(pick).filter((k) => pick[k])
  return (
    <>
      <div className="px-4 pb-2"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="群名（可以不填）" className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-[14px] outline-none focus:border-fg-3" /></div>
      <Scroll className="px-2">
        {list.map((p) => (
          <label key={p.id} className="flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 hover:bg-hover">
            <Checkbox checked={!!pick[p.id]} onCheckedChange={(v) => setPick((x) => ({ ...x, [p.id]: !!v }))} className="rounded-full border-fg-3 data-[state=checked]:border-me data-[state=checked]:bg-me data-[state=checked]:text-me-fg" />
            <Avatar id={p.id} size={34} status={false} />
            <div className="min-w-0 flex-1"><div className="text-[14px] font-medium">{p.name}</div><div className="truncate text-[12px] text-fg-2">{p.role}</div></div>
          </label>
        ))}
      </Scroll>
      <div className="border-t border-line p-3">
        <div className="mb-2.5 flex items-center gap-2 text-[13px]" data-testid="newgroup-pool">
          <span className="text-fg-2">临时算力</span>
          {[0, 1, 2, 3].map((n) => (
            <button key={n} data-testid={`newgroup-pool-${n}`} onClick={() => setPoolN(n)} className={cn('h-7 min-w-8 rounded-md border px-2', n === pool ? 'border-me bg-me/10 font-medium text-me' : 'border-line text-fg-2 hover:bg-hover')}>{n === 0 ? '不给' : `${n} 格`}</button>
          ))}
          <span className="ml-auto text-[12px] text-fg-3">人少时补算力，做完就还</span>
        </div>
        <button disabled={ids.length < 2} onClick={() => { createGroup(title.trim() || ids.map((i) => people[i].name).slice(0, 3).join('、'), ids, undefined, pool); closeAll() }} className="h-10 w-full rounded-xl bg-me text-[14px] font-medium text-me-fg disabled:bg-hover disabled:text-fg-3">
          {ids.length < 2 ? '至少选 2 人' : `创建群聊（${ids.length + 1} 人）`}
        </button>
      </div>
    </>
  )
}

/* ---------- 外部来源：列表 → 某个来源（压栈，返回回到列表） ---------- */
function SourcesPage() {
  const { push } = useApp()
  return (
    <Scroll className="px-2">
      <div className="px-2.5 pb-1 pt-1 text-[12px] font-medium text-fg-3">已连接</div>
      {sources.filter((x) => x.connected).map((x) => (
        <button key={x.id} data-testid={`source-${x.id}`} onClick={() => push({ t: 'source', id: x.id })} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left hover:bg-hover">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-hover text-[13px] font-semibold">{x.letter}</span>
          <div className="min-w-0 flex-1"><div className="text-[14px] font-medium">{x.app} · {x.name}</div><div className="text-[12px] text-fg-2">{x.state}</div></div>
          <ChevronRight className="h-4 w-4 text-fg-3" />
        </button>
      ))}
      <div className="px-2.5 pb-1 pt-3 text-[12px] font-medium text-fg-3">还可以连接（装插件）</div>
      {sources.filter((x) => !x.connected).map((x) => (
        <div key={x.id} className="flex items-center gap-3 rounded-xl px-2.5 py-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-hover text-[13px] font-semibold text-fg-3">{x.letter}</span>
          <span className="flex-1 text-[14px] text-fg-2">{x.app}</span>
          <button className="flex h-7 items-center gap-1 rounded-full bg-hover px-3 text-[12.5px] font-medium hover:bg-sel"><Plus className="h-3.5 w-3.5" />连接</button>
        </div>
      ))}
    </Scroll>
  )
}
function SourcePage({ id }: { id: string }) {
  const { quoteExternal, closeAll } = useApp()
  const s = sources.find((x) => x.id === id)!
  const [sel, setSel] = useState<Record<number, boolean>>({})
  const n = Object.values(sel).filter(Boolean).length
  return (
    <>
      <div className="px-4 pb-1 text-[12.5px] text-fg-3">{s.name} · {s.state}</div>
      <Scroll className="px-2">
        {s.msgs!.map((m, i) => (
          <label key={i} data-testid={`srcmsg-${i}`} className={cn('flex cursor-pointer gap-3 rounded-xl px-2.5 py-2.5 hover:bg-hover', sel[i] && 'bg-sel hover:bg-sel')}>
            <Checkbox checked={!!sel[i]} onCheckedChange={(v) => setSel((x) => ({ ...x, [i]: !!v }))} className="mt-0.5 rounded-[5px] border-fg-3 data-[state=checked]:border-me data-[state=checked]:bg-me data-[state=checked]:text-me-fg" />
            <div className="min-w-0"><div className="text-[12px] text-fg-2">{m.who} · {m.time}</div><div className="text-[14px] leading-relaxed">{m.text}</div></div>
          </label>
        ))}
      </Scroll>
      <div className="border-t border-line p-3">
        <button data-testid="src-quote" disabled={!n} onClick={() => { quoteExternal(s.msgs!.filter((_, i) => sel[i]), s.app); closeAll() }} className="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-me text-[14px] font-medium text-me-fg disabled:bg-hover disabled:text-fg-3"><Send className="h-4 w-4" />{n ? `带 ${n} 条进对话` : '勾选要带进对话的消息'}</button>
        <p className="mt-2 text-center text-[12px] text-fg-3">外部消息只当参考，不会让助手直接去执行</p>
      </div>
    </>
  )
}

/* ---------- 查看对话细节：它和你 / 和其他助手 / 在做什么 / 它记住了什么 ---------- */
export function DetailPage({ id, conv, tab: tab0, bare }: { id: PersonId; conv: string; tab?: 'me' | 'agents' | 'work' | 'memory'; bare?: boolean }) {
  const { convs, computes, push, openDm, jump, closeAll } = useApp()
  const p = people[id]
  const [tab, setTab] = useState(tab0 ?? 'agents')
  const dm = convs.find((c) => c.kind === 'dm' && c.members.includes(id))
  const talks = agentTalks.filter((t) => t.who.includes(id))
  const mine = Object.values(computes).filter((c) => c.owner === id)
  const groupMsgs = convs.flatMap((c) => c.messages.filter((m) => m.k === 'text' && (m.from === id || (m.from === 'me' && m.text.includes('@' + p.name)))).map((m) => ({ conv: c, m: m as Extract<Msg, { k: 'text' }> })))
  const tabs = [{ k: 'agents', l: `和其他助手 ${talks.length}` }, { k: 'me', l: '和你' }, { k: 'work', l: `在做的事 ${mine.filter((c) => c.status !== 'done').length}` }, { k: 'memory', l: '它记住的' }] as const
  return (
    <>
      {!bare && <><div className="flex items-center gap-3 px-4 pb-2" data-testid="detail">
        <Avatar id={id} size={36} />
        <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium">{p.name}</div><div className="truncate text-[12px] text-fg-3">{p.role} · {p.model}</div></div>
        <button onClick={() => push({ t: 'person', id })} className="h-7 rounded-md px-2 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg">资料 ›</button>
      </div>
      <div className="flex gap-1 border-b border-line px-3">
        {tabs.map((t) => <button key={t.k} data-testid={`dtab-${t.k}`} onClick={() => setTab(t.k)} className={cn('-mb-px h-9 border-b-2 px-2 text-[12.5px]', tab === t.k ? 'border-fg font-medium' : 'border-transparent text-fg-2 hover:text-fg')}>{t.l}</button>)}
      </div>
      </>}
      <Scroll className="px-3 pt-2">
        {tab === 'agents' && (
          <>
            <p className="mb-2 px-1 text-[12px] text-fg-3">助手之间的对话平时不进群聊，只在群里留一行灰字和结论。原话都在这里。</p>
            {talks.map((t) => {
              const other = t.who.find((w) => w !== id)!
              return (
                <button key={t.id} data-testid={`talk-${t.id}`} onClick={() => push({ t: 'talk', id: t.id })} className="mb-1 flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-hover">
                  <Avatar id={other} size={30} status={false} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2"><span className="truncate text-[13.5px] font-medium">和 {people[other].name}：{t.title}</span><span className="ml-auto shrink-0 text-[11.5px] text-fg-3">{t.at}</span></div>
                    <div className="truncate text-[12px] text-fg-2">{t.items.length} 条 · 在{convs.find((c) => c.id === t.conv)?.title} · {t.items[t.items.length - 1]?.text}</div>
                  </div>
                </button>
              )
            })}
          </>
        )}
        {tab === 'me' && (
          <>
            <div className="mb-1 px-1 text-[12px] font-medium text-fg-3">私聊</div>
            {dm ? (
              <button onClick={() => openDm(id)} className="mb-3 flex w-full items-center gap-2 rounded-xl bg-hover/60 px-3 py-2 text-left hover:bg-hover">
                <span className="min-w-0 flex-1 truncate text-[13px]">{(dm.messages.filter((m) => m.k === 'text').slice(-1)[0] as { text: string } | undefined)?.text ?? '还没有消息'}</span><span className="text-[12px] text-me">打开私聊 ›</span>
              </button>
            ) : <div className="mb-3 px-1 text-[13px] text-fg-3">还没有私聊</div>}
            <div className="mb-1 px-1 text-[12px] font-medium text-fg-3">在群里和你有关的消息</div>
            {groupMsgs.slice(-8).map(({ conv: c, m }) => (
              <button key={c.id + m.id} onClick={() => { jump(m.id); closeAll() }} className="flex w-full gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-hover">
                <Avatar id={m.from} size={20} status={false} mood="idle" />
                <div className="min-w-0 flex-1"><div className="text-[11.5px] text-fg-3">{c.title}</div><div className="line-clamp-2 text-[13px]">{m.text}</div></div>
              </button>
            ))}
          </>
        )}
        {tab === 'work' && (
          <>
            {mine.map((c) => (
              <div key={c.id} className="mb-1"><ComputeLine id={c.id} /></div>
            ))}
            <div className="mb-1 mt-3 px-1 text-[12px] font-medium text-fg-3">它怎么安排的（{convs.find((c) => c.id === conv)?.title}）</div>
            <ol className="ml-2 border-l border-line pl-3">
              {(innerLog[id] ?? []).map((l, i) => <li key={i} className="pb-2 text-[13px]"><span className="mr-2 text-[11.5px] text-fg-3">{l.at}</span>{renderText(l.text, false)}</li>)}
            </ol>
          </>
        )}
        {tab === 'memory' && (
          <>
            {candidate('U61') && <><div className="mb-1 px-1 text-[12px] font-medium text-fg-3">性格（它自己会慢慢改，改了留版本）</div>
            <div className="mb-3 rounded-xl bg-hover/60 px-3 py-2.5 text-[13px] leading-relaxed">{p.soul}</div></>}
            <div className="mb-1 px-1 text-[12px] font-medium text-fg-3">长期记忆</div>
            {(p.memory ?? []).map((m, i) => <div key={i} className="flex gap-2 rounded-lg px-2 py-1.5 text-[13px]"><span className="text-fg-3">·</span><span className="flex-1">{m.text}</span><span className="shrink-0 text-[11.5px] text-fg-3">{m.src}</span></div>)}
            <div className="mb-1 mt-3 px-1 text-[12px] font-medium text-fg-3">配置版本</div>
            {(p.versions ?? []).map((v) => (
              <div key={v.v} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]">
                <span className="w-7 text-fg-3">v{v.v}</span><span className="flex-1">{v.note}</span><span className="text-[11.5px] text-fg-3">{v.at}</span>
                {v.v !== p.versions![0].v && <button className="rounded px-1.5 text-[12px] text-me hover:underline">回到这版</button>}
              </div>
            ))}
          </>
        )}
      </Scroll>
    </>
  )
}

function TalkPage({ id }: { id: string }) {
  const { convs, jump, closeAll } = useApp()
  const t = agentTalks.find((x) => x.id === id)!
  return (
    <>
      <Scroll className="px-4">
        <div className="mb-3 flex items-center gap-2 text-[12.5px] text-fg-2" data-testid="talk-page">
          {t.who.map((w) => <span key={w} className="flex items-center gap-1"><Avatar id={w} size={18} status={false} mood="idle" />{people[w].name}</span>)}
          <span className="text-fg-3">· {t.items.length} 条 · 只读 · 在{convs.find((c) => c.id === t.conv)?.title}</span>
        </div>
        <MessageList msgs={t.items.map((it, i) => ({ k: 'text', id: t.id + i, from: it.from, text: it.text }))} compact />
      </Scroll>
      <div className="border-t border-line p-3"><button onClick={() => { const c = convs.find((x) => x.id === t.conv)!; const last = [...c.messages].reverse().find((m) => m.k === 'text' && t.who.includes(m.from)) as { id: string } | undefined; if (last) jump(last.id); closeAll() }} className="h-9 w-full rounded-lg bg-hover text-[13px] font-medium hover:bg-sel">回到群里看结论</button></div>
    </>
  )
}

/* U27/U28：群工作区与提交归属 */
function WorkspacePage({ id }: { id: string }) {
  const { convs } = useApp()
  const g = convs.find((c) => c.id === id)!
  const w = g.workspace
  if (!w) return <Scroll className="px-4"><div className="py-6 text-center text-[13px] text-fg-3">这个群还没绑定工作区</div></Scroll>
  return (
    <Scroll className="px-1">
      <Group title="工作区"><Row label="目录" value={<span className="font-mono text-[12.5px]">{w.path}</span>} /><Row label="分支" value={w.branch} /></Group>
      <Group title="最近提交（谁改的都记着）">
        {w.commits.map((c, i) => (
          <div key={i} className="flex items-center gap-2.5 px-4 py-2.5">
            <Avatar id={c.who} size={22} status={false} />
            <div className="min-w-0 flex-1"><div className="truncate text-[13.5px]">{c.msg}</div><div className="text-[11.5px] text-fg-3">{people[c.who].name} · {c.at}</div></div>
            <span className="text-[11.5px] text-ok">+{c.add}</span><span className="text-[11.5px] text-err">−{c.del}</span>
          </div>
        ))}
      </Group>
      <p className="mx-4 text-[12px] text-fg-3">对外是一个仓库，内部每条提交都记着是哪个助手写的。回退工作区时，助手的长期记忆不跟着回退。</p>
    </Scroll>
  )
}

function PinsPage({ id }: { id: string }) {
  const { convs, jump, closeAll, pinMsg } = useApp()
  const g = convs.find((c) => c.id === id)!
  const list = (g.pins ?? []).map((pid) => g.messages.find((m) => m.k === 'text' && m.id === pid)).filter(Boolean) as Extract<Msg, { k: 'text' }>[]
  return (
    <Scroll className="px-2">
      <p className="mx-2 mb-2 text-[12px] text-fg-3">置顶只是方便你找回，不会当成群规；要助手照做的，写进群公告。</p>
      {list.map((m) => (
        <div key={m.id} className="group/p flex gap-2.5 rounded-xl px-2.5 py-2 hover:bg-hover">
          <Avatar id={m.from} size={26} status={false} />
          <button onClick={() => { jump(m.id); closeAll() }} className="min-w-0 flex-1 text-left"><div className="text-[12px] text-fg-2">{people[m.from].name}</div><div className="line-clamp-2 text-[13.5px]">{m.text}</div></button>
          <button onClick={() => pinMsg(id, m.id)} className="self-center text-[12px] text-fg-3 opacity-0 hover:text-err group-hover/p:opacity-100">移出</button>
        </div>
      ))}
    </Scroll>
  )
}

function FilesPage({ id }: { id: string }) {
  const { openSplit, closeAll } = useApp()
  const list = artifacts.filter((a) => a.conv === id)
  return (
    <Scroll className="px-2">
      {list.map((a) => (
        <button key={a.id} onClick={() => { openSplit({ t: 'artifact', id: a.id }); closeAll() }} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-hover">
          <ArtifactIcon kind={a.kind} className="h-9 w-9" />
          <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{a.name}</div><div className="text-[12px] text-fg-2">{a.meta} · {people[a.by].name} · {a.when}</div></div>
        </button>
      ))}
      {!list.length && <div className="py-6 text-center text-[13px] text-fg-3">还没有文件</div>}
      <p className="mx-2 mt-2 text-[12px] text-fg-3">群文件是群里共享的资产：助手交付的文档、页面、任务板、服务器账号都在这。删聊天记录不会删文件。</p>
    </Scroll>
  )
}

/* U09 #13 #154：群临时算力。给这个群额外借几格算力，只能本群用、不串群；做完、停下、出错、踢人、解散都自动还回来。
   群主能改上限、能把某一格立刻收回（= 停下那件事）；别人只能看 */
function PoolPage({ id }: { id: string }) {
  const { convs, computes, setPool, stop, openSplit, closeAll } = useApp()
  const g = convs.find((c) => c.id === id)
  if (!g) return null
  const owner = g.roles?.me === 'owner'
  const max = g.tempCompute?.max ?? 0
  const lent = Object.values(computes).filter((c) => c.conv === id && c.pool === 'group' && (c.status === 'running' || c.status === 'waiting' || c.stopping))
  const back = Object.values(computes).filter((c) => c.conv === id && c.pool === 'group' && !lent.includes(c))
  return (
    <Scroll className="px-4 pb-4">
      <div data-testid="pool-page" data-max={max} data-used={lent.length} className="rounded-xl border border-line p-3.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[14px] font-semibold">借出 {lent.length} / {max} 格</span>
          <span className="text-[12px] text-fg-3">只给本群用，做完自动还</span>
        </div>
        <div className="mt-2 flex gap-1.5">{Array.from({ length: Math.max(max, lent.length) }, (_, i) => (
          <span key={i} className={cn('h-2 flex-1 rounded-full', i < lent.length ? (i < max ? 'bg-me' : 'bg-warn') : 'bg-line')} />
        ))}</div>
        {owner ? (
          <div className="mt-3 flex items-center gap-2 text-[13px]">
            <span className="text-fg-2">上限</span>
            {[0, 1, 2, 3, 5].map((n) => (
              <button key={n} data-testid={`pool-max-${n}`} onClick={() => setPool(id, n)} className={cn('h-7 min-w-8 rounded-md border px-2', n === max ? 'border-me bg-me/10 font-medium text-me' : 'border-line text-fg-2 hover:bg-hover')}>{n === 0 ? '不给' : n}</button>
            ))}
          </div>
        ) : <div className="mt-3 text-[12.5px] text-fg-3">上限由群主设</div>}
      </div>
      <div className="mt-4 text-[12.5px] font-medium text-fg-3">正在用</div>
      {lent.length === 0 && <div className="py-3 text-[13px] text-fg-3">没有借出去的</div>}
      {lent.map((c) => (
        <div key={c.id} data-testid={`pool-lent-${c.id}`} className="flex items-center gap-2.5 rounded-lg px-1 py-2">
          <Avatar id={c.owner} size={26} status={false} />
          <button onClick={() => { closeAll(); openSplit({ t: 'compute', id: c.id }) }} className="min-w-0 flex-1 text-left">
            <div className="truncate text-[13.5px]">{c.short ?? c.title}</div>
            <div className="truncate text-[12px] text-fg-3">{people[c.owner].name} · {c.stopping ? '正在停止，停完才归还' : c.phase}</div>
          </button>
          {owner && !c.stopping && <button data-testid={`pool-reclaim-${c.id}`} onClick={() => stop(c.id)} className="h-7 rounded-md border border-line px-2.5 text-[12.5px] text-fg-2 hover:bg-hover">停下并收回</button>}
        </div>
      ))}
      {back.length > 0 && <>
        <div className="mt-4 text-[12.5px] font-medium text-fg-3">已归还</div>
        {back.map((c) => (
          <div key={c.id} data-testid={`pool-back-${c.id}`} className="flex items-center gap-2.5 px-1 py-1.5 text-[12.5px] text-fg-3">
            <Avatar id={c.owner} size={20} status={false} /><span className="min-w-0 flex-1 truncate">{c.short ?? c.title}</span><span>{c.phase}</span>
          </div>
        ))}
      </>}
    </Scroll>
  )
}
