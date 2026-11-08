/* 定时编辑器（新建和修改共用）：做什么 → 由谁、在哪 → 什么时候醒 → 什么时候开口 → 开启。
   什么时候醒有四种：按时间重复（预设芯片 + 自定义 cron，逐段校验、人话说明、接下来几次）/ 只跑一次 / 每 N 条消息 / 某件事发生（插件来源）。
   时刻一律按本地时区算，界面写明是哪个时区。保存前整张校验，不合法保存按钮不可用。 */
import { useRef, useState, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AlertCircle, Megaphone, X } from 'lucide-react'
import {
  CRON_FIELDS, CRON_PRESETS, CUSTOM_PRESET, cronPresetId, describeCron, formatRunAt, localZoneLabel, nextRuns, parseCron,
  parseLocalDateTime, toLocalDateTime, triggerError, type CronTrigger, type CronTriggerKind,
} from '@g-group/ui-core'
import { useApp } from '@/ctx'
import { people, type Cron, type PersonId } from '@/data'
import { useNow } from '@/cronView'
import { cn } from '@/lib/utils'
import { Avatar } from './Avatar'
import { Switch } from '@/components/ui/switch'

export type CronDraft = Omit<Cron, 'id' | 'runs'>

const KINDS: { k: CronTriggerKind; label: string }[] = [
  { k: 'cron', label: '按时间重复' }, { k: 'once', label: '只跑一次' }, { k: 'messages', label: '每 N 条消息' }, { k: 'event', label: '某件事发生' },
]

const isBot = (p: PersonId) => !!people[p] && !people[p].human && p !== 'helper'

export function CronEditor({ open, init, seed, conv, owner, onClose, onSave }: {
  open: boolean
  /** 有 = 修改这个定时 */
  init?: Cron
  /** 新建时从别处带来的预填(如 /schedule <何时> <做什么>):做什么、cron 表达式 */
  seed?: { text?: string; expr?: string }
  /** 新建时预填的会话 / 助手 */
  conv?: string
  owner?: PersonId
  onClose: () => void
  onSave: (d: CronDraft) => void
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-testid="cron-editor"
          aria-describedby={undefined}
          /* Esc 只关这张卡，不让外层顺带收起分屏 */
          onEscapeKeyDown={(e) => e.stopPropagation()}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-56px)] w-[min(640px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-elev text-fg shadow-elev data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          {open && <EditorBody init={init} seed={seed} conv={conv} owner={owner} onClose={onClose} onSave={onSave} />}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2"><span className="text-[12.5px] font-semibold text-fg">{label}</span>{hint && <span className="text-[11.5px] text-fg-3">{hint}</span>}</div>
      {children}
    </div>
  )
}

function Segmented<T extends string>({ value, options, onChange, testid }: { value: T; options: { k: T; label: string }[]; onChange: (v: T) => void; testid: string }) {
  return (
    <div role="radiogroup" className="inline-flex rounded-lg bg-hover p-0.5">
      {options.map((o) => (
        <button key={o.k} type="button" role="radio" aria-checked={value === o.k} data-testid={`${testid}-${o.k}`} onClick={() => onChange(o.k)}
          className={cn('h-7 rounded-md px-3 text-[12.5px] transition', value === o.k ? 'bg-elev font-medium text-fg shadow-sm' : 'text-fg-2 hover:text-fg')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

const inputCls = 'w-full rounded-lg border border-line bg-bg px-3 text-[13.5px] outline-none transition focus:border-fg-3'

function EditorBody({ init, seed, conv, owner, onClose, onSave }: { init?: Cron; seed?: { text?: string; expr?: string } | undefined; conv?: string | undefined; owner?: PersonId | undefined; onClose: () => void; onSave: (d: CronDraft) => void }) {
  const { convs, plugins } = useApp()
  const now = useNow()
  const t0 = init?.trigger
  const usable = convs.filter((c) => c.members.some(isBot))
  const firstConvOf = (p?: PersonId) => (p ? usable.find((c) => c.members.includes(p))?.id : undefined)
  const [text, setText] = useState(init?.text ?? seed?.text ?? '')
  const [where, setWhere] = useState<string | undefined>(init?.conv ?? conv ?? firstConvOf(owner))
  const [who, setWho] = useState<PersonId | undefined>(init?.owner ?? owner)
  const [kind, setKind] = useState<CronTriggerKind>(t0?.kind ?? 'cron')
  const [expr, setExpr] = useState(t0?.kind === 'cron' ? t0.expr : seed?.expr ?? CRON_PRESETS[0]!.expr)
  const [custom, setCustom] = useState(false)
  const tomorrow9 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0)
  const [onceAt, setOnceAt] = useState(t0?.kind === 'once' ? t0.at : toLocalDateTime(tomorrow9))
  const [n, setN] = useState(t0?.kind === 'messages' ? t0.n : 30)
  const [source, setSource] = useState(t0?.kind === 'event' ? t0.source : '')
  const [cond, setCond] = useState(t0?.kind === 'event' ? t0.cond : '')
  const [speak, setSpeak] = useState<Cron['speak']>(init?.speak ?? 'always')
  const [on, setOn] = useState(!init?.paused)
  const exprRef = useRef<HTMLInputElement>(null)

  const g = convs.find((c) => c.id === where)
  const candidates = (g?.members ?? []).filter(isBot)
  const sources = plugins.filter((p) => p.installed && p.kind === 'source' && !!where && p.convs.includes(where))
  const trigger: CronTrigger =
    kind === 'cron' ? { kind, expr }
    : kind === 'once' ? { kind, at: onceAt }
    : kind === 'messages' ? { kind, n, seen: t0?.kind === 'messages' ? Math.min(t0.seen, Math.max(0, n - 1)) : 0 }
    : { kind, source, cond }
  const parsed = parseCron(expr)
  const tErr = triggerError(trigger, now)
  const missing = !text.trim() ? '写一下醒来做什么' : !where ? '选一个会话' : !who ? '选由谁来做' : null
  const ok = !tErr && !missing

  const pickWhere = (id: string) => {
    setWhere(id)
    const next = convs.find((c) => c.id === id)?.members.filter(isBot) ?? []
    if (!who || !next.includes(who)) setWho(next.length === 1 ? next[0] : undefined)
    if (kind === 'event') setSource('')
  }
  const save = () => {
    if (!ok || !where || !who) return
    /* 存规整后的表达式（段间单空格、英文名大写），各处显示和将来交给后端都是同一个写法 */
    const t: CronTrigger = trigger.kind === 'cron' && parsed.ok ? { kind: 'cron', expr: parsed.spec.expr } : trigger
    onSave({ owner: who, conv: where, text: text.trim(), trigger: t, speak, paused: !on, ...(init?.uses ? { uses: init.uses } : {}), ...(init?.srcMsg ? { srcMsg: init.srcMsg } : {}) })
  }

  /* ---- 按时间重复：逐段尺子 + 人话 + 接下来 ---- */
  const tokens = expr.trim().split(/\s+/).filter(Boolean)
  const badField = !parsed.ok ? parsed.error.field : null
  const activePreset = custom ? CUSTOM_PRESET : cronPresetId(expr)
  const upcoming = parsed.ok ? nextRuns(expr, now, 5) : []
  const zone = localZoneLabel(now)

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); save() }}>
      <div className="flex items-start gap-3 border-b border-line px-5 pb-3.5 pt-4">
        <div className="min-w-0 flex-1">
          <DialogPrimitive.Title className="text-[15px] font-semibold">{init ? '改定时' : '新建定时'}</DialogPrimitive.Title>
          <div className="mt-0.5 text-[12.5px] text-fg-3">到点叫醒一位助手，让它在会话里替你做一件事</div>
        </div>
        <DialogPrimitive.Close type="button" title="关闭（Esc）" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-fg-2 hover:bg-hover hover:text-fg"><X className="h-[18px] w-[18px]" /></DialogPrimitive.Close>
      </div>

      <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <Field label="做什么">
          <textarea data-testid="cron-editor-text" autoFocus={!init} value={text} onChange={(e) => setText(e.target.value)} rows={3}
            placeholder={'醒来做什么，比如「总结昨天的报错，有 P0 才叫我」'} className={cn(inputCls, 'min-h-[76px] resize-y py-2 leading-relaxed')} />
        </Field>

        <div className="grid grid-cols-[minmax(0,200px)_minmax(0,1fr)] gap-4">
          <Field label="在哪个会话">
            <select data-testid="cron-editor-conv" value={where ?? ''} onChange={(e) => pickWhere(e.target.value)} className={cn(inputCls, 'h-9 px-2')}>
              <option value="" disabled>选一个会话</option>
              {usable.map((c) => <option key={c.id} value={c.id}>{c.kind === 'dm' ? `与 ${c.title} 私聊` : c.title}</option>)}
            </select>
          </Field>
          <Field label="由谁做" hint={g ? '这个会话里的助手' : undefined}>
            <div className="flex min-h-9 flex-wrap items-center gap-1.5">
              {!g && <span className="text-[12.5px] text-fg-3">先选会话</span>}
              {candidates.map((p) => (
                <button type="button" key={p} data-testid={`cron-editor-who-${p}`} aria-pressed={who === p} onClick={() => setWho(p)}
                  className={cn('flex h-8 items-center gap-1.5 rounded-full border py-0.5 pl-1 pr-2.5 text-[12.5px] transition', who === p ? 'border-me bg-me/10 font-medium text-me' : 'border-line text-fg-2 hover:bg-hover hover:text-fg')}>
                  <Avatar id={p} size={22} status={false} mood="idle" />{people[p].name}
                </button>
              ))}
            </div>
          </Field>
        </div>

        <Field label="什么时候醒">
          <Segmented testid="cron-editor-kind" value={kind} options={KINDS} onChange={setKind} />
          <div className="mt-3 rounded-xl border border-line bg-side p-3.5">
            {kind === 'cron' && (
              <div data-testid="cron-editor-cron">
                <div className="flex flex-wrap gap-1.5">
                  {CRON_PRESETS.map((p) => (
                    <button type="button" key={p.id} data-testid={`cron-preset-${p.id}`} aria-pressed={activePreset === p.id} onClick={() => { setExpr(p.expr); setCustom(false) }}
                      className={cn('h-7 rounded-full border px-3 text-[12.5px] transition', activePreset === p.id ? 'border-fg/50 bg-elev font-medium text-fg shadow-sm' : 'border-line text-fg-2 hover:bg-hover hover:text-fg')}>{p.label}</button>
                  ))}
                  <button type="button" data-testid={`cron-preset-${CUSTOM_PRESET}`} aria-pressed={activePreset === CUSTOM_PRESET} onClick={() => { setCustom(true); exprRef.current?.focus(); exprRef.current?.select() }}
                    className={cn('h-7 rounded-full border px-3 text-[12.5px] transition', activePreset === CUSTOM_PRESET ? 'border-fg/50 bg-elev font-medium text-fg shadow-sm' : 'border-dashed border-line text-fg-2 hover:bg-hover hover:text-fg')}>自定义</button>
                </div>
                <div className={cn('mt-3 flex items-center gap-3 rounded-lg border bg-bg pl-3 pr-3 transition', parsed.ok ? 'border-line focus-within:border-fg-3' : 'border-err')}>
                  <span className="shrink-0 text-[11.5px] text-fg-3">cron</span>
                  <input ref={exprRef} data-testid="cron-editor-expr" value={expr} spellCheck={false} aria-invalid={!parsed.ok}
                    onChange={(e) => { setExpr(e.target.value); setCustom(false) }}
                    className="h-10 min-w-0 flex-1 bg-transparent font-mono text-[15px] tracking-wide outline-none" />
                  {parsed.ok && <span data-testid="cron-editor-desc" className="shrink-0 truncate text-[13px] font-medium text-fg">{describeCron(expr)}</span>}
                </div>
                {/* 逐段尺子：每段的写法对着它的名字，哪段错了哪段红 */}
                <div className="mt-2 grid grid-cols-5 gap-1.5" aria-hidden>
                  {CRON_FIELDS.map((f, i) => (
                    <div key={f.name} data-testid={`cron-editor-field-${i + 1}`} data-bad={badField === i + 1 || undefined}
                      className={cn('rounded-md px-1.5 py-1 text-center transition', badField === i + 1 ? 'bg-err-soft text-err ring-1 ring-err/40' : 'bg-hover/70 text-fg-2')}>
                      <div className="truncate font-mono text-[12.5px]">{tokens[i] ?? '·'}</div>
                      <div className="text-[10.5px] opacity-80">{f.name} {f.min}–{f.max}</div>
                    </div>
                  ))}
                </div>
                {!parsed.ok ? (
                  <div data-testid="cron-editor-error" role="alert" className="mt-2.5 flex items-start gap-1.5 text-[12.5px] text-err"><AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />{parsed.error.message}</div>
                ) : (
                  <div className="mt-2.5 flex items-baseline gap-2 text-[12.5px]">
                    <span className="shrink-0 text-fg-3">接下来</span>
                    <div data-testid="cron-preview" className="flex min-w-0 flex-wrap gap-1">
                      {upcoming.map((d, i) => <span key={d.getTime()} data-testid={`cron-preview-${i}`} className="rounded-md bg-elev px-1.5 py-px tabular-nums text-fg-2 ring-1 ring-line">{formatRunAt(d, now)}</span>)}
                    </div>
                  </div>
                )}
                <div data-testid="cron-editor-zone" className="mt-2 text-[11.5px] text-fg-3">按本地时间算 · {zone}</div>
              </div>
            )}
            {kind === 'once' && (
              <div data-testid="cron-editor-once-box">
                <input data-testid="cron-editor-once" type="datetime-local" value={onceAt} min={toLocalDateTime(now)} onChange={(e) => setOnceAt(e.target.value)} className={cn(inputCls, 'h-10 w-auto font-mono', tErr && 'border-err')} />
                {tErr ? <div data-testid="cron-editor-error" role="alert" className="mt-2 flex items-center gap-1.5 text-[12.5px] text-err"><AlertCircle className="h-3.5 w-3.5" />{tErr}</div>
                  : <div className="mt-2 text-[12.5px] text-fg-2">将在 <span data-testid="cron-preview-0" className="font-medium text-fg">{formatRunAt(parseLocalDateTime(onceAt)!, now)}</span> 醒来一次，跑完自动停用</div>}
                <div className="mt-2 text-[11.5px] text-fg-3">按本地时间算 · {zone}</div>
              </div>
            )}
            {kind === 'messages' && (
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-2">
                会话里每有
                <input data-testid="cron-editor-n" type="number" min={1} max={1000} value={Number.isNaN(n) ? '' : n} onChange={(e) => setN(e.target.valueAsNumber)} className={cn(inputCls, 'h-8 w-20 px-2 text-center font-mono', tErr && 'border-err')} />
                条新消息醒一次（只数人和助手说的话）
                {tErr && <div data-testid="cron-editor-error" role="alert" className="flex w-full items-center gap-1.5 text-[12.5px] text-err"><AlertCircle className="h-3.5 w-3.5" />{tErr}</div>}
              </div>
            )}
            {kind === 'event' && (
              <div className="space-y-2">
                {sources.length === 0 ? (
                  <div className="text-[12.5px] text-fg-3">这个会话还没挂数据源插件。先到「插件」里把来源挂到这个会话，再回来选。</div>
                ) : (
                  <select data-testid="cron-editor-source" value={source} onChange={(e) => setSource(e.target.value)} className={cn(inputCls, 'h-9 px-2')}>
                    <option value="" disabled>哪个插件报来的事</option>
                    {sources.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.desc}</option>)}
                  </select>
                )}
                <input data-testid="cron-editor-cond" value={cond} onChange={(e) => setCond(e.target.value)} placeholder="满足什么条件才叫醒它，比如「CVSS ≥ 9 且命中本项目依赖」" className={cn(inputCls, 'h-9')} />
                {tErr && <div data-testid="cron-editor-error" role="alert" className="flex items-center gap-1.5 text-[12.5px] text-err"><AlertCircle className="h-3.5 w-3.5" />{tErr}</div>}
                <div className="text-[11.5px] text-fg-3">插件只负责把事报过来，判断要不要开口的仍是这位助手</div>
              </div>
            )}
          </div>
        </Field>

        <Field label="什么时候开口">
          <Segmented testid="cron-editor-speak" value={speak} options={[{ k: 'always', label: '每次都发结果' }, { k: 'only-if', label: '有情况才说' }]} onChange={setSpeak} />
          <div className="mt-1.5 text-[12px] text-fg-3">{speak === 'always' ? '每次醒来都在会话里发一条结果' : '看过没情况就不说话，只记进运行历史'}</div>
        </Field>

        {g?.kind === 'group' && (g.notices?.length ?? 0) > 0 && (
          <div data-testid="cron-editor-notices" className="flex items-start gap-2 rounded-lg bg-hover/60 px-3 py-2 text-[12px] leading-relaxed text-fg-2">
            <Megaphone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-3" />
            <span>醒来时先装配「{g.title}」当前的 {g.notices!.length} 条群公告（{g.notices!.map((x) => `v${x.ver}`).join(' · ')}）。公告改了，下次醒来就按新版本做，不用重建定时。</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-line px-5 py-3">
        <label className="flex items-center gap-2 text-[13px] text-fg-2"><Switch data-testid="cron-editor-on" checked={on} onCheckedChange={setOn} />{on ? '开启' : '先不开'}</label>
        <span className="flex-1" />
        {missing && <span data-testid="cron-editor-missing" className="text-[12px] text-fg-3">{missing}</span>}
        <button type="button" data-testid="cron-editor-cancel" onClick={onClose} className="h-9 rounded-lg px-3.5 text-[13px] text-fg-2 hover:bg-hover hover:text-fg">取消</button>
        <button type="submit" data-testid="cron-editor-save" disabled={!ok} className="h-9 rounded-lg bg-btn px-4 text-[13px] font-medium text-btn-fg transition disabled:cursor-not-allowed disabled:opacity-35">保存</button>
      </div>
    </form>
  )
}
