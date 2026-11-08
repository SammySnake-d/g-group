import { useState } from 'react'
import { ChevronRight, MessagesSquare } from 'lucide-react'
import { people, agentTalks, innerLog, type Msg, type PersonId } from '@/data'
import { modelLabel } from '@/modelConfig'
import { useApp } from '@/ctx'
import { candidate } from '@/mut'
import { Avatar } from '@/components/Avatar'
import { ComputeLine, renderText } from '@/components/Messages'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/section'
import { Surface } from '@/components/ui/surface'
import { ListItem } from '@/components/ui/list-row'
import { Tabs, TabList, TabPanel } from './kit/tabs'
import { Hint, PageScroll, Subhead } from './kit/parts'

/* ---------- 查看对话细节:它和其他助手 / 和你 / 在做什么 / 它记住了什么 ----------
   bare:嵌在联系人分栏「对话」页签里,只要「和其他助手」那一页,不要头部和页签 */
type DTab = 'me' | 'agents' | 'work' | 'memory'

export function DetailPage({ id, conv, tab: tab0, bare }: { id: PersonId; conv: string; tab?: DTab; bare?: boolean }) {
  const { computes, push, modelSettings } = useApp()
  const p = people[id]
  const [tab, setTab] = useState<DTab>(tab0 ?? 'agents')
  const talks = agentTalks.filter((t) => t.who.includes(id))
  const working = Object.values(computes).filter((c) => c.owner === id && c.status !== 'done').length
  const panels = (
    <>
      <TabPanel value="agents"><AgentsTab id={id} /></TabPanel>
      <TabPanel value="me"><MeTab id={id} /></TabPanel>
      <TabPanel value="work"><WorkTab id={id} conv={conv} /></TabPanel>
      <TabPanel value="memory"><MemoryTab id={id} /></TabPanel>
    </>
  )
  if (bare) return <Tabs value={tab} onValueChange={setTab}><div className="px-3 pb-4 pt-2">{panels}</div></Tabs>
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-4 pb-2" data-testid="detail">
        <Avatar id={id} size={36} />
        <div className="min-w-0 flex-1"><div className="truncate text-[13.5px] font-medium">{p.name}</div><div className="truncate text-[12px] text-fg-3">{p.role} · {modelLabel(p.model, modelSettings)}</div></div>
        <Button variant="ghost" size="xs" onClick={() => push({ t: 'person', id })} className="gap-0.5 font-normal">资料<ChevronRight /></Button>
      </div>
      <div className="border-b border-line px-3">
        <TabList size="sm" label={`${p.name} 的对话细节`} items={[
          { value: 'agents', label: `和其他助手 ${talks.length}`, testid: 'dtab-agents' },
          { value: 'me', label: '和你', testid: 'dtab-me' },
          { value: 'work', label: `在做的事 ${working}`, testid: 'dtab-work' },
          { value: 'memory', label: '它记住的', testid: 'dtab-memory' },
        ]} />
      </div>
      <PageScroll className="px-3 pt-2"><div>{panels}</div></PageScroll>
    </Tabs>
  )
}

/** 和其他助手:原话都在这里,群里只留一行灰字和结论 */
function AgentsTab({ id }: { id: PersonId }) {
  const { convs, push } = useApp()
  const talks = agentTalks.filter((t) => t.who.includes(id))
  return (
    <>
      <Hint className="mb-2 px-1 text-[12px]">助手之间的对话平时不进群聊，只在群里留一行灰字和结论。原话都在这里。</Hint>
      {talks.map((t) => {
        const other = t.who.find((w) => w !== id)!
        return (
          <ListItem key={t.id} data-testid={`talk-${t.id}`} onClick={() => push({ t: 'talk', id: t.id })} className="mb-1 gap-2.5 px-2"
            media={<Avatar id={other} size={30} status={false} />}
            title={<span className="flex items-baseline gap-2"><span className="min-w-0 truncate text-[13.5px]">和 {people[other].name}：{t.title}</span><span className="ml-auto shrink-0 text-[11.5px] font-normal tabular-nums text-fg-3">{t.at}</span></span>}
            subtitle={`${t.items.length} 条 · 在${convs.find((c) => c.id === t.conv)?.title} · ${t.items[t.items.length - 1]?.text ?? ''}`} />
        )
      })}
      {!talks.length && <EmptyState icon={<MessagesSquare />} title="它还没和其他助手单独聊过" />}
    </>
  )
}

/** 和你:私聊的最后一句 + 群里和你有关的最近 8 条 */
function MeTab({ id }: { id: PersonId }) {
  const { convs, openDm, jump, closeAll } = useApp()
  const p = people[id]
  const dm = convs.find((c) => c.kind === 'dm' && c.members.includes(id))
  const groupMsgs = convs.flatMap((c) => c.messages.filter((m) => m.k === 'text' && (m.from === id || (m.from === 'me' && m.text.includes('@' + p.name)))).map((m) => ({ conv: c, m: m as Extract<Msg, { k: 'text' }> })))
  return (
    <>
      <Subhead className="px-1">私聊</Subhead>
      {dm ? (
        <ListItem onClick={() => openDm(id)} className="bg-hover/60 px-3"
          title={<span className="text-[13px] font-normal">{(dm.messages.filter((m) => m.k === 'text').slice(-1)[0] as { text: string } | undefined)?.text ?? '还没有消息'}</span>}
          trailing={<span className="flex shrink-0 items-center text-[12px] text-me">打开私聊<ChevronRight className="h-3.5 w-3.5" /></span>} />
      ) : <div className="px-1 text-[13px] text-fg-3">还没有私聊</div>}
      <Subhead className="px-1">在群里和你有关的消息</Subhead>
      {groupMsgs.slice(-8).map(({ conv: c, m }) => (
        <ListItem key={c.id + m.id} onClick={() => { jump(m.id); closeAll() }} className="items-start gap-2 rounded-lg px-2 py-1.5"
          media={<Avatar id={m.from} size={20} status={false} mood="idle" />}
          subtitleFirst clamp={2} subtitle={<span className="text-[11.5px] text-fg-3">{c.title}</span>} title={<span className="text-[13px]">{m.text}</span>} />
      ))}
    </>
  )
}

/** 在做的事:它的 Compute + 它在这个会话里怎么安排的 */
function WorkTab({ id, conv }: { id: PersonId; conv: string }) {
  const { convs, computes } = useApp()
  const mine = Object.values(computes).filter((c) => c.owner === id)
  return (
    <>
      {mine.map((c) => <div key={c.id} className="mb-1"><ComputeLine id={c.id} /></div>)}
      <Subhead className="px-1">它怎么安排的（{convs.find((c) => c.id === conv)?.title}）</Subhead>
      <ol className="ml-2 border-l border-line pl-3">
        {(innerLog[id] ?? []).map((l, i) => <li key={i} className="pb-2 text-[13px]"><span className="mr-2 text-[11.5px] tabular-nums text-fg-3">{l.at}</span>{renderText(l.text, false)}</li>)}
      </ol>
    </>
  )
}

/** 它记住的:性格(候选)、长期记忆、配置版本 */
function MemoryTab({ id }: { id: PersonId }) {
  const p = people[id]
  return (
    <>
      {candidate('U61') && <>
        <Subhead className="px-1">性格（它自己会慢慢改，改了留版本）</Subhead>
        <Surface elevation="sunken" className="px-3 py-2.5 text-[13px] leading-relaxed">{p.soul}</Surface>
      </>}
      <Subhead className="px-1">长期记忆</Subhead>
      {(p.memory ?? []).map((m, i) => <div key={i} className="flex gap-2 rounded-lg px-2 py-1.5 text-[13px]"><span aria-hidden className="text-fg-3">·</span><span className="min-w-0 flex-1">{m.text}</span><span className="max-w-[35%] shrink-0 truncate text-[11.5px] text-fg-3">{m.src}</span></div>)}
      <Subhead className="px-1">配置版本</Subhead>
      {(p.versions ?? []).map((v) => (
        <div key={v.v} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]">
          <span className="w-7 shrink-0 tabular-nums text-fg-3">v{v.v}</span><span className="min-w-0 flex-1 truncate">{v.note}</span><span className="shrink-0 text-[11.5px] tabular-nums text-fg-3">{v.at}</span>
          {v.v !== p.versions![0].v && <Button variant="link" size="xs" className="h-6 text-[12px]">回到这版</Button>}
        </div>
      ))}
    </>
  )
}
