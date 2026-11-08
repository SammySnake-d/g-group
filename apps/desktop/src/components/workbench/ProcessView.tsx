import { useState } from 'react'
import { History } from 'lucide-react'
import { people, innerLog, type Msg, type PersonId } from '@/data'
import { useApp } from '@/ctx'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/section'
import { GroupAvatar } from '../Avatar'
import { MessageList } from '../Messages'

/* 联系人的完整过程:和聊天同一套模板,只有它一个人说话。从某个群打开时先只看这个群,可以「看全部」 */
type Log = (typeof innerLog)[string]

/** 连续同一会话的记录归成一段 */
function segments(log: Log) {
  const segs: { conv: string; items: Log }[] = []
  for (const l of log) {
    const last = segs[segs.length - 1]
    if (last && last.conv === l.conv) last.items.push(l)
    else segs.push({ conv: l.conv, items: [l] })
  }
  return segs
}

/** 一段过程记录 → 消息列表(换了时间插一行日期,带 Compute 的跟一张 Compute 卡) */
function toMsgs(id: PersonId, items: Log, seg: number): Msg[] {
  const out: Msg[] = []
  let at = ''
  items.forEach((l, i) => {
    if (l.at !== at) { out.push({ k: 'date', text: l.at }); at = l.at }
    out.push({ k: 'text', id: `pv-${id}-${seg}-${i}`, from: id, text: l.text })
    if (l.computeId) out.push({ k: 'compute', id: `pv-${id}-${seg}-${i}-c`, from: id, computeId: l.computeId })
  })
  return out
}

export function ProcessView({ id, conv }: { id: PersonId; conv?: string }) {
  const { convs } = useApp()
  const [all, setAll] = useState(false)
  const p = people[id]
  const only = conv && !all ? conv : undefined
  const log = (innerLog[id] ?? []).filter((l) => !only || l.conv === only)
  const title = (cid: string) => {
    const c = convs.find((x) => x.id === cid)
    return c ? (c.kind === 'dm' ? `与 ${c.title} 私聊` : c.title) : cid
  }
  return (
    <div data-testid={`process-${id}`} data-conv={only ?? 'all'} className="flex min-w-0 flex-col px-4 pb-6">
      <div className="sticky top-0 z-10 -mx-4 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur">
        <div className="text-center text-[12px] text-fg-3">这里只能看。可以停下某个 Compute 或补一句，不能在这里聊天。</div>
        {only && (
          <div className="mt-1 flex items-center justify-center gap-1 text-[12.5px] text-fg-2">
            <span className="min-w-0 truncate">只看「{title(only)}」里的 ·</span>
            <Button data-testid="process-show-all" variant="link" size="xs" onClick={() => setAll(true)} className="h-auto px-0 text-[12.5px] font-medium text-fg">看全部 ›</Button>
          </div>
        )}
      </div>
      {!log.length && <EmptyState icon={<History />} title={`${p?.name ?? '它'}${only ? '在这里' : ''}还没有过程记录`} />}
      {segments(log).map((s, i) => {
        const c = convs.find((x) => x.id === s.conv)
        return (
          <div key={i}>
            {!only && (
              <div data-testid={`process-seg-${s.conv}`} className="mt-4 flex items-center gap-2 rounded-lg bg-hover/60 px-2.5 py-1.5">
                {c?.kind === 'group' ? <GroupAvatar ids={c.members} size={20} /> : null}
                <span className="min-w-0 truncate text-[12.5px] font-semibold">{title(s.conv)}</span>
                <span className="shrink-0 text-[12px] text-fg-3">在这个群</span>
              </div>
            )}
            <MessageList msgs={toMsgs(id, s.items, i)} compact conv={s.conv} />
          </div>
        )
      })}
    </div>
  )
}
