import { useState, type ReactNode } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, MessageSquare, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, innerLog, dutyDefault, dutyByConv, presetOf, MODELS, GLOBAL_MODEL, vendorOf, type PersonId, type Msg, type Compute, type Cron, type Conversation, type Pending } from '@/data'
import { useApp, type WbTab } from '@/ctx'
import { CronEditor } from './CronEditor'
import { CronRow, convName } from './CronList'
import { cronOrder, openCronOverview, useNow } from '@/cronView'
import { localZoneLabel } from '@g-group/ui-core'
import { Avatar, GroupAvatar, useLive } from './Avatar'
import { MessageList } from './Messages'
import { DetailPage } from './Overlays'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { candidate } from '@/mut'

/* ---------- 小部件 ---------- */
const Card = ({ children, className, testid }: { children: ReactNode; className?: string; testid?: string }) => (
  <section data-testid={testid} className={cn('rounded-xl bg-hover/60 p-4', className)}>{children}</section>
)
const H = ({ children, right }: { children: ReactNode; right?: ReactNode }) => (
  <div className="mb-2 flex items-center gap-2"><h3 className="flex-1 text-[13px] font-semibold text-fg">{children}</h3>{right}</div>
)
const Note = ({ children }: { children: ReactNode }) => <p className="mb-2 text-[12px] leading-relaxed text-fg-3">{children}</p>
const Spin = () => <span className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-run border-t-transparent" />

/** 来源标签：群头像 + 群名，或“与 X 私聊” */
function Source({ conv }: { conv?: Conversation }) {
  if (!conv) return null
  if (conv.kind === 'dm') {
    const other = conv.members.find((m) => m !== 'me') ?? ''
    return <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bg px-1.5 py-0.5 text-[11px] text-fg-2">与 {people[other]?.name ?? conv.title} 私聊</span>
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bg py-0.5 pl-0.5 pr-1.5 text-[11px] text-fg-2">
      <GroupAvatar ids={conv.members} size={16} />{conv.title}
    </span>
  )
}

/** 就地编辑的一行文字 */
function InlineEdit({ value, onSave, testid, placeholder }: { value: string; onSave: (v: string) => void; testid: string; placeholder?: string }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value)
  if (editing)
    return (
      <form className="flex flex-1 items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); onSave(v.trim()); setEditing(false) }}>
        <input autoFocus data-testid={`${testid}-input`} value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring" />
        <button type="submit" data-testid={`${testid}-save`} className="h-8 rounded-lg bg-btn px-3 text-[12.5px] font-medium text-btn-fg">保存</button>
        <button type="button" onClick={() => { setV(value); setEditing(false) }} className="h-8 rounded-lg px-2 text-[12.5px] text-fg-2 hover:bg-hover">取消</button>
      </form>
    )
  return (
    <button data-testid={testid} onClick={() => { setV(value); setEditing(true) }} className="group/e flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-1 text-left text-[13.5px] hover:bg-hover">
      <span className={cn('min-w-0 flex-1 truncate', !value && 'text-fg-3')}>{value || placeholder}</span>
      <Pencil className="h-3.5 w-3.5 shrink-0 text-fg-3 opacity-60 group-hover/e:opacity-100" />
    </button>
  )
}

/* ============ 联系人工作台（主面板） ============ */
const TABS: { k: WbTab; l: string }[] = [
  { k: 'overview', l: '概览' }, { k: 'duty', l: '职责与预设' }, { k: 'memory', l: '记忆' }, { k: 'cron', l: '定时' }, { k: 'settings', l: '设置' }, { k: 'process', l: '完整过程' },
]

export function Workbench({ id, tab, onTab }: { id: PersonId; tab: WbTab; onTab: (t: WbTab) => void }) {
  const { openDm, computes } = useApp()
  const p = people[id]
  const live = useLive(id)
  if (!p) return <main data-testid={`workbench-${id}`} className="grid flex-1 place-items-center text-[13px] text-fg-3">在左侧选一个联系人</main>
  const mine = Object.values(computes).filter((c) => c.owner === id)
  const runC = mine.find((c) => c.status === 'running')
  const errC = mine.find((c) => c.status === 'error')
  const status: { cls: string; icon: ReactNode; text: string } =
    live === 'error' ? { cls: 'text-err', icon: <AlertTriangle className="h-3.5 w-3.5" />, text: `遇到问题：${errC?.title ?? '有一件事出错了'}` }
    : live === 'waiting' ? { cls: 'font-semibold text-warm', icon: <span className="h-2 w-2 rounded-full bg-warm-dot" />, text: '在等你处理' }
    : live === 'running' ? { cls: 'text-run', icon: <Spin />, text: `正在做：${runC?.title ?? ''}` }
    : { cls: 'text-fg-3', icon: null, text: '空闲' }
  return (
    <main data-testid={`workbench-${id}`} className="flex min-w-0 flex-1 flex-col overflow-hidden bg-bg">
      <div className="shrink-0 border-b border-line">
        <div className="mx-auto w-full max-w-[1080px] px-5 pt-6">
          <div className="flex items-center gap-4">
            <Avatar id={id} size={64} follow status={false} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[20px] font-semibold tracking-tight">{p.name}</div>
              <div className="mt-0.5 truncate text-[13px] text-fg-2">{dutyDefault[id] ?? p.role}</div>
              {!p.human && <div data-testid="wb-status" className={cn('mt-1 flex items-center gap-1.5 text-[12.5px]', status.cls)}>{status.icon}<span className="truncate">{status.text}</span></div>}
            </div>
            <div className="flex shrink-0 gap-2">
              {!p.human && <button data-testid="wb-dm" onClick={() => openDm(id)} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-me px-4 text-[13px] font-medium text-me-fg hover:opacity-90"><MessageSquare className="h-3.5 w-3.5" />发消息</button>}
              <button data-testid="wb-open-process" onClick={() => onTab('process')} className="h-8 rounded-full bg-hover px-4 text-[13px] font-medium hover:bg-sel">看完整过程</button>
            </div>
          </div>
          <div role="tablist" className="-mb-px mt-5 flex gap-1 overflow-x-auto">
            {TABS.map((t) => (
              <button key={t.k} role="tab" aria-selected={tab === t.k} data-testid={`wb-tab-${t.k}`} onClick={() => onTab(t.k)} className={cn('shrink-0 border-b-2 px-3 pb-2 pt-1 text-[13.5px] transition', tab === t.k ? 'border-fg font-semibold text-fg' : 'border-transparent text-fg-2 hover:text-fg')}>{t.l}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'process' ? (
          <div className="mx-auto h-full w-full max-w-[1080px]"><ProcessView id={id} /></div>
        ) : (
          <div className="mx-auto w-full max-w-[1080px] space-y-4 px-5 py-5">
            {tab === 'overview' && <Overview id={id} />}
            {tab === 'duty' && <Duty id={id} />}
            {tab === 'memory' && <Memory id={id} />}
            {tab === 'cron' && <Crons id={id} />}
            {tab === 'settings' && <Settings id={id} />}
          </div>
        )}
      </div>
    </main>
  )
}

/* ---------- 概览 ---------- */
function Overview({ id }: { id: PersonId }) {
  const { computes, pending, convs, openSplit, openConv } = useApp()
  const [showDone, setShowDone] = useState(false)
  const mine = Object.values(computes).filter((c) => c.owner === id)
  const convOf = (cid: string) => convs.find((c) => c.id === cid)
  const myPending = pending.filter((x) => x.from === id)
  const pendingCids = new Set(myPending.flatMap((x) => ('computeId' in x ? [x.computeId] : [])))
  const waitC = mine.filter((c) => c.status === 'waiting' && !pendingCids.has(c.id))
  const doing = mine.filter((c) => c.status === 'running' || c.status === 'error').sort((a, b) => (a.status === 'error' ? -1 : 0) - (b.status === 'error' ? -1 : 0))
  const done = mine.filter((c) => c.status === 'done')
  const groups = convs.filter((c) => c.kind === 'group' && c.members.includes(id))
  const openLink = (conv: string) => (
    <button data-testid={`wb-open-conv-${conv}`} onClick={(e) => { e.stopPropagation(); openConv(conv) }} className="shrink-0 text-[12px] text-fg-3 underline-offset-2 hover:text-fg hover:underline">打开会话</button>
  )
  const pendingTitle = (x: Pending) => (x.kind === 'choice' || x.kind === 'proposal' ? x.title : computes[x.computeId]?.title ?? '')
  const pendingVerb = (x: Pending) => (x.kind === 'choice' ? '等你回答' : x.kind === 'proposal' ? '等你同意' : x.kind === 'accept' ? '做完了，在聊天里 @你了' : '出错了，等你决定')
  const waitCount = myPending.length + waitC.length
  return (
    <>
      <Card testid="wb-waiting">
        <H>等你 {waitCount > 0 && <span className="ml-1 text-warm">{waitCount}</span>}</H>
        {waitCount === 0 && <div className="text-[13px] text-fg-3">没有要你处理的事</div>}
        <div className="space-y-1.5">
          {myPending.map((x) => {
            const cid = 'computeId' in x ? x.computeId : undefined
            const err = x.kind === 'error'
            return (
              <div key={x.id} data-testid={`wb-wait-${x.id}`} role="button" onClick={() => (cid ? openSplit({ t: 'compute', id: cid }) : openConv(x.conv))}
                className={cn('flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 transition hover:brightness-[0.98]', err ? 'border-l-2 border-err bg-err-soft' : 'bg-warm-soft')}>
                {err ? <AlertTriangle className="h-4 w-4 shrink-0 text-err" /> : <span className="h-2 w-2 shrink-0 rounded-full bg-warm-dot" />}
                <div className="min-w-0 flex-1">
                  <div className={cn('truncate text-[13.5px] font-semibold', err ? 'text-err' : 'text-fg')}>{pendingTitle(x)}</div>
                  <div className={cn('text-[12px]', err ? 'text-err' : 'text-warm')}>{pendingVerb(x)}</div>
                </div>
                <Source conv={convOf(x.conv)} />
                <button onClick={(e) => { e.stopPropagation(); if (cid && x.kind !== 'accept') openSplit({ t: 'compute', id: cid }); else openConv(x.conv) }} className={cn('h-7 shrink-0 rounded-full px-3 text-[12.5px] font-medium', err ? 'bg-err text-white' : 'bg-warm text-white')}>
                  {x.kind === 'accept' ? '去回复' : x.kind === 'error' ? '去处理' : '去回答'}
                </button>
                {openLink(x.conv)}
              </div>
            )
          })}
          {waitC.map((c) => (
            <div key={c.id} data-testid={`wb-wait-${c.id}`} role="button" onClick={() => openSplit({ t: 'compute', id: c.id })} className="flex cursor-pointer items-center gap-2 rounded-lg bg-warm-soft px-3 py-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-warm-dot" />
              <div className="min-w-0 flex-1"><div className="truncate text-[13.5px] font-semibold">{c.title}</div><div className="text-[12px] text-warm">做完了，在聊天里 @你了</div></div>
              <Source conv={convOf(c.conv)} />
              <button onClick={(e) => { e.stopPropagation(); openConv(c.conv) }} className="h-7 shrink-0 rounded-full bg-warm px-3 text-[12.5px] font-medium text-white">去回复</button>
              {openLink(c.conv)}
            </div>
          ))}
        </div>
      </Card>

      <Card testid="wb-doing">
        <H>在做 {doing.length > 0 && <span className="ml-1 text-fg-3">{doing.length}</span>}</H>
        {doing.length === 0 && <div className="text-[13px] text-fg-3">现在没有在做的事</div>}
        <div className="space-y-1">
          {doing.map((c) => <DoingRow key={c.id} c={c} conv={convOf(c.conv)} link={openLink(c.conv)} />)}
        </div>
      </Card>

      <Card testid="wb-done" className="py-3">
        {done.length === 0 ? <div className="text-[12.5px] text-fg-3">最近没有做完的事</div> : (
          <>
            <button data-testid="wb-done-toggle" onClick={() => setShowDone((v) => !v)} className="flex items-center gap-1.5 text-[12.5px] text-fg-3 hover:text-fg-2">
              <Check className="h-3.5 w-3.5" strokeWidth={2.5} />做完 {done.length} 件{showDone ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
            {showDone && (
              <div className="mt-2 space-y-0.5">
                {done.map((c) => (
                  <div key={c.id} data-testid={`wb-done-${c.id}`} role="button" onClick={() => openSplit({ t: 'compute', id: c.id })} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] text-fg-3 hover:bg-hover">
                    <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
                    <span className="min-w-0 flex-1 truncate">{c.title}<span className="ml-2">{c.result}</span></span>
                    <Source conv={convOf(c.conv)} />
                    {openLink(c.conv)}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      <Card testid="wb-groups">
        <H>所在的群 · {groups.length}</H>
        {groups.length === 0 && <div className="text-[13px] text-fg-3">还没进任何群</div>}
        <div className="divide-y divide-line">
          {groups.map((g) => {
            const duty = dutyByConv[g.id]?.[id]
            return (
              <div key={g.id} data-testid={`wb-group-${g.id}`} className="flex items-center gap-2.5 py-2">
                <GroupAvatar ids={g.members} size={28} />
                <span className="w-36 shrink-0 truncate text-[13.5px] font-medium">{g.title}</span>
                <span className={cn('min-w-0 flex-1 truncate text-[13px]', duty ? 'text-fg-2' : 'text-fg-3')}>{duty ?? '未设分工 · 用默认职位'}</span>
                {openLink(g.id)}
              </div>
            )
          })}
        </div>
      </Card>
    </>
  )
}

function DoingRow({ c, conv, link }: { c: Compute; conv?: Conversation; link: ReactNode }) {
  const { openSplit, resume } = useApp()
  const err = c.status === 'error'
  const step = c.steps.findIndex((s) => s.state === 'now' || s.state === 'fail')
  const n = step < 0 ? c.steps.filter((s) => s.state === 'done').length : step + 1
  return (
    <div data-testid={`wb-doing-${c.id}`} role="button" onClick={() => openSplit({ t: 'compute', id: c.id })} className={cn('flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 hover:bg-hover', err && 'border-l-2 border-err bg-err-soft hover:bg-err-soft')}>
      {err ? <AlertTriangle className="h-4 w-4 shrink-0 text-err" /> : <Spin />}
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-[13.5px] font-medium', err && 'text-err')}>{c.title}</div>
        <div className={cn('truncate text-[12px]', err ? 'text-err' : 'text-run')}>{err ? c.error ?? '出错了' : `${c.phase} · 第 ${n}/共 ${c.steps.length} 步`}</div>
      </div>
      <Source conv={conv} />
      {err && <button data-testid={`wb-retry-${c.id}`} onClick={(e) => { e.stopPropagation(); resume(c.id) }} className="h-7 shrink-0 rounded-full border border-err px-3 text-[12.5px] font-medium text-err hover:bg-err hover:text-white">重试</button>}
      {link}
    </div>
  )
}

/* ---------- 职责与预设 ---------- */
function W({ k }: { k: string }) { const l = LAYERS.find((x) => x.k === k); return l ? <span className="ml-1.5 text-[11.5px] font-normal text-fg-3">{l.who}</span> : null }
const LAYERS: { k: string; who: string }[] = [
  { k: '职责', who: '你写 · 换群或换活时改' },
  { k: '预设', who: '你写 · 偶尔调' },
  { k: '记忆', who: '它自己写，你能删改 · 每天都在长' },
  { k: '红线', who: '只有你能改 · 基本不变' },
]

function Duty({ id }: { id: PersonId }) {
  const { convs, updatePerson, toast } = useApp()
  const p = people[id]
  const [def, setDef] = useState(dutyDefault[id] ?? p.role)
  const [byConv, setByConv] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(dutyByConv).map(([c, m]) => [c, m[id] ?? ''])))
  const [preset, setPreset] = useState(presetOf[id] ?? '')
  const [savedPreset, setSavedPreset] = useState(presetOf[id] ?? '')
  const [soul, setSoul] = useState(p.soul ?? '')
  const groups = convs.filter((c) => c.kind === 'group' && c.members.includes(id))
  const saveDef = (v: string) => { if (!v || v === def) return; dutyDefault[id] = v; setDef(v); updatePerson(id, { role: v }, `默认职位改成「${v}」`) }
  const saveConv = (conv: string, v: string) => {
    dutyByConv[conv] = { ...(dutyByConv[conv] ?? {}) }
    if (v) dutyByConv[conv][id] = v; else delete dutyByConv[conv][id]
    setByConv((m) => ({ ...m, [conv]: v }))
    updatePerson(id, {}, v ? `在「${convs.find((c) => c.id === conv)?.title}」的分工改成「${v}」` : `清空了在「${convs.find((c) => c.id === conv)?.title}」的分工`)
  }
  const tools = (p.tools ?? []).filter((t) => t.on)
  return (
    <div data-testid="wb-duty" className="space-y-4">

      <Card>
        <H>职责 <W k="职责" /></H>
        <Note>改职责只改变谁来接这个活；共享清单认领、@所有人、Helper 拉群推荐成员都按它排。</Note>
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-[12.5px] text-fg-3">默认职位</span>
          <InlineEdit testid="duty-default-edit" value={def} onSave={saveDef} />
        </div>
        {groups.length > 0 && <div className="mb-1 mt-3 text-[12px] font-medium text-fg-3">在这个群的分工</div>}
        {groups.map((g) => (
          <div key={g.id} className="flex items-center gap-2 py-0.5">
            <span className="flex w-24 shrink-0 items-center gap-1.5 truncate text-[12.5px] text-fg-2"><GroupAvatar ids={g.members} size={18} /><span className="truncate">{g.title}</span></span>
            <InlineEdit testid={`duty-${g.id}`} value={byConv[g.id] ?? ''} placeholder="未设分工 · 用默认职位" onSave={(v) => saveConv(g.id, v)} />
          </div>
        ))}
      </Card>

      <Card>
        <H>预设 <W k="预设" /></H>
        <textarea data-testid="preset-edit" value={preset} onChange={(e) => setPreset(e.target.value)} rows={4} className="w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-[13.5px] leading-relaxed outline-none focus:ring-2 focus:ring-ring" />
        <div className="mt-2 flex items-center gap-2">
          <span className="flex-1 text-[12px] text-fg-3">{preset === savedPreset ? '已保存' : '有改动未保存'}</span>
          <button data-testid="preset-save" disabled={preset === savedPreset} onClick={() => { presetOf[id] = preset; setSavedPreset(preset); updatePerson(id, {}, '改了预设') }} className="h-8 rounded-lg bg-btn px-4 text-[12.5px] font-medium text-btn-fg disabled:opacity-40">保存</button>
        </div>
      </Card>

      {candidate('U61') && <Card>
        <H>性格 <W k="性格" /></H>
        <textarea data-testid="soul-edit" value={soul} onChange={(e) => setSoul(e.target.value)} rows={3} className="w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-[13.5px] leading-relaxed outline-none focus:ring-2 focus:ring-ring" />
        <div className="mt-2 flex justify-end">
          <button data-testid="soul-save" disabled={soul === (p.soul ?? '')} onClick={() => updatePerson(id, { soul }, '改了性格')} className="h-8 rounded-lg bg-btn px-4 text-[12.5px] font-medium text-btn-fg disabled:opacity-40">保存</button>
        </div>
        <div className="mb-1 mt-2 text-[12px] font-medium text-fg-3">版本历史</div>
        <div className="divide-y divide-line">
          {(p.versions ?? []).map((v, i) => (
            <div key={v.v} className="flex items-center gap-2 py-1.5 text-[13px]">
              <span className="w-8 shrink-0 font-mono text-[12px] text-fg-3">v{v.v}</span>
              <span className="w-24 shrink-0 text-[12px] text-fg-3">{v.at}</span>
              <span className="min-w-0 flex-1 truncate text-fg-2">{v.note}</span>
              {i === 0 ? <span className="text-[12px] text-fg-3">现在用的</span> : <button data-testid={`soul-rollback-${v.v}`} onClick={() => toast(`已把 ${p.name} 的性格回到 v${v.v}`)} className="shrink-0 rounded-md px-2 py-0.5 text-[12px] text-fg-2 hover:bg-hover hover:text-fg">回到这一版</button>}
            </div>
          ))}
        </div>
      </Card>}

      <Card>
        <H>红线（只有你能改）</H>
        <Note>这些不归它自己改。它的记忆怎么变，都越不过这里。</Note>
        <div className="mb-1 text-[12px] font-medium text-fg-3">群公告</div>
        {groups.filter((g) => g.notice).map((g) => (
          <div key={g.id} className="flex items-start gap-2 py-1 text-[13px]">
            <Source conv={g} />
            <span className="min-w-0 flex-1 text-fg-2">{g.notice!.split(/[。\n]/)[0]}。</span>
          </div>
        ))}
        {!groups.some((g) => g.notice) && <div className="text-[13px] text-fg-3">它所在的群都没有公告</div>}
        <div className="mb-1 mt-3 text-[12px] font-medium text-fg-3">允许用的技能和工具</div>
        <div className="flex flex-wrap gap-1.5">
          {tools.map((t) => <span key={t.name} className="rounded-full bg-bg px-2 py-0.5 text-[12px] text-fg-2">{t.name}</span>)}
          {!tools.length && <span className="text-[13px] text-fg-3">一个都没开</span>}
        </div>
      </Card>
    </div>
  )
}

/* ---------- 记忆 ---------- */
function Memory({ id }: { id: PersonId }) {
  const { jump, updatePerson } = useApp()
  const p = people[id]
  const [list, setList] = useState(p.memory ?? [])
  const [fixing, setFixing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const save = (next: typeof list, note: string) => { setList(next); updatePerson(id, { memory: next }, note) }
  return (
    <Card testid="wb-memory">
      <H>记忆（MEMORY.md）</H>
      <Note>它自己写，你可以删或纠正。每条都记着是从哪句话学来的。</Note>
      {list.length === 0 && <div className="py-2 text-[13px] text-fg-3">它还没记下什么</div>}
      <div className="divide-y divide-line">
        {list.map((m, i) => {
          const msgId = /^#([A-Za-z][\w-]*)$/.exec(m.src)?.[1]
          return (
            <div key={i + m.text} className="flex items-center gap-2 py-2">
              {fixing === i ? (
                <form className="flex flex-1 items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) save(list.map((x, j) => (j === i ? { ...x, text: draft.trim() } : x)), `纠正了一条记忆：${draft.trim()}`); setFixing(null) }}>
                  <input autoFocus data-testid={`mem-fix-input-${i}`} value={draft} onChange={(e) => setDraft(e.target.value)} className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring" />
                  <button type="submit" data-testid={`mem-fix-save-${i}`} className="h-8 rounded-lg bg-btn px-3 text-[12.5px] font-medium text-btn-fg">保存</button>
                  <button type="button" onClick={() => setFixing(null)} className="h-8 rounded-lg px-2 text-[12.5px] text-fg-2 hover:bg-hover">取消</button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 text-[13.5px]">{m.text}</span>
                  {msgId ? <button data-testid={`mem-src-${i}`} onClick={() => jump(msgId)} className="shrink-0 text-[12px] text-fg-3 underline-offset-2 hover:text-fg hover:underline">来自 {m.src}</button>
                    : <span className="max-w-[40%] shrink-0 truncate text-[12px] text-fg-3">来自 {m.src}</span>}
                  <button data-testid={`mem-fix-${i}`} onClick={() => { setDraft(m.text); setFixing(i) }} className="shrink-0 rounded-md px-2 py-0.5 text-[12px] text-fg-2 hover:bg-hover hover:text-fg">纠正</button>
                  <button data-testid={`mem-del-${i}`} onClick={() => save(list.filter((_, j) => j !== i), `删了一条记忆：${m.text}`)} className="shrink-0 rounded-md px-2 py-0.5 text-[12px] text-fg-2 hover:bg-err-soft hover:text-err">删除</button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

/* ---------- 定时：它在各个会话的全部定时，按会话分组（AC-53 联系人视角） ---------- */
function Crons({ id }: { id: PersonId }) {
  const { crons, convs, openConv, addCron, setPanoOpen } = useApp()
  const now = useNow()
  const [adding, setAdding] = useState(false)
  const mine = crons.filter((c) => c.owner === id).sort(cronOrder(now))
  const byConv = new Map<string, Cron[]>()
  for (const c of mine) byConv.set(c.conv, [...(byConv.get(c.conv) ?? []), c])
  const add = (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-fg-2">{people[id].name} 在各个会话里的全部定时。点一行在右边看详情、改、看每次醒来做了什么</div>
        <div data-testid="wb-cron-zone" className="text-[11.5px] text-fg-3">按本地时间（{localZoneLabel(now)}）· <button onClick={() => openCronOverview(setPanoOpen)} className="hover:text-fg hover:underline">所有人的定时在「进展」里看</button></div>
      </div>
      <button data-testid="wb-cron-add" onClick={() => setAdding(true)} className="h-8 shrink-0 rounded-lg bg-btn px-3 text-[13px] font-medium text-btn-fg hover:opacity-90">+ 新建定时</button>
    </div>
  )
  const editor = <CronEditor open={adding} owner={id} onClose={() => setAdding(false)} onSave={(d) => { addCron(d, 'panel'); setAdding(false) }} />
  if (!mine.length)
    return <div data-testid="wb-cron" className="space-y-3">{add}{editor}<Card><div className="py-6 text-center text-[13px] text-fg-3">它还没有定时任务。在聊天里跟它说「每天 8 点…」，或点「新建定时」</div></Card></div>
  return (
    <div data-testid="wb-cron" className="space-y-4">
      {add}{editor}
      {[...byConv.entries()].map(([cid, list]) => {
        const conv = convs.find((c) => c.id === cid)
        return (
          <Card key={cid} testid={`wb-cron-group-${cid}`} className="px-2 pb-2 pt-3">
            <div className="mb-1 flex items-center gap-2 px-2.5">
              {conv?.kind === 'group' ? <GroupAvatar ids={conv.members} size={22} /> : null}
              <span className="flex-1 truncate text-[13px] font-semibold">{convName(conv, cid)}</span>
              <span className="text-[12px] text-fg-3">{list.length} 个</span>
              <button onClick={() => openConv(cid)} className="text-[12px] text-fg-3 hover:text-fg hover:underline">打开会话</button>
            </div>
            <div className="space-y-0.5">{list.map((c) => <CronRow key={c.id} c={c} now={now} showOwner={false} />)}</div>
          </Card>
        )
      })}
    </div>
  )
}

/* ---------- 设置（原 PersonPage / ModelPage / ToolsPage，就地显示） ---------- */
function SRow({ label, children, testid }: { label: ReactNode; children?: ReactNode; testid?: string }) {
  return <div data-testid={testid} className="flex min-h-[40px] items-center gap-3 py-1.5"><span className="min-w-0 flex-1 text-[13.5px]">{label}</span>{children}</div>
}

function Settings({ id }: { id: PersonId }) {
  const { updatePerson } = useApp()
  const p = people[id]
  const [talk, setTalk] = useState(p.model ?? GLOBAL_MODEL)
  const [cm, setCm] = useState(p.computeModel ?? 'inherit')
  const [quota, setQuota] = useState(p.computeQuota ?? 1)
  const [tools, setTools] = useState(p.tools ?? [])
  if (p.human) return <Card testid="wb-settings"><div className="text-[13px] text-fg-3">{p.name} 是真人，没有模型和工具设置。</div></Card>
  const custom = cm !== 'inherit' && cm !== 'follow'
  const effective = cm === 'inherit' ? GLOBAL_MODEL : cm === 'follow' ? talk : cm
  const cmLabel = (v: string) => (v === 'inherit' ? '跟全局默认' : v === 'follow' ? '跟说话模型一样' : v)
  const setCompute = (v: string) => { if (v === cm) return; updatePerson(id, { computeModel: v }, `干活用的模型 ${cmLabel(cm)} → ${cmLabel(v)}`); setCm(v) }
  const toggleTool = (name: string, on: boolean) => {
    const next = tools.map((t) => (t.name === name ? { ...t, on } : t))
    setTools(next)
    updatePerson(id, { tools: next }, `${on ? '打开' : '关掉'}了「${name}」`)
  }
  const select = 'h-8 rounded-lg border border-line bg-bg px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring'
  return (
    <div data-testid="wb-settings" className="space-y-4">
      <Card>
        <H>模型</H>
        <SRow label="说话用的模型（在群里聊天、判断要不要接活）">
          <select data-testid="set-talk-model" value={talk} onChange={(e) => { const m = e.target.value; updatePerson(id, { model: m }, `说话模型 ${talk} → ${m}`); setTalk(m) }} className={select}>
            {MODELS.map((m) => <option key={m} value={m}>{m} · {vendorOf(m)}</option>)}
          </select>
        </SRow>
        <div className="mb-1 mt-2 text-[12px] font-medium text-fg-3">Compute 用的模型（干活）</div>
        <div role="radiogroup" className="space-y-0.5">
          {[{ k: 'inherit', l: `跟全局默认（现在是 ${GLOBAL_MODEL}）` }, { k: 'follow', l: `跟说话模型一样（${talk}）` }].map((o) => (
            <button key={o.k} role="radio" aria-checked={cm === o.k} data-testid={`set-cm-${o.k}`} onClick={() => setCompute(o.k)} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13.5px] hover:bg-hover">
              <span className={cn('grid h-4 w-4 place-items-center rounded-full border', cm === o.k ? 'border-fg' : 'border-fg-3')}>{cm === o.k && <span className="h-2 w-2 rounded-full bg-fg" />}</span>{o.l}
            </button>
          ))}
          <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
            <button role="radio" aria-checked={custom} data-testid="set-cm-custom" onClick={() => !custom && setCompute('Claude Opus 5.5')} className="flex flex-1 items-center gap-2 text-left text-[13.5px]">
              <span className={cn('grid h-4 w-4 place-items-center rounded-full border', custom ? 'border-fg' : 'border-fg-3')}>{custom && <span className="h-2 w-2 rounded-full bg-fg" />}</span>单独指定
            </button>
            {custom && <select data-testid="set-cm-model" value={cm} onChange={(e) => setCompute(e.target.value)} className={select}>{MODELS.map((m) => <option key={m} value={m}>{m}</option>)}</select>}
          </div>
        </div>
        <Note>实际用：{effective}。复核要换一家：{p.name} 的产出会交给不是 {vendorOf(effective)} 的模型复核。</Note>
        <SRow label={`最多同时分几个 Compute · ${quota} 个`} testid="set-quota">
          <div className="w-40"><Slider value={[quota]} min={1} max={5} step={1} onValueChange={(v) => setQuota(v[0])} onValueCommit={(v) => { if (v[0] !== p.computeQuota) updatePerson(id, { computeQuota: v[0] }, `最多同时 ${v[0]} 个 Compute`) }} /></div>
        </SRow>
      </Card>

      <Card>
        <H>能用的技能和工具</H>
        <Note>只有打开的能被 {p.name} 和它分出的 Compute 用到。本机装的其他技能和工具默认不给。</Note>
        {(['skill', 'mcp'] as const).map((k) => (
          <div key={k}>
            <div className="mb-0.5 mt-2 text-[12px] font-medium text-fg-3">{k === 'skill' ? '技能' : '工具'}</div>
            <div className="divide-y divide-line">
              {tools.filter((t) => t.kind === k).map((t) => (
                <SRow key={t.name} label={t.name}><Switch data-testid={`set-tool-${t.name}`} checked={t.on} onCheckedChange={(v) => toggleTool(t.name, v)} /></SRow>
              ))}
            </div>
          </div>
        ))}
      </Card>

      {p.today && (
        <Card>
          <H>花费</H>
          <div className="divide-y divide-line">
            <SRow label="今天"><span className="font-mono text-[13px] tabular-nums text-fg-2">{p.today}</span></SRow>
            <SRow label="本月"><span className="font-mono text-[13px] tabular-nums text-fg-2">{p.month}</span></SRow>
          </div>
        </Card>
      )}
    </div>
  )
}

/* ============ 联系人的完整过程：和聊天同一套模板，只有它一个人说话 ============ */
export function ProcessView({ id, conv }: { id: PersonId; conv?: string }) {
  const { convs } = useApp()
  const [all, setAll] = useState(false)
  const p = people[id]
  const only = conv && !all ? conv : undefined
  const log = (innerLog[id] ?? []).filter((l) => !only || l.conv === only)
  const segs: { conv: string; items: typeof log }[] = []
  for (const l of log) {
    const last = segs[segs.length - 1]
    if (last && last.conv === l.conv) last.items.push(l)
    else segs.push({ conv: l.conv, items: [l] })
  }
  const toMsgs = (items: typeof log, seg: number): Msg[] => {
    const out: Msg[] = []
    let at = ''
    items.forEach((l, i) => {
      if (l.at !== at) { out.push({ k: 'date', text: l.at }); at = l.at }
      out.push({ k: 'text', id: `pv-${id}-${seg}-${i}`, from: id, text: l.text })
      if (l.computeId) out.push({ k: 'compute', id: `pv-${id}-${seg}-${i}-c`, from: id, computeId: l.computeId })
    })
    return out
  }
  const title = (cid: string) => {
    const c = convs.find((x) => x.id === cid)
    return c ? (c.kind === 'dm' ? `与 ${c.title} 私聊` : c.title) : cid
  }
  return (
    <div data-testid={`process-${id}`} data-conv={only ?? 'all'} className="flex min-w-0 flex-col px-4 pb-6">
      <div className="sticky top-0 z-10 -mx-4 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur">
        <div className="text-center text-[12px] text-fg-3">这里只能看。可以停下某个 Compute 或补一句，不能在这里聊天。</div>
        {only && (
          <div className="mt-1 flex items-center justify-center gap-1 text-[12.5px] text-fg-2">
            只看「{title(only)}」里的 ·
            <button data-testid="process-show-all" onClick={() => setAll(true)} className="font-medium text-fg hover:underline">看全部 ›</button>
          </div>
        )}
      </div>
      {!log.length && <div className="py-10 text-center text-[13px] text-fg-3">{p?.name ?? '它'}{only ? '在这里' : ''}还没有过程记录</div>}
      {segs.map((s, i) => (
        <div key={i}>
          {!only && (
            <div data-testid={`process-seg-${s.conv}`} className="mt-4 flex items-center gap-2 rounded-lg bg-hover/60 px-2.5 py-1.5">
              {(() => { const c = convs.find((x) => x.id === s.conv); return c?.kind === 'group' ? <GroupAvatar ids={c.members} size={20} /> : null })()}
              <span className="min-w-0 truncate text-[12.5px] font-semibold">{title(s.conv)}</span>
              <span className="shrink-0 text-[12px] text-fg-3">在这个群</span>
            </div>
          )}
          <MessageList msgs={toMsgs(s.items, i)} compact conv={s.conv} />
        </div>
      ))}
    </div>
  )
}

/* ---------- 右侧分栏里的联系人详情（#1620）：不遮挡聊天，和 Compute 分栏同一套缝隙与标签 ----------
   从群里打开：默认看「在本群」——本群分工、在本群做的事、它在本群的完整过程；
   想管理全部（记忆、定时、设置）再点「去工作台」，在主面板展开。 */
export function ContactPane({ id, conv, initial }: { id: PersonId; conv?: string; initial?: 'here' | 'talks' | 'process' | 'duty' | 'memory' }) {
  const { convs, openDm, mention, openWorkbench, computes } = useApp()
  const p = people[id]
  const [tab, setTab] = useState<'here' | 'talks' | 'process' | 'duty' | 'memory'>(initial ?? 'here')
  if (!p) return null
  const c = convs.find((x) => x.id === conv)
  const inGroup = c?.kind === 'group'
  const here = Object.values(computes).filter((x) => x.owner === id && (!conv || x.conv === conv))
  const T = [
    { k: 'here' as const, l: inGroup ? '在本群' : '概览' },
    { k: 'talks' as const, l: '对话' },
    { k: 'process' as const, l: '完整过程' },
    { k: 'duty' as const, l: '职责与预设' },
    { k: 'memory' as const, l: '记忆' },
  ]
  return (
    <div data-testid={`contact-pane-${id}`} className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-4 pb-0 pt-3">
        <div className="flex items-center gap-3">
          <Avatar id={id} size={44} status={false} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{p.name}</div>
            <div className="truncate text-[12px] text-fg-2">{inGroup && dutyByConv[conv!]?.[id] ? `在「${c!.title}」：${dutyByConv[conv!][id]}` : dutyDefault[id] ?? p.role}</div>
          </div>
        </div>
        <div className="mt-2.5 flex gap-1.5">
          <button data-testid="cp-dm" onClick={() => openDm(id)} className="h-7 rounded-full bg-me px-3 text-[12.5px] font-medium text-me-fg hover:opacity-90">私聊</button>
          {inGroup && <button data-testid="cp-at" onClick={() => mention(id)} className="h-7 rounded-full bg-hover px-3 text-[12.5px] hover:bg-sel">@它</button>}
          <button data-testid="cp-workbench" onClick={() => openWorkbench(id)} className="h-7 rounded-full px-3 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg">去工作台 ›</button>
        </div>
        <div role="tablist" className="-mx-1 mt-2 flex gap-0.5 border-b border-line">
          {T.map((t) => <button key={t.k} role="tab" aria-selected={tab === t.k} data-testid={`cp-tab-${t.k}`} onClick={() => setTab(t.k)} className={cn('-mb-px border-b-2 px-2.5 pb-1.5 pt-1 text-[12.5px] transition', tab === t.k ? 'border-fg font-semibold text-fg' : 'border-transparent text-fg-2 hover:text-fg')}>{t.l}</button>)}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'process' ? <ProcessView id={id} conv={inGroup ? conv : undefined} />
        : tab === 'talks' ? <DetailPage id={id} conv={conv ?? ''} tab="agents" bare />
        : <div className="space-y-3 px-4 py-3 text-[13px]">
            {tab === 'here' && (
              <>
                {here.length === 0 && <div className="py-6 text-center text-fg-3">{inGroup ? '它在本群还没开过 Compute' : '还没开过 Compute'}</div>}
                {here.map((x) => <DoingRow key={x.id} c={x} conv={convs.find((y) => y.id === x.conv)} link={null} />)}
              </>
            )}
            {tab === 'duty' && <Duty id={id} />}
            {tab === 'memory' && <Memory id={id} />}
          </div>}
      </div>
    </div>
  )
}

