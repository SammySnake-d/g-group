import { ContactPane } from './Workbench'
import { GroupPane } from './GroupSide'
import { useMemo, useState } from 'react'
import { X, Square, Play, Check, AlertCircle, RotateCw, MessageSquarePlus, ArrowUpRight, MousePointer2, Hand, PictureInPicture2, ChevronRight, FileText, Search, Terminal, Pencil, Brain, ShieldCheck, Send, User, HelpCircle, GitBranch, History, Undo2, Eye, Clock, Coins, Cpu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, artifacts, type Compute, type CFile, type Activity, type ActKind, type PersonId } from '@/data'
import { broken } from '@/mut'
import { useApp, type SplitTab, type CView } from '@/ctx'
import { CronDetail } from './CronDetail'
import { Avatar } from './Avatar'
import { ArtifactIcon, StatusDot, statusText, Tip } from './Messages'

/* ============ 右侧分屏工作区：工件 / Compute 用标签页切换，聊天让出位置 ============ */
export function SplitPane({ tabs, active, onPick, onClose, onCloseAll, width }: { tabs: SplitTab[]; active: number; onPick: (i: number) => void; onClose: (i: number) => void; onCloseAll: () => void; width?: number }) {
  const { computes } = useApp()
  const tab = tabs[active]
  return (
    <section className="slide-in flex h-full shrink-0 flex-col border-l border-line bg-bg" style={{ width: width ?? 400 }} data-testid="split">
      <div className="flex h-12 shrink-0 items-end gap-1 border-b border-line pl-2 pr-2">
        <div className="no-scrollbar flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
          {tabs.map((t, i) => {
            const label = t.t === 'compute' ? computes[t.id]?.title : t.t === 'contact' ? people[t.id]?.name : t.t === 'group' ? '群资料' : t.t === 'cron' ? '定时' : artifacts.find((a) => a.id === t.id)?.name
            return (
              <div key={t.t + t.id} data-testid={`split-tab-${t.t}-${t.id}`} className={cn('group/t flex h-9 max-w-[220px] shrink-0 items-center gap-1.5 rounded-t-lg pl-3 pr-1 text-[13px]', i === active ? 'bg-hover font-medium text-fg' : 'text-fg-2 hover:text-fg')}>
                <button onClick={() => onPick(i)} className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{label}</span>
                </button>
                <button onClick={() => onClose(i)} className="grid h-5 w-5 shrink-0 place-items-center rounded text-fg-3 opacity-0 hover:bg-sel hover:text-fg group-hover/t:opacity-100"><X className="h-3.5 w-3.5" /></button>
              </div>
            )
          })}
        </div>
        <Tip label="关闭分屏（Esc）">
          <button data-testid="split-close" onClick={onCloseAll} className="mb-1.5 grid h-8 w-8 place-items-center rounded-lg text-fg-2 hover:bg-hover hover:text-fg"><X className="h-[18px] w-[18px]" /></button>
        </Tip>
      </div>
      {tab?.t === 'compute' && <ComputeWork key={tab.id} id={tab.id} initial={tab.view} />}
      {tab?.t === 'artifact' && <ArtifactView key={tab.id} id={tab.id} />}
      {tab?.t === 'cron' && <CronDetail key={tab.id} id={tab.id} />}
      {tab?.t === 'group' && <GroupPane key={tab.id + (tab.tab ?? '')} id={tab.id} initial={tab.tab} />}
      {tab?.t === 'contact' && <ContactPane key={tab.id + (tab.tab ?? '')} id={tab.id} conv={tab.conv} initial={tab.tab} />}
    </section>
  )
}

const ACT: Record<ActKind, { I: typeof FileText; label: string }> = {
  think: { I: Brain, label: '想法' }, read: { I: FileText, label: '读文件' }, search: { I: Search, label: '搜索' }, edit: { I: Pencil, label: '改文件' },
  cmd: { I: Terminal, label: '命令' }, review: { I: ShieldCheck, label: '复核' }, report: { I: Send, label: '汇报' }, user: { I: User, label: '你补充' },
  ask: { I: HelpCircle, label: '顺便问' }, answer: { I: HelpCircle, label: '回答' }, sub: { I: GitBranch, label: '子任务' }, error: { I: AlertCircle, label: '出错' }, rollback: { I: Undo2, label: '回滚' },
}

/* ---------- Compute 详情：参照 Devin Activity、Copilot session log、Linear agent session、Replit checkpoint ----------
   从上到下：头部（状态 / 耗时 / 花费 / 模型 / 停止）→ 待你处理（有才出现）→ 结论与证据（完成后）→ 步骤（点一步只看这一步的活动）
   → 活动流（每条可展开看原始输出）→ 底部常驻：补一句（下一步生效）/ 顺便问（不打断） */
function ComputeWork({ id, initial }: { id: string; initial?: CView }) {
  const { computes, stop, resume, jump, resolve, pending, showPip, debug, convs, openConv, addQuote } = useApp()
  const c = computes[id]
  const views = [
    { k: 'activity', label: '过程' },
    ...(c.files.length ? [{ k: 'diff', label: `改动 ${c.files.length}` }] : []),
    ...(c.preview ? [{ k: 'preview', label: '预览' }] : []),
    ...(c.checks.length ? [{ k: 'checks', label: `检查 ${c.checks.filter((k) => k.ok).length}/${c.checks.length}` }] : []),
    ...(c.checkpoints.length ? [{ k: 'checkpoints', label: '检查点' }] : []),
  ] as { k: CView; label: string }[]
  const [view, setView] = useState<CView>(initial ?? 'activity')
  const err = pending.find((p) => p.kind === 'error' && p.computeId === id)
  const done = c.steps.filter((s) => s.state === 'done').length
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={`compute-${id}`}>
      <div className="flex items-start gap-3 px-5 pb-3 pt-4">
        <Avatar id={c.owner} size={34} status={false} />
        <div className="min-w-0 flex-1">
          <div className="text-[16.5px] font-semibold leading-snug tracking-tight">{c.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-fg-2">
            {c.status !== 'waiting' && c.status !== 'error' && <span className="flex items-center gap-1.5"><StatusDot c={c} /><span className={cn(c.status === 'running' && 'text-run')}>{statusText(c)}</span></span>}
            <span className="flex items-center gap-1 text-fg-3"><Clock className="h-3 w-3" />{c.elapsed}</span>
            <span className="flex items-center gap-1 text-fg-3"><Coins className="h-3 w-3" />{c.cost}</span>
            <span className="flex items-center gap-1 text-fg-3"><Cpu className="h-3 w-3" />{c.model}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] text-fg-3" data-testid="compute-source"><span className="rounded bg-hover px-1.5 py-px text-fg-2">来自「{convs.find((x) => x.id === c.conv)?.title}」</span>{people[c.owner].name} 分出的 Compute · <span data-testid="compute-placement" title="以后可以切到云端托管或自带机器" className="rounded border border-line px-1 text-fg-2">运行在：本机</span> · <button onClick={() => jump(c.askMsg)} className="inline-flex items-center gap-0.5 hover:text-fg">看派活的原消息<ArrowUpRight className="h-3 w-3" /></button>{c.reportMsg && <> · <button onClick={() => jump(c.reportMsg!)} className="inline-flex items-center gap-0.5 hover:text-fg">看群里的汇报<ArrowUpRight className="h-3 w-3" /></button></>}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {c.preview && c.status === 'running' && <Tip label="小窗看画面"><button onClick={() => showPip(id)} className="grid h-8 w-8 place-items-center rounded-lg text-fg-2 hover:bg-hover hover:text-fg"><PictureInPicture2 className="h-4 w-4" /></button></Tip>}
          {c.status === 'running' && c.stopping && <span data-testid="compute-stopping" className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-fg-2"><Square className="h-3 w-3 animate-pulse fill-current" />正在停止…</span>}
          {c.status === 'running' && !c.stopping && <button data-testid="compute-stop" onClick={() => stop(id)} className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12.5px] font-medium text-fg-2 hover:bg-hover hover:text-fg"><Square className="h-3 w-3 fill-current" />停止</button>}
          {c.status === 'stopped' && <button onClick={() => resume(id)} className="flex h-8 items-center gap-1.5 rounded-lg bg-me px-3 text-[13px] font-medium text-me-fg"><Play className="h-3.5 w-3.5 fill-current" />继续</button>}
        </div>
      </div>

      {/* 步骤条：一眼看到第几步，点一步过滤下面的活动 */}
      <StepBar c={c} />

      {err && (
        <div className="mx-5 mt-3 border-l-2 border-err pl-3" data-testid="compute-fail-step">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold text-err"><AlertCircle className="h-4 w-4" />卡在「{c.steps.find((s) => s.state === 'fail')?.text ?? '这一步'}」</div>
          <div className="mt-0.5 text-[13px] text-fg-2">{c.error} · 自动试了 {c.attempts} 次</div>
          <div className="mt-2 flex gap-2">
            <button data-testid="compute-retry" onClick={() => resolve(err.id, 'retry')} className="flex h-8 items-center gap-1.5 rounded-lg border border-err/40 px-3 text-[13px] font-medium text-err hover:bg-err-soft"><RotateCw className="h-3.5 w-3.5" />重试</button>
            <button onClick={() => resolve(err.id, 'switch')} className="h-8 rounded-lg px-3 text-[13px] font-medium text-fg-2 hover:bg-hover">换个模型再试</button>
          </div>
        </div>
      )}

      <div className="mt-3 flex gap-1 border-b border-line px-4">
        {views.map((v) => (
          <button key={v.k} data-testid={`cview-${v.k}`} onClick={() => setView(v.k)} className={cn('-mb-px h-9 border-b-2 px-2.5 text-[13px] transition', view === v.k ? 'border-fg font-medium text-fg' : 'border-transparent text-fg-2 hover:text-fg')}>{v.label}</button>
        ))}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-3">
        {view === 'activity' && <ActivityView c={c} />}
        {view === 'diff' && <DiffView files={c.files} onAsk={(t) => { openConv(c.conv); setTimeout(() => addQuote({ msgId: c.reportMsg ?? c.askMsg, from: c.owner, text: `「${c.title}」改动：${t}`, reply: true }), 50) }} />}
        {view === 'preview' && <Preview kind={c.preview!} />}
        {view === 'checks' && <ChecksView c={c} />}
        {view === 'checkpoints' && <CheckpointView c={c} />}
        {debug && <div className="mt-4 rounded-lg bg-hover px-3 py-2 font-mono text-[11px] text-fg-3">compute:{c.id} · conv:{c.conv} · harness:{c.harness} · {done}/{c.steps.length}</div>}
      </div>

      {/* #22：Compute 只读。要干预就去找派它的联系人说，不能直接对 Compute 说话 */}
      <div className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-[12.5px] text-fg-3" data-testid="compute-readonly">
        <span className="flex-1">这里只能看。要改要求，去和 {people[c.owner].name} 说</span>
        <button data-testid="compute-talk" onClick={() => { openConv(c.conv); setTimeout(() => addQuote({ msgId: c.reportMsg ?? c.askMsg, from: c.owner, text: c.title, reply: true }), 50) }} className="h-7 rounded-full bg-hover px-3 font-medium text-fg hover:bg-sel">回{c.conv.startsWith('dm') ? '私聊' : '群里'} @{people[c.owner].name}</button>
      </div>
    </div>
  )
}

function StepBar({ c }: { c: Compute }) {
  return (
    <div className="mx-5 flex gap-1" data-testid="stepbar">
      {c.steps.map((s, i) => (
        <Tip key={i} label={s.text}>
          <div className={cn('h-1 flex-1 rounded-full', s.state === 'done' ? 'bg-fg-3/60' : s.state === 'now' ? (c.status === 'running' ? 'bg-run' : c.status === 'waiting' ? 'bg-warm-dot' : 'bg-fg-3') : s.state === 'fail' ? 'bg-err' : 'bg-hover')} />
        </Tip>
      ))}
    </div>
  )
}

/* 过程：左边步骤（可点筛选），右边按步骤分组的活动流；默认展开最新一条 */
function ActivityView({ c }: { c: Compute }) {
  const { jump } = useApp()
  const [step, setStep] = useState<number | null>(null)
  const latest = c.activity[c.activity.length - 1]?.id
  const [open, setOpen] = useState<Set<string>>(() => new Set(latest ? [latest] : []))
  const list = useMemo(() => c.activity.filter((a) => step === null || a.step === step), [c.activity, step])
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return (
    <div className="flex gap-5" data-testid="activity">
      <ol className="w-[168px] shrink-0 pt-0.5">
        <li><button onClick={() => setStep(null)} className={cn('mb-1 w-full rounded-lg px-2 py-1 text-left text-[12.5px]', step === null ? 'bg-hover font-medium' : 'text-fg-2 hover:bg-hover/60')}>全部 · {c.activity.length} 条</button></li>
        {c.steps.map((s, i) => {
          const n = c.activity.filter((a) => a.step === i).length
          return (
            <li key={i}>
              <button data-testid={`step-${i}`} onClick={() => setStep(step === i ? null : i)} className={cn('flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px]', step === i ? 'bg-hover' : 'hover:bg-hover/60')}>
                <span className="mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center">
                  {s.state === 'done' ? <Check className="h-3.5 w-3.5 text-fg-3" strokeWidth={2.5} /> : s.state === 'fail' ? <AlertCircle className="h-3.5 w-3.5 text-err" /> : s.state === 'now' ? (c.status === 'running' ? <span className="spin-ring" /> : <span className="h-2 w-2 rounded-full border border-fg-3" />) : <span className="h-2 w-2 rounded-full border border-fg-3" />}
                </span>
                <span className={cn('min-w-0 flex-1 leading-[20px]', s.state === 'todo' ? 'text-fg-3' : s.state === 'now' ? 'font-medium text-fg' : s.state === 'fail' ? 'text-err' : 'text-fg-2')}>{s.text}</span>
                {n > 0 && <span className="text-[11px] text-fg-3">{n}</span>}
              </button>
            </li>
          )
        })}
      </ol>
      <div className="min-w-0 flex-1">
        {list.length === 0 && <div className="py-8 text-center text-[13px] text-fg-3">这一步还没开始</div>}
        {list.map((a, i) => {
          const prev = list[i - 1]
          return (
            <div key={a.id}>
              {(!prev || prev.step !== a.step) && step === null && <div className="mb-1 mt-3 text-[11.5px] font-medium text-fg-3 first:mt-0">{c.steps[a.step]?.text}</div>}
              <ActRow a={a} open={open.has(a.id)} onToggle={() => toggle(a.id)} onLink={jump} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ActRow({ a, open, onToggle, onLink }: { a: Activity; open: boolean; onToggle: () => void; onLink: (id: string) => void }) {
  const K = ACT[a.kind]
  const can = !!a.detail || !!a.files?.length || !!a.link
  const userish = a.kind === 'user' || a.kind === 'ask'
  return (
    <div className={cn('rounded-lg', open && can && 'bg-hover/50')} data-testid={`act-${a.id}`}>
      <button onClick={can ? onToggle : undefined} className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left', can && 'hover:bg-hover/60')}>
        {a.who ? <Avatar id={a.who} size={18} status={false} mood="idle" /> : <K.I className={cn('h-[15px] w-[15px] shrink-0', a.kind === 'error' ? 'text-err' : userish ? 'text-warm' : 'text-fg-3')} strokeWidth={1.75} />}
        <span className={cn('min-w-0 flex-1 truncate text-[13.5px]', a.kind === 'think' ? 'italic text-fg-2' : a.kind === 'error' ? 'text-err' : 'text-fg')}>{a.title}</span>
        {a.dur && <span className="shrink-0 text-[11.5px] text-fg-3">{a.dur}</span>}
        <span className="shrink-0 text-[11.5px] text-fg-3">{a.at}</span>
        {can && <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-fg-3 transition', open && 'rotate-90')} />}
      </button>
      {open && can && (
        <div className="px-2 pb-2 pl-[34px]">
          {a.detail && <pre className="scroll-thin max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-bg px-3 py-2 font-mono text-[12px] leading-[1.6] text-fg-2">{a.detail}</pre>}
          {a.files && <div className="mt-1 flex flex-wrap gap-1">{a.files.map((f) => <span key={f} className="rounded bg-bg px-1.5 py-0.5 font-mono text-[11.5px] text-fg-2">{f}</span>)}</div>}
          {a.link && <button onClick={() => onLink(a.link!)} className="mt-1 inline-flex items-center gap-1 text-[12.5px] text-fg-2 hover:text-fg">在聊天里看<ArrowUpRight className="h-3 w-3" /></button>}
        </div>
      )}
    </div>
  )
}

function ChecksView({ c }: { c: Compute }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <ul className="space-y-0.5" data-testid="checks">
      {c.checks.map((k, i) => (
        <li key={i} className={cn('rounded-lg', open === i && 'bg-hover/50')}>
          <button onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[14px] hover:bg-hover/60">
            {k.ok === true ? <Check className="h-4 w-4 text-ok" strokeWidth={2.5} /> : k.ok === false ? <X className="h-4 w-4 text-err" /> : <span className="pulse-dot ml-1 mr-0.5 h-2 w-2 rounded-full bg-run" />}
            <span className={cn('flex-1', k.ok === null && 'text-fg-2')}>{k.text}</span>
            {k.ok === null && <span className="text-[12px] text-fg-3">正在检查</span>}
            <ChevronRight className={cn('h-3.5 w-3.5 text-fg-3 transition', open === i && 'rotate-90')} />
          </button>
          {open === i && (
            <div className="space-y-1.5 px-2 pb-2.5 pl-9 text-[12.5px]">
              {k.cmd && <div className="flex items-center gap-2"><Terminal className="h-3.5 w-3.5 text-fg-3" /><code className="font-mono text-fg-2">{k.cmd}</code></div>}
              {k.out ? <pre className="whitespace-pre-wrap rounded-md bg-bg px-3 py-2 font-mono text-[12px] text-fg-2">{k.out}</pre> : <div className="text-fg-3">还没有输出</div>}
              {k.file && <div className="text-fg-3">测试写在 <span className="font-mono">{k.file}</span></div>}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function CheckpointView({ c }: { c: Compute }) {
  const { rollback } = useApp()
  const [confirm, setConfirm] = useState<string | null>(null)
  return (
    <div data-testid="checkpoints">
      <p className="mb-3 text-[12.5px] text-fg-3">每做完一步自动存一个检查点。回到某个检查点，之后改的文件会恢复原样；之后的过程记录不删，还能再前进回来。</p>
      {[...c.checkpoints].reverse().map((cp) => (
        <div key={cp.id} className="flex items-center gap-3 border-b border-line py-2.5 last:border-0">
          <History className="h-4 w-4 text-fg-3" />
          <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium">{cp.label}</div><div className="text-[12px] text-fg-3">{cp.at} · 第 {cp.step + 1} 步后 · {cp.files} 个文件</div></div>
          {confirm === cp.id ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] text-warm">之后改的 {Math.max(0, c.files.length - cp.files)} 个文件会恢复</span>
              <button onClick={() => setConfirm(null)} className="h-7 rounded-md px-2 text-[12.5px] hover:bg-hover">取消</button>
              <button onClick={() => { rollback(c.id, cp.id); setConfirm(null) }} className="h-7 rounded-md bg-me px-2.5 text-[12.5px] font-medium text-me-fg">确认回到这里</button>
            </div>
          ) : (
            <button onClick={() => setConfirm(cp.id)} className="flex h-7 items-center gap-1 rounded-md border border-line px-2.5 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg"><Undo2 className="h-3.5 w-3.5" />回到这里</button>
          )}
        </div>
      ))}
    </div>
  )
}

/* 底部常驻：补一句（下一步生效，进入同一个任务）/ 顺便问（只读问答，不打断） */
/* 改动：逐文件 diff，行上可以留评论，然后让它按评论改 */
function DiffView({ files, onAsk }: { files: CFile[]; onAsk: (t: string) => void }) {
  const [sel, setSel] = useState(0)
  const [comments, setComments] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const f = files[sel]
  const n = Object.keys(comments).length
  return (
    <div className="flex h-full min-h-[360px] gap-4" data-testid="diff">
      <div className="w-[180px] shrink-0">
        {files.map((x, i) => (
          <button key={x.path} onClick={() => setSel(i)} className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left', i === sel ? 'bg-hover' : 'hover:bg-hover/60')}>
            <span className="min-w-0 flex-1 truncate text-[13px]">{x.path.split('/').pop()}</span>
            <span className="text-[11.5px] text-ok">+{x.add}</span>
            {x.del > 0 && <span className="text-[11.5px] text-err">−{x.del}</span>}
          </button>
        ))}
        {n > 0 && <button onClick={() => { onAsk(`按我在改动里留的 ${n} 条评论改一下`); setComments({}) }} className="mt-3 w-full rounded-lg bg-me py-2 text-[13px] font-medium text-me-fg">按 {n} 条评论修改</button>}
      </div>
      <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-line">
        <div className="border-b border-line bg-hover/50 px-3 py-2 font-mono text-[12px] text-fg-2">{f.path}</div>
        <div className="font-mono text-[12.5px] leading-[22px]">
          {f.diff.map((l, i) => {
            const key = f.path + ':' + i
            if (l.t === 'hunk') return <div key={i} className="bg-hover/40 px-3 text-fg-3">{l.s}</div>
            return (
              <div key={i}>
                <div className={cn('group/l flex', l.t === 'add' && 'bg-run-soft', l.t === 'del' && 'bg-err-soft')}>
                  <button onClick={() => { setEditing(key); setDraft(comments[key] ?? '') }} className="w-6 shrink-0 text-center text-fg-3 opacity-0 hover:text-fg group-hover/l:opacity-100" title="在这一行留评论"><MessageSquarePlus className="mx-auto h-3.5 w-3.5" /></button>
                  <span className="w-8 shrink-0 select-none pr-2 text-right text-fg-3">{l.n}</span>
                  <span className={cn('w-4 shrink-0 select-none', l.t === 'add' ? 'text-ok' : l.t === 'del' ? 'text-err' : 'text-fg-3')}>{l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}</span>
                  <span className="whitespace-pre pr-3">{l.s}</span>
                </div>
                {comments[key] && editing !== key && <div className="mx-3 my-1.5 rounded-lg bg-warm-soft px-3 py-1.5 font-sans text-[13px]">你：{comments[key]}</div>}
                {editing === key && (
                  <form className="mx-3 my-1.5 flex gap-2 font-sans" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) setComments((c) => ({ ...c, [key]: draft.trim() })); setEditing(null) }}>
                    <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="这一行想怎么改？" className="h-8 flex-1 rounded-lg border border-line bg-elev px-2.5 text-[13px] outline-none" />
                    <button className="h-8 rounded-lg bg-me px-3 text-[12.5px] font-medium text-me-fg">留评论</button>
                  </form>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function Preview({ kind, small = false }: { kind: 'login' | 'home'; small?: boolean }) {
  return (
    <div className={cn('overflow-hidden rounded-xl border border-line bg-elev', !small && 'shadow-elev')}>
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-fg-3/30" /><span className="h-2.5 w-2.5 rounded-full bg-fg-3/30" /><span className="h-2.5 w-2.5 rounded-full bg-fg-3/30" />
        <span className="ml-2 flex-1 truncate rounded-md bg-hover px-2 py-0.5 text-[11px] text-fg-2">localhost:5173/{kind}</span>
      </div>
      {kind === 'login' ? (
        <div className="relative grid aspect-[16/10] place-items-center bg-[#16171a]">
          <div className="w-[46%] space-y-2.5 rounded-xl bg-[#1f2024] p-5">
            <div className="mx-auto mb-3 h-2.5 w-16 rounded bg-white/70" />
            <div className="h-7 rounded-md bg-white/10" />
            <div className="h-7 rounded-md bg-white/10 ring-1 ring-white/50" />
            <div className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-white/70" /><span className="h-1.5 w-12 rounded bg-white/30" /></div>
            <div className="h-7 rounded-md bg-white/85" />
          </div>
          <MousePointer2 className="absolute left-[54%] top-[56%] h-5 w-5 fill-white text-black drop-shadow" />
        </div>
      ) : (
        <div className="grid aspect-[16/10] grid-cols-[30%_1fr] gap-2 bg-[#f6f6f7] p-3">
          <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-6 rounded bg-black/[0.06]" />)}</div>
          <div className="space-y-2 rounded bg-white p-3">{[70, 50, 80, 40, 60].map((w, i) => <div key={i} className="h-3 rounded bg-black/[0.07]" style={{ width: w + '%' }} />)}</div>
        </div>
      )}
    </div>
  )
}

/* Computer Use 小窗：可拖动，聊天时一直在（画中画） */
export function Pip({ id, onClose }: { id: string; onClose: () => void }) {
  const { computes } = useApp()
  const c = computes[id]
  const [pos, setPos] = useState({ x: 24, y: 96 })
  const [taken, setTaken] = useState(false)
  return (
    <div data-testid="pip" className="fade-up fixed z-40 w-[320px] overflow-hidden rounded-2xl border border-line bg-elev shadow-elev" style={{ right: pos.x, bottom: pos.y }}>
      <div className="flex cursor-grab items-center gap-2 px-3 py-2 active:cursor-grabbing" onPointerDown={(e) => {
        const sx = e.clientX, sy = e.clientY, ox = pos.x, oy = pos.y
        const mv = (ev: PointerEvent) => setPos({ x: Math.max(8, ox - (ev.clientX - sx)), y: Math.max(8, oy - (ev.clientY - sy)) })
        const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up) }
        window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
      }}>
        <Avatar id={c.owner} size={20} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">{taken ? '你在操作' : `${people[c.owner].name} 在浏览器里检查`}</span>
        <button onClick={onClose} className="grid h-6 w-6 place-items-center rounded text-fg-3 hover:bg-hover hover:text-fg"><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="px-2"><Preview kind={c.preview ?? 'login'} small /></div>
      <div className="p-2">
        <button onClick={() => setTaken((t) => !t)} className={cn('flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium', taken ? 'bg-me text-me-fg' : 'bg-hover hover:bg-sel')}>
          {taken ? `交还给 ${people[c.owner].name}` : <><Hand className="h-3.5 w-3.5" />我来操作</>}
        </button>
      </div>
    </div>
  )
}

/* ---------- 文件 / 任务板 / 资产 预览 ---------- */
/* AC-21 共享文档单一提交点：两人基于同一版本改，后提交者遇到版本冲突，不静默覆盖；冲突左右对照两版，等你选 */
type DocRev = { v: number; by: PersonId; text: string }
function DocConflict({ sec, onResolved }: { sec: string; onResolved: (t: string) => void }) {
  const { pushMsg, active } = useApp()
  const [head, setHead] = useState<DocRev>({ v: 3, by: 'astra', text: sec })
  const [conflict, setConflict] = useState<{ mine: DocRev; theirs: DocRev } | null>(null)
  const [log, setLog] = useState<string[]>([])
  const commit = (by: PersonId, base: number, text: string) => {
    if (base !== head.v && !broken('AC-21')) {
      setConflict({ mine: { v: base, by, text }, theirs: head })
      pushMsg({ k: 'sys', id: 's' + Math.random().toString(36).slice(2, 8), text: `${people[by].name} 改「IM 竞品交互对照」第 4 节时，${people[head.by].name} 已经先提交了 v${head.v}；没有覆盖，等你选` }, active)
      return
    }
    const n = { v: head.v + 1, by, text }; setHead(n); setLog((l) => [`v${n.v} · ${people[by].name}`, ...l]); onResolved(text)
  }
  const pick = (r: DocRev) => { const n = { v: head.v + 1, by: r.by, text: r.text }; setHead(n); setLog((l) => [`v${n.v} · 你选了 ${people[r.by].name} 的`, ...l]); setConflict(null); onResolved(r.text) }
  return (
    <div data-testid="doc-rev" data-v={head.v} className="mt-4 rounded-xl border border-line p-3 text-[13px]">
      <div className="flex items-center gap-2"><span className="font-medium">第 4 节 · 当前 v{head.v}</span><span className="text-fg-3">{people[head.by].name}</span></div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <span className="contents">
          <button data-testid="doc-demo-claude" onClick={() => commit('claude', 3, '决定贴在提问消息下面：几颗轻按钮，点了以你的名义发一条回复。')} className="rounded-md px-2 py-0.5 text-[12px] text-fg-2 hover:bg-hover">演示：Claude Code 基于 v3 提交</button>
          <button data-testid="doc-demo-argon" onClick={() => commit('argon', 3, '决定用消息 + 选项，选项不进输入框上方的托盘。')} className="rounded-md px-2 py-0.5 text-[12px] text-fg-2 hover:bg-hover">演示：Argon 也基于 v3 提交</button>
        </span>
      </div>
      {conflict && (
        <div data-testid="doc-conflict" className="mt-2.5 rounded-lg border border-warm/50 bg-warm/5 p-2.5">
          <div className="mb-2 text-warm">版本冲突：{people[conflict.mine.by].name} 基于 v{conflict.mine.v} 改的，但 {people[conflict.theirs.by].name} 已经提交了 v{conflict.theirs.v}。没有覆盖，选一版：</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {[conflict.theirs, conflict.mine].map((r, i) => (
              <div key={i} className="rounded-md border border-line bg-bg p-2">
                <div className="mb-1 text-[12px] text-fg-3">{i === 0 ? `已提交 v${r.v}` : `后到 · 基于 v${r.v}`} · {people[r.by].name}</div>
                <div className="leading-relaxed">{r.text}</div>
                <button data-testid={`doc-pick-${r.by}`} onClick={() => pick(r)} className="mt-1.5 rounded-md bg-btn px-2 py-0.5 text-[12px] font-medium text-btn-fg">用这版</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {log.length > 0 && <div className="mt-2 text-[12px] text-fg-3">版本：{log.join(' ← ')}</div>}
    </div>
  )
}

function ArtifactView({ id }: { id: string }) {
  const { addQuote, boards, claim } = useApp()
  const a = artifacts.find((x) => x.id === id)!
  const b = boards.b1
  const [sec4, setSec4] = useState('Telegram 的机器人按钮贴在输入框上方；iMessage 的快捷回复也在输入区。')
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid={`artifact-${id}`}>
      <div className="mx-auto max-w-[680px] px-8 py-6">
        <div className="mb-5 flex items-center gap-3">
          <ArtifactIcon kind={a.kind} />
          <div>
            <div className="text-[17px] font-semibold tracking-tight">{a.name}</div>
            <div className="flex items-center gap-1.5 text-[12.5px] text-fg-2"><Avatar id={a.by} size={16} status={false} mood="idle" />{people[a.by].name} · {a.when}</div>
          </div>
        </div>
        {a.kind === 'page' ? <Preview kind="login" /> : a.kind === 'sheet' ? (
          <>
            <table className="w-full text-[13.5px]">
              <thead><tr className="border-b border-line text-left text-fg-2"><th className="py-2 font-medium">任务</th><th className="font-medium">认领</th><th /></tr></thead>
              <tbody>
                {b.rows.map((r, i) => (
                  <tr key={r.task} className="border-b border-line">
                    <td className="py-2.5">{r.task}</td>
                    <td>{r.who ? <span className="inline-flex items-center gap-1.5"><Avatar id={r.who} size={18} status={false} mood="idle" />{people[r.who].name}</span> : <span className="text-warm">没人领</span>}</td>
                    <td className="text-right">{!r.who && <button data-testid={`claim-${i}`} onClick={() => claim('b1', i, 'grok')} className="rounded-md px-2 py-0.5 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg">演示：让 Grok 认领</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[12px] text-fg-3">两个人同时领同一项时，先到的领到，后到的会被告知“已被领走”。</p>
          </>
        ) : a.kind === 'asset' ? (
          <div className="space-y-3">
            <div className="overflow-hidden rounded-xl border border-line">
              {[['地址', '43.•••.•••.12'], ['用户', 'root'], ['密码', '已加密保存，助手只拿到引用，看不到明文'], ['部署目录', '/srv/app']].map(([k, v]) => (
                <div key={k} className="flex border-b border-line px-4 py-2.5 text-[13.5px] last:border-0"><span className="w-24 shrink-0 text-fg-2">{k}</span><span>{v}</span></div>
              ))}
            </div>
            <div className="text-[12.5px] text-fg-3">能用它的助手：Codex、Claude Code · 来自你和 Codex 的私聊 · 删掉原消息不会删掉资产</div>
          </div>
        ) : (
          <article className="space-y-3 text-[14.5px] leading-[1.8]">
            <p className="text-fg-2">对照了 QQ、Telegram、GrokBot、iMessage 四款产品，看它们怎么处理“谁在做事”和“要你处理什么”。</p>
            {[
              ['1. 列表', '四家都只给一行预览。需要你处理时只改这一行的颜色，不加徽章。'],
              ['2. 消息', '气泡不描边，连发合并。系统事件只占一行居中灰字。'],
              ['3. 进度在聊天里', '大家都把“谁在干活”放在聊天里，而不是另开页面。'],
              ['4. 决定不混在消息里', sec4],
            ].map(([h, bb]) => (
              <section key={h} className="group/s relative -mx-3 rounded-lg px-3 py-1 hover:bg-hover/50">
                <h3 className="text-[15.5px] font-semibold">{h}</h3>
                <p>{bb}</p>
                <button onClick={() => addQuote({ msgId: 'g2', from: a.by, text: `${a.name} · ${h}：${bb}` })} className="absolute right-2 top-1.5 rounded-md bg-elev px-2 py-0.5 text-[12px] text-fg-2 opacity-0 shadow-elev hover:text-fg group-hover/s:opacity-100">引用到对话</button>
              </section>
            ))}
            <DocConflict sec={sec4} onResolved={setSec4} />
          </article>
        )}
      </div>
    </div>
  )
}

export { Eye }
export type { Compute }
