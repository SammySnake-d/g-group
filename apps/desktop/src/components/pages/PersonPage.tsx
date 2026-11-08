import { useState } from 'react'
import { people, type PersonId } from '@/data'
import { MODE_LABEL, modelLabel } from '@/modelConfig'
import { useApp } from '@/ctx'
import { Avatar, useLive } from '@/components/Avatar'
import { ComputeLine } from '@/components/Messages'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ListGroup, ListRow } from '@/components/ui/list-row'
import { Hint, PageScroll } from './kit/parts'
import { LIVE } from './constants'

/* ---------- 联系人资料:头像 + 名字 + 三个最常用的动作贴在名字下面;再往下是手上的事、设置、所在的群、花费 ---------- */
export function PersonPage({ id }: { id: PersonId }) {
  const { computes, convs, openDm, mention, push, active, openWorkbench, modelSettings } = useApp()
  const p = people[id]
  const live = LIVE[useLive(id)]
  const liveC = Object.values(computes).filter((c) => c.owner === id && c.status !== 'done')
  const groups = convs.filter((c) => c.kind === 'group' && c.members.includes(id))
  const conv = convs.find((c) => c.id === active)
  return (
    <PageScroll>
      <div className="flex flex-col items-center px-4 pb-4 pt-1 text-center" data-testid={`person-${id}`}>
        <Avatar id={id} size={76} follow status={false} />
        <div className="mt-2.5 max-w-full truncate text-[18px] font-semibold tracking-tight">{p.name}</div>
        <div className="mt-0.5 max-w-full truncate text-[13px] text-fg-2">{p.role}{!p.human && <> · <span className={live.cls}>{live.text}</span></>}</div>
        <div className="mt-3.5 flex flex-wrap justify-center gap-2">
          {!p.human && <Button data-testid="person-dm" variant="primary" shape="pill" onClick={() => openDm(id)}>私聊</Button>}
          {!p.human && conv?.kind === 'group' && conv.members.includes(id) && <Button data-testid="person-inner" shape="pill" onClick={() => push({ t: 'inner', id, conv: active })}>从群聊私信</Button>}
          <Button shape="pill" onClick={() => mention(id)}>@{p.human ? 'TA' : '他'}</Button>
        </div>
      </div>
      {!p.human && (
        <ListGroup title={liveC.length ? `手上的事 · ${liveC.length}` : '手上的事'}>
          {liveC.length ? liveC.map((c) => <div key={c.id} className="px-2 py-1"><ComputeLine id={c.id} /></div>) : <div className="px-4 py-3 text-[13px] text-fg-3">现在没有在做的事</div>}
        </ListGroup>
      )}
      {p.model && (
        <ListGroup title="设置">
          {/* 模型只在工作台「设置」和设置页「默认」改(D07.4 规则 5),这里只显示、点了过去改 */}
          <ListRow testid="person-model" label="模型" value={<span className="text-[12.5px]">{modelLabel(p.model, modelSettings)} · Compute {p.computeModel?.mode === 'explicit' ? modelLabel(p.computeModel.model, modelSettings) : MODE_LABEL[p.computeModel?.mode ?? 'inherit']}</span>} onClick={() => openWorkbench(id, 'settings')} />
          <ListRow label="最多同时分几个 Compute" value={`${p.computeQuota} 个`} onClick={() => openWorkbench(id, 'settings')} />
          <ListRow testid="person-tools" label="能用的技能和工具" value={`${p.tools?.filter((t) => t.on).length} 个`} onClick={() => push({ t: 'personTools', id })} />
          {p.focus && <ListRow label="专职" value={p.focus} />}
        </ListGroup>
      )}
      {groups.length > 0 && (
        <ListGroup title={`在的群 · ${groups.length}`}>
          {groups.map((g) => <ListRow key={g.id} label={g.title} value={`${g.members.length} 人`} onClick={() => push({ t: 'group', id: g.id })} />)}
        </ListGroup>
      )}
      {p.today && (
        <ListGroup title="花费">
          <ListRow label="今天" value={p.today} />
          <ListRow label="本月" value={p.month} />
        </ListGroup>
      )}
    </PageScroll>
  )
}

/* AC-29:联系人能力默认隔离,白名单勾选 */
export function ToolsPage({ id }: { id: PersonId }) {
  const p = people[id]
  const [tools, setTools] = useState(p.tools ?? [])
  const toggle = (name: string, on: boolean) => setTools((ts) => ts.map((x) => (x.name === name ? { ...x, on } : x)))
  return (
    <PageScroll className="px-1">
      <Hint className="mx-4 mb-2">只有勾上的能被 {p.name} 和它分出的 Compute 用到。本机装的其他技能和工具默认不给。</Hint>
      {(['skill', 'mcp'] as const).map((k) => (
        <ListGroup key={k} title={k === 'skill' ? '技能' : '工具'}>
          {tools.filter((t) => t.kind === k).map((t) => (
            <ListRow key={t.name} label={t.name}><Switch aria-label={t.name} checked={t.on} onCheckedChange={(v) => toggle(t.name, v)} /></ListRow>
          ))}
        </ListGroup>
      ))}
    </PageScroll>
  )
}
