import { useState, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { people, type Plugin, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { Avatar } from './Avatar'

type Tab = 'installed' | 'available' | 'create'
const KINDS: { k: Plugin['kind']; label: string; desc: string }[] = [
  { k: 'source', label: '取数据', desc: '让助手读到外面的东西：别的聊天软件、网页、订阅。' },
  { k: 'outbound', label: '发出去', desc: '让助手往外发：邮件、请求、别的群。要先说好能发给谁。' },
  { k: 'ui', label: '加面板', desc: '在聊天旁边多一块面板，比如看板。' },
]
const kindLabel = (k: Plugin['kind']) => KINDS.find((x) => x.k === k)!.label

export function PluginCenter() {
  const { plugins } = useApp()
  const [tab, setTab] = useState<Tab>('installed')
  const [mine, setMine] = useState<Plugin[]>([])
  const all = [...plugins, ...mine.filter((m) => !plugins.some((p) => p.id === m.id))]
  const list = all.filter((p) => (tab === 'installed' ? p.installed : !p.installed))

  return (
    <main data-testid="plugin-center" className="scroll-thin min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[860px] px-8 pb-12 pt-6">
        <h1 className="text-[20px] font-semibold tracking-tight">插件</h1>
        <p className="mt-0.5 text-[13px] text-fg-2">给助手加本事：取消息、发邮件、发请求、多一块面板。装好以后，要挂到具体的群或私聊才会生效。</p>
        <div className="mt-5 flex gap-1 border-b border-line">
          {([['installed', '已安装'], ['available', '可安装'], ['create', '自己创建']] as const).map(([k, l]) => (
            <button key={k} data-testid={`plg-tab-${k}`} onClick={() => setTab(k)} className={cn('-mb-px border-b-2 px-3 pb-2 text-[14px]', tab === k ? 'border-fg font-medium' : 'border-transparent text-fg-2 hover:text-fg')}>
              {l}{k !== 'create' && <span className="ml-1 text-fg-3">{all.filter((p) => (k === 'installed' ? p.installed : !p.installed)).length}</span>}{k === 'installed' && all.some((p) => p.installed && p.latest) && <span data-testid="plg-has-update" className="ml-1.5 rounded-full bg-me/10 px-1.5 text-[11px] text-me">{all.filter((p) => p.installed && p.latest).length} 个有更新</span>}
            </button>
          ))}
        </div>

        {tab === 'create' ? <CreateForm onCreate={(p) => { setMine((m) => [...m, p]); setTab('installed') }} /> : (
          <div className="mt-5 space-y-7">
            {KINDS.map((g) => {
              const items = list.filter((p) => p.kind === g.k)
              return (
                <section key={g.k} data-testid={`plg-group-${g.k}`}>
                  <div className="flex items-baseline gap-2"><h2 className="text-[15px] font-semibold">{g.label}</h2><span className="text-[12.5px] text-fg-3">{g.desc}</span></div>
                  <div className="mt-2.5 space-y-2.5">
                    {items.length === 0 && <div className="rounded-xl border border-dashed border-line py-4 text-center text-[12.5px] text-fg-3">{tab === 'installed' ? '这类还没装' : '这类都装过了'}</div>}
                    {items.map((p) => <PluginCard key={p.id} p={p} local={mine.some((m) => m.id === p.id) && !plugins.some((x) => x.id === p.id)} onLocal={(patch) => setMine((m) => m.map((x) => (x.id === p.id ? { ...x, ...patch } : x)))} />)}
                  </div>
                </section>
              )
            })}
          </div>
        )}
        <p className="mt-10 text-[12px] text-fg-3">定时不在这里：“每天 8 点去看”是联系人自己的能力，在联系人工作台的「定时」里。</p>
      </div>
    </main>
  )
}

function Icon({ p, size = 40 }: { p: Plugin; size?: number }) {
  return <div className="grid shrink-0 place-items-center rounded-[10px] text-[15px] font-semibold text-white" style={{ width: size, height: size, background: p.color }}>{p.letter}</div>
}

function PluginCard({ p, local, onLocal }: { p: Plugin; local: boolean; onLocal: (patch: Partial<Plugin>) => void }) {
  const { updatePlugin, toast, convs, revokePlugin, reauthPlugin } = useApp()
  const update = (patch: Partial<Plugin>) => (local ? onLocal(patch) : updatePlugin(p.id, patch))
  const [editLimit, setEditLimit] = useState(false)
  const [limit, setLimit] = useState(p.limit ?? '')
  const who = p.who ?? []
  const bots = Object.values(people).filter((x) => !x.human && x.id !== 'helper')
  const convName = (id: string) => { const c = convs.find((x) => x.id === id); return c ? (c.kind === 'group' ? c.title : `与 ${c.title} 私聊`) : id }
  const unattached = convs.filter((c) => !p.convs.includes(c.id))

  return (
    <div data-testid={`plg-${p.id}`} className="rounded-xl border border-line bg-elev">
      <div className="flex items-center gap-3 p-3.5">
        <Icon p={p} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><span className="text-[14.5px] font-semibold">{p.name}</span><span data-testid={`plg-ver-${p.id}`} className="font-mono text-[11.5px] text-fg-3">v{p.ver}</span><span className="rounded bg-hover px-1.5 py-0.5 text-[11.5px] text-fg-2">{kindLabel(p.kind)}</span>{p.mine && <span className="rounded bg-hover px-1.5 py-0.5 text-[11.5px] text-fg-2">你创建的</span>}</div>
          <div className="mt-0.5 truncate text-[13px] text-fg-2">{p.desc}</div>
        </div>
        {p.revoked
          ? <span data-testid={`plg-revoked-${p.id}`} className="shrink-0 text-[12px] text-err">授权失效 · 外发已暂停</span>
          : <span className={cn('shrink-0 text-[12px]', p.cred ? (p.cred.includes('未') ? 'text-warm' : 'text-fg-3') : 'text-fg-3')}>{p.cred ?? (p.installed ? '不需要凭据' : '装好后登录')}</span>}
        {p.installed && p.cred && p.kind === 'outbound' && (p.revoked
          ? <button data-testid={`plg-reauth-${p.id}`} onClick={() => reauthPlugin(p.id)} className="h-7 shrink-0 rounded-md bg-err px-2.5 text-[12.5px] font-medium text-white">重新授权</button>
          : <button data-testid={`plg-revoke-${p.id}`} title="原型里模拟对方撤销授权 / 凭据过期" onClick={() => revokePlugin(p.id)} className="h-7 shrink-0 rounded-md px-2 text-[12px] text-fg-3 hover:bg-hover hover:text-fg">模拟授权过期</button>)}
        {p.installed && p.latest && <button data-testid={`plg-update-${p.id}`} title={p.changes} onClick={() => { update({ ver: p.latest!, latest: undefined, changes: undefined }); toast(`「${p.name}」更新到 v${p.latest}：${p.changes}`) }} className="h-8 shrink-0 rounded-lg border border-line px-3 text-[12.5px] font-medium hover:bg-hover">更新到 v{p.latest}</button>}
        {!p.installed && <button data-testid={`plg-install-${p.id}`} onClick={() => { update({ installed: true }); toast(`装好了「${p.name}」，还没挂到任何聊天`) }} className="h-8 shrink-0 rounded-lg bg-btn px-3.5 text-[13px] font-medium text-btn-fg">安装</button>}
      </div>
      {p.installed && (
        <div className="divide-y divide-line border-t border-line text-[13px]">
          <Gate n={1} title="已安装">
            <span className="text-fg-2">装在这台电脑上，谁也还用不了，要过下面几道关</span>
            <button data-testid={`plg-disable-${p.id}`} onClick={() => { update({ installed: false }); toast(`已停用「${p.name}」`) }} className="ml-auto rounded-md px-2 py-0.5 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg">停用</button>
          </Gate>
          <Gate n={2} title="挂在哪些聊天" testid={`plg-attach-${p.id}`}>
            <div className="flex flex-wrap items-center gap-1.5">
              {p.convs.length === 0 && <span className="text-warm">还没挂，现在不生效</span>}
              {p.convs.map((c) => <Chip key={c} onRemove={() => update({ convs: p.convs.filter((x) => x !== c) })}>{convName(c)}</Chip>)}
              {unattached.length > 0 && (
                <select data-testid={`plg-attach-pick-${p.id}`} value="" onChange={(e) => { if (e.target.value) { update({ convs: [...p.convs, e.target.value] }); toast(`「${p.name}」挂到了「${convName(e.target.value)}」`) } }} className="h-7 rounded-md border border-dashed border-line bg-transparent px-1.5 text-[12.5px] text-fg-2">
                  <option value="">+ 挂到…</option>
                  {unattached.map((c) => <option key={c.id} value={c.id}>{convName(c.id)}</option>)}
                </select>
              )}
            </div>
          </Gate>
          <Gate n={3} title="谁能调用" testid={`plg-who-${p.id}`}>
            <div className="flex flex-wrap items-center gap-1.5">
              {who.length === 0 && <span className="text-warm">还没有助手能用</span>}
              {who.map((w) => <Chip key={w} onRemove={() => update({ who: who.filter((x) => x !== w) })}><Avatar id={w} size={16} status={false} mood="idle" />{people[w].name}</Chip>)}
              <select data-testid={`plg-who-pick-${p.id}`} value="" onChange={(e) => e.target.value && update({ who: [...who, e.target.value as PersonId] })} className="h-7 rounded-md border border-dashed border-line bg-transparent px-1.5 text-[12.5px] text-fg-2">
                <option value="">+ 加一个</option>
                {bots.filter((b) => !who.includes(b.id)).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          </Gate>
          {p.kind === 'outbound' && (
            <Gate n={4} title="能发给谁" testid={`plg-limit-${p.id}`}>
              {editLimit ? (
                <div className="flex flex-1 items-center gap-2">
                  <input autoFocus value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="比如：只发给 wang@team.com · 每小时最多 3 封" className="h-7 flex-1 rounded-md border border-line bg-bg px-2 text-[13px]" />
                  <button onClick={() => { update({ limit: limit.trim() || undefined }); setEditLimit(false) }} className="h-7 rounded-md bg-btn px-2.5 text-[12.5px] text-btn-fg">保存</button>
                </div>
              ) : (
                <><span className={p.limit ? '' : 'text-warm'}>{p.limit ?? '还没说好，现在一封也发不出去'}</span><button onClick={() => setEditLimit(true)} className="ml-auto rounded-md px-2 py-0.5 text-[12.5px] text-fg-2 hover:bg-hover hover:text-fg">改</button></>
              )}
            </Gate>
          )}
        </div>
      )}
    </div>
  )
}

function Gate({ n, title, children, testid }: { n: number; title: string; children: ReactNode; testid?: string }) {
  return (
    <div data-testid={testid} className="flex items-center gap-3 px-3.5 py-2.5">
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-hover text-[11px] font-medium text-fg-2">{n}</span>
      <span className="w-[92px] shrink-0 font-medium">{title}</span>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
    </div>
  )
}

function Chip({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return <span className="inline-flex h-7 items-center gap-1 rounded-md bg-hover pl-2 pr-1 text-[12.5px]">{children}<button onClick={onRemove} className="rounded p-0.5 text-fg-3 hover:text-fg"><X className="h-3 w-3" /></button></span>
}

function CreateForm({ onCreate }: { onCreate: (p: Plugin) => void }) {
  const { toast } = useApp()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Plugin['kind']>('source')
  const [desc, setDesc] = useState('')
  const [cred, setCred] = useState('')
  return (
    <div data-testid="plg-create-form" className="mt-5 max-w-[560px] space-y-4">
      <p className="rounded-lg bg-hover px-3 py-2 text-[12.5px] text-fg-2">创建的插件默认只装不挂，要你挂到具体聊天才生效。</p>
      <label className="block"><div className="mb-1 text-[13px] font-medium">名字</div><input data-testid="plg-new-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="比如：公司 Jira" className="h-9 w-full rounded-lg border border-line bg-bg px-3 text-[14px]" /></label>
      <div><div className="mb-1 text-[13px] font-medium">类型</div>
        <div className="flex gap-2">{KINDS.map((k) => <button key={k.k} data-testid={`plg-new-kind-${k.k}`} onClick={() => setKind(k.k)} className={cn('flex-1 rounded-lg border px-3 py-2 text-left text-[13px]', kind === k.k ? 'border-fg/50 bg-sel font-medium' : 'border-line hover:bg-hover')}>{k.label}</button>)}</div>
      </div>
      <label className="block"><div className="mb-1 text-[13px] font-medium">它能做什么</div><textarea data-testid="plg-new-desc" value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} placeholder="比如：查某个需求单的状态，把评论带进对话" className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px]" /></label>
      <label className="block"><div className="mb-1 text-[13px] font-medium">需要的凭据</div><input data-testid="plg-new-cred" value={cred} onChange={(e) => setCred(e.target.value)} placeholder="比如：Jira 的访问令牌（只存引用，助手看不到明文）" className="h-9 w-full rounded-lg border border-line bg-bg px-3 text-[14px]" /></label>
      <button data-testid="plg-new-create" disabled={!name.trim()} onClick={() => {
        onCreate({ id: 'p-mine-' + Date.now(), name: name.trim(), kind, desc: desc.trim() || '你创建的插件', letter: name.trim().slice(0, 1).toUpperCase(), color: '#7a7a7a', installed: true, convs: [], who: [], cred: cred.trim() ? `需要：${cred.trim()} · 未填` : undefined, mine: true, ver: "0.1.0" })
        toast(`创建了「${name.trim()}」，还没挂到任何聊天`)
      }} className="inline-flex h-9 items-center gap-1 rounded-lg bg-btn px-4 text-[14px] font-medium text-btn-fg disabled:opacity-40"><Plus className="h-4 w-4" />创建</button>
    </div>
  )
}
