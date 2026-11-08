/* 定时编辑器的表单:做什么 → 由谁、在哪 → 什么时候醒 → 什么时候开口 → 开启。
   保存前整张校验,不合法保存按钮不可用;缺什么写在保存按钮旁边。 */
import { useId, useState, type ReactNode } from 'react'
import { Megaphone } from 'lucide-react'
import { CRON_PRESETS, parseCron, toLocalDateTime, triggerError, type CronTrigger, type CronTriggerKind } from '@g-group/ui-core'
import { useApp } from '@/ctx'
import { people, type Cron, type PersonId } from '@/data'
import { useNow } from '@/cronView'
import { pinfo } from '@/pluginInfo'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/button'
import { Field, SelectMenu, Textarea } from '@/components/ui/field'
import { ModalBody, ModalFooter } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { EDITOR, KINDS, SPEAKS, SPEAK_HINT } from './constants'
import { CronExprField, pillCls } from './CronExprField'
import { EventField, MessagesField, OnceField } from './TriggerFields'
import { convName, isBot } from './util'

export type CronDraft = Omit<Cron, 'id' | 'runs'>
export type EditorProps = { init?: Cron; seed?: { text?: string; expr?: string } | undefined; conv?: string | undefined; owner?: PersonId | undefined; onClose: () => void; onSave: (d: CronDraft) => void }

/** 一组控件的名字(芯片、分段切换、整块触发设置):role=group 挂标签,不把 id 分给里面的控件 */
function Group({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className="min-w-0">
      <div className="mb-1.5 flex items-baseline gap-2"><span id={id} className="text-[12.5px] font-semibold text-fg">{label}</span>{hint && <span className="truncate text-[11.5px] text-fg-3">{hint}</span>}</div>
      {children}
    </div>
  )
}

export function EditorBody({ init, seed, conv, owner, onClose, onSave }: EditorProps) {
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

  const g = convs.find((c) => c.id === where)
  const candidates = (g?.members ?? []).filter(isBot)
  const sources = plugins.map(pinfo).filter((p) => p.installed && p.kind === 'source' && !!where && p.convs.includes(where))
  const trigger: CronTrigger =
    kind === 'cron' ? { kind, expr }
    : kind === 'once' ? { kind, at: onceAt }
    : kind === 'messages' ? { kind, n, seen: t0?.kind === 'messages' ? Math.min(t0.seen, Math.max(0, n - 1)) : 0 }
    : { kind, source, cond }
  const parsed = parseCron(expr)
  const tErr = triggerError(trigger, now)
  const missing = !text.trim() ? EDITOR.missingText : !where ? EDITOR.missingWhere : !who ? EDITOR.missingWho : null
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

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); save() }}>
      <ModalBody className="space-y-5 pb-2 pt-4">
        <Field label={EDITOR.what}>
          <Textarea data-testid="cron-editor-text" autoFocus={!init} value={text} onChange={(e) => setText(e.target.value)} rows={3}
            placeholder={EDITOR.whatPh} className="min-h-[76px] resize-y" />
        </Field>

        <div className="grid grid-cols-[minmax(0,200px)_minmax(0,1fr)] gap-4">
          <Field label={EDITOR.where}>
            <SelectMenu testid="cron-editor-conv" placeholder={EDITOR.wherePh} value={where} onChange={pickWhere}
              options={usable.map((c) => ({ value: c.id, label: convName(c) }))} />
          </Field>
          <Group label={EDITOR.who} hint={g ? EDITOR.whoHint : undefined}>
            <div className="flex min-h-9 flex-wrap items-center gap-1.5">
              {!g && <span className="text-[12.5px] text-fg-3">{EDITOR.whoFirst}</span>}
              {candidates.map((p) => (
                <Button key={p} data-testid={`cron-editor-who-${p}`} aria-pressed={who === p} onClick={() => setWho(p)} variant="outline" size={null} shape="pill" className={cn(pillCls(who === p), 'gap-1.5 pl-1')}>
                  <Avatar id={p} size={22} status={false} mood="idle" />{people[p].name}
                </Button>
              ))}
            </div>
          </Group>
        </div>

        <Group label={EDITOR.when}>
          <Segmented ariaLabel={EDITOR.when} value={kind} onChange={setKind} options={KINDS.map((k) => ({ ...k, testid: `cron-editor-kind-${k.value}` }))} />
          <div className="mt-3 rounded-xl border border-line bg-side p-3.5">
            {kind === 'cron' && <CronExprField expr={expr} setExpr={setExpr} custom={custom} setCustom={setCustom} now={now} />}
            {kind === 'once' && <OnceField at={onceAt} setAt={setOnceAt} err={tErr} now={now} />}
            {kind === 'messages' && <MessagesField n={n} setN={setN} err={tErr} />}
            {kind === 'event' && <EventField sources={sources} source={source} setSource={setSource} cond={cond} setCond={setCond} err={tErr} />}
          </div>
        </Group>

        <Group label={EDITOR.speak}>
          <Segmented ariaLabel={EDITOR.speak} value={speak} onChange={setSpeak} options={SPEAKS.map((s) => ({ ...s, testid: `cron-editor-speak-${s.value}` }))} />
          <div className="mt-1.5 text-[12px] text-fg-3">{SPEAK_HINT[speak]}</div>
        </Group>

        {g?.kind === 'group' && (g.notices?.length ?? 0) > 0 && (
          <div data-testid="cron-editor-notices" className="flex items-start gap-2 rounded-lg bg-hover/60 px-3 py-2 text-[12px] leading-relaxed text-fg-2">
            <Megaphone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-3" />
            <span>醒来时先装配「{g.title}」当前的 {g.notices!.length} 条群公告（{g.notices!.map((x) => `v${x.ver}`).join(' · ')}）。公告改了，下次醒来就按新版本做，不用重建定时。</span>
          </div>
        )}
      </ModalBody>

      <ModalFooter className="gap-3">
        <label className="flex items-center gap-2 text-[13px] text-fg-2"><Switch data-testid="cron-editor-on" checked={on} onCheckedChange={setOn} />{on ? EDITOR.on : EDITOR.off}</label>
        <span className="flex-1" />
        {missing && <span data-testid="cron-editor-missing" className="truncate text-[12px] text-fg-3">{missing}</span>}
        <Button data-testid="cron-editor-cancel" variant="ghost" size="md" onClick={onClose}>{EDITOR.cancel}</Button>
        <Button type="submit" data-testid="cron-editor-save" variant="primary" size="md" disabled={!ok}>{EDITOR.save}</Button>
      </ModalFooter>
    </form>
  )
}
