import { AlarmClock, UserPlus, UsersRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { Avatar, GroupAvatar } from '@/components/Avatar'
import { cronFailed } from '@/cronView'
import { people, type PersonId } from '@/data'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'
import { ListRow } from '../ListRow'

const groupLabel = 'px-2 pb-1 pt-3 text-[12px] font-medium text-fg-3'

/** 通讯录:新建入口、助手(带它的定时数)、群聊 */
export function ContactList({ query }: { query: string }) {
  const { convs, contact, push, pickContact, setActive, contactIds } = useApp((s) => ({ convs: s.convs, contact: s.contact, push: s.push, pickContact: s.pickContact, setActive: s.setActive, contactIds: s.contactIds }))
  const setSection = useApp((s) => s.setSection)
  /* 通讯录列谁由联系人切片定(演示数据或后端 contacts.list),资料从登记表查 */
  const bots = contactIds.flatMap((id) => people[id] ?? [])
  const groups = convs.filter((c) => c.kind === 'group')
  return (
    <>
      <Entry icon={<UserPlus className="h-4 w-4" />} onClick={() => push({ t: 'addContact' }, true)}>添加联系人</Entry>
      <Entry icon={<UsersRound className="h-4 w-4" />} onClick={() => push({ t: 'newGroup' }, true)}>发起群聊</Entry>
      <div className={groupLabel}>助手 · <span className="tabular-nums">{bots.length}</span></div>
      {bots.filter((p) => !query || p.name.includes(query)).map((p) => (
        <ListRow key={p.id} data-testid={`contact-${p.id}`} onClick={() => pickContact(p.id)} selected={contact === p.id} className="gap-2.5 rounded-xl px-2 py-1.5">
          <Avatar id={p.id} size={36} />
          <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{p.name}</div><div className="truncate text-[12px] text-fg-2">{p.role}</div></div>
          <CronCount id={p.id} />
        </ListRow>
      ))}
      <div className={groupLabel}>群聊 · <span className="tabular-nums">{groups.length}</span></div>
      {groups.map((c) => (
        <ListRow key={c.id} onClick={() => { setSection('chat'); setActive(c.id) }} className="gap-2.5 rounded-xl px-2 py-1.5">
          <GroupAvatar ids={c.members} size={36} />
          <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{c.title}</div><div className="text-[12px] tabular-nums text-fg-2">{c.members.length} 人</div></div>
        </ListRow>
      ))}
    </>
  )
}

function Entry({ icon, onClick, children }: { icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <ListRow onClick={onClick} className="gap-2.5 rounded-xl px-2 py-2">
      <span className="grid h-9 w-9 place-items-center rounded-full bg-hover text-fg-2">{icon}</span>
      <span className="text-[14px]">{children}</span>
    </ListRow>
  )
}

/** 联系人行尾:它开着的定时数,有失败的标红 */
function CronCount({ id }: { id: PersonId }) {
  const crons = useApp((s) => s.crons)
  const mine = crons.filter((c) => c.owner === id && !c.paused)
  const bad = mine.filter(cronFailed).length
  if (!mine.length) return null
  return <span data-testid={`contact-cron-${id}`} title="它的定时" className={cn('flex shrink-0 items-center gap-0.5 text-[11.5px] tabular-nums', bad ? 'font-medium text-err' : 'text-fg-3')}><AlarmClock className="h-3 w-3" />{bad ? `${bad} 异常` : mine.length}</span>
}
