import { AlertCircle, ArrowUpRight, Clock, PictureInPicture2, Play, RotateCw, Square, SquareTerminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, type Compute } from '@/data'
import { useApp, type CView } from '@/ctx'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Avatar } from '@/components/Avatar'
import { StatusDot, statusText } from '@/components/Messages'
import { Tabs, TabList, TabPanel, type TabItem } from '@/components/pages/kit/tabs'
import { StepBar } from './StepBar'
import { ActivityView } from './ActivityView'
import { DiffView } from './DiffView'
import { Preview } from './Preview'
import { ChecksView } from './ChecksView'
import { CheckpointView } from './CheckpointView'
import { DEMO_NOW, demoSession, HarnessSession } from '@/components/compute'
import { useLiveSession } from '@/components/compute/useLiveSession'
import { useFailChoices } from '@/components/messages/compute/useFailChoices'

/* ---------- Compute 详情:参照 Devin Activity、Copilot session log、Linear agent session、Replit checkpoint ----------
   从上到下:头部(状态 / 耗时 / 花费 / 模型 / 停止)→ 步骤条 → 卡住的那一步(有才出现)→ 视图页签
   → 当前视图 → 底部常驻只读条(#22:要干预就去找派它的联系人说,不能直接对 Compute 说话) */

const views = (c: Compute): TabItem<CView>[] => {
  const list: { value: CView; label: string }[] = [
    /* #1005:Compute 背后就是一个具体的 harness,默认先看它的原始会话(照 mirasim 的「打开会话」) */
    { value: 'session', label: '会话' },
    { value: 'activity', label: '过程' },
    ...(c.files.length ? [{ value: 'diff' as const, label: `改动 ${c.files.length}` }] : []),
    ...(c.preview ? [{ value: 'preview' as const, label: '预览' }] : []),
    ...(c.checks.length ? [{ value: 'checks' as const, label: `检查 ${c.checks.filter((k) => k.ok).length}/${c.checks.length}` }] : []),
    ...(c.checkpoints.length ? [{ value: 'checkpoints' as const, label: '检查点' }] : []),
  ]
  return list.map((v) => ({ ...v, testid: `cview-${v.value}` }))
}

/** 带图标的一格元信息(耗时、花费、模型),数字等宽 */
const Meta = ({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) => (
  <span className="flex min-w-0 items-center gap-1 tabular-nums text-fg-3 [&_svg]:size-3 [&_svg]:shrink-0">{icon}<span className="truncate">{children}</span></span>
)

/** view 由分屏页签记着(store 的 SplitTab.view):消息行点「打开会话」时即使这页已经开着也能切到「会话」 */
export function ComputeWork({ id, view = 'session' }: { id: string; view?: CView }) {
  const { computes, stop, resume, jump, resolve, pending, showPip, debug, convs, openConv, addQuote, openSplit } = useApp()
  const c = computes[id]
  const setView = (v: CView) => openSplit({ t: 'compute', id, view: v })
  const err = pending.find((p) => p.kind === 'error' && p.computeId === id)
  const choices = useFailChoices(err?.id)
  const session = useLiveSession(c)
  const done = c.steps.filter((s) => s.state === 'done').length
  const owner = people[c.owner]?.name ?? ''
  const conv = convs.find((x) => x.id === c.conv)
  const dm = conv?.kind === 'dm'
  const convTitle = conv ? (dm ? `与 ${conv.title} 私聊` : conv.title) : c.conv
  /* 回复要对着联系人说的那句:有汇报回汇报,否则回它接活那句(连上后端时派活那条是你自己发的) */
  const lead = conv?.messages.find((m) => m.k === 'compute' && m.computeId === id)
  const replyTo = c.reportMsg ?? (lead && 'id' in lead ? lead.id.replace(/~c$/, '') : c.askMsg)
  const talk = (text: string) => { openConv(c.conv); setTimeout(() => addQuote({ msgId: replyTo, from: c.owner, text, reply: true }), 50) }
  const failedStep = c.steps.find((s) => s.state === 'fail')?.text
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={`compute-${id}`}>
      <div className="flex items-start gap-3 px-5 pb-3 pt-4">
        <Avatar id={c.owner} size={34} status={false} />
        <div className="min-w-0 flex-1">
          <div className="text-[16.5px] font-semibold leading-snug tracking-tight [text-wrap:balance]">{c.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-fg-2">
            {c.status !== 'waiting' && c.status !== 'error' && <span className="flex items-center gap-1.5"><StatusDot c={c} /><span className={cn(c.status === 'running' && 'text-run')} data-testid="compute-status-text">{c.status === 'stopped' && c.phase.startsWith('已停止') ? c.phase : statusText(c)}</span></span>}
            {!(c.status === 'done' && c.result?.endsWith(c.elapsed)) && <Meta icon={<Clock />}>{c.elapsed}</Meta>}
            {/* harness 就是这个 Compute 本身(#1005);花费按 #877 不放 */}
            <Meta icon={<SquareTerminal />}><span data-testid="compute-harness">{c.harness}</span><span className="text-fg-3/70"> · </span>{c.model}</Meta>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] text-fg-3" data-testid="compute-source">
            <span className="max-w-full truncate rounded bg-hover px-1.5 py-px text-fg-2" title={`${owner} 分出的 Compute`}>来自「{conv?.title}」</span>
            <span data-testid="compute-placement" title="以后可以切到云端托管或自带机器" className="rounded border border-line px-1 text-fg-2">运行在：{c.placement ?? '本机'}</span>
            <Button variant="link" onClick={() => jump(c.askMsg)} className="h-auto gap-0.5 px-0 text-[12px] font-normal text-fg-3 hover:text-fg [&_svg]:size-3">看派活的原消息<ArrowUpRight /></Button>
            {c.reportMsg && <> · <Button variant="link" onClick={() => jump(c.reportMsg!)} className="h-auto gap-0.5 px-0 text-[12px] font-normal text-fg-3 hover:text-fg [&_svg]:size-3">{dm ? '看它的交付消息' : '看群里的汇报'}<ArrowUpRight /></Button></>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {c.preview && c.status === 'running' && <IconButton label="小窗看画面" icon={<PictureInPicture2 />} onClick={() => showPip(id)} className="[&_svg]:size-4" />}
          {c.status === 'running' && c.stopping && <span data-testid="compute-stopping" className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-fg-2"><Square className="h-3 w-3 fill-current motion-safe:animate-pulse" />正在停止…</span>}
          {c.status === 'running' && !c.stopping && <Button data-testid="compute-stop" variant="outline" size="sm" onClick={() => stop(id)} className="px-2.5 text-[12.5px] text-fg-2 hover:text-fg [&_svg]:size-3"><Square className="fill-current" />停止</Button>}
          {c.status === 'stopped' && <Button variant="primary" size="sm" onClick={() => resume(id)} className="[&_svg]:size-3.5"><Play className="fill-current" />继续</Button>}
        </div>
      </div>

      {/* 步骤条:一眼看到第几步 */}
      <StepBar c={c} />

      {/* 卡住的那一步:细线提示条(#1005:不铺红底),原因一句,重试离指针最近 */}
      {err && (
        <div className="mx-5 mt-3 flex items-start gap-2 border-y border-err/30 py-2.5" data-testid="compute-fail-step" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-err" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-err">{failedStep ? `卡在「${failedStep}」` : '没做下去'}</div>
            <div className="mt-0.5 text-[12.5px] text-fg-2">{c.error ?? '出错了'}{c.attempts != null && <> · 自动试了 <span className="tabular-nums">{c.attempts}</span> 次</>}</div>
          </div>
          <div className="flex shrink-0 gap-1">
            {choices.switchable && <Button variant="ghost" size="xs" onClick={() => resolve(err.id, 'switch')} title={choices.switchLabel}>换个模型再试</Button>}
            {!err.id.startsWith('card:') ? null : <Button data-testid="compute-skip" variant="ghost" size="xs" onClick={() => resolve(err.id, 'skip')}>{choices.skipLabel}</Button>}
            <Button data-testid="compute-retry" variant="outline" size="xs" onClick={() => resolve(err.id, 'retry')} className="text-err"><RotateCw />重试</Button>
          </div>
        </div>
      )}

      <Tabs value={view} onValueChange={setView} className="mt-3 flex min-h-0 flex-1 flex-col">
        <div className="border-b border-line px-4"><TabList items={views(c)} label="Compute 视图" size="sm" /></div>
        {/* 会话页自己滚、自己有状态行,铺满;只读条用下面这条共用的 */}
        {view === 'session' && (
          <TabPanel value="session" className="flex min-h-0 flex-1 flex-col">
            <HarnessSession embedded className="min-h-0 flex-1" compute={c} transcript={session.live ? session.transcript : demoSession(id)} loading={session.loading} noCalls={session.live} {...(session.live ? {} : { now: DEMO_NOW })} sourceTitle={convTitle} dm={dm} onJumpSource={() => jump(c.askMsg)} />
          </TabPanel>
        )}
        {view !== 'session' && <TabPanel value={view} className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-3">
          {view === 'activity' && <ActivityView c={c} />}
          {view === 'diff' && <DiffView files={c.files} onAsk={(t) => talk(`「${c.title}」改动：${t}`)} />}
          {view === 'preview' && <Preview kind={c.preview!} />}
          {view === 'checks' && <ChecksView c={c} />}
          {view === 'checkpoints' && <CheckpointView c={c} />}
          {debug && <div className="mt-4 rounded-lg bg-hover px-3 py-2 font-mono text-[11px] tabular-nums text-fg-3">compute:{c.id} · conv:{c.conv} · harness:{c.harness} · {done}/{c.steps.length}</div>}
        </TabPanel>}
      </Tabs>

      {/* #22:Compute 只读。要干预就去找派它的联系人说 */}
      <div className="flex items-center gap-2 border-t border-line bg-side/60 px-4 py-2.5 text-[12.5px] text-fg-3" data-testid="compute-readonly">
        <span className="min-w-0 flex-1">这里只能看。要改要求，去和 {owner} 说</span>
        <Button data-testid="compute-talk" variant="secondary" size="xs" shape="pill" onClick={() => talk(c.title)} className="max-w-[55%]"><span className="truncate">回{dm || c.conv.startsWith('dm') ? '私聊' : '群里'} @{owner}</span></Button>
      </div>
    </div>
  )
}
