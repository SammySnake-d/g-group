import { Button } from '@astryxdesign/core/Button'
import { HoverCard } from '@astryxdesign/core/HoverCard'
import { OverflowList } from '@astryxdesign/core/OverflowList'
import { Popover } from '@astryxdesign/core/Popover'
import { cn } from '@/lib/utils'
import { FileText } from 'lucide-react'
import { people, type Artifact } from '@/data'
import { useApp } from '@/store'
import { Avatar } from '../Avatar'
import { messageText, provenance, sourceLabel, type Hop } from './context'

const who = (h: Hop) => (h.from ? people[h.from].name : '系统')

/** 一站的原话:和聊天里同一套「名字 + 正文」,不加说明 */
function HopWords({ hop }: { hop: Hop }) {
  return <div className="max-w-[320px] space-y-1.5 text-[13px] leading-relaxed">
    <div className="font-semibold">{who(hop)}</div>
    {hop.msgs.map((m) => m.k === 'file'
      ? <p key={m.id} className="flex items-center gap-1.5 text-fg"><FileText className="h-3.5 w-3.5 shrink-0 text-fg-2" /><span className="truncate">{messageText(m)}</span></p>
      : <p key={m.id} className="line-clamp-4 whitespace-pre-line text-fg-2">{messageText(m).replace(/\n{2,}/g, '\n')}</p>)}
  </div>
}

function HopButton({ hop, onGo }: { hop: Hop; onGo: (id: string) => void }) {
  return <HoverCard content={<HopWords hop={hop} />} placement="below" alignment="start" delay={250}>
    <Button variant="ghost" size="sm" label={`${who(hop)}${hop.verb ? ' ' + hop.verb : ''}，回到原消息`} onClick={() => onGo(hop.target.id)}
      data-testid={`file-hop-${hop.target.id}`} data-source={hop.isSource ? 'true' : undefined}
      className="gap-1.5 px-1.5">
      <span className="flex items-center gap-1.5">
        {hop.from && <Avatar id={hop.from} size={20} status={false} mood="idle" />}
        {hop.verb && <span className={cn('text-[13px]', hop.isSource ? 'font-medium text-fg' : 'text-fg-2')}>{hop.verb}</span>}
      </span>
    </Button>
  </HoverCard>
}

/** 文件的来处:对话名 + 这份文件在对话里经过的几个人。一行放得下就全摆出来,放不下的收进「+N」 */
export function Provenance({ artifact: a }: { artifact: Artifact }) {
  const { convs, jump: jumpTo, openConv: open, setFileReturn } = useApp((s) => ({ convs: s.convs, jump: s.jump, openConv: s.openConv, setFileReturn: s.setFileReturn }))
  const { conv, hops } = provenance(a, convs)
  // 从来处进聊天都记下回程,聊天里顶上给一个回到这份文件的入口
  const trip = <T,>(go: (x: T) => void) => (x: T) => { go(x); if (conv) setFileReturn({ file: a.id, conv: conv.id }) }
  const jump = trip(jumpTo)
  const openConv = trip(open)
  return <div data-testid="file-source" className="flex min-w-0 flex-1 items-center gap-1">
    {conv
      ? <Button variant="ghost" size="sm" label={`打开${sourceLabel(conv)}`} onClick={() => openConv(conv.id)} data-testid="file-open-conv" className="min-w-0 shrink px-2">
          <span className="truncate text-[14px] font-medium">{sourceLabel(conv)}</span>
        </Button>
      : <span className="px-2 text-[14px] text-fg-2">{sourceLabel(conv)}</span>}
    {hops.length > 0 && <span aria-hidden className="h-4 w-px shrink-0 bg-line" />}
    {hops.length > 0 && <OverflowList gap={0} minVisibleItems={1} className="min-w-0 flex-1 items-center" data-testid="file-hops"
      overflowRenderer={(rest) => <Popover placement="below" alignment="start" label="其余来处" content={<div className="flex flex-col py-1">
        {rest.map(({ index }) => { const h = hops[index]; return <Button key={h.key} variant="ghost" size="sm" label={`${who(h)}${h.verb ? ' ' + h.verb : ''}，回到原消息`} onClick={() => jump(h.target.id)} className="justify-start">
          <span className="flex min-w-0 max-w-[300px] items-center gap-2 text-[13px]">
            {h.from && <Avatar id={h.from} size={18} status={false} mood="idle" />}
            {h.verb && <span className="shrink-0 text-fg-2">{h.verb}</span>}
            <span className="truncate">{messageText(h.target)}</span>
          </span>
        </Button> })}
      </div>}>
        <Button variant="ghost" size="sm" label={`还有 ${rest.length} 处`} data-testid="file-hops-more"><span className="text-[13px] tabular-nums text-fg-2">+{rest.length}</span></Button>
      </Popover>}>
      {hops.map((h, i) => <span key={h.key} className="flex items-center">
        {i > 0 && <span aria-hidden className="mx-0.5 h-px w-2.5 bg-line" />}
        <HopButton hop={h} onGo={jump} />
      </span>)}
    </OverflowList>}
  </div>
}
