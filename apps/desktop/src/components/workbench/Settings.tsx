import { useState } from 'react'
import { people, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { ListRow } from '@/components/ui/list-row'
import { SectionHeader } from '@/components/ui/section'
import { Switch } from '@/components/ui/switch'
import { Hint, Subhead } from '@/components/pages/kit/parts'
import { ContactModelSettings } from '../ModelSettings'
import { WbCard } from './parts'

/* 设置(原资料页 / 模型页 / 工具页,就地显示):模型 → 能用的技能和工具 → 花费 */
const row = 'min-h-10 px-0 text-[13.5px]'
const KINDS = [{ k: 'skill', l: '技能' }, { k: 'mcp', l: '工具' }] as const

export function Settings({ id }: { id: PersonId }) {
  const { updatePerson } = useApp()
  const p = people[id]
  const [tools, setTools] = useState(p.tools ?? [])
  if (p.human) return <WbCard testid="wb-settings"><div className="text-[13px] text-fg-3">{p.name} 是真人，没有模型和工具设置。</div></WbCard>
  const toggleTool = (name: string, on: boolean) => {
    const next = tools.map((t) => (t.name === name ? { ...t, on } : t))
    setTools(next)
    updatePerson(id, { tools: next }, `${on ? '打开' : '关掉'}了「${name}」`)
  }
  return (
    <div data-testid="wb-settings" className="space-y-4">
      <ContactModelSettings key={id} id={id} />

      <WbCard>
        <SectionHeader title="能用的技能和工具" />
        <Hint className="mb-2 text-[12px]">只有打开的能被 {p.name} 和它分出的 Compute 用到。本机装的其他技能和工具默认不给。</Hint>
        {KINDS.map(({ k, l }) => (
          <div key={k}>
            <Subhead className="mb-0.5 mt-2 first:mt-2">{l}</Subhead>
            <div className="divide-y divide-line">
              {tools.filter((t) => t.kind === k).map((t) => (
                <ListRow key={t.name} label={t.name} className={row}><Switch data-testid={`set-tool-${t.name}`} aria-label={t.name} checked={t.on} onCheckedChange={(v) => toggleTool(t.name, v)} /></ListRow>
              ))}
            </div>
          </div>
        ))}
      </WbCard>

      {p.today && (
        <WbCard>
          <SectionHeader title="花费" />
          <div className="divide-y divide-line">
            <ListRow label="今天" value={p.today} className={row} />
            <ListRow label="本月" value={p.month} className={row} />
          </div>
        </WbCard>
      )}
    </div>
  )
}
