import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ArrowLeft, BadgeCheck, Check, Compass, FileUp, Package, Plus, RefreshCw, Search, ShieldAlert, Trash2, X } from 'lucide-react'
import {
  CATEGORY_DESC, CATEGORY_LABEL, CONTENT_POLICIES, CONTENT_POLICY_LABEL, PHASE_LABEL, PLUGIN_CATEGORIES, RISK_LABEL,
  changesSince, commandUsage, hasUpdate, isInstalled, marketCounts, marketList, permissionsToConsent, readInstallSource, splitList, validateGrant,
  type ContentPolicy, type InstallSource, type MarketSort, type OutboundGrant, type PluginCategory, type PluginManifest, type PluginPermission, type RiskLevel,
} from '@g-group/ui-core'
import { cn } from '@/lib/utils'
import { people, type PluginState } from '@/data'
import { useApp, type Section } from '@/ctx'
import { Avatar, GroupAvatar } from './Avatar'
import { Switch } from './ui/switch'
import { Checkbox } from './ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/* 插件中心（用户 #719：要有插件市场和安装入口）。
   左边是自己的一栏：发现 / 已安装 / 有更新 + 类别；右边是卡片网格或详情页。
   安装：先逐条同意权限 → 安装中 → 装好后直接选挂到哪个聊天。卸载二次确认；更新多要权限时先同意新增的那几项。
   状态推进全部走 ui-core 的 pluginReducer（ctx.pluginAct），这里只管界面。 */

type Tab = 'discover' | 'installed' | 'updates'
/** 从别处（群资料·插件）点进来时要打开的详情 */
const intent: { detail: string | null } = { detail: null }
export function openPluginDetail(setSection: (s: Section) => void, id: string) {
  intent.detail = id
  setSection('plugins')
}

/* ---------------------------------------------------------------- 小部件 */

export function PluginIcon({ m, size = 40, className }: { m: { icon: { letter: string; color: string } }; size?: number; className?: string }) {
  return (
    <span aria-hidden className={cn('grid shrink-0 select-none place-items-center font-semibold text-white', className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.27), background: m.icon.color, fontSize: Math.round(size * ([...m.icon.letter].length > 1 ? 0.33 : 0.42)) }}>
      {m.icon.letter}
    </span>
  )
}
export function CategoryTag({ c, className }: { c: PluginCategory; className?: string }) {
  return <span className={cn('inline-flex h-5 shrink-0 items-center rounded-md bg-hover px-1.5 text-[11.5px] text-fg-2', className)}>{CATEGORY_LABEL[c]}</span>
}
const RISK_CLS: Record<RiskLevel, string> = { low: 'bg-ok/10 text-ok', medium: 'bg-warm-soft text-warm', high: 'bg-err/10 text-err' }
function RiskBadge({ r, className }: { r: RiskLevel; className?: string }) {
  return <span data-risk={r} className={cn('inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11.5px] font-medium', RISK_CLS[r], className)}>{RISK_LABEL[r]}风险</span>
}
function Cmd({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn('inline-flex h-5 shrink-0 items-center rounded-md bg-hover px-1.5 font-mono text-[11.5px] text-fg-2', className)}>{children}</code>
}
const Spinner = () => <span className="spin-ring" />
const convName = (convs: { id: string; kind: string; title: string }[], id: string) => { const c = convs.find((x) => x.id === id); return c ? (c.kind === 'group' ? c.title : `与 ${c.title} 私聊`) : id }
const assistants = () => Object.values(people).filter((x) => !x.human && x.id !== 'helper')
const UNTRUSTED = '取来的内容一律标「不可信外部数据」：只当背景参考，不会让助手自动开工，也不能触发控制指令或授权。'

/** 弹窗：和全景遮罩同一种半透明底，内容卡用 elev 面 */
function Modal({ open, onClose, testid, width = 520, children }: { open: boolean; onClose: () => void; testid: string; width?: number; children: ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content data-testid={testid} aria-describedby={undefined} style={{ maxWidth: width }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-elev text-fg shadow-elev outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
function ModalHead({ icon, title, desc }: { icon?: ReactNode; title: ReactNode; desc?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-6 pb-1 pt-5">
      {icon}
      <div className="min-w-0 flex-1">
        <DialogPrimitive.Title className="text-[16.5px] font-semibold leading-snug">{title}</DialogPrimitive.Title>
        {desc && <div className="mt-1 text-[13px] leading-relaxed text-fg-2">{desc}</div>}
      </div>
      <DialogPrimitive.Close aria-label="关闭" className="-mr-2 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-fg-3 hover:bg-hover hover:text-fg"><X className="h-4 w-4" /></DialogPrimitive.Close>
    </div>
  )
}
function ModalFoot({ children }: { children: ReactNode }) {
  return <div className="mt-4 flex items-center gap-2 border-t border-line px-6 py-3.5">{children}</div>
}
const btnPrimary = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-btn px-3.5 text-[13px] font-medium text-btn-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35'
const btnGhost = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] text-fg-2 transition hover:bg-hover hover:text-fg'
const btnLine = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium transition hover:bg-hover'

/* ---------------------------------------------------------------- 安装 / 更新 / 卸载流程 */

type Consent = { mode: 'install' | 'update'; manifest: PluginManifest; perms: PluginPermission[]; from?: string }
export function usePluginFlow() {
  const { plugins, pluginCatalog, pluginAct, toast } = useApp()
  const [consent, setConsent] = useState<Consent | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [justInstalled, setJustInstalled] = useState<string | null>(null)
  const [attachFor, setAttachFor] = useState<string | null>(null)
  /* 装好的那一刻（安装中 → 已启用）接着问挂到哪个聊天 */
  useEffect(() => {
    if (justInstalled && plugins.find((p) => p.id === justInstalled)?.phase === 'enabled') { setAttachFor(justInstalled); setJustInstalled(null) }
  }, [plugins, justInstalled])
  const latestOf = (id: string) => pluginCatalog.find((m) => m.id === id) ?? plugins.find((p) => p.id === id)?.manifest ?? null
  const install = (m: PluginManifest) => setConsent({ mode: 'install', manifest: m, perms: m.permissions })
  const update = (id: string) => {
    const s = plugins.find((p) => p.id === id); const latest = latestOf(id)
    if (!s?.manifest || !latest) return
    const need = permissionsToConsent(s.granted, latest.permissions)
    if (need.length) { setConsent({ mode: 'update', manifest: latest, perms: need, from: s.manifest.version }); return }
    const r = pluginAct(id, { type: 'update', manifest: latest, consent: [] })
    if (!r.ok) toast(r.error)
  }
  const confirm = (scopes: string[]) => {
    if (!consent) return
    const { manifest } = consent
    const r = pluginAct(manifest.id, consent.mode === 'install' ? { type: 'install', manifest, consent: scopes } : { type: 'update', manifest, consent: scopes })
    if (!r.ok) { toast(r.error); return }
    if (consent.mode === 'install') setJustInstalled(manifest.id)
    setConsent(null)
  }
  const dialogs = (
    <>
      {consent && <ConsentDialog c={consent} onCancel={() => setConsent(null)} onConfirm={confirm} />}
      {removing && <UninstallDialog id={removing} onClose={() => setRemoving(null)} />}
      {attachFor && <AttachDialog id={attachFor} onClose={() => setAttachFor(null)} />}
    </>
  )
  return { install, update, uninstall: setRemoving, dialogs }
}
type Flow = ReturnType<typeof usePluginFlow>

function ConsentDialog({ c, onCancel, onConfirm }: { c: Consent; onCancel: () => void; onConfirm: (scopes: string[]) => void }) {
  const [ok, setOk] = useState<Set<string>>(new Set())
  const m = c.manifest
  const all = c.perms.length > 0 && c.perms.every((p) => ok.has(p.scope))
  const toggle = (scope: string, on: boolean) => setOk((s) => { const n = new Set(s); if (on) n.add(scope); else n.delete(scope); return n })
  return (
    <Modal open onClose={onCancel} testid="plg-consent" width={540}>
      <ModalHead icon={<PluginIcon m={m} size={44} />}
        title={c.mode === 'install' ? `安装「${m.name}」` : `更新「${m.name}」到 v${m.version}`}
        desc={c.mode === 'install'
          ? <>{m.publisher} · v{m.version}。它要下面 {c.perms.length} 项权限，逐条看过并勾选同意，才能安装。</>
          : <>新版本比已装的 v{c.from} 多要 {c.perms.length} 项权限。同意之前还用旧版本，用到这些权限的事会先停着。</>} />
      <ul className="scroll-thin mt-3 space-y-2 overflow-y-auto px-6" data-testid="plg-consent-list">
        {c.perms.map((p) => (
          <li key={p.scope}>
            <label data-testid={`plg-consent-perm-${p.scope}`} data-risk={p.risk} className={cn('flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors', p.risk === 'high' ? 'border-err/35 bg-err-soft' : 'border-line hover:bg-hover/60')}>
              <Checkbox checked={ok.has(p.scope)} onCheckedChange={(v) => toggle(p.scope, v === true)} aria-label={`同意：${p.detail}`} className="mt-0.5 rounded-[5px]" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium leading-snug">{p.detail}</span>
                <span className="mt-0.5 block font-mono text-[11.5px] text-fg-3">{p.scope}</span>
              </span>
              <RiskBadge r={p.risk} />
            </label>
          </li>
        ))}
      </ul>
      {m.category === 'source' && <p className="mx-6 mt-3 flex gap-2 rounded-xl bg-hover px-3 py-2.5 text-[12.5px] leading-relaxed text-fg-2"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-fg-3" />{UNTRUSTED}</p>}
      <ModalFoot>
        <span data-testid="plg-consent-count" className={cn('text-[12.5px] tabular-nums', all ? 'text-ok' : 'text-fg-3')}>已同意 {c.perms.filter((p) => ok.has(p.scope)).length}/{c.perms.length}</span>
        <span className="flex-1" />
        <button onClick={onCancel} className={btnGhost}>取消</button>
        <button data-testid="plg-consent-confirm" disabled={!all} onClick={() => onConfirm([...ok])} className={btnPrimary}>{c.mode === 'install' ? '同意并安装' : '同意并更新'}</button>
      </ModalFoot>
    </Modal>
  )
}

function UninstallDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { plugins, convs, pluginAct, toast } = useApp()
  const s = plugins.find((p) => p.id === id)
  if (!s?.manifest) return null
  const m = s.manifest
  const go = () => { const r = pluginAct(id, { type: 'uninstall' }); if (!r.ok) toast(r.error); onClose() }
  return (
    <Modal open onClose={onClose} testid="plg-uninstall-confirm" width={460}>
      <ModalHead icon={<PluginIcon m={m} size={40} />} title={`卸载「${m.name}」？`} desc="卸载后要用得重新安装、重新同意权限。" />
      <ul className="mt-2 space-y-1.5 px-6 text-[13px] text-fg-2">
        <li>· {s.convs.length ? <>从 {s.convs.length} 个聊天摘下：{s.convs.map((c) => convName(convs, c)).join('、')}</> : '没挂在任何聊天上'}</li>
        {s.callers.length > 0 && <li>· {s.callers.map((c) => people[c]?.name ?? c).join('、')} 不能再调用它</li>}
        {m.contributes.commands.length > 0 && <li>· 这些命令不能再用：{m.contributes.commands.map((c) => `/${c.name}`).join('  ')}</li>}
        {s.granted.length > 0 && <li>· 已同意的 {s.granted.length} 项权限一并收回</li>}
      </ul>
      <ModalFoot>
        <span className="flex-1" />
        <button data-testid="plg-uninstall-cancel" onClick={onClose} className={btnGhost}>取消</button>
        <button data-testid="plg-uninstall-yes" onClick={go} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-err/10 px-3.5 text-[13px] font-medium text-err transition hover:bg-err/15"><Trash2 className="h-3.5 w-3.5" />卸载</button>
      </ModalFoot>
    </Modal>
  )
}

function AttachDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { plugins, convs, pluginAct } = useApp()
  const s = plugins.find((p) => p.id === id)
  const [pick, setPick] = useState<Set<string>>(new Set())
  const [who, setWho] = useState<Set<string>>(new Set())
  if (!s?.manifest) return null
  const m = s.manifest
  const flip = (set: Set<string>, k: string) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n }
  const done = () => {
    for (const c of pick) pluginAct(id, { type: 'attach', conv: c })
    for (const w of who) pluginAct(id, { type: 'allow', caller: w })
    onClose()
  }
  const list = [...convs].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'group' ? -1 : 1))
  return (
    <Modal open onClose={onClose} testid="plg-attach-after" width={500}>
      <ModalHead icon={<span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ok/10 text-ok"><Check className="h-5 w-5" /></span>}
        title={`「${m.name}」装好了，挂到哪个聊天？`} desc="装好还不生效：挂到哪个聊天、让哪些助手能调用，那里才用得上。也可以以后在群资料·插件里挂。" />
      <div className="scroll-thin mt-3 max-h-[300px] overflow-y-auto px-4">
        {list.map((c) => {
          const on = pick.has(c.id); const peer = c.kind === 'dm' ? c.members.find((x) => x !== 'me') : undefined
          return (
            <button key={c.id} data-testid={`plg-attach-after-${c.id}`} aria-pressed={on} onClick={() => setPick((p) => flip(p, c.id))}
              className={cn('flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors', on ? 'bg-sel' : 'hover:bg-hover')}>
              {peer ? <Avatar id={peer} size={30} status={false} /> : <GroupAvatar ids={c.members} size={30} />}
              <span className="min-w-0 flex-1 truncate text-[13.5px]">{convName(convs, c.id)}</span>
              <span className={cn('grid h-5 w-5 place-items-center rounded-full border', on ? 'border-me bg-me text-me-fg' : 'border-fg-3/50')}>{on && <Check className="h-3 w-3" />}</span>
            </button>
          )
        })}
      </div>
      <div className="mt-3 px-6">
        <div className="mb-1.5 text-[12.5px] font-medium text-fg-2">哪些助手能调用</div>
        <div className="flex flex-wrap gap-1.5">
          {assistants().map((a) => (
            <button key={a.id} data-testid={`plg-attach-who-${a.id}`} aria-pressed={who.has(a.id)} onClick={() => setWho((w) => flip(w, a.id))}
              className={cn('inline-flex h-7 items-center gap-1.5 rounded-full border pl-1 pr-2.5 text-[12.5px] transition-colors', who.has(a.id) ? 'border-me/50 bg-me/10 text-fg' : 'border-line text-fg-2 hover:bg-hover')}>
              <Avatar id={a.id} size={18} status={false} />{a.name}
            </button>
          ))}
        </div>
      </div>
      <ModalFoot>
        <span className="text-[12.5px] text-fg-3">{pick.size ? `挂到 ${pick.size} 个聊天` : '还没选聊天'}{who.size ? ` · ${who.size} 位助手能调用` : ''}</span>
        <span className="flex-1" />
        <button data-testid="plg-attach-after-skip" onClick={onClose} className={btnGhost}>先不挂</button>
        <button data-testid="plg-attach-after-done" disabled={pick.size === 0} onClick={done} className={btnPrimary}>挂上</button>
      </ModalFoot>
    </Modal>
  )
}

/* ---------------------------------------------------------------- 从文件或地址安装 */

function SideloadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { plugins, pluginCatalog } = useApp()
  const [text, setText] = useState('')
  const [res, setRes] = useState<InstallSource | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const check = (t = text) => setRes(readInstallSource(t))
  const same = res?.kind === 'manifest' && res.check.ok ? (pluginCatalog.find((m) => res.check.ok && m.id === res.check.manifest.id) ?? plugins.find((p) => res.check.ok && p.id === res.check.manifest.id)?.manifest) : undefined
  return (
    <Modal open={open} onClose={onClose} testid="plg-sideload" width={620}>
      <ModalHead icon={<span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-hover text-fg-2"><FileUp className="h-5 w-5" /></span>}
        title="从文件或地址安装" desc="粘贴插件清单（plugin.json）或它的 https 地址，也可以选一个本地 .json 文件。清单先在本机校验；下载安装包、核对签名要连接后端。" />
      <div className="scroll-thin mt-3 min-h-0 flex-1 overflow-y-auto px-6">
        <textarea data-testid="plg-sideload-input" value={text} onChange={(e) => { setText(e.target.value); setRes(null) }} rows={7} spellCheck={false}
          placeholder={'{\n  "id": "acme.notes",\n  "name": "笔记",\n  "version": "0.1.0",\n  …\n}\n或 https://plugins.example.com/notes/plugin.json'}
          className="w-full resize-none rounded-xl border border-line bg-bg px-3 py-2.5 font-mono text-[12.5px] leading-relaxed outline-none placeholder:text-fg-3 focus:border-fg-3" />
        <div className="mt-2 flex items-center gap-1.5">
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" data-testid="plg-sideload-file"
            onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const t = await f.text(); setText(t); check(t); e.target.value = '' }} />
          <button onClick={() => fileRef.current?.click()} className={btnLine}><FileUp className="h-3.5 w-3.5" />选择文件</button>
          {text && <button onClick={() => { setText(''); setRes(null) }} className={btnGhost}>清空</button>}
          <span className="flex-1" />
          <button data-testid="plg-sideload-check" disabled={!text.trim()} onClick={() => check()} className={btnPrimary}>校验</button>
        </div>
        {res && <div className="fade-up mt-3 pb-1">
          {res.kind === 'empty' && null}
          {res.kind === 'invalid' && <p data-testid="plg-sideload-errors" className="rounded-xl border border-err/30 bg-err-soft px-3.5 py-2.5 text-[13px] text-err">{res.error}</p>}
          {res.kind === 'url' && (
            <p data-testid="plg-sideload-backend" className="rounded-xl bg-hover px-3.5 py-2.5 text-[13px] leading-relaxed text-fg-2">
              地址格式没问题：<span className="break-all font-mono text-[12px] text-fg">{res.url}</span><br />从地址取清单和安装包需要连接后端，现在没连上，所以还没去取，也没有安装。
            </p>
          )}
          {res.kind === 'manifest' && !res.check.ok && (
            <div data-testid="plg-sideload-errors" className="rounded-xl border border-err/30 bg-err-soft px-3.5 py-3">
              <div className="text-[13px] font-medium text-err">清单有 {res.check.errors.length} 处问题，改好再校验</div>
              <ul className="mt-1.5 space-y-1 text-[12.5px] leading-relaxed text-err">{res.check.errors.map((e) => <li key={e} className="flex gap-1.5"><span>·</span><span>{e}</span></li>)}</ul>
            </div>
          )}
          {res.kind === 'manifest' && res.check.ok && (() => {
            const m = res.check.manifest
            return (
              <div data-testid="plg-sideload-ok" className="rounded-xl border border-line px-3.5 py-3">
                <div className="flex items-center gap-3">
                  <PluginIcon m={m} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><span className="text-[14px] font-semibold">{m.name}</span><span className="font-mono text-[11.5px] text-fg-3">v{m.version}</span><CategoryTag c={m.category} /></div>
                    <div className="truncate text-[12px] text-fg-2">{m.publisher} · {m.summary}</div>
                  </div>
                  <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ok"><Check className="h-3.5 w-3.5" />清单校验通过</span>
                </div>
                {same && <p className="mt-2 text-[12.5px] text-warm">已经有同 id 的插件「{same.name}」v{same.version}，装这份会当成它的另一个版本。</p>}
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {m.permissions.map((p) => <span key={p.scope} className="inline-flex items-center gap-1.5 rounded-lg border border-line py-0.5 pl-2 pr-1 text-[12px] text-fg-2">{p.detail}<RiskBadge r={p.risk} /></span>)}
                  {m.contributes.commands.map((c) => <Cmd key={c.name}>/{c.name}</Cmd>)}
                </div>
                <p data-testid="plg-sideload-backend" className="mt-3 rounded-lg bg-hover px-3 py-2 text-[12.5px] leading-relaxed text-fg-2">安装包要从发布者那里下载并核对签名，这一步需要连接后端。现在没连上，所以还没有安装。</p>
              </div>
            )
          })()}
        </div>}
      </div>
      <ModalFoot>
        <span className="flex-1" />
        <button onClick={onClose} className={btnGhost}>关闭</button>
        <button data-testid="plg-sideload-install" disabled className={btnPrimary} title="需要连接后端">安装（需要连接后端）</button>
      </ModalFoot>
    </Modal>
  )
}

/* ---------------------------------------------------------------- 插件中心 */

export function PluginCenter() {
  const { plugins, pluginCatalog } = useApp()
  const [tab, setTab] = useState<Tab>('discover')
  const [detail, setDetail] = useState<string | null>(() => { const d = intent.detail; intent.detail = null; return d })
  const [text, setText] = useState('')
  const [cat, setCat] = useState<PluginCategory | 'all'>('all')
  const [sort, setSort] = useState<MarketSort>('featured')
  const [sideload, setSideload] = useState(false)
  const flow = usePluginFlow()
  const counts = useMemo(() => marketCounts(pluginCatalog, plugins), [pluginCatalog, plugins])
  const go = (t: Tab) => { setTab(t); setDetail(null) }
  const NavBtn = ({ k, I, label, n, badge }: { k: Tab; I: typeof Compass; label: string; n: number; badge?: boolean }) => (
    <button data-testid={`plg-tab-${k}`} role="tab" aria-selected={tab === k && !detail} onClick={() => go(k)}
      className={cn('flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] transition-colors', tab === k ? 'bg-sel font-medium text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg')}>
      <I className="h-4 w-4" strokeWidth={tab === k ? 2 : 1.75} /><span className="flex-1">{label}</span>
      {badge ? (n > 0 && <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-warm-dot px-1 text-[10.5px] font-semibold text-white">{n}</span>) : <span className="text-[12px] tabular-nums text-fg-3">{n}</span>}
    </button>
  )
  return (
    <div data-testid="plugin-center" className="flex min-w-0 flex-1">
      <aside className="flex w-[228px] shrink-0 flex-col border-r border-line bg-side px-3 pb-3 pt-4">
        <div className="px-2.5 pb-3">
          <div className="text-[16px] font-semibold tracking-tight">插件</div>
          <div className="mt-0.5 text-[12px] leading-snug text-fg-3">给助手加本事。装了要挂到聊天才生效。</div>
        </div>
        <div role="tablist" aria-label="插件" className="space-y-0.5">
          <NavBtn k="discover" I={Compass} label="发现" n={counts.all} />
          <NavBtn k="installed" I={Package} label="已安装" n={counts.installed} />
          <NavBtn k="updates" I={RefreshCw} label="有更新" n={counts.updates} badge />
        </div>
        <div className="mb-1 mt-5 px-2.5 text-[11.5px] font-medium text-fg-3">类别</div>
        <div className="space-y-0.5">
          {(['all', ...PLUGIN_CATEGORIES] as const).map((c) => (
            <button key={c} data-testid={`plg-cat-${c}`} aria-pressed={tab === 'discover' && cat === c} onClick={() => { setCat(c); go('discover') }}
              className={cn('flex h-8 w-full items-center rounded-lg px-2.5 text-left text-[13px] transition-colors', tab === 'discover' && !detail && cat === c ? 'bg-hover font-medium text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg')}>
              <span className="flex-1">{c === 'all' ? '全部' : CATEGORY_LABEL[c]}</span><span className="text-[12px] tabular-nums text-fg-3">{c === 'all' ? counts.all : counts.byCategory[c]}</span>
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button data-testid="plg-sideload-open" onClick={() => setSideload(true)} className="flex w-full items-center gap-2.5 rounded-xl border border-dashed border-fg-3/40 px-3 py-2.5 text-left transition-colors hover:border-fg-3 hover:bg-hover">
          <FileUp className="h-4 w-4 shrink-0 text-fg-2" />
          <span className="min-w-0"><span className="block text-[13px] font-medium">从文件或地址安装</span><span className="block text-[11.5px] text-fg-3">粘贴 plugin.json 或 https 地址</span></span>
        </button>
        <p className="mt-2 px-1 text-[11px] leading-snug text-fg-3">现在是演示数据：市场里的安装只改本机界面状态，接上后端才会真的下载。</p>
      </aside>

      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto">
        {detail ? <PluginDetail key={detail} id={detail} flow={flow} onBack={() => setDetail(null)} backLabel={{ discover: '发现', installed: '已安装', updates: '有更新' }[tab]} />
          : tab === 'discover' ? <Discover text={text} setText={setText} cat={cat} sort={sort} setSort={setSort} flow={flow} open={setDetail} onSideload={() => setSideload(true)} />
          : tab === 'installed' ? <Installed flow={flow} open={setDetail} onDiscover={() => go('discover')} />
          : <Updates flow={flow} open={setDetail} />}
      </main>
      {flow.dialogs}
      <SideloadDialog open={sideload} onClose={() => setSideload(false)} />
    </div>
  )
}

function PageHead({ title, desc, children }: { title: string; desc: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
      <div className="min-w-0 flex-1"><h1 className="text-[22px] font-semibold tracking-tight">{title}</h1><p className="mt-1 text-[13px] text-fg-2">{desc}</p></div>
      {children}
    </div>
  )
}

function Discover({ text, setText, cat, sort, setSort, flow, open, onSideload }: { text: string; setText: (v: string) => void; cat: PluginCategory | 'all'; sort: MarketSort; setSort: (s: MarketSort) => void; flow: Flow; open: (id: string) => void; onSideload: () => void }) {
  const { plugins, pluginCatalog } = useApp()
  const items = marketList(pluginCatalog, plugins, { text, category: cat, filter: 'all', sort })
  return (
    <div className="mx-auto max-w-[1120px] px-8 pb-14 pt-7" data-testid="plg-discover">
      <PageHead title={cat === 'all' ? '发现插件' : CATEGORY_LABEL[cat]} desc={cat === 'all' ? '取消息、发邮件、多一块面板、多一条 / 命令。装之前会逐条告诉你它要什么权限。' : CATEGORY_DESC[cat]}>
        <label className="flex h-10 w-[380px] items-center gap-2 rounded-xl border border-line bg-bg px-3 text-fg-3 transition-colors focus-within:border-fg-3">
          <Search className="h-4 w-4 shrink-0" />
          <input data-testid="plg-search" value={text} onChange={(e) => setText(e.target.value)} placeholder="搜名称、简介或命令，比如 /mail" className="min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-fg-3" />
          {text && <button aria-label="清空搜索" onClick={() => setText('')} className="grid h-6 w-6 place-items-center rounded-md hover:bg-hover hover:text-fg"><X className="h-3.5 w-3.5" /></button>}
        </label>
        <select data-testid="plg-sort" aria-label="排序" value={sort} onChange={(e) => setSort(e.target.value as MarketSort)} className="h-10 rounded-xl border border-line bg-bg px-3 text-[13px] text-fg-2 outline-none">
          <option value="featured">精选顺序</option><option value="name">按名称</option><option value="updated">最近更新</option>
        </select>
      </PageHead>
      {items.length === 0 ? (
        <div data-testid="plg-empty" className="mt-10 rounded-2xl border border-dashed border-line px-6 py-12 text-center">
          <div className="text-[14px] font-medium">{text ? `没找到和「${text}」有关的插件` : '这一类还没有插件'}</div>
          <div className="mt-1.5 text-[13px] text-fg-2">换个说法搜搜看，或者 <button onClick={onSideload} className="text-me hover:underline">从文件或地址安装</button></div>
        </div>
      ) : (
        <div data-testid="plg-grid" className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3.5">
          {items.map((it) => <MarketCard key={it.manifest.id} m={it.manifest} s={it.install as PluginState | null} upd={it.hasUpdate} matched={it.matched} flow={flow} open={open} />)}
        </div>
      )}
    </div>
  )
}

function ActionButton({ m, s, upd, flow, size = 'sm' }: { m: PluginManifest; s: PluginState | null; upd: boolean; flow: Flow; size?: 'sm' | 'lg' }) {
  const phase = s?.phase ?? 'not_installed'
  const h = size === 'lg' ? 'h-9 px-4 text-[13.5px]' : 'h-7 px-3 text-[12.5px]'
  const stop = (f: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); f() }
  if (phase === 'not_installed') return <button data-testid={`plg-install-${m.id}`} onClick={stop(() => flow.install(m))} className={cn('inline-flex shrink-0 items-center gap-1 rounded-lg bg-btn font-medium text-btn-fg transition hover:opacity-90', h)}>安装</button>
  if (phase === 'installing' || phase === 'uninstalling') return <span data-testid={`plg-busy-${m.id}`} className={cn('inline-flex shrink-0 items-center gap-1.5 text-fg-2', size === 'lg' ? 'text-[13.5px]' : 'text-[12.5px]')}><Spinner />{PHASE_LABEL[phase]}…</span>
  if (upd) return <button data-testid={`plg-update-${m.id}`} onClick={stop(() => flow.update(m.id))} className={cn('inline-flex shrink-0 items-center gap-1 rounded-lg border border-warm/40 bg-warm-soft font-medium text-warm transition hover:brightness-95', h)}><RefreshCw className="h-3 w-3" />更新到 v{m.version}</button>
  return <span data-testid={`plg-installed-${m.id}`} className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-fg-3"><Check className="h-3.5 w-3.5" />{phase === 'disabled' ? '已停用' : '已安装'}</span>
}

function MarketCard({ m, s, upd, matched, flow, open }: { m: PluginManifest; s: PluginState | null; upd: boolean; matched: string[]; flow: Flow; open: (id: string) => void }) {
  const cmds = m.contributes.commands
  return (
    <div role="button" tabIndex={0} data-testid={`plg-card-${m.id}`} data-phase={s?.phase ?? 'not_installed'} onClick={() => open(m.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(m.id) }}
      className="group flex cursor-pointer flex-col rounded-2xl border border-line bg-elev p-4 transition hover:border-fg-3/40 hover:shadow-elev focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg-3">
      <div className="flex items-start gap-3">
        <PluginIcon m={m} size={44} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-1.5"><span data-testid="plg-card-name" className="truncate text-[15px] font-semibold">{m.name}</span>{upd && <span data-testid={`plg-has-update-${m.id}`} className="shrink-0 rounded-full bg-warm-soft px-1.5 text-[11px] font-medium leading-[18px] text-warm">有更新</span>}</div>
          <div className="mt-0.5 flex items-center gap-1 truncate text-[12px] text-fg-3">{m.publisher === 'g-group 官方' && <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-me" />}{m.publisher}</div>
        </div>
      </div>
      <p className="mt-2.5 line-clamp-2 min-h-[38px] text-[13px] leading-[19px] text-fg-2">{m.summary}</p>
      <div className="mt-auto flex items-center gap-1.5 pt-3.5">
        <CategoryTag c={m.category} />
        {cmds.slice(0, 2).map((c) => <Cmd key={c.name} className={cn(matched.includes('command') && 'bg-me/10 text-me')}>/{c.name}</Cmd>)}
        <span className="flex-1" />
        <ActionButton m={m} s={s} upd={upd} flow={flow} />
      </div>
    </div>
  )
}

function Installed({ flow, open, onDiscover }: { flow: Flow; open: (id: string) => void; onDiscover: () => void }) {
  const { plugins, pluginCatalog, convs, pluginAct, toast } = useApp()
  /* 装着的，加上正在装 / 正在卸的（让你看到进度） */
  const items = marketList(pluginCatalog, plugins, { text: '', category: 'all', filter: 'all', sort: 'name' }).filter((it) => it.install && it.install.phase !== 'not_installed')
  return (
    <div className="mx-auto max-w-[920px] px-8 pb-14 pt-7" data-testid="plg-installed">
      <PageHead title="已安装" desc="停用后所有聊天里都暂时用不了；卸载会从聊天上摘下并收回权限。装了但没挂到聊天的，不生效。" />
      {items.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-line px-6 py-12 text-center text-[13px] text-fg-2">还没装插件。<button onClick={onDiscover} className="text-me hover:underline">去发现</button></div>
      ) : (
        <div className="mt-6 divide-y divide-line rounded-2xl border border-line bg-elev">
          {items.map((it) => {
            const s = it.install as PluginState
            const m = s.manifest ?? it.manifest
            const busy = s.phase === 'uninstalling' || s.phase === 'installing'
            return (
              <div key={m.id} role="button" tabIndex={0} data-testid={`plg-row-${m.id}`} data-phase={s.phase} onClick={() => open(m.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(m.id) }}
                className={cn('flex cursor-pointer items-center gap-3.5 px-4 py-3.5 transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-hover/60', s.phase === 'disabled' && 'opacity-70')}>
                <PluginIcon m={m} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14.5px] font-semibold">{m.name}</span>
                    <span className="font-mono text-[11.5px] text-fg-3">v{m.version}</span>
                    <CategoryTag c={m.category} />
                    {s.phase === 'disabled' && <span data-testid={`plg-disabled-${m.id}`} className="rounded-md bg-hover px-1.5 text-[11.5px] leading-5 text-fg-2">已停用</span>}
                  </div>
                  <div className="mt-0.5 truncate text-[12.5px] text-fg-2">
                    {s.convs.length ? <>挂在 {s.convs.map((c) => convName(convs, c)).join('、')}</> : <span className="text-warm">还没挂到聊天，现在不生效</span>}
                    <span className="text-fg-3"> · {s.callers.length ? `${s.callers.map((c) => people[c]?.name ?? c).join('、')} 能调用` : '还没有助手能调用'}</span>
                  </div>
                </div>
                {busy ? <span className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-2"><Spinner />{PHASE_LABEL[s.phase]}…</span> : <>
                  {it.hasUpdate && <ActionButton m={it.manifest} s={s} upd flow={flow} />}
                  <span onClick={(e) => e.stopPropagation()} className="flex items-center gap-2 pl-1">
                    <span className="w-[40px] text-right text-[12px] text-fg-3">{s.phase === 'enabled' ? '启用' : '停用'}</span>
                    <Switch data-testid={`plg-toggle-${m.id}`} aria-label={`启用「${m.name}」`} checked={s.phase === 'enabled'} onCheckedChange={(v) => { const r = pluginAct(m.id, { type: v ? 'enable' : 'disable' }); if (!r.ok) toast(r.error) }} />
                  </span>
                  <button data-testid={`plg-uninstall-${m.id}`} aria-label={`卸载「${m.name}」`} title="卸载" onClick={(e) => { e.stopPropagation(); flow.uninstall(m.id) }} className="grid h-8 w-8 place-items-center rounded-lg text-fg-3 transition hover:bg-err/10 hover:text-err"><Trash2 className="h-4 w-4" /></button>
                </>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Updates({ flow, open }: { flow: Flow; open: (id: string) => void }) {
  const { plugins, pluginCatalog } = useApp()
  const items = marketList(pluginCatalog, plugins, { text: '', category: 'all', filter: 'updates', sort: 'name' })
  return (
    <div className="mx-auto max-w-[920px] px-8 pb-14 pt-7" data-testid="plg-updates">
      <PageHead title="有更新" desc="更新不会改你挂的聊天和调用名单。新版本多要的权限，会先问你。" />
      {items.length === 0 && <div data-testid="plg-updates-empty" className="mt-8 rounded-2xl border border-dashed border-line px-6 py-12 text-center text-[13px] text-fg-2">都是最新版本。</div>}
      <div className="mt-6 space-y-3">
        {items.map((it) => {
          const s = it.install as PluginState
          const m = it.manifest
          const need = permissionsToConsent(s.granted, m.permissions)
          return (
            <div key={m.id} data-testid={`plg-upd-${m.id}`} className="rounded-2xl border border-line bg-elev p-4">
              <div className="flex items-center gap-3">
                <PluginIcon m={m} size={40} />
                <button onClick={() => open(m.id)} className="min-w-0 flex-1 text-left">
                  <div className="text-[14.5px] font-semibold hover:underline">{m.name}</div>
                  <div className="font-mono text-[12px] text-fg-2">v{it.installedVersion} <span className="text-fg-3">→</span> <span className="font-semibold text-fg">v{m.version}</span></div>
                </button>
                <button data-testid={`plg-update-${m.id}`} onClick={() => flow.update(m.id)} className={btnPrimary}><RefreshCw className="h-3.5 w-3.5" />{need.length ? '同意新权限并更新' : '更新'}</button>
              </div>
              <ul className="mt-3 space-y-1.5 border-l-2 border-line pl-3.5">
                {changesSince(it.installedVersion ?? '0.0.0', m).map((e) => (
                  <li key={e.version} className="text-[13px]"><span className="font-mono text-[12px] font-medium">v{e.version}</span><span className="ml-2 text-[12px] text-fg-3">{e.date}</span><div className="text-fg-2">{e.notes.join('；')}</div></li>
                ))}
              </ul>
              {need.length > 0 && (
                <div data-testid={`plg-upd-perms-${m.id}`} className="mt-3 rounded-xl bg-warm-soft px-3.5 py-2.5">
                  <div className="text-[12.5px] font-medium text-warm">新版本多要 {need.length} 项权限，更新时要你同意</div>
                  {need.map((p) => <div key={p.scope} className="mt-1.5 flex items-center gap-2 text-[12.5px] text-fg"><RiskBadge r={p.risk} className="bg-elev" />{p.detail}</div>)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- 详情页 */

function Section({ title, sub, children, testid }: { title: string; sub?: string; children: ReactNode; testid?: string }) {
  return (
    <section data-testid={testid}>
      <div className="flex items-baseline gap-2"><h2 className="text-[15px] font-semibold">{title}</h2>{sub && <span className="text-[12px] text-fg-3">{sub}</span>}</div>
      <div className="mt-2.5">{children}</div>
    </section>
  )
}
function Card({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return <div data-testid={testid} className="rounded-2xl border border-line bg-elev p-4"><div className="mb-2.5 text-[13px] font-semibold">{title}</div>{children}</div>
}

function PluginDetail({ id, flow, onBack, backLabel }: { id: string; flow: Flow; onBack: () => void; backLabel: string }) {
  const { plugins, pluginCatalog, pluginAct, toast } = useApp()
  const s = plugins.find((p) => p.id === id) ?? null
  const latest = pluginCatalog.find((m) => m.id === id) ?? s?.manifest ?? null
  if (!latest) return <div className="p-8 text-[13px] text-fg-2">没有这个插件。<button onClick={onBack} className="text-me hover:underline">返回</button></div>
  const installed = !!s && isInstalled(s)
  const m = installed && s?.manifest ? s.manifest : latest
  const upd = hasUpdate(s, latest)
  const granted = new Set(s?.granted.map((p) => p.scope) ?? [])
  const pendingNew = upd && s ? permissionsToConsent(s.granted, latest.permissions) : []
  const lastDate = latest.changelog[0]?.date
  return (
    <div className="mx-auto max-w-[1080px] px-8 pb-16 pt-5" data-testid={`plg-detail-${id}`}>
      <button data-testid="plg-detail-back" onClick={onBack} className="-ml-2 inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] text-fg-2 hover:bg-hover hover:text-fg"><ArrowLeft className="h-4 w-4" />{backLabel}</button>
      <header className="mt-3 flex items-start gap-5">
        <PluginIcon m={m} size={72} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[24px] font-semibold leading-tight tracking-tight">{m.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-fg-2">
            <span className="inline-flex items-center gap-1">{m.publisher === 'g-group 官方' && <BadgeCheck className="h-3.5 w-3.5 text-me" />}{m.publisher}</span>
            <span className="text-fg-3">·</span><CategoryTag c={m.category} />
            <span className="text-fg-3">·</span>
            <span data-testid="plg-detail-version" className="font-mono text-[12.5px]">{installed ? `已装 v${m.version}` : `v${latest.version}`}</span>
            {upd && <span data-testid="plg-detail-has-update" className="rounded-full bg-warm-soft px-2 text-[12px] font-medium leading-5 text-warm">有新版本 v{latest.version}</span>}
            {installed && !upd && <span className="text-[12px] text-fg-3">已是最新</span>}
            {s && <span data-testid="plg-detail-phase" className={cn('rounded-full px-2 text-[12px] leading-5', s.phase === 'enabled' ? 'bg-ok/10 text-ok' : 'bg-hover text-fg-2')}>{PHASE_LABEL[s.phase]}</span>}
          </div>
          <p className="mt-2 text-[14px] text-fg-2">{m.summary}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          {installed && s ? <>
            <label className="flex items-center gap-2 rounded-lg px-2 text-[13px] text-fg-2">启用
              <Switch data-testid="plg-detail-toggle" aria-label={`启用「${m.name}」`} checked={s.phase === 'enabled'} onCheckedChange={(v) => { const r = pluginAct(id, { type: v ? 'enable' : 'disable' }); if (!r.ok) toast(r.error) }} />
            </label>
            {upd && <ActionButton m={latest} s={s} upd flow={flow} size="lg" />}
            <button data-testid="plg-detail-uninstall" onClick={() => flow.uninstall(id)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3.5 text-[13.5px] text-fg-2 transition hover:border-err/40 hover:bg-err/10 hover:text-err"><Trash2 className="h-4 w-4" />卸载</button>
          </> : <ActionButton m={latest} s={s} upd={false} flow={flow} size="lg" />}
        </div>
      </header>

      <div className="mt-8 grid grid-cols-[minmax(0,1fr)_300px] gap-8">
        <div className="min-w-0 space-y-8">
          <Section title="说明">
            <div className="space-y-2 text-[14px] leading-[1.7] text-fg">{m.description.split('\n').map((t) => <p key={t}>{t}</p>)}</div>
            {m.category === 'source' && (
              <p data-testid="plg-untrusted" className="mt-3 flex gap-2.5 rounded-xl bg-hover px-3.5 py-3 text-[13px] leading-relaxed text-fg-2">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-fg-3" />
                <span>{UNTRUSTED}在聊天里从输入框的「+」选数据源，取来的内容挂到输入框上方的引用条，你看过再发。</span>
              </p>
            )}
            {m.category === 'outbound' && <p className="mt-3 flex gap-2.5 rounded-xl bg-hover px-3.5 py-3 text-[13px] leading-relaxed text-fg-2"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-fg-3" /><span>助手只能在「外发预授权」说好的范围里发：给哪项承诺用、用哪个账号、发给谁、能用哪些数据、发什么、每小时几次。每次发之前都会复核；授权失效或你撤销，外发立即停下，群里出修复卡。</span></p>}
          </Section>

          <Section title="提供的能力" testid="plg-capabilities">
            <div className="divide-y divide-line rounded-2xl border border-line">
              {m.contributes.commands.map((c) => (
                <div key={c.name} data-testid={`plg-cmd-${c.name}`} className="px-4 py-3">
                  <div className="flex items-center gap-2"><span className="w-12 shrink-0 text-[11.5px] text-fg-3">命令</span><code className="font-mono text-[13px] font-medium text-fg">{commandUsage(c)}</code><span className="text-[13px] text-fg-2">{c.title}</span></div>
                  <div className="mt-1 pl-14 text-[12.5px] text-fg-2">{c.desc}</div>
                  {c.args.length > 0 && <div className="mt-1 pl-14 text-[12px] text-fg-3">{c.args.map((a) => `${a.name}${a.required ? '' : '（可选）'}：${a.desc}`).join('；')}</div>}
                </div>
              ))}
              {m.contributes.panels.map((p) => (
                <div key={p.id} data-testid={`plg-panel-${p.id}`} className="flex items-start gap-2 px-4 py-3"><span className="w-12 shrink-0 pt-px text-[11.5px] text-fg-3">面板</span><div><div className="text-[13px] font-medium">{p.title}</div><div className="text-[12.5px] text-fg-2">{p.desc}</div></div></div>
              ))}
              {m.contributes.events.map((e) => (
                <div key={e.name} data-testid={`plg-event-${e.name}`} className="flex items-start gap-2 px-4 py-3"><span className="w-12 shrink-0 pt-px text-[11.5px] text-fg-3">事件</span><div><code className="font-mono text-[12.5px]">{e.name}</code><div className="text-[12.5px] text-fg-2">{e.desc}</div></div></div>
              ))}
              {!m.contributes.commands.length && !m.contributes.panels.length && !m.contributes.events.length && <div className="px-4 py-3 text-[13px] text-fg-3">没有声明命令、面板或事件</div>}
            </div>
          </Section>

          <Section title="权限" sub={installed ? '你安装时逐条同意过；新版本多要的会再问你' : '安装时会逐条问你'} testid="plg-perms">
            <div className="space-y-2">
              {latest.permissions.map((p) => {
                const isNew = pendingNew.some((x) => x.scope === p.scope)
                return (
                  <div key={p.scope} data-testid={`plg-perm-${p.scope}`} data-risk={p.risk} className={cn('flex items-center gap-3 rounded-xl border px-3.5 py-2.5', p.risk === 'high' ? 'border-err/35 bg-err-soft' : 'border-line')}>
                    <RiskBadge r={p.risk} />
                    <div className="min-w-0 flex-1"><div className="text-[13.5px]">{p.detail}</div><div className="font-mono text-[11.5px] text-fg-3">{p.scope}</div></div>
                    {isNew ? <span className="shrink-0 text-[12px] font-medium text-warm">v{latest.version} 新增 · 更新时问你</span>
                      : installed && granted.has(p.scope) ? <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-fg-3"><Check className="h-3.5 w-3.5" />已同意</span> : null}
                  </div>
                )
              })}
              {latest.permissions.length === 0 && <div className="text-[13px] text-fg-3">不需要任何权限</div>}
            </div>
          </Section>

          <Section title="版本与更新日志" testid="plg-changelog">
            <ol className="relative ml-1.5 border-l border-line pl-5">
              {latest.changelog.map((e) => (
                <li key={e.version} className="relative pb-4 last:pb-0">
                  <span className={cn('absolute -left-[25px] top-1.5 h-2 w-2 rounded-full ring-4 ring-bg', s?.manifest?.version === e.version ? 'bg-me' : 'bg-fg-3/50')} />
                  <div className="flex items-baseline gap-2"><span className="font-mono text-[13px] font-semibold">v{e.version}</span><span className="text-[12px] text-fg-3">{e.date}</span>
                    {e.version === latest.version && <span className="text-[11.5px] text-fg-3">最新</span>}
                    {installed && s?.manifest?.version === e.version && <span className="rounded bg-me/10 px-1 text-[11px] font-medium text-me">你装的</span>}
                  </div>
                  <ul className="mt-0.5 text-[13px] text-fg-2">{e.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                </li>
              ))}
            </ol>
          </Section>
        </div>

        <aside className="space-y-4">
          {installed && s ? <Where s={s} /> : (
            <Card title="在哪里生效"><p className="text-[13px] leading-relaxed text-fg-2">装好以后，在这里选挂到哪些聊天、哪些助手能调用。装了不挂不生效。</p></Card>
          )}
          {installed && s && m.category === 'outbound' && <GrantCard s={s} />}
          <Card title="信息">
            <dl className="grid grid-cols-[64px_1fr] gap-y-1.5 text-[12.5px]">
              <dt className="text-fg-3">发布者</dt><dd>{m.publisher}</dd>
              <dt className="text-fg-3">版本</dt><dd className="font-mono">{installed ? `v${m.version}` : `v${latest.version}`}{upd && <span className="text-warm">（最新 v{latest.version}）</span>}</dd>
              {lastDate && <><dt className="text-fg-3">更新于</dt><dd>{lastDate}</dd></>}
              <dt className="text-fg-3">类别</dt><dd>{CATEGORY_LABEL[m.category]}</dd>
              {s?.cred && <><dt className="text-fg-3">凭据</dt><dd data-testid="plg-detail-cred" className={cn(s.cred.includes('失效') && 'text-err')}>{s.cred}</dd></>}
              <dt className="text-fg-3">id</dt><dd className="break-all font-mono text-[11.5px] text-fg-2">{m.id}</dd>
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  )
}

function Chip({ children, onRemove, testid, label }: { children: ReactNode; onRemove: () => void; testid: string; label: string }) {
  return (
    <span data-testid={testid} className="inline-flex h-7 max-w-full items-center gap-1 rounded-lg bg-hover pl-2 pr-0.5 text-[12.5px]">
      <span className="flex min-w-0 items-center gap-1 truncate">{children}</span>
      <button aria-label={label} title={label} onClick={onRemove} className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-sel hover:text-fg"><X className="h-3 w-3" /></button>
    </span>
  )
}
function AddPicker({ testid, label, items }: { testid: string; label: string; items: { id: string; node: ReactNode; pick: () => void }[] }) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button data-testid={testid} className="inline-flex h-7 items-center gap-1 rounded-lg border border-dashed border-fg-3/50 px-2 text-[12.5px] text-fg-2 hover:border-fg-3 hover:text-fg"><Plus className="h-3.5 w-3.5" />{label}</button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 rounded-xl border-line bg-elev p-1 shadow-elev">
        {items.map((it) => <button key={it.id} data-testid={`${testid}-${it.id}`} onClick={() => { it.pick(); setOpen(false) }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-hover">{it.node}</button>)}
      </PopoverContent>
    </Popover>
  )
}

function Where({ s }: { s: PluginState }) {
  const { convs, pluginAct, toast } = useApp()
  const act = (a: Parameters<typeof pluginAct>[1]) => { const r = pluginAct(s.id, a); if (!r.ok) toast(r.error) }
  const free = convs.filter((c) => !s.convs.includes(c.id)).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'group' ? -1 : 1))
  return (
    <Card title="在哪里生效">
      <div data-testid="plg-convs">
        <div className="mb-1.5 text-[12px] text-fg-3">挂在哪些聊天</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {s.convs.length === 0 && <span className="text-[12.5px] text-warm">还没挂，现在不生效</span>}
          {s.convs.map((c) => <Chip key={c} testid={`plg-conv-${c}`} label={`从「${convName(convs, c)}」摘下`} onRemove={() => act({ type: 'detach', conv: c })}>{convName(convs, c)}</Chip>)}
          <AddPicker testid="plg-conv-add" label="挂到…" items={free.map((c) => ({ id: c.id, node: <span className="truncate">{convName(convs, c.id)}</span>, pick: () => act({ type: 'attach', conv: c.id }) }))} />
        </div>
      </div>
      <div data-testid="plg-callers" className="mt-4">
        <div className="mb-1.5 text-[12px] text-fg-3">谁能调用</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {s.callers.length === 0 && <span className="text-[12.5px] text-warm">还没有助手能用</span>}
          {s.callers.map((w) => <Chip key={w} testid={`plg-caller-${w}`} label={`不让 ${people[w]?.name ?? w} 调用`} onRemove={() => act({ type: 'disallow', caller: w })}><Avatar id={w} size={16} status={false} />{people[w]?.name ?? w}</Chip>)}
          <AddPicker testid="plg-caller-add" label="加一个" items={assistants().filter((a) => !s.callers.includes(a.id)).map((a) => ({ id: a.id, node: <><Avatar id={a.id} size={18} status={false} />{a.name}</>, pick: () => act({ type: 'allow', caller: a.id }) }))} />
        </div>
      </div>
      <p className="mt-4 border-t border-line pt-3 text-[11.5px] leading-relaxed text-fg-3">已启用、挂到这个聊天、助手在名单里，三样都满足它才用得上。</p>
    </Card>
  )
}

/* 输出渠道的六项预授权（需求 US12 第 5 条）。收件人对助手只读：只能在这里由你改 */
function GrantCard({ s }: { s: PluginState }) {
  const { plugins, updatePlugin, revokePlugin, reauthPlugin, toast } = useApp()
  const m = s.manifest!
  const kind = m.id === 'g-group.webhook' ? 'url' : 'email'
  const g = s.grant ?? null
  const [edit, setEdit] = useState(false)
  const sourceOpts = ['本群消息', ...plugins.filter((p) => p.manifest?.category === 'source' && isInstalled(p)).map((p) => p.manifest!.name)]
  const blank: OutboundGrant = { commitment: '', sender: '', recipients: [], sources: ['本群消息'], contentPolicy: 'summary', maxPerHour: 3, pluginVersion: m.version, revoked: false }
  const [d, setD] = useState<OutboundGrant>(g ?? blank)
  const [to, setTo] = useState((g?.recipients ?? []).join('\n'))
  const [errs, setErrs] = useState<string[]>([])
  const save = () => {
    const next = { ...d, recipients: splitList(to), pluginVersion: m.version, revoked: false }
    const e = validateGrant(next, kind)
    setErrs(e)
    if (e.length) return
    updatePlugin(s.id, { grant: next })
    setEdit(false)
    toast(`「${m.name}」的外发预授权已保存`)
  }
  const status = !g ? { t: '还没授权，一封也发不出去', cls: 'text-warm' } : g.revoked ? { t: '授权失效，外发已阻断', cls: 'text-err' } : g.pluginVersion !== m.version ? { t: `插件已到 v${m.version}，要你重新确认`, cls: 'text-warm' } : { t: '有效', cls: 'text-ok' }
  const field = (label: string, node: ReactNode) => <label className="block"><span className="mb-1 block text-[12px] text-fg-2">{label}</span>{node}</label>
  const input = 'h-8 w-full rounded-lg border border-line bg-bg px-2.5 text-[13px] outline-none focus:border-fg-3'
  return (
    <Card title="外发预授权" testid="plg-grant">
      <div data-testid="plg-grant-status" className={cn('mb-2.5 text-[12.5px] font-medium', status.cls)}>{status.t}</div>
      {!edit && g && (
        <dl className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1.5 text-[12.5px]">
          <dt className="text-fg-3">给谁用</dt><dd>{g.commitment}</dd>
          <dt className="text-fg-3">{kind === 'email' ? '发件账号' : '发件身份'}</dt><dd className="break-all">{g.sender}</dd>
          <dt className="text-fg-3">{kind === 'email' ? '收件人' : '目标地址'}</dt><dd className="break-all">{g.recipients.join('、')}</dd>
          <dt className="text-fg-3">数据源</dt><dd>{g.sources.join('、')}</dd>
          <dt className="text-fg-3">发什么</dt><dd>{CONTENT_POLICY_LABEL[g.contentPolicy]}</dd>
          <dt className="text-fg-3">频率</dt><dd>每小时最多 {g.maxPerHour} 次</dd>
        </dl>
      )}
      {edit && (
        <div className="space-y-2.5" data-testid="plg-grant-form">
          {field('给哪项承诺用', <input className={input} value={d.commitment} onChange={(e) => setD({ ...d, commitment: e.target.value })} placeholder="比如：每天 8 点日报" />)}
          {field(kind === 'email' ? '发件账号' : '发件身份', <input className={input} value={d.sender} onChange={(e) => setD({ ...d, sender: e.target.value })} placeholder={kind === 'email' ? 'me@team.com' : '签名密钥的名字'} />)}
          {field(kind === 'email' ? '收件白名单（一行一个）' : '目标地址（一行一个）', <textarea className={cn(input, 'h-auto py-1.5')} rows={2} value={to} onChange={(e) => setTo(e.target.value)} />)}
          <div><span className="mb-1 block text-[12px] text-fg-2">能用哪些数据</span>
            <div className="flex flex-wrap gap-1.5">{sourceOpts.map((o) => { const on = d.sources.includes(o); return <button key={o} aria-pressed={on} onClick={() => setD({ ...d, sources: on ? d.sources.filter((x) => x !== o) : [...d.sources, o] })} className={cn('h-7 rounded-lg border px-2 text-[12px]', on ? 'border-me/50 bg-me/10' : 'border-line text-fg-2 hover:bg-hover')}>{o}</button> })}</div>
          </div>
          {field('发什么', <select className={input} value={d.contentPolicy} onChange={(e) => setD({ ...d, contentPolicy: e.target.value as ContentPolicy })}>{CONTENT_POLICIES.map((c) => <option key={c} value={c}>{CONTENT_POLICY_LABEL[c]}</option>)}</select>)}
          {field('每小时最多几次', <input className={input} type="number" min={1} max={60} value={d.maxPerHour} onChange={(e) => setD({ ...d, maxPerHour: Number(e.target.value) })} />)}
          {errs.length > 0 && <ul data-testid="plg-grant-errors" className="space-y-0.5 rounded-lg bg-err-soft px-2.5 py-2 text-[12px] text-err">{errs.map((e) => <li key={e}>{e}</li>)}</ul>}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {edit ? <>
          <button data-testid="plg-grant-save" onClick={save} className={cn(btnPrimary, 'h-7 px-3 text-[12.5px]')}>保存授权</button>
          <button onClick={() => { setEdit(false); setErrs([]) }} className={cn(btnGhost, 'h-7 px-2 text-[12.5px]')}>取消</button>
        </> : <>
          {g?.revoked ? <button data-testid="plg-reauth" onClick={() => reauthPlugin(s.id)} className="h-7 rounded-lg bg-err/10 px-3 text-[12.5px] font-medium text-err hover:bg-err/15">重新授权</button>
            : g && g.pluginVersion !== m.version ? <button data-testid="plg-grant-reconfirm" onClick={() => updatePlugin(s.id, { grant: { ...g, pluginVersion: m.version } })} className={cn(btnPrimary, 'h-7 px-3 text-[12.5px]')}>确认沿用到 v{m.version}</button> : null}
          <button data-testid="plg-grant-edit" onClick={() => { setD(g ?? blank); setTo((g?.recipients ?? []).join('\n')); setEdit(true) }} className={cn(btnLine, 'h-7 px-2.5 text-[12.5px]')}>{g ? '改' : '设置授权'}</button>
          {g && !g.revoked && <button data-testid="plg-revoke" title="原型里模拟你撤销授权 / OAuth 过期" onClick={() => revokePlugin(s.id)} className={cn(btnGhost, 'h-7 px-2 text-[12px] text-fg-3')}>模拟授权失效</button>}
        </>}
      </div>
    </Card>
  )
}
