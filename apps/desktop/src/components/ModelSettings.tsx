/* ============ 模型配置（D07.4 规则 1/2/5/6、U93、U92；验收 R-17、AC-32、AC-51） ============
   全软件只在两处改模型：设置页「默认」一节（GlobalModelDefaults + 批量替换）和联系人工作台「设置」页签（ContactModelSettings）。
   判定全部来自 @g-group/ui-core 的纯函数：生效值和继承链、三时机同一个兼容判定、改全局默认的影响预检、批量替换预览。
   不兼容一律阻断并给两条修复路径，界面上没有任何「自动换一个能用的」分支。 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowRight, ArrowRightLeft, Check, ChevronDown, ChevronRight, Undo2 } from 'lucide-react'
import {
  applyFix, checkStall, confirmReplace, DEFAULTS_KEY, gateCompute, nextTurn, planDefaults, planReplace, resolveCompute, resolveSpeaking, resolveStall,
  taskModels, vendorOf,
  type Change, type ContactModels, type Fix, type Mismatch, type ModelSlot, type NextTurn, type Resolution, type Resolved, type StallOverride,
} from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { people, type Person, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  EFFORT_LIST, HARNESS_LIST, MODE_LABEL, VENDOR_LABEL, harnessLabel, hopParts, liveComputes, modelContacts, modelLabel, modelOption, snapshotOfCompute, toContactModels,
  type ModelSettings,
} from '@/modelConfig'

/* ---------------------------------------------------------------- 小部件 */

function Pick({ value, onChange, children, testid, invalid, className, label }: { value: string; onChange: (v: string) => void; children: ReactNode; testid: string; invalid?: boolean; className?: string; label: string }) {
  return (
    <span className={cn('relative inline-flex min-w-0', className)}>
      <select aria-label={label} data-testid={testid} value={value} onChange={(e) => onChange(e.target.value)}
        className={cn('h-8 w-full min-w-0 appearance-none truncate rounded-lg border bg-bg pl-2.5 pr-7 text-[13px] outline-none transition hover:border-fg-3/60 focus:ring-2 focus:ring-ring', invalid ? 'border-err text-err' : 'border-line text-fg')}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
    </span>
  )
}

/** 一条继承链：每一跳「来自哪里」，最后一跳的取值就是生效值 */
function Chain({ r, testid }: { r: Resolved; testid: string }) {
  return (
    <span data-testid={testid} className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
      {r.chain.map((h, i) => {
        const { where, value } = hopParts(h)
        return (
          <Fragment key={i}>
            {i > 0 && <ArrowRight className="h-3 w-3 shrink-0 text-fg-3" />}
            <span className="text-fg-2">{where}</span>
            {value !== undefined && <code className={cn('rounded-md px-1.5 py-px font-mono text-[11.5px]', i === r.chain.length - 1 ? 'bg-bg text-fg ring-1 ring-line' : 'text-fg-2')}>{value}</code>}
          </Fragment>
        )
      })}
    </span>
  )
}

const mismatchText = (m: Mismatch, s: ModelSettings) =>
  m.reason === 'unknown-model' ? (m.model ? `模型目录里没有「${m.model}」` : '还没选模型')
  : `${harnessLabel(m.harness)} 这个 Harness 跑不了 ${modelLabel(m.model, s)}`

/**
 * 失配就地红字 + 两条修复路径。路径一「单独指定兼容模型」：候选是这个 Harness 支持的模型（推荐项在前）；
 * 路径二「换 Harness」：支持这个模型的 Harness。没有可行的那条直接说明为什么没有，不藏起来。
 */
function MismatchFix({ m, s, prefer, onPin, onHarness, testid, compact }: { m: Mismatch; s: ModelSettings; prefer?: string; onPin: (model: string) => void; onHarness: (h: string) => void; testid: string; compact?: boolean }) {
  const first = prefer && m.compatibleModels.includes(prefer) ? prefer : m.compatibleModels[0]
  const [pick, setPick] = useState(first ?? '')
  useEffect(() => { setPick(first ?? '') }, [first, m.model, m.harness])
  const h = m.supportingHarnesses[0]
  return (
    <div data-testid={testid} role="alert" className={cn('rounded-lg border border-err/30 bg-err-soft text-[12.5px]', compact ? 'p-2.5' : 'p-3')}>
      <div className="flex items-start gap-1.5 font-medium text-err">
        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
        <span data-testid={`${testid}-text`}>{mismatchText(m, s)}，不会自动换成别的模型。选一条修好再保存：</span>
      </div>
      <div className={cn('mt-2 flex gap-2', compact ? 'flex-col' : 'flex-wrap items-center')}>
        {first ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <button data-testid={`${testid}-pin`} onClick={() => onPin(pick)} className="h-8 shrink-0 rounded-lg bg-btn px-3 text-[12.5px] font-medium text-btn-fg hover:opacity-90">单独指定兼容模型</button>
            <Pick label="兼容的模型" testid={`${testid}-pin-model`} value={pick} onChange={setPick} className="w-[190px]">
              {m.compatibleModels.map((id) => <option key={id} value={id}>{modelLabel(id, s)}</option>)}
            </Pick>
          </div>
        ) : <span className="text-fg-2">{harnessLabel(m.harness)} 上没有能用的模型</span>}
        {h ? (
          <button data-testid={`${testid}-harness`} onClick={() => onHarness(h)} className="h-8 shrink-0 self-start rounded-lg border border-line bg-bg px-3 text-[12.5px] font-medium text-fg hover:bg-hover">换 Harness 为 {harnessLabel(h)}</button>
        ) : <span data-testid={`${testid}-noharness`} className="text-fg-2">{m.reason === 'unknown-model' ? '' : `没有 Harness 能跑 ${modelLabel(m.model, s)}（它只能用来说话）`}</span>}
      </div>
    </div>
  )
}

const slotText = (slot: ModelSlot) => (slot.mode === 'explicit' ? `单独指定 ${slot.model ?? '（没填）'}` : MODE_LABEL[slot.mode])
const sameSlot = (a: ModelSlot, b: ModelSlot) => a.mode === b.mode && (a.mode !== 'explicit' || a.model === b.model) && a.effort === b.effort
const cleanSlot = (mode: ModelSlot['mode'], model: string | undefined, effort: string | undefined): ModelSlot =>
  ({ mode, ...(mode === 'explicit' && model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) })

/* ================================================================ 联系人工作台 · 设置 · 模型 */

interface Draft { speakingModel: string; harness: string; computeModel: ModelSlot; quota: number; stall: StallOverride | null }
const fromPerson = (p: Person): Draft => ({ speakingModel: p.model ?? '', harness: p.harness ?? 'claude-code', computeModel: p.computeModel ?? { mode: 'inherit' }, quota: p.computeQuota ?? 1, stall: p.stall ?? null })
const sameStall = (a: StallOverride | null, b: StallOverride | null) => (a === null || b === null ? a === b : a.turnMinutes === b.turnMinutes && a.firstByteSeconds === b.firstByteSeconds)
const sameDraft = (a: Draft, b: Draft) => a.speakingModel === b.speakingModel && a.harness === b.harness && sameSlot(a.computeModel, b.computeModel) && a.quota === b.quota && sameStall(a.stall, b.stall)
const asContact = (id: PersonId, d: Draft): ContactModels => ({ id, name: people[id]?.name ?? id, speakingModel: d.speakingModel, harness: d.harness, computeModel: d.computeModel })

function changeNote(b: Draft, a: Draft, s: ModelSettings): string {
  const out: string[] = []
  if (b.speakingModel !== a.speakingModel) out.push(`说话模型 ${b.speakingModel} → ${a.speakingModel}`)
  if (b.harness !== a.harness) out.push(`Compute Harness ${harnessLabel(b.harness)} → ${harnessLabel(a.harness)}`)
  if (b.computeModel.mode !== a.computeModel.mode || (a.computeModel.mode === 'explicit' && b.computeModel.model !== a.computeModel.model)) out.push(`Compute 模型 ${slotText(b.computeModel)} → ${slotText(a.computeModel)}`)
  if (b.computeModel.effort !== a.computeModel.effort) out.push(`effort ${b.computeModel.effort ?? `跟全局（${s.defaultEffort}）`} → ${a.computeModel.effort ?? `跟全局（${s.defaultEffort}）`}`)
  if (b.quota !== a.quota) out.push(`最多同时 ${a.quota} 个 Compute`)
  if (!sameStall(b.stall, a.stall)) { const r = resolveStall(a.stall ?? undefined); out.push(`卡死判定 ${r.turnMinutes.value} 分钟 / 首字节 ${r.firstByteSeconds.value} 秒${a.stall ? '（单独设）' : '（默认）'}`) }
  return out.join('；')
}

const Lbl = ({ children, sub }: { children: ReactNode; sub?: ReactNode }) => (
  <div className="min-w-0 flex-1"><div className="text-[13.5px]">{children}</div>{sub && <div className="text-[11.5px] leading-snug text-fg-3">{sub}</div>}</div>
)

export function ContactModelSettings({ id }: { id: PersonId }) {
  const { modelSettings: s, modelsRev, saveModels, computes } = useApp()
  const p = people[id]
  const [base, setBase] = useState<Draft>(() => fromPerson(p))
  const [draft, setDraft] = useState<Draft>(base)
  const [notice, setNotice] = useState<NextTurn | null>(null)
  const [adv, setAdv] = useState(!!p.stall)
  /* 别处（全局默认、批量替换）保存过：没改动就跟上新值 */
  useEffect(() => {
    const cur = fromPerson(people[id])
    if (!sameDraft(cur, base)) { setBase(cur); setDraft(cur) }
  }, [modelsRev, id]) // 只在保存过或换了联系人时对一次，不跟着 base 自己变

  const cm = asContact(id, draft)
  const gate = gateCompute('save', cm, s)
  const speaking = resolveSpeaking(cm)
  const compute = gate.compute
  const dirty = !sameDraft(draft, base)
  const stallErr = draft.stall ? checkStall(draft.stall) : null
  const canSave = dirty && gate.allowed && !stallErr
  const running = liveComputes(computes, id)
  const set = (patch: Partial<Draft>) => { setDraft((d) => ({ ...d, ...patch })); setNotice(null) }
  const setSlot = (mode: ModelSlot['mode'], model?: string) => set({ computeModel: cleanSlot(mode, model, draft.computeModel.effort) })
  const fix = (f: Fix) => { const c = applyFix(cm, f); set({ harness: c.harness, computeModel: c.computeModel }) }
  const save = () => {
    if (!canSave) return
    const nt = nextTurn(asContact(id, base), cm, s, running.length)
    const note = changeNote(base, draft, s) + (nt ? '，下一轮生效' : '')
    saveModels({ contacts: [{ id, patch: { model: draft.speakingModel, harness: draft.harness, computeModel: draft.computeModel, computeQuota: draft.quota, stall: draft.stall ?? undefined }, note }] })
    setBase(draft)
    setNotice(nt)
  }
  const prevModel = resolveCompute(asContact(id, base), s).model.value
  const stall = resolveStall(draft.stall ?? undefined)
  const modes: ModelSlot['mode'][] = ['inherit', 'follow-speaking', 'explicit']
  const modeHint: Record<ModelSlot['mode'], string> = {
    inherit: `用全局默认 Compute 模型，现在是 ${modelLabel(s.defaultComputeModel, s)}`,
    'follow-speaking': `和说话模型一样，现在是 ${modelLabel(draft.speakingModel, s)}`,
    explicit: '另选一个具体模型',
  }

  return (
    <section data-testid="cm-card" className="rounded-xl bg-hover/60 p-4">
      <div className="mb-3 flex items-baseline gap-2">
        <h3 className="flex-1 text-[13px] font-semibold text-fg">模型</h3>
        <span className="text-[11.5px] text-fg-3">只在这里和设置页「默认」改模型</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* ---- 左：配置 ---- */}
        <div className="min-w-0 space-y-3">
          <div className="flex items-center gap-3">
            <Lbl sub="在群里聊天、判断要不要接活。说话不选 Harness">说话模型</Lbl>
            <Pick label="说话模型" testid="cm-talk" value={draft.speakingModel} onChange={(v) => set({ speakingModel: v })} className="w-[230px]">
              {s.models.map((m) => <option key={m.id} value={m.id}>{m.label} · {VENDOR_LABEL[m.vendor] ?? m.vendor}</option>)}
            </Pick>
          </div>
          <div className="border-t border-line pt-3">
            <div className="mb-2 text-[12px] font-medium text-fg-3">Compute（干活）</div>
            <div className="space-y-2.5">
              <div className="flex items-center gap-3">
                <Lbl>Harness</Lbl>
                <Pick label="Compute Harness" testid="cm-harness" value={draft.harness} onChange={(v) => set({ harness: v })} className="w-[230px]">
                  {HARNESS_LIST.map((h) => <option key={h} value={h}>{harnessLabel(h)}</option>)}
                </Pick>
              </div>
              <div>
                <div className="mb-1.5 text-[13.5px]">模型</div>
                <div role="radiogroup" aria-label="Compute 模型从哪来" className="overflow-hidden rounded-lg bg-bg ring-1 ring-line [&>*+*]:border-t [&>*+*]:border-line">
                  {modes.map((m) => {
                    const on = draft.computeModel.mode === m
                    return (
                      <button key={m} role="radio" aria-checked={on} data-testid={`cm-mode-${m}`}
                        onClick={() => { if (!on) setSlot(m, m === 'explicit' ? compute.model.value || s.defaultComputeModel : undefined) }}
                        className={cn('flex w-full items-center gap-2.5 px-3 py-2 text-left transition', on ? 'bg-sel/70' : 'hover:bg-hover')}>
                        <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded-full border', on ? 'border-fg' : 'border-fg-3')}>{on && <span className="h-2 w-2 rounded-full bg-fg" />}</span>
                        <span className={cn('w-[88px] shrink-0 text-[13px]', on ? 'font-semibold text-fg' : 'text-fg')}>{MODE_LABEL[m]}</span>
                        <span className="min-w-0 truncate text-[12px] text-fg-3">{modeHint[m]}</span>
                      </button>
                    )
                  })}
                </div>
                {draft.computeModel.mode === 'explicit' && (
                  <div className="mt-2 flex items-center gap-3">
                    <Lbl sub="后面写着它能在哪些 Harness 上跑">指定的模型</Lbl>
                    <Pick label="单独指定的 Compute 模型" testid="cm-model" value={draft.computeModel.model ?? ''} onChange={(v) => setSlot('explicit', v)} invalid={!gate.allowed} className="w-[230px]">
                      {s.models.map((m) => <option key={m.id} value={m.id}>{modelOption(m.id, s)}</option>)}
                    </Pick>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                <Lbl sub="跟着这个槽位走；跟随说话模型时也可以单独设">effort</Lbl>
                <Pick label="Compute effort" testid="cm-effort" value={draft.computeModel.effort ?? ''} onChange={(v) => set({ computeModel: cleanSlot(draft.computeModel.mode, draft.computeModel.model, v || undefined) })} className="w-[230px]">
                  <option value="">跟全局（{s.defaultEffort}）</option>
                  {EFFORT_LIST.map((e) => <option key={e} value={e}>{e}</option>)}
                </Pick>
              </div>
              <div className="flex items-center gap-3" data-testid="cm-quota">
                <Lbl>最多同时分几个 Compute · {draft.quota} 个</Lbl>
                <div className="w-[230px] px-1"><Slider value={[draft.quota]} min={1} max={5} step={1} onValueChange={(v) => set({ quota: v[0] })} /></div>
              </div>
            </div>
          </div>
          {gate.mismatch && (
            <MismatchFix testid="cm-mismatch" m={gate.mismatch} s={s} prefer={prevModel}
              onPin={(model) => fix({ kind: 'pin-model', contactId: id, model })} onHarness={(h) => fix({ kind: 'switch-harness', contactId: id, harness: h })} />
          )}
        </div>

        {/* ---- 右：生效值与继承链 ---- */}
        <div className="min-w-0 self-start rounded-lg bg-bg p-3 ring-1 ring-line" data-testid="cm-effective">
          <div data-testid="cm-effective-title" className="mb-2 text-[12px] font-medium text-fg-3">{dirty ? '保存后，下一轮会用' : '按现在的配置，下一轮会用'}</div>
          <div className="space-y-2.5 text-[12.5px]">
            <div>
              <div data-testid="cm-speaking-summary" className="font-medium">说话 → <code className="font-mono text-[12px]">{speaking.value || '（没填）'}</code></div>
              <div className="mt-0.5 pl-3 text-[12px]"><Chain r={speaking} testid="chain-speaking" /></div>
            </div>
            <div>
              <div data-testid="cm-summary" className={cn('font-medium', !gate.allowed && 'text-err')}>
                Compute → {MODE_LABEL[compute.mode]} → <code className="font-mono text-[12px]">{compute.model.value || '（没填）'} · {compute.harness.value} · {compute.effort.value}</code>
              </div>
              <div className="mt-1 space-y-1 pl-3 text-[12px]">
                {([['模型', compute.model, 'chain-model'], ['Harness', compute.harness, 'chain-harness'], ['effort', compute.effort, 'chain-effort']] as const).map(([l, r, t]) => (
                  <div key={t} className="flex items-start gap-2"><span className="w-[52px] shrink-0 pt-px text-fg-3">{l}</span><Chain r={r} testid={t} /></div>
                ))}
              </div>
            </div>
            {!gate.allowed && <div data-testid="cm-blocked" className="text-[12px] text-err">这样配，下次开 Compute 会被拦下；{p.name} 在群里说话不受影响。</div>}
            {gate.allowed && <div className="text-[12px] text-fg-3">复核要换一家：{p.name} 的产出会交给不是 {VENDOR_LABEL[vendorOf(compute.model.value, s.models)] ?? vendorOf(compute.model.value, s.models)} 的模型复核。</div>}
            {running.length > 0 && (() => {
              const drift = new Set(running.flatMap((c) => taskModels(snapshotOfCompute(c, s), cm, s).drift.filter((f) => f !== 'effort'))) // 演示数据的 Compute 没记 effort
              return (
                <div data-testid="cm-running" className="border-t border-line pt-2">
                  <div className="mb-1 text-[12px] font-medium text-fg-3">在跑的任务实际在用（启动时记下，不追溯）</div>
                  <div className="space-y-0.5">
                    {running.map((c) => (
                      <div key={c.id} data-testid={`cm-running-${c.id}`} className="flex items-baseline gap-1.5 text-[12px]">
                        <span className="min-w-0 truncate font-medium">「{c.short ?? c.title}」</span>
                        <span className="shrink-0 text-fg-2">{c.model} · {c.harness}</span>
                      </div>
                    ))}
                  </div>
                  {gate.allowed && drift.size > 0 && (
                    <div data-testid="cm-running-next" className="mt-1 text-[12px] text-warm">
                      {dirty ? '保存后，' : ''}{running.length > 1 ? `这 ${running.length} 个任务` : '它'}这一轮照常跑完，下一轮起用 <code className="font-mono">{compute.model.value} · {compute.harness.value}</code>
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        </div>
      </div>

      {/* ---- 高级：卡死判定（U92） ---- */}
      <div className="mt-3 border-t border-line pt-2">
        <button data-testid="cm-adv" onClick={() => setAdv((v) => !v)} className="flex items-center gap-1 rounded-md py-1 text-[12.5px] font-medium text-fg-2 hover:text-fg">
          {adv ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}高级 · 卡死判定
          <span className="ml-1 font-normal text-fg-3">一轮 {stall.turnMinutes.value} 分钟无进展判失败 · 首字节等 {stall.firstByteSeconds.value} 秒{draft.stall ? '（单独设）' : '（默认）'}</span>
        </button>
        {adv && (
          <div data-testid="cm-stall" className="mt-1 space-y-2 pl-5">
            <p className="text-[12px] leading-relaxed text-fg-3">一轮多久没有新进展就判失败，失败卡上写清原因，你可以自己换上游；模型调用发出后多久还没收到第一个字，算上游没回应。等你回答、工具在跑的时间不算。</p>
            <div className="flex items-center gap-3">
              <Lbl sub={draft.stall ? '只对它生效' : '默认 15 分钟 / 120 秒'}>为 {p.name} 单独设</Lbl>
              <Switch data-testid="stall-own" checked={!!draft.stall} onCheckedChange={(v) => set({ stall: v ? { turnMinutes: stall.turnMinutes.value, firstByteSeconds: stall.firstByteSeconds.value } : null })} />
            </div>
            {draft.stall && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
                <label className="flex items-center gap-2">一轮无进展
                  <input data-testid="stall-turn" type="number" min={1} value={Number.isFinite(draft.stall.turnMinutes) ? draft.stall.turnMinutes : ''} onChange={(e) => set({ stall: { ...draft.stall, turnMinutes: e.target.value === '' ? Number.NaN : Number(e.target.value) } })}
                    className="h-8 w-20 rounded-lg border border-line bg-bg px-2 text-right font-mono text-[13px] outline-none focus:ring-2 focus:ring-ring" />分钟
                </label>
                <label className="flex items-center gap-2">首字节等待
                  <input data-testid="stall-first" type="number" min={1} value={Number.isFinite(draft.stall.firstByteSeconds) ? draft.stall.firstByteSeconds : ''} onChange={(e) => set({ stall: { ...draft.stall, firstByteSeconds: e.target.value === '' ? Number.NaN : Number(e.target.value) } })}
                    className="h-8 w-20 rounded-lg border border-line bg-bg px-2 text-right font-mono text-[13px] outline-none focus:ring-2 focus:ring-ring" />秒
                </label>
              </div>
            )}
            {stallErr && <div data-testid="stall-error" className="text-[12px] text-err">{stallErr}</div>}
          </div>
        )}
      </div>

      {/* ---- 保存 ---- */}
      {(dirty || notice) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {dirty ? (
            <>
              <span className={cn('flex-1 text-[12.5px]', gate.allowed && !stallErr ? 'text-fg-2' : 'text-err')} data-testid="cm-save-hint">
                {!gate.allowed ? '模型和 Harness 对不上，修好才能保存' : stallErr ? '卡死判定的数不对，改好才能保存' : '改了还没保存'}
              </span>
              <button data-testid="cm-revert" onClick={() => { setDraft(base); setNotice(null) }} className="flex h-8 items-center gap-1 rounded-lg px-3 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg"><Undo2 className="h-3.5 w-3.5" />还原</button>
              <button data-testid="cm-save" disabled={!canSave} onClick={save} className="h-8 rounded-lg bg-btn px-4 text-[12.5px] font-medium text-btn-fg hover:opacity-90 disabled:cursor-not-allowed disabled:bg-hover disabled:text-fg-3">保存</button>
            </>
          ) : notice && <NextTurnNote n={notice} s={s} c={cm} name={p.name} running={running.map((c) => `${c.model} · ${c.harness}`)} />}
        </div>
      )}
    </section>
  )
}

/** U93：改了下一轮就生效，正在跑的这一轮不打断 */
function NextTurnNote({ n, s, c, name, running }: { n: NextTurn; s: ModelSettings; c: ContactModels; name: string; running: string[] }) {
  const r = resolveCompute(c, s)
  return (
    <div data-testid="next-turn" className="flex flex-1 items-start gap-2 rounded-lg bg-run-soft px-3 py-2 text-[12.5px]">
      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-run" />
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium">已保存，下一轮生效，不用再手动切。</div>
        {n.speaking && <div className="text-fg-2">{name} 下一次说话用 <code className="font-mono">{resolveSpeaking(c).value}</code></div>}
        {n.compute.length > 0 && <div className="text-fg-2">Compute 下一次输入用 <code className="font-mono">{r.model.value} · {r.harness.value} · {r.effort.value}</code></div>}
        {n.harnessSwitch && <div className="text-fg-2">换了 Harness：下一轮在 {harnessLabel(r.harness.value)} 上开新会话，之前的任务和约束由软件带过去。</div>}
        <div className="text-fg-2">{n.running > 0 ? `正在跑的 ${n.running} 个任务这一轮不打断，按启动时的 ${[...new Set(running)].join('、')} 跑完。` : '正在跑的这一轮不打断。现在没有在跑的。'}</div>
      </div>
    </div>
  )
}

/* ================================================================ 设置页 ·「默认」一节 */

const DEFAULT_FIELDS = ['defaultHarness', 'defaultSpeakingModel', 'defaultComputeModel', 'defaultEffort'] as const
type DefaultField = (typeof DEFAULT_FIELDS)[number]

function Line({ label, sub, children, testid }: { label: ReactNode; sub?: ReactNode; children?: ReactNode; testid?: string }) {
  return (
    <div data-testid={testid} className="flex min-h-11 items-center gap-3 px-4 py-1.5">
      <div className="min-w-0 flex-1"><div className="text-[14px]">{label}</div>{sub && <div className="text-[11.5px] leading-snug text-fg-3">{sub}</div>}</div>
      {children}
    </div>
  )
}

const fixLabel = (f: Fix, s: ModelSettings) => (f.kind === 'pin-model' ? `单独指定 ${modelLabel(f.model, s)}` : `换 Harness 为 ${harnessLabel(f.harness)}`)

export function GlobalModelDefaults() {
  const { modelSettings: s, modelsRev, saveModels, openWorkbench } = useApp()
  const [draft, setDraft] = useState<ModelSettings>(s)
  const [fixes, setFixes] = useState<Fix[]>([])
  const [savedN, setSavedN] = useState<number | null>(null)
  const [batch, setBatch] = useState(false)
  const impactRef = useRef<HTMLDivElement>(null)
  useEffect(() => { setDraft(s); setFixes([]) }, [modelsRev]) // 任何一处保存过都从新的全局默认重新开始

  const contacts = modelContacts().map(toContactModels)
  const plan = planDefaults(contacts, s, draft, fixes)
  const changed = DEFAULT_FIELDS.filter((k) => draft[k] !== s[k])
  const dirty = changed.length > 0 || fixes.length > 0
  /* 一改就把影响预览滚进视野，不让用户以为改完就生效了 */
  useEffect(() => { if (dirty) impactRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [dirty])
  const setField = (k: DefaultField, v: string) => { setDraft((d) => ({ ...d, [k]: v })); setSavedN(null) }
  const addFix = (f: Fix) => setFixes((fs) => [...fs.filter((x) => x.contactId !== f.contactId), f])
  const cancel = () => { setDraft(s); setFixes([]) }
  const save = () => {
    if (!plan.canSave) return
    const settings: Partial<ModelSettings> = Object.fromEntries(changed.map((k) => [k, draft[k]]))
    const why = changed.map((k) => `${{ defaultHarness: '默认 Harness', defaultSpeakingModel: '默认说话模型', defaultComputeModel: '默认 Compute 模型', defaultEffort: '默认 effort' }[k]}改成 ${draft[k]}`).join('、')
    saveModels({
      settings,
      contacts: plan.patched.map((c) => {
        const f = fixes.find((x) => x.contactId === c.id)!
        return { id: c.id, patch: { harness: c.harness, computeModel: c.computeModel }, note: `${why || '全局默认改动'}时为它${fixLabel(f, s)}，下一轮生效` }
      }),
      toast: '全局默认已保存',
    })
    setSavedN(plan.affected.length)
  }
  const name = (id: string) => people[id]?.name ?? id
  const sel = 'w-[168px]'

  return (
    <>
      <div className="mx-3 mb-3" data-testid="model-defaults">
        <div className="flex items-center px-1 pb-1.5 pt-2 text-[12px] font-medium text-fg-3"><span className="flex-1">默认</span></div>
        <div className="overflow-hidden rounded-xl bg-hover/60 [&>*+*]:border-t [&>*+*]:border-line">
          <Line label="默认 Compute 模型" sub={`继承全局的联系人用它（${(s.models.find((m) => m.id === draft.defaultComputeModel)?.harnesses ?? []).map(harnessLabel).join(' / ') || '没有 Harness'} 能跑）`}>
            <Pick label="默认 Compute 模型" testid="def-compute" value={draft.defaultComputeModel} onChange={(v) => setField('defaultComputeModel', v)} className={sel} invalid={!!plan.defaultsMismatch}>
              {s.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </Pick>
          </Line>
          <Line label="默认 effort" sub="没单独设 effort 的联系人用它">
            <Pick label="默认 effort" testid="def-effort" value={draft.defaultEffort} onChange={(v) => setField('defaultEffort', v)} className={sel}>
              {EFFORT_LIST.map((e) => <option key={e} value={e}>{e}</option>)}
            </Pick>
          </Line>
          <Line label="默认 Harness" sub="新建联系人的 Compute 用它">
            <Pick label="默认 Harness" testid="def-harness" value={draft.defaultHarness} onChange={(v) => setField('defaultHarness', v)} className={sel} invalid={!!plan.defaultsMismatch}>
              {HARNESS_LIST.map((h) => <option key={h} value={h}>{harnessLabel(h)}</option>)}
            </Pick>
          </Line>
          <Line label="默认说话模型" sub="新建联系人说话用它">
            <Pick label="默认说话模型" testid="def-talk" value={draft.defaultSpeakingModel} onChange={(v) => setField('defaultSpeakingModel', v)} className={sel}>
              {s.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </Pick>
          </Line>
          <Line label="复核必须换一家模型"><Switch defaultChecked /></Line>
          <button data-testid="open-batch" onClick={() => setBatch(true)} className="flex min-h-11 w-full items-center gap-3 px-4 text-left text-[14px] hover:bg-hover">
            <ArrowRightLeft className="h-4 w-4 text-fg-2" /><span className="flex-1">批量替换模型</span><span className="text-[12.5px] text-fg-2">把 X 换成 Y，先预览</span><ChevronRight className="h-4 w-4 text-fg-3" />
          </button>
        </div>

        {dirty && (
          <div ref={impactRef} data-testid="defaults-impact" className="mt-2 rounded-xl border border-line bg-bg p-3 text-[12.5px]">
            <div data-testid="impact-count" className="font-semibold">{plan.affected.length ? `会影响 ${plan.affected.length} 位联系人` : '已有的联系人都不受影响'}</div>
            {plan.affected.length > 0 && <div className="mb-1.5 text-[11.5px] text-fg-3">保存后它们下一轮就用新值，正在跑的这一轮不打断</div>}
            <div className="space-y-1">
              {plan.affected.map((a) => (
                <div key={a.contactId} data-testid={`impact-row-${a.contactId}`} className={cn('rounded-lg px-2 py-1.5', a.mismatch ? 'bg-err-soft' : 'bg-hover/60')}>
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 font-medium">{a.name}</span>
                    <span className="min-w-0 truncate font-mono text-[11.5px] text-fg-2">
                      {a.changed.map((f) => `${a.before[f].value} → ${a.after[f].value}`).join('，')}
                    </span>
                  </div>
                  {a.mismatch && (
                    <div className="mt-1.5" data-testid={`impact-mismatch-${a.contactId}`}>
                      <div className="flex items-start gap-1 text-err"><AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />{a.name} 用 {harnessLabel(a.mismatch.harness)}，{mismatchText(a.mismatch, s)}。不会自动换，选一条：</div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {a.fixes.map((f) => (
                          <button key={f.kind} data-testid={`dfix-${f.kind === 'pin-model' ? 'pin' : 'harness'}-${a.contactId}`} onClick={() => addFix(f)}
                            className={cn('h-7 rounded-lg px-2.5 text-[12px] font-medium', f.kind === 'pin-model' ? 'bg-btn text-btn-fg hover:opacity-90' : 'border border-line bg-bg hover:bg-hover')}>
                            {fixLabel(f, s)}{f.kind === 'pin-model' && f.model === a.before.model.value ? '（保持原来的）' : ''}
                          </button>
                        ))}
                        {!a.fixes.length && <span className="text-fg-2">这个 Harness 上没有能用的模型</span>}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {fixes.length > 0 && (
              <div className="mt-2 space-y-1" data-testid="defaults-fixes">
                {fixes.map((f) => (
                  <div key={f.contactId} className="flex items-center gap-1.5 text-[12px] text-fg-2">
                    <Check className="h-3.5 w-3.5 text-run" />{name(f.contactId)}：{fixLabel(f, s)}
                    <button onClick={() => setFixes((fs) => fs.filter((x) => x !== f))} className="ml-auto rounded px-1.5 text-[11.5px] text-fg-3 hover:bg-hover hover:text-fg">撤销</button>
                  </div>
                ))}
              </div>
            )}
            {plan.defaultsMismatch && (
              <div className="mt-2">
                <MismatchFix compact testid="defaults-combo" m={plan.defaultsMismatch} s={s} prefer={s.defaultComputeModel}
                  onPin={(m) => setField('defaultComputeModel', m)} onHarness={(h) => setField('defaultHarness', h)} />
              </div>
            )}
            {plan.newContactsOnly.length > 0 && <div data-testid="impact-new-only" className="mt-2 text-[11.5px] text-fg-3">{plan.newContactsOnly.map((k) => (k === 'defaultHarness' ? '默认 Harness' : '默认说话模型')).join('、')}只用于之后新建的联系人，已有联系人各自存了自己的。</div>}
            <div className="mt-3 flex items-center gap-2">
              <span className={cn('flex-1 text-[12px]', plan.canSave ? 'text-fg-3' : 'text-err')}>{plan.canSave ? '' : `还有 ${plan.mismatched.length + (plan.defaultsMismatch ? 1 : 0)} 处对不上，修好才能保存`}</span>
              <button data-testid="defaults-cancel" onClick={cancel} className="h-8 rounded-lg px-3 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg">取消</button>
              <button data-testid="defaults-save" disabled={!plan.canSave} onClick={save} className="h-8 rounded-lg bg-btn px-4 text-[12.5px] font-medium text-btn-fg hover:opacity-90 disabled:cursor-not-allowed disabled:bg-hover disabled:text-fg-3">保存</button>
            </div>
          </div>
        )}
        {!dirty && savedN !== null && (
          <div data-testid="defaults-saved" className="mt-2 flex items-start gap-2 rounded-xl bg-run-soft px-3 py-2 text-[12.5px]">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-run" />
            <span>已保存。{savedN ? `受影响的 ${savedN} 位联系人下一轮生效，` : ''}正在跑的这一轮不打断。</span>
          </div>
        )}
      </div>

      <div className="mx-3 mb-3" data-testid="model-overview">
        <div className="flex items-center px-1 pb-1.5 pt-2 text-[12px] font-medium text-fg-3"><span className="flex-1">各联系人现在用的模型</span></div>
        <div className="overflow-hidden rounded-xl bg-hover/60 [&>*+*]:border-t [&>*+*]:border-line">
          {contacts.map((c) => {
            const r = resolveCompute(c, s)
            const ok = gateCompute('launch', c, s).allowed
            return (
              <button key={c.id} data-testid={`model-row-${c.id}`} onClick={() => openWorkbench(c.id, 'settings')} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-hover">
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium">{c.name}</div>
                  <div className="truncate font-mono text-[11.5px] text-fg-2">
                    <span data-testid={`model-row-talk-${c.id}`}>说话 {c.speakingModel}</span>
                    <span className="text-fg-3"> · </span>
                    <span data-testid={`model-row-compute-${c.id}`} className={cn(!ok && 'text-err')}>Compute {r.model.value} · {r.harness.value}</span>
                    <span className="font-sans text-fg-3">（{MODE_LABEL[c.computeModel.mode]}）</span>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-fg-3" />
              </button>
            )
          })}
        </div>
      </div>
      {batch && <BatchReplace onClose={() => setBatch(false)} />}
    </>
  )
}

/* ================================================================ 批量替换（规则 6） */

const REF_LABEL: Record<string, string> = { defaultSpeakingModel: '默认说话模型', defaultComputeModel: '默认 Compute 模型', speakingModel: '说话模型', 'computeModel.model': 'Compute（单独指定）' }

/** 把确认后的变更落成「全局默认补丁 + 每位联系人的补丁」 */
function toPatches(changes: readonly Change[], contacts: readonly ContactModels[]) {
  const settings: Partial<ModelSettings> = {}
  const byContact = new Map<string, ContactModels>()
  const notes = new Map<string, string[]>()
  for (const ch of changes) {
    if (ch.contactId === null) { (settings as Record<string, string>)[ch.field] = ch.to; continue }
    const cur = byContact.get(ch.contactId) ?? contacts.find((c) => c.id === ch.contactId)!
    let next: ContactModels = cur
    if (ch.field === 'speakingModel') next = { ...cur, speakingModel: ch.to }
    else if (ch.field === 'harness') next = { ...cur, harness: ch.to }
    else {
      const slot = { ...cur.computeModel } as { mode: ModelSlot['mode']; model?: string; effort?: string }
      if (ch.field === 'computeModel.mode') slot.mode = ch.to as ModelSlot['mode']
      if (ch.field === 'computeModel.model') { if (ch.to) slot.model = ch.to; else delete slot.model }
      if (ch.field === 'computeModel.effort') { if (ch.to) slot.effort = ch.to; else delete slot.effort }
      next = { ...cur, computeModel: slot }
    }
    byContact.set(ch.contactId, next)
    notes.set(ch.contactId, [...(notes.get(ch.contactId) ?? []), `${REF_LABEL[ch.field] ?? (ch.field === 'harness' ? 'Compute Harness' : ch.field)} ${ch.from || '（空）'} → ${ch.to || '（空）'}`])
  }
  return { settings, contacts: [...byContact.values()].map((c) => ({ c, note: (notes.get(c.id) ?? []).join('；') })) }
}

function Col({ title, n, testid, children, tone }: { title: string; n: number; testid: string; children: ReactNode; tone?: 'err' }) {
  return (
    <div data-testid={testid} className="flex min-h-[180px] min-w-0 flex-col rounded-xl bg-hover/60 p-3">
      <div className={cn('mb-2 flex items-baseline gap-1.5 text-[12.5px] font-semibold', tone === 'err' && n > 0 && 'text-err')}>{title}<span data-testid={`${testid}-n`} className="font-mono text-[12px] font-normal text-fg-3">{n}</span></div>
      <div className="space-y-1.5">{n === 0 && <div className="text-[12px] text-fg-3">没有</div>}{children}</div>
    </div>
  )
}

function BatchReplace({ onClose }: { onClose: () => void }) {
  const { modelSettings: s, computes, saveModels } = useApp()
  const contacts = modelContacts().map(toContactModels)
  const used = s.models.filter((m) => m.id === s.defaultComputeModel || m.id === s.defaultSpeakingModel || contacts.some((c) => c.speakingModel === m.id || resolveCompute(c, s).model.value === m.id))
  const [from, setFrom] = useState(used[0]?.id ?? s.models[0]!.id)
  const [to, setTo] = useState(() => s.models.find((m) => m.id !== from)!.id)
  const [res, setRes] = useState<Record<string, Resolution>>({})
  const tasks = liveComputes(computes).map((c) => ({ id: c.id, model: snapshotOfCompute(c, s).model, label: `「${c.short ?? c.title}」` }))
  const input = { contacts, defaults: s, from, to, tasks, resolutions: res }
  const plan = planReplace(input)
  const name = (id: string | null) => (id === null || id === DEFAULTS_KEY ? '全局默认' : people[id]?.name ?? id)
  const pickFrom = (v: string) => { setFrom(v); setRes({}); if (v === to) setTo(s.models.find((m) => m.id !== v)!.id) }
  const confirm = () => {
    const r = confirmReplace(input)
    if (!r.ok) return
    const { settings, contacts: patches } = toPatches(r.changes, contacts)
    saveModels({
      settings,
      contacts: patches.map(({ c, note }) => ({ id: c.id, patch: { model: c.speakingModel, harness: c.harness, computeModel: c.computeModel }, note: `批量把 ${from} 换成 ${to}：${note}，下一轮生效` })),
      toast: `已把 ${from} 换成 ${to}（${r.changes.length} 处）`,
    })
    onClose()
  }
  const resLabel = (r: Resolution) => (r.kind === 'keep' ? `保留 ${modelLabel(r.model, s)}（单独指定）` : `换 Harness 为 ${harnessLabel(r.harness)}`)
  const blockedWhy = plan.problem ?? (plan.conflicts.length ? `还有 ${plan.conflicts.length} 处冲突，先选怎么处理` : plan.explicit.length ? '' : `没有地方直接用了 ${from}`)
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent data-testid="batch-dialog" onEscapeKeyDown={(e) => e.stopPropagation()} className="max-w-[920px] gap-3 rounded-2xl border-line bg-elev p-5">
        <DialogTitle className="text-[15px] font-semibold">批量替换模型</DialogTitle>
        <DialogDescription className="text-[12.5px] leading-relaxed text-fg-2">新出了好模型，不用挨个点开联系人改。先看会动到哪些地方，确认后才改；固定在别的模型上的不动，在途任务按启动时的模型跑完。</DialogDescription>
        <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
          把<Pick label="要换掉的模型" testid="br-from" value={from} onChange={pickFrom} className="w-[200px]">{used.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Pick>
          换成<Pick label="换成的模型" testid="br-to" value={to} onChange={(v) => { setTo(v); setRes({}) }} className="w-[260px]">{s.models.filter((m) => m.id !== from).map((m) => <option key={m.id} value={m.id}>{modelOption(m.id, s)}</option>)}</Pick>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          <Col title={`直接写了 ${from} 的`} n={plan.explicit.length} testid="br-explicit">
            {plan.explicit.map((r) => (
              <div key={`${r.contactId}-${r.field}`} data-testid={`br-ref-${r.contactId ?? 'defaults'}-${r.field}`} className="rounded-lg bg-bg px-2.5 py-1.5 text-[12.5px] ring-1 ring-line">
                <span className="font-medium">{name(r.contactId)}</span><span className="text-fg-2"> · {REF_LABEL[r.field]}</span>
                <div className="font-mono text-[11.5px] text-fg-3">{from} → {to}</div>
              </div>
            ))}
          </Col>
          <Col title="跟着变的" n={plan.inheritors.length} testid="br-inheritors">
            {plan.inheritors.map((r) => (
              <div key={r.contactId} data-testid={`br-inh-${r.contactId}`} className="rounded-lg bg-bg px-2.5 py-1.5 text-[12.5px] ring-1 ring-line">
                <span className="font-medium">{name(r.contactId)}</span><span className="text-fg-2"> · Compute（{MODE_LABEL[r.via]}）</span>
                <div className="text-[11.5px] text-fg-3">{r.via === 'inherit' ? '全局默认换了，它跟着换' : '说话模型换了，它跟着换'}</div>
              </div>
            ))}
          </Col>
          <Col title="兼容冲突" n={plan.conflicts.length} testid="br-conflicts" tone="err">
            {plan.conflicts.map((c) => {
              const key = c.contactId ?? DEFAULTS_KEY
              return (
                <div key={key} data-testid={`br-conflict-${key}`} className="rounded-lg border border-err/30 bg-err-soft px-2.5 py-1.5 text-[12.5px]">
                  <div><span className="font-medium">{name(c.contactId)}</span><span className="text-err"> · {mismatchText(c.mismatch, s)}</span></div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {c.fixes.map((f) => (
                      <button key={f.kind} data-testid={`br-${f.kind === 'pin-model' ? 'keep' : 'harness'}-${key}`}
                        onClick={() => setRes((r) => ({ ...r, [key]: f.kind === 'pin-model' ? { kind: 'keep', model: f.model } : { kind: 'harness', harness: f.harness } }))}
                        className={cn('h-7 rounded-lg px-2.5 text-[12px] font-medium', f.kind === 'pin-model' ? 'bg-btn text-btn-fg hover:opacity-90' : 'border border-line bg-bg hover:bg-hover')}>
                        {f.kind === 'pin-model' ? `保留 ${modelLabel(f.model, s)}` : `换 Harness 为 ${harnessLabel(f.harness)}`}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
            {plan.resolved.map((k) => (
              <div key={k} data-testid={`br-resolved-${k}`} className="flex items-start gap-1.5 rounded-lg bg-bg px-2.5 py-1.5 text-[12.5px] ring-1 ring-line">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-run" />
                <div className="min-w-0 flex-1"><span className="font-medium">{name(k)}</span><span className="text-fg-2"> · {res[k] ? resLabel(res[k]) : ''}</span></div>
                <button onClick={() => setRes((r) => { const n = { ...r }; delete n[k]; return n })} className="shrink-0 rounded px-1 text-[11.5px] text-fg-3 hover:bg-hover hover:text-fg">撤销</button>
              </div>
            ))}
          </Col>
        </div>
        <div data-testid="br-untouched" className="space-y-0.5 text-[12px] text-fg-3">
          {plan.pinnedElsewhere.length > 0 && <div>固定在别的模型上的 {plan.pinnedElsewhere.map((i) => name(i)).join('、')} 不动。</div>}
          <div data-testid="br-inflight">{plan.inFlight.length ? `在途 ${plan.inFlight.length} 个任务（${tasks.filter((t) => plan.inFlight.includes(t.id)).map((t) => t.label).join('、')}）按启动时的 ${from} 跑完，快照和历史不改。` : `没有按 ${from} 在跑的任务。`}</div>
        </div>
        <div className="flex items-center gap-2 border-t border-line pt-3">
          <span data-testid="br-why" className={cn('flex-1 text-[12.5px]', blockedWhy ? 'text-err' : 'text-fg-2')}>{blockedWhy || `确认后改 ${plan.explicit.length} 处直接引用，${plan.inheritors.length} 位继承者跟着变，下一轮生效。`}</span>
          <button onClick={onClose} className="h-9 rounded-lg px-3 text-[13px] text-fg-2 hover:bg-hover hover:text-fg">取消</button>
          <button data-testid="br-confirm" disabled={!plan.canConfirm} onClick={confirm} className="h-9 rounded-lg bg-btn px-4 text-[13px] font-medium text-btn-fg hover:opacity-90 disabled:cursor-not-allowed disabled:bg-hover disabled:text-fg-3">确认替换</button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
