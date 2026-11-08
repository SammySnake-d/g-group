/* 群成员：身份 + 状态，点头像出菜单。AC-49 拖拽：从左侧联系人拖进来 = 拉进群；把成员拖到底部「移出群」 = 移出。 */
import { useState } from 'react'
import { Search } from 'lucide-react'
import { useApp } from '@/ctx'
import { dutyByConv, people, type Conversation, type PersonId } from '@/data'
import { drag, endDrag, startDrag } from '@/drag'
import { broken } from '@/mut'
import { Avatar, useLive } from '@/components/Avatar'
import { PersonMenu } from '@/components/Messages'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Input } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { LIVE_TEXT, LIVE_TONE, MEMBERS } from './constants'

function MemberRow({ id, role, silenced, duty, onDrag }: { id: PersonId; role?: 'owner' | 'admin'; silenced?: boolean; duty?: string; onDrag?: (on: boolean) => void }) {
  const p = people[id]
  const live = useLive(id)
  const row = (
    <Button data-testid={`side-member-${id}`} variant="ghost" size={null} draggable={id !== 'me'}
      onDragStart={(e) => { startDrag(e, id as never, 'member'); onDrag?.(true) }} onDragEnd={() => { endDrag(); onDrag?.(false) }}
      className="h-auto w-full justify-start gap-2.5 rounded-lg px-2 py-[7px] text-left font-normal text-fg active:scale-100">
      <Avatar id={id} size={28} />
      <span className="min-w-0 flex-1 truncate text-[13px]">{id === 'me' ? `${p.name}（你）` : p.name}{duty && <span className="ml-1.5 text-[11.5px] text-fg-3">{duty}</span>}</span>
      {silenced && <Chip tone="neutral" size="xs">禁言中</Chip>}
      {LIVE_TEXT[live] && <Chip tone={LIVE_TONE[live]} size="xs">{LIVE_TEXT[live]}</Chip>}
      {role === 'owner' && <Chip tone="warm" size="xs">群主</Chip>}
      {role === 'admin' && <Chip tone="link" size="xs">管理员</Chip>}
      {!p.human && !role && <Chip tone="neutral" size="xs" className="font-normal text-fg-3">助手</Chip>}
    </Button>
  )
  return id === 'me' ? row : <PersonMenu id={id} side="left">{row}</PersonMenu>
}

export function MembersTab({ conv }: { conv: Conversation }) {
  const { addMembers, removeMember } = useApp()
  const [over, setOver] = useState<null | 'in' | 'dup' | 'out'>(null)
  const [dragging, setDragging] = useState(false)
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const roleOrder = (m: string) => (conv.roles?.[m] === 'owner' ? 0 : conv.roles?.[m] === 'admin' ? 1 : people[m].human ? 3 : 2)
  const members = [...conv.members].sort((a, b) => roleOrder(a) - roleOrder(b)).filter((m) => !q || people[m].name.toLowerCase().includes(q.toLowerCase()))
  const bots = conv.members.filter((m) => !people[m].human).length
  return (
    <>
      <div className="mb-1 flex h-8 items-center gap-1 px-4 pt-1.5">
        {searching ? (
          <Input autoFocus size="sm" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => !q && setSearching(false)} placeholder={MEMBERS.search} aria-label={MEMBERS.search} className="h-7 bg-side" />
        ) : <span className="flex-1 text-[12px] tabular-nums text-fg-3">{bots} 位助手 · {conv.members.length - bots} 位成员</span>}
        <IconButton label={MEMBERS.search} size="icon-sm" icon={<Search />} active={searching} onClick={() => setSearching((x) => !x)} className="text-fg-3" />
      </div>
      <div data-testid="side-members-drop" data-over={over ?? ''} className={cn('mx-2 rounded-lg transition-[background-color,box-shadow] duration-fast ease-out [--avatar-ring:var(--bg)]', over === 'in' && 'bg-me/10 ring-1 ring-me/40', over === 'dup' && 'bg-hover')}
        onDragOver={(e) => { if (drag.from !== 'contact' || !drag.who) return; e.preventDefault(); setOver(conv.members.includes(drag.who) && !broken('AC-49-3') ? 'dup' : 'in') }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null) }}
        onDrop={(e) => { e.preventDefault(); const w = drag.who; const ok = over === 'in'; setOver(null); endDrag(); if (w && ok && !broken('AC-49-1')) addMembers(conv.id, [w]) }}>
        {(over === 'in' || over === 'dup') && drag.who && <div data-testid="side-drop-hint" className={cn('px-2 py-1.5 text-[12px]', over === 'in' ? 'text-me' : 'text-fg-3')}>{over === 'in' ? `松手把 ${people[drag.who].name} 拉进群` : `${people[drag.who].name} 已经在群里`}</div>}
        {members.map((m) => <MemberRow key={m} id={m} role={conv.roles?.[m]} silenced={!!conv.silenced?.[m]} duty={dutyByConv[conv.id]?.[m]} onDrag={setDragging} />)}
      </div>
      {dragging && !broken('AC-49-2') && (
        <div data-testid="side-drop-out" data-over={over === 'out' ? '1' : '0'} className={cn('mx-3 mt-2 grid h-11 place-items-center rounded-lg border border-dashed text-[12.5px] transition-colors duration-fast', over === 'out' ? 'border-err bg-err-soft text-err' : 'border-line text-fg-3')}
          onDragOver={(e) => { if (drag.from !== 'member') return; e.preventDefault(); setOver('out') }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => { e.preventDefault(); const w = drag.who; setOver(null); setDragging(false); endDrag(); if (w && w !== 'me') removeMember(conv.id, w) }}>
          {MEMBERS.dropOut}
        </div>
      )}
    </>
  )
}
