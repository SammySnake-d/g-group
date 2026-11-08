/* 定时详情（#1286 #1850 #1858）：在右侧分栏打开。能改、能暂停、能删、能立即跑一次，能看最近几次醒来做了什么、点了跳回当次的消息。
   定时属于联系人、作用在会话；三处列表（本群 / 它的工作台 / 进展总览）点任意一行都打开这里。 */
import { useState } from 'react'
import { AlarmClock, AlertTriangle, ArrowUpRight, Check, Megaphone, MoonStar, Play, Trash2 } from 'lucide-react'
import { broken } from '@/mut'
import { useApp } from '@/ctx'
import { people, type Cron, type PersonId } from '@/data'
import { Avatar } from './Avatar'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

const REPEATS: Cron['repeat'][] = ['每天', '工作日', '每周一', '一次']
export const cronRule = (c: Cron) => (c.when?.k === 'every' ? `每 ${c.when.n} 条消息` : c.when?.k === 'cond' ? `当${c.when.cond}` : `${c.repeat} ${c.time}`)
/** 列表里那一格：到点的写时间，按条数的写“每 N 条”，按条件的写“条件” */
export const cronWhen = (c: Cron) => (c.when?.k === 'every' ? `每${c.when.n}条` : c.when?.k === 'cond' ? '条件' : c.time)
export const cronRepeat = (c: Cron) => (c.when?.k === 'every' ? `已 ${c.when.seen}/${c.when.n}` : c.when?.k === 'cond' ? c.when.src : c.repeat)

export function CronDetail({ id }: { id: string }) {
  const { crons, convs, updateCron, removeCron, runCronNow, jump, openConv } = useApp()
  const c = crons.find((x) => x.id === id)
  const [edit, setEdit] = useState(false)
  if (!c) return <div className="p-6 text-[13px] text-fg-3" data-testid="cron-detail-gone">这个定时已经删掉了</div>
  const conv = convs.find((x) => x.id === c.conv)
  const where = conv ? (conv.kind === 'dm' ? `与 ${conv.title} 私聊` : conv.title) : c.conv
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid={`cron-detail-${c.id}`}>
      <div className="px-5 pt-4">
        <div className="flex items-center gap-2 text-[12px] text-fg-3">
          <Avatar id={c.owner} size={18} status={false} mood="idle" />
          <span>{people[c.owner].name} 的定时</span><span>·</span>
          <button onClick={() => openConv(c.conv)} className="inline-flex items-center gap-0.5 rounded bg-hover px-1.5 py-px text-fg-2 hover:text-fg">在「{where}」<ArrowUpRight className="h-3 w-3" /></button>
        </div>
        {!edit ? (
          <>
            <div className="mt-2 text-[16px] font-semibold leading-snug">{c.text}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-fg-2">
              <span className="font-mono tabular-nums" data-testid="cron-rule">{cronRule(c)}</span>
              <span className="text-fg-3">·</span>
              <span>{c.when?.k === 'cond' ? '命中才说话' : c.speak === 'only-if' ? '有情况才说话' : '每次都发结果'}</span>
              <span className="text-fg-3">·</span>
              <span data-testid="cron-next" className={cn(c.paused && 'text-fg-3')}>{c.paused ? '已暂停' : `下次 ${c.next}`}</span>
            </div>
            {c.uses?.length ? <div className="mt-1.5 flex gap-1">{c.uses.map((u) => <span key={u} className="rounded bg-hover px-1.5 text-[11.5px] text-fg-2">{u}</span>)}</div> : null}
          </>
        ) : <CronForm init={c} onDone={(patch) => { if (patch) updateCron(c.id, patch); setEdit(false) }} />}
        {!edit && (
          <div className="mt-3 flex items-center gap-1.5">
            <button data-testid="cron-run-now" onClick={() => runCronNow(c.id)} className="flex h-8 items-center gap-1 rounded-lg bg-btn px-3 text-[13px] font-medium text-btn-fg"><Play className="h-3.5 w-3.5" />立即跑一次</button>
            <button data-testid="cron-edit" onClick={() => setEdit(true)} className="h-8 rounded-lg px-3 text-[13px] font-medium hover:bg-hover">改</button>
            <span className="flex-1" />
            <label className="flex items-center gap-1.5 text-[12.5px] text-fg-2">{c.paused ? '已暂停' : '开着'}<Switch data-testid="cron-pause" checked={!c.paused} onCheckedChange={(v) => updateCron(c.id, { paused: !v })} /></label>
            <button data-testid="cron-delete" onClick={() => removeCron(c.id)} title="删除" className="grid h-8 w-8 place-items-center rounded-lg text-fg-3 hover:bg-err-soft hover:text-err"><Trash2 className="h-4 w-4" /></button>
          </div>
        )}
        {c.srcMsg && <button onClick={() => jump(c.srcMsg!)} className="mt-2 inline-flex items-center gap-0.5 text-[12px] text-fg-3 hover:text-fg">看当初是怎么说的<ArrowUpRight className="h-3 w-3" /></button>}
      </div>
      {/* D02 第 2 条 / U86（#413 ⑪）：到点醒来时，宿主先把这个会话当前的群公告装配进它的上下文，不用建定时那会儿的旧规矩。
          这里写明下次醒来会带哪几条、各是第几版；每次醒来也记下当时带的是哪一版。坏实现（埋雷 AC-35-11）：一直用建定时时的版本 */}
      {conv?.kind === 'group' && (conv.notices?.length ?? 0) > 0 && (
        <div className="mt-5 border-t border-line px-5 py-3" data-testid="cron-notices">
          <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-fg-3"><Megaphone className="h-3.5 w-3.5" />下次醒来先带上的群公告</div>
          <div className="space-y-0.5">
            {conv.notices!.map((n) => {
              const v = broken('AC-35-11') ? (c.runs?.[c.runs.length - 1]?.notices?.[n.id] ?? n.ver) : n.ver
              return (
                <div key={n.id} data-testid={`cron-notice-${n.id}`} data-ver={v} className="flex items-baseline gap-2 rounded-lg px-2 py-1 text-[13px]">
                  <span className="shrink-0 rounded bg-hover px-1 font-mono text-[11px] text-fg-2">v{v}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-2">{n.text.split('\n')[0]}</span>
                  <span className="shrink-0 text-[11.5px] text-fg-3">{n.at}</span>
                </div>
              )
            })}
          </div>
          <div className="mt-1 px-2 text-[11.5px] text-fg-3">公告改了，下次醒来就按新版本做，不用重建定时。</div>
        </div>
      )}
      <div className="mt-5 border-t border-line px-5 py-3">
        <div className="mb-1.5 text-[12px] font-medium text-fg-3">最近醒来</div>
        {!(c.runs?.length) && <div className="py-2 text-[13px] text-fg-3">还没跑过。点「立即跑一次」先试试</div>}
        <div className="space-y-0.5" data-testid="cron-runs">
          {c.runs?.map((r, i) => (
            <div key={i} data-testid={`cron-run-${i}`} data-result={r.result} className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]', r.result === 'error' && 'bg-err-soft/50')}>
              {r.result === 'said' ? <Check className="h-3.5 w-3.5 shrink-0 text-fg-3" strokeWidth={2.5} /> : r.result === 'silent' ? <MoonStar className="h-3.5 w-3.5 shrink-0 text-fg-3" /> : <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-err" />}
              <span className="w-[74px] shrink-0 text-[12px] tabular-nums text-fg-3">{r.at}</span>
              <span className={cn('min-w-0 flex-1 truncate', r.result === 'error' ? 'text-err' : r.result === 'silent' ? 'text-fg-3' : 'text-fg')}>{r.note}</span>
              {r.notices && conv?.notices && (() => {
                const old = conv.notices.filter((n) => (r.notices![n.id] ?? 0) < n.ver)
                return <span data-testid={`cron-run-notices-${i}`} data-stale={old.length || undefined} title={conv.notices.map((n) => `${n.text.split('\n')[0].slice(0, 16)}… v${r.notices![n.id] ?? '—'}`).join('\n')} className="shrink-0 text-[11px] text-fg-3">公告 {old.length ? `${old.length} 条是旧版` : '当时最新'}</span>
              })()}
              {r.msg && <button data-testid={`cron-run-jump-${i}`} onClick={() => jump(r.msg!)} className="shrink-0 text-[12px] text-me hover:underline">看消息</button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 新建和修改共用一张一行半的表单：时间、重复、做什么、什么时候才开口 */
export function CronForm({ init, owner, conv, onDone }: { init?: Partial<Cron>; owner?: PersonId; conv?: string; onDone: (patch?: Partial<Cron>) => void }) {
  const { convs } = useApp()
  const [time, setTime] = useState(init?.time ?? '09:00')
  const [repeat, setRepeat] = useState<Cron['repeat']>(init?.repeat ?? '每天')
  const [text, setText] = useState(init?.text ?? '')
  const [speak, setSpeak] = useState<Cron['speak']>(init?.speak ?? 'always')
  const [who, setWho] = useState<PersonId | undefined>(owner ?? init?.owner)
  const [where, setWhere] = useState<string | undefined>(conv ?? init?.conv)
  const g = convs.find((x) => x.id === where)
  const pickWho = !init?.owner && !owner
  const pickWhere = !init?.conv && !conv
  const candidates = (g ? g.members : Object.keys(people)).filter((p) => p !== 'me' && !people[p]?.human && p !== 'helper') as PersonId[]
  const ok = !!text.trim() && !!who && !!where
  return (
    <form data-testid="cron-form" className="mt-2 space-y-2 rounded-xl border border-line bg-side p-3" onSubmit={(e) => { e.preventDefault(); if (ok) onDone({ time, repeat, text: text.trim(), speak, owner: who!, conv: where! }) }}>
      {pickWho && (
        <div className="flex flex-wrap gap-1">{candidates.map((p) => (
          <button type="button" key={p} data-testid={`cron-form-who-${p}`} onClick={() => setWho(p)} className={cn('flex h-7 items-center gap-1 rounded-full border px-2 text-[12.5px]', who === p ? 'border-me bg-me/10 text-me' : 'border-line hover:bg-hover')}><Avatar id={p} size={16} status={false} mood="idle" />{people[p].name}</button>
        ))}</div>
      )}
      {pickWhere && (
        <select data-testid="cron-form-where" value={where ?? ''} onChange={(e) => setWhere(e.target.value)} className="h-8 w-full rounded-lg border border-line bg-bg px-2 text-[13px]">
          <option value="" disabled>发在哪个会话</option>
          {convs.filter((x) => !who || x.members.includes(who)).map((x) => <option key={x.id} value={x.id}>{x.kind === 'dm' ? `与 ${x.title} 私聊` : x.title}</option>)}
        </select>
      )}
      <div className="flex items-center gap-1.5">
        <AlarmClock className="h-4 w-4 shrink-0 text-fg-3" />
        <select data-testid="cron-form-repeat" value={repeat} onChange={(e) => setRepeat(e.target.value as Cron['repeat'])} className="h-8 rounded-lg border border-line bg-bg px-1.5 text-[13px]">{REPEATS.map((r) => <option key={r}>{r}</option>)}</select>
        <input data-testid="cron-form-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-8 rounded-lg border border-line bg-bg px-1.5 font-mono text-[13px]" />
        <select data-testid="cron-form-speak" value={speak} onChange={(e) => setSpeak(e.target.value as Cron['speak'])} className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-1.5 text-[13px]"><option value="always">每次都发结果</option><option value="only-if">有情况才说话</option></select>
      </div>
      <input data-testid="cron-form-text" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="醒来做什么，比如“总结昨天的报错，有 P0 才叫我”" className="h-9 w-full rounded-lg border border-line bg-bg px-2.5 text-[13.5px] outline-none focus:border-fg-3" />
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={() => onDone()} className="h-8 rounded-lg px-3 text-[13px] hover:bg-hover">取消</button>
        <button data-testid="cron-form-save" disabled={!ok} className="h-8 rounded-lg bg-btn px-3.5 text-[13px] font-medium text-btn-fg disabled:opacity-40">保存</button>
      </div>
    </form>
  )
}

/* 手动新建群清单项（总账 #17 / 遗漏核查 #930 #24）：居中弹窗、标题 + 描述分开、谁做 + 在哪个群 */
export function TaskForm({ conv, onDone }: { conv?: string; onDone: (item?: { text: string; desc?: string; who?: PersonId; conv: string }) => void }) {
  const { convs } = useApp()
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [who, setWho] = useState<PersonId | undefined>(undefined)
  const [where, setWhere] = useState<string | undefined>(conv)
  const g = convs.find((x) => x.id === where)
  const pickWhere = !conv
  const candidates = (g ? g.members : Object.keys(people)).filter((p) => p !== 'me' && !people[p]?.human && p !== 'helper') as PersonId[]
  const ok = !!title.trim() && !!where
  return (
    <form data-testid="task-form" className="w-full max-w-md space-y-3 rounded-xl border border-line bg-side p-4" onSubmit={(e) => { e.preventDefault(); if (ok) onDone({ text: title.trim(), desc: desc.trim() || undefined, who, conv: where! }) }}>
      <div className="text-[13.5px] font-semibold">新建任务</div>
      <input autoFocus data-testid="task-form-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="任务标题" className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-[13.5px]" />
      <textarea data-testid="task-form-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="详细描述（可选）" className="min-h-[80px] w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-[13px] scroll-thin" />
      {pickWhere && (
        <select data-testid="task-form-where" value={where ?? ''} onChange={(e) => setWhere(e.target.value)} className="h-9 w-full rounded-lg border border-line bg-bg px-2 text-[13px]">
          <option value="" disabled>在哪个群</option>
          {convs.filter((x) => x.kind === 'group').map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
        </select>
      )}
      <div className="flex flex-wrap gap-1"><span className="mr-1 text-[12px] text-fg-3">谁做（可选）</span>{candidates.map((p) => (
        <button type="button" key={p} data-testid={`task-form-who-${p}`} onClick={() => setWho((x) => (x === p ? undefined : p))} className={cn('flex h-7 items-center gap-1 rounded-full border px-2 text-[12.5px]', who === p ? 'border-me bg-me/10 text-me' : 'border-line hover:bg-hover')}><Avatar id={p} size={16} status={false} mood="idle" />{people[p].name}</button>
      ))}</div>
      <div className="flex gap-2 pt-1">
        <button type="button" data-testid="task-form-cancel" onClick={() => onDone()} className="h-9 flex-1 rounded-lg border border-line text-[13px] hover:bg-hover">取消</button>
        <button type="submit" data-testid="task-form-submit" disabled={!ok} className="h-9 flex-1 rounded-lg bg-me text-[13px] text-bg disabled:opacity-40">创建</button>
      </div>
    </form>
  )
}
