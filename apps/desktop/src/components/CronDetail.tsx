/* 定时详情（#1286 #1850 #1858）：在右侧分栏打开。能改、能暂停、能删（二次确认）、能立即跑一次，
   能看每次醒来做了什么（发了消息 / 没打扰你 / 失败）、点了跳回当次的消息。
   三处列表（本群 / 它的工作台 / 进展总览）点任意一行都打开这里。 */
import { useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AlarmClock, ArrowUpRight, Megaphone, Pencil, Play, Trash2 } from 'lucide-react'
import { formatRunAt, localZoneLabel, nextRuns } from '@g-group/ui-core'
import { broken } from '@/mut'
import { useApp } from '@/ctx'
import { people, type PersonId } from '@/data'
import { RESULT, cronExpr, cronFailed, cronNextText, cronRule, useNow } from '@/cronView'
import { Avatar } from './Avatar'
import { CronEditor } from './CronEditor'
import { ResultIcon, convName } from './CronList'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

export { cronRule } from '@/cronView'

export function CronDetail({ id }: { id: string }) {
  const { crons, convs, plugins, updateCron, removeCron, runCronNow, jump, openConv } = useApp()
  const now = useNow()
  const c = crons.find((x) => x.id === id)
  const [edit, setEdit] = useState(false)
  const [asking, setAsking] = useState(false)
  if (!c) return <div className="p-6 text-[13px] text-fg-3" data-testid="cron-detail-gone">这个定时已经删掉了</div>
  const conv = convs.find((x) => x.id === c.conv)
  const expr = cronExpr(c)
  const failed = cronFailed(c)
  const upcoming = expr && !c.paused ? nextRuns(expr, now, 4).slice(1) : []
  const speakText = c.trigger.kind === 'event' ? '命中才说话' : c.speak === 'only-if' ? '有情况才说' : '每次都发结果'
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid={`cron-detail-${c.id}`}>
      <div className="px-5 pt-4">
        <div className="flex items-center gap-1.5 text-[12px] text-fg-3">
          <Avatar id={c.owner} size={18} status={false} mood="idle" />
          <span>{people[c.owner]?.name} 的定时</span><span>·</span>
          <button onClick={() => openConv(c.conv)} className="inline-flex min-w-0 items-center gap-0.5 rounded bg-hover px-1.5 py-px text-fg-2 hover:text-fg"><span className="truncate">在「{convName(conv, c.conv)}」</span><ArrowUpRight className="h-3 w-3 shrink-0" /></button>
        </div>
        <div data-testid="cron-detail-text" className="mt-2 whitespace-pre-line text-[16px] font-semibold leading-snug">{c.text}</div>

        <div className={cn('mt-3 rounded-xl border border-line bg-side px-3.5 py-3', c.paused && 'opacity-70')}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <AlarmClock className="h-4 w-4 shrink-0 text-fg-3" />
            <span data-testid="cron-rule" className="text-[14.5px] font-semibold">{cronRule(c)}</span>
            {expr && <code data-testid="cron-detail-expr" className="rounded bg-hover px-1.5 py-px font-mono text-[12px] text-fg-2">{expr}</code>}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-fg-2">
            <span>{c.paused ? '' : '下次 '}<span data-testid="cron-next" className={cn('font-medium', c.paused ? 'text-fg-3' : 'text-fg')}>{cronNextText(c, now, plugins)}</span></span>
            <span className="text-fg-3">·</span><span>{speakText}</span>
          </div>
          {upcoming.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1 text-[12px]">
              <span className="mr-0.5 text-fg-3">再往后</span>
              {upcoming.map((d, i) => <span key={d.getTime()} data-testid={`cron-detail-next-${i}`} className="rounded-md bg-elev px-1.5 py-px tabular-nums text-fg-2 ring-1 ring-line">{formatRunAt(d, now)}</span>)}
            </div>
          )}
          {(c.trigger.kind === 'cron' || c.trigger.kind === 'once') && <div className="mt-1.5 text-[11.5px] text-fg-3">按本地时间 · {localZoneLabel(now)}</div>}
          {c.uses?.length ? <div className="mt-2 flex flex-wrap gap-1">{c.uses.map((u) => <span key={u} className="rounded bg-hover px-1.5 text-[11.5px] text-fg-2">{u}</span>)}</div> : null}
        </div>

        <div className="mt-3 flex items-center gap-1.5">
          <button data-testid="cron-run-now" onClick={() => runCronNow(c.id)} className="flex h-8 items-center gap-1.5 rounded-lg bg-btn px-3 text-[13px] font-medium text-btn-fg hover:opacity-90"><Play className="h-3.5 w-3.5" />立即跑一次</button>
          <button data-testid="cron-edit" onClick={() => setEdit(true)} className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-[13px] font-medium text-fg-2 hover:bg-hover hover:text-fg"><Pencil className="h-3.5 w-3.5" />编辑</button>
          <span className="flex-1" />
          <label className="flex items-center gap-1.5 text-[12.5px] text-fg-2"><span data-testid="cron-pause-label">{c.paused ? '已暂停' : '开着'}</span><Switch data-testid="cron-pause" checked={!c.paused} onCheckedChange={(v) => updateCron(c.id, { paused: !v })} /></label>
          <button data-testid="cron-delete" onClick={() => setAsking(true)} title="删除" className="grid h-8 w-8 place-items-center rounded-lg text-fg-3 hover:bg-err-soft hover:text-err"><Trash2 className="h-4 w-4" /></button>
        </div>
        {c.srcMsg && <button onClick={() => jump(c.srcMsg!)} className="mt-2 inline-flex items-center gap-0.5 text-[12px] text-fg-3 hover:text-fg">看当初是怎么说的<ArrowUpRight className="h-3 w-3" /></button>}
      </div>

      {/* D02 第 2 条 / U86 / C-US26（#413 ⑪）：到点醒来时，宿主先把这个会话当前的群公告装配进它的上下文，不用建定时那会儿的旧规矩。
          这里写明下次醒来会带哪几条、各是第几版；每次醒来也记下当时带的是哪一版。坏实现（埋雷 AC-35-11）：一直用建定时时的版本 */}
      {conv?.kind === 'group' && (conv.notices?.length ?? 0) > 0 && (
        <div className="mt-5 border-t border-line px-5 py-3" data-testid="cron-notices">
          <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-fg-3"><Megaphone className="h-3.5 w-3.5" />下次醒来先带上的群公告</div>
          <div className="space-y-0.5">
            {conv.notices!.map((n) => {
              const v = broken('AC-35-11') ? (c.runs[c.runs.length - 1]?.notices?.[n.id] ?? n.ver) : n.ver
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

      <div className={cn('border-t border-line px-5 py-3', !(conv?.kind === 'group' && conv.notices?.length) && 'mt-5')}>
        <div className="mb-1.5 flex items-baseline gap-2 text-[12px] font-medium text-fg-3">运行历史<span data-testid="cron-runs-count" className="font-normal">{c.runs.length} 次</span>{failed && <span className="font-normal text-err">· 最近一次失败</span>}</div>
        {c.runs.length === 0 && <div className="py-2 text-[13px] text-fg-3">还没跑过。点「立即跑一次」先试试</div>}
        <div className="space-y-1" data-testid="cron-runs">
          {c.runs.map((r, i) => (
            <div key={`${r.at}-${i}`} data-testid={`cron-run-${i}`} data-result={r.result} className={cn('rounded-lg px-2 py-1.5 text-[13px]', r.result === 'error' && 'bg-err-soft/60')}>
              <div className="flex items-center gap-2">
                <ResultIcon r={r.result} />
                <span className={cn('shrink-0 text-[12.5px] font-medium', r.result === 'error' ? 'text-err' : r.result === 'silent' ? 'text-fg-2' : 'text-fg')}>{RESULT[r.result]}</span>
                <span className="shrink-0 text-[12px] tabular-nums text-fg-3">{formatRunAt(new Date(r.at), now)}</span>
                <span className="flex-1" />
                {r.notices && conv?.notices && (() => {
                  const old = conv.notices.filter((n) => (r.notices![n.id] ?? 0) < n.ver)
                  return <span data-testid={`cron-run-notices-${i}`} data-stale={old.length || undefined} title={conv.notices.map((n) => `${n.text.split('\n')[0].slice(0, 16)}… v${r.notices![n.id] ?? '—'}`).join('\n')} className="shrink-0 text-[11px] text-fg-3">公告 {old.length ? `${old.length} 条是旧版` : '当时最新'}</span>
                })()}
                {r.msg && <button data-testid={`cron-run-jump-${i}`} onClick={() => jump(r.msg!)} className="shrink-0 rounded-md px-1.5 text-[12px] text-me hover:bg-me/10">看消息</button>}
              </div>
              <div className={cn('mt-0.5 pl-[22px] text-[12.5px] leading-snug', r.result === 'error' ? 'text-err' : 'text-fg-2')}>{r.note}</div>
            </div>
          ))}
        </div>
      </div>

      <CronEditor open={edit} init={c} onClose={() => setEdit(false)} onSave={(d) => { updateCron(c.id, d); setEdit(false) }} />
      <DialogPrimitive.Root open={asking} onOpenChange={setAsking}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content data-testid="cron-delete-confirm" aria-describedby={undefined} onEscapeKeyDown={(e) => e.stopPropagation()} className="fixed left-1/2 top-1/2 z-50 w-[min(400px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-elev p-5 text-fg shadow-elev data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
            <DialogPrimitive.Title className="text-[15px] font-semibold">删除这个定时？</DialogPrimitive.Title>
            <div className="mt-2 rounded-lg bg-hover/70 px-3 py-2 text-[13px] leading-snug">{c.text}<div className="mt-0.5 text-[12px] text-fg-3">{people[c.owner]?.name} · {cronRule(c)}</div></div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-fg-2">{people[c.owner]?.name} 之后不会再按它醒来，{c.runs.length} 次运行历史也一起删掉。只想停一阵子，用「暂停」就行。</p>
            <div className="mt-4 flex justify-end gap-2">
              <DialogPrimitive.Close data-testid="cron-delete-cancel" className="h-9 rounded-lg px-3.5 text-[13px] text-fg-2 hover:bg-hover hover:text-fg">取消</DialogPrimitive.Close>
              <button data-testid="cron-delete-ok" onClick={() => { setAsking(false); removeCron(c.id) }} className="h-9 rounded-lg bg-err px-4 text-[13px] font-medium text-me-fg hover:opacity-90">删除</button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
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
