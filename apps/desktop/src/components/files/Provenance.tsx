import { useState } from 'react'
import { MessagesSquare } from 'lucide-react'
import { Button } from '@astryxdesign/core/Button'
import { HoverCard } from '@astryxdesign/core/HoverCard'
import { List, ListItem } from '@astryxdesign/core/List'
import { cn } from '@/lib/utils'
import type { Artifact } from '@/data'
import { useApp } from '@/store'
import { Avatar } from '../Avatar'
import { hopQuote, hopWho, provenance, sourceLabel, type Hop } from './context'

/* 文件的来处:这份文件在对话里经过的人、各自做了什么、说了什么。放在正文右侧,随阅读位置固定,
   文档再长、翻到哪里都看得见。点一站回到那条消息,聊天顶上留一枚回到文件的入口。 */
function useProvenance(a: Artifact) {
  const { convs, jump: jumpTo, openConv: open, setFileReturn } = useApp((s) => ({ convs: s.convs, jump: s.jump, openConv: s.openConv, setFileReturn: s.setFileReturn }))
  const { conv, hops } = provenance(a, convs)
  const trip = <T,>(go: (x: T) => void) => (x: T) => { go(x); if (conv) setFileReturn({ file: a.id, conv: conv.id }) }
  return { conv, hops, jump: trip(jumpTo), openConv: trip(open) }
}

const hopLabel = (h: Hop) => `${hopWho(h)}${h.verb ? ' ' + h.verb : ''}：${hopQuote(h)}`
const FOLD = 5

function Who({ h }: { h: Hop }) {
  return <span className="flex min-w-0 items-baseline gap-1.5 text-[13px] leading-5">
    <span className="truncate font-semibold text-fg">{hopWho(h)}</span>
    {h.verb && <span className={cn('shrink-0', h.isSource ? 'font-medium text-fg' : 'text-fg-2')}>{h.verb}</span>}
  </span>
}

/** 右侧来往:对话名 + 每站「人 动作」和原话头两行(交付那站三行)。站多时先列 5 站,其余点开 */
export function ProvenanceThread({ artifact: a }: { artifact: Artifact }) {
  const { conv, hops, jump, openConv } = useProvenance(a)
  const [open, setOpen] = useState(false)
  const shown = open || hops.length <= FOLD + 1 ? hops : hops.slice(0, FOLD)
  return <nav aria-label="来处" data-testid="file-source" data-place="margin" className="min-w-0">
    {conv
      ? <Button variant="ghost" size="sm" label={`打开${sourceLabel(conv)}`} onClick={() => openConv(conv.id)} data-testid="file-open-conv" className="-ml-1.5 mb-1 h-7 max-w-full justify-start px-1.5">
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-fg-2"><MessagesSquare className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} /><span className="truncate">{sourceLabel(conv)}</span></span>
        </Button>
      : <p className="mb-1 text-[13px] text-fg-2">{sourceLabel(conv)}</p>}
    {hops.length > 0 && <List density="compact" edge="outset" aria-label="经手的人">
      {shown.map((h) => <ListItem key={h.key} align="first-line" data-testid={`file-hop-${h.target.id}`} data-source={h.isSource ? 'true' : undefined}
        startContent={h.from ? <Avatar id={h.from} size={22} status={false} mood="idle" /> : undefined}
        label={<Who h={h} />}
        description={<span className={cn('mt-0.5 block whitespace-normal break-words text-[13px] leading-[1.55]', h.isSource ? 'line-clamp-3 text-fg' : 'line-clamp-2 text-fg-2')}>{hopQuote(h)}</span>}
        onClick={() => jump(h.target.id)} aria-label={`${hopLabel(h)}，回到原消息`} />)}
    </List>}
    {shown.length < hops.length && <Button variant="ghost" size="sm" label={`另外 ${hops.length - shown.length} 处`} onClick={() => setOpen(true)} data-testid="file-hops-more" className="mt-0.5 h-7 px-1.5">
      <span className="text-[13px] text-fg-2">另外 {hops.length - shown.length} 处</span>
    </Button>}
  </nav>
}

/** 窗口很窄时右侧只留一列头像:悬停或聚焦看原话,点了回到原消息 */
export function ProvenanceRail({ artifact: a }: { artifact: Artifact }) {
  const { conv, hops, jump, openConv } = useProvenance(a)
  return <nav aria-label="来处" data-testid="file-source" data-place="rail" className="flex flex-col items-center gap-1">
    {conv && <Button variant="ghost" size="sm" isIconOnly label={`打开${sourceLabel(conv)}`} icon={<MessagesSquare strokeWidth={1.8} />} onClick={() => openConv(conv.id)} data-testid="file-open-conv" />}
    {hops.map((h) => <HoverCard key={h.key} placement="start" alignment="start" delay={150} label={hopLabel(h)}
      content={<div className="max-w-[280px] space-y-1"><Who h={h} /><p className="whitespace-pre-line text-[13px] leading-[1.55] text-fg-2">{hopQuote(h)}</p></div>}>
      <Button variant="ghost" size="sm" isIconOnly label={`${hopLabel(h)}，回到原消息`} onClick={() => jump(h.target.id)} data-testid={`file-hop-${h.target.id}`} data-source={h.isSource ? 'true' : undefined}
        icon={h.from ? <Avatar id={h.from} size={22} status={false} mood="idle" /> : <MessagesSquare />} />
    </HoverCard>)}
  </nav>
}
