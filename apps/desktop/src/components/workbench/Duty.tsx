import { useEffect, useState } from 'react'
import { people, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { candidate } from '@/mut'
import { live } from '@/api/wire/live'
import { personaLive } from '@/api/wire/workbench'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { SectionHeader } from '@/components/ui/section'
import { Hint, Subhead, TextArea } from '@/components/pages/kit/parts'
import { GroupAvatar } from '../Avatar'
import { DUTY_FALLBACK } from './constants'
import { InlineEdit, LayerHint, Source, WbCard } from './parts'

/* 职责与预设:四层设定从「最常改」到「基本不变」往下排——职责、预设、(候选)性格、红线 */
const label = 'w-24 shrink-0 text-[12.5px]'

export function Duty({ id }: { id: PersonId }) {
  const { convs, updatePerson, toast, isLive } = useApp((s) => ({ convs: s.convs, updatePerson: s.updatePerson, toast: s.toast, isLive: live(s) }))
  const p = people[id]
  const [def, setDef] = useState(p.role)
  const [preset, setPreset] = useState('')
  const [savedPreset, setSavedPreset] = useState('')
  const [soul, setSoul] = useState(p.soul ?? '')
  useEffect(() => {
    setDef(people[id]?.role ?? '')
    if (!isLive) return
    void personaLive(id).then((r) => { if (r.ok) { setPreset(r.value); setSavedPreset(r.value) } })
  }, [id, isLive])
  const groups = convs.filter((c) => c.kind === 'group' && c.members.includes(id))
  const saveDef = (v: string) => { if (!v || v === def) return; void updatePerson(id, { role: v }, `默认职位改成「${v}」`).then((ok) => { if (ok) setDef(v) }) }
  const savePreset = () => { if (!presetDirty) return; void updatePerson(id, { persona: preset }, '改了预设').then((ok) => { if (ok) setSavedPreset(preset) }) }
  const tools = (p.tools ?? []).filter((t) => t.on)
  const presetDirty = preset !== savedPreset
  return (
    <div data-testid="wb-duty" className="space-y-4">
      <WbCard>
        <SectionHeader title={<>职责 <LayerHint k="职责" /></>} />
        <Hint className="mb-2 text-[12px]">改职责只改变谁来接这个活；共享清单认领、@所有人、Helper 拉群推荐成员都按它排。</Hint>
        <div className="flex items-center gap-2">
          <span className={`${label} text-fg-3`}>默认职位</span>
          <InlineEdit testid="duty-default-edit" value={def} onSave={saveDef} />
        </div>
        {isLive ? <div data-testid="duty-conv-off" className="mt-3 rounded-lg bg-hover/60 px-3 py-2 text-[12.5px] text-fg-3">还不能按群分工：后端合同暂未提供群级职责字段。</div> : groups.length > 0 && <Subhead className="mt-3">在这个群的分工</Subhead>}
        {!isLive && groups.map((g) => <div key={g.id} className="flex items-center gap-2 py-0.5"><span className={`${label} flex min-w-0 items-center gap-1.5 text-fg-2`}><GroupAvatar ids={g.members} size={18} /><span className="truncate">{g.title}</span></span><InlineEdit testid={`duty-${g.id}`} value="" placeholder={DUTY_FALLBACK} onSave={() => {}} /></div>)}
      </WbCard>

      <WbCard>
        <SectionHeader className="mb-2" title={<>预设 <LayerHint k="预设" /></>} />
        <TextArea data-testid="preset-edit" value={preset} onChange={(e) => setPreset(e.target.value)} rows={4} />
        <div className="mt-2 flex items-center gap-2">
          <span data-testid="preset-state" className={presetDirty ? 'flex-1 text-[12px] text-warm' : 'flex-1 text-[12px] text-fg-3'}>{presetDirty ? '有改动未保存' : '已保存'}</span>
          <Button data-testid="preset-save" variant="primary" size="sm" disabled={!presetDirty} onClick={savePreset}>保存</Button>
        </div>
      </WbCard>

      {!isLive && candidate('U61') && <WbCard>
        <SectionHeader className="mb-2" title={<>性格 <LayerHint k="性格" /></>} />
        <TextArea data-testid="soul-edit" value={soul} onChange={(e) => setSoul(e.target.value)} rows={3} />
        <div className="mt-2 flex justify-end">
          <Button data-testid="soul-save" variant="primary" size="sm" disabled={soul === (p.soul ?? '')} onClick={() => updatePerson(id, { soul }, '改了性格')}>保存</Button>
        </div>
        <Subhead className="mt-2">版本历史</Subhead>
        <div className="divide-y divide-line">
          {(p.versions ?? []).map((v, i) => (
            <div key={v.v} className="flex items-center gap-2 py-1.5 text-[13px]">
              <span className="w-8 shrink-0 text-[12px] tabular-nums text-fg-3">v{v.v}</span>
              <span className="w-24 shrink-0 text-[12px] tabular-nums text-fg-3">{v.at}</span>
              <span className="min-w-0 flex-1 truncate text-fg-2">{v.note}</span>
              {i === 0 ? <span className="text-[12px] text-fg-3">现在用的</span> : <Button data-testid={`soul-rollback-${v.v}`} variant="ghost" size="xs" onClick={() => toast(`已把 ${p.name} 的性格回到 v${v.v}`)}>回到这一版</Button>}
            </div>
          ))}
        </div>
      </WbCard>}

      <WbCard>
        <SectionHeader title="红线（只有你能改）" />
        <Hint className="mb-2 text-[12px]">这些不归它自己改。它的记忆怎么变，都越不过这里。</Hint>
        <Subhead className="mt-0">群公告</Subhead>
        {groups.filter((g) => g.notice).map((g) => (
          <div key={g.id} className="flex items-start gap-2 py-1 text-[13px]">
            <Source conv={g} />
            <span className="min-w-0 flex-1 text-fg-2">{g.notice!.split(/[。\n]/)[0]}。</span>
          </div>
        ))}
        {!groups.some((g) => g.notice) && <div className="text-[13px] text-fg-3">它所在的群都没有公告</div>}
        <Subhead className="mt-3">允许用的技能和工具</Subhead>
        <div className="flex flex-wrap gap-1.5">
          {tools.map((t) => <Chip key={t.name} size="md" className="bg-bg font-normal">{t.name}</Chip>)}
          {!tools.length && <span className="text-[13px] text-fg-3">一个都没开</span>}
        </div>
      </WbCard>
    </div>
  )
}
