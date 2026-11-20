import { scheduleHint } from '@g-group/ui-core'
import { CronEditor } from '@/components/CronEditor'
import { people, type Conversation } from '@/data'
import { useApp } from '@/store'

export function ScheduleDialog({ conv }: { conv: Conversation }) {
  const { d, openSchedule, addCron } = useApp((s) => ({ d: s.scheduleDraft, openSchedule: s.openSchedule, addCron: s.addCron }))
  if (!d || d.conv !== conv.id) return null
  const hint = scheduleHint(d.when ?? '')
  const [hh, mm] = (hint.time ?? '09:00').split(':').map(Number) as [number, number]
  const dow = hint.repeat === '工作日' ? '1-5' : hint.repeat === '每周一' ? '1' : '*'
  const expr = hint.cron ?? (hint.time ? `${mm} ${hh} * * ${dow}` : undefined)
  const peer = conv.kind === 'dm' ? conv.members.find((m) => m !== 'me' && !people[m]?.human) : undefined
  return <CronEditor open seed={{ text: d.what ?? '', ...(expr ? { expr } : {}) }} conv={d.conv} {...(peer ? { owner: peer } : {})} onClose={() => openSchedule(null)} onSave={(c) => { addCron(c, 'panel'); openSchedule(null) }} />
}
