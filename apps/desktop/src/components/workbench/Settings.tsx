import { useEffect, useState } from 'react'
import { people, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { live } from '@/api/wire/live'
import { assetsLive, libraryLive, type ComputeAsset } from '@/api/wire/workbench'
import { ListRow } from '@/components/ui/list-row'
import { SectionHeader } from '@/components/ui/section'
import { Switch } from '@/components/ui/switch'
import { Hint, Subhead } from '@/components/pages/kit/parts'
import { ContactModelSettings } from '../ModelSettings'
import { WbCard } from './parts'

const row = 'min-h-10 px-0 text-[13.5px]'
const KINDS = [{ k: 'skill' as const, l: '技能' }, { k: 'mcp' as const, l: '工具' }]
type LibraryItem = { name: string; kind: 'skill' | 'mcp'; description?: string }

/** 设置页的能力清单来自后端；没有能力库时明确写关闭原因，不拿演示工具顶上。 */
export function Settings({ id }: { id: PersonId }) {
  const { updatePerson, isLive } = useApp((s) => ({ updatePerson: s.updatePerson, isLive: live(s) }))
  const p = people[id]
  const [tools, setTools] = useState(p.tools ?? [])
  const [library, setLibrary] = useState<LibraryItem[]>([])
  const [assets, setAssets] = useState<ComputeAsset[]>([])
  useEffect(() => {
    if (!isLive) return
    void Promise.all([libraryLive(), assetsLive(id)]).then(([lib, own]) => {
      if (lib.ok) setLibrary([...lib.value.skills.map((x) => ({ name: x.name, description: x.description, kind: 'skill' as const })), ...lib.value.mcp.map((x) => ({ name: x.name, kind: 'mcp' as const }))])
      if (own.ok) setAssets(own.value)
    })
  }, [id, isLive])
  if (p.human) return <WbCard testid="wb-settings"><div className="text-[13px] text-fg-3">{p.name} 是真人，没有模型和工具设置。</div></WbCard>
  const toggleTool = (name: string, kind: 'skill' | 'mcp', on: boolean) => {
    if (!isLive) { const next = tools.map((t) => (t.name === name ? { ...t, on } : t)); setTools(next); void updatePerson(id, { tools: next }, `${on ? '打开' : '关掉'}了「${name}」`); return }
    const nextAssets = [...assets.filter((x) => x.name !== name), ...(on ? [{ name, kind }] : [])]
    void updatePerson(id, { computeAssets: nextAssets }, `${on ? '打开' : '关掉'}了「${name}」`).then((ok) => { if (ok) setAssets(nextAssets) })
  }
  return <div data-testid="wb-settings" className="space-y-4">
    <ContactModelSettings key={id} id={id} />
    <WbCard>
      <SectionHeader title="能用的技能和工具" />
      <Hint className="mb-2 text-[12px]">只有打开的能被 {p.name} 和它分出的 Compute 用到。本机装的其他技能和工具默认不给。</Hint>
      {isLive && library.length === 0 && <div data-testid="wb-capabilities-off" className="rounded-lg bg-hover/60 px-3 py-2 text-[12.5px] text-fg-3">能力库是空的，后端还没有可开的技能或工具。</div>}
      {KINDS.map(({ k, l }) => <div key={k}><Subhead className="mb-0.5 mt-2 first:mt-2">{l}</Subhead><div className="divide-y divide-line">{(isLive ? library.filter((x) => x.kind === k) : tools.filter((x) => x.kind === k)).map((t) => { const on = isLive ? assets.some((x) => x.name === t.name && x.kind === t.kind) : ('on' in t ? t.on : false); const label = 'description' in t && t.description ? <span><span title={t.description}>{t.name}</span><span className="ml-2 text-[11px] text-fg-3">{t.description}</span></span> : t.name; return <ListRow key={t.name} label={label} className={row}><Switch data-testid={`set-tool-${t.name}`} aria-label={t.name} checked={on} onCheckedChange={(v) => toggleTool(t.name, t.kind, v)} /></ListRow> })}</div></div>)}
    </WbCard>
    {!isLive && p.today && <WbCard><SectionHeader title="花费" /><div className="divide-y divide-line"><ListRow label="今天" value={p.today} className={row} /><ListRow label="本月" value={p.month} className={row} /></div></WbCard>}
  </div>
}
