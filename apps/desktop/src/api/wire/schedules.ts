// 定时接线(AC-53 三视角共用一份真源):schedules.list 全量读 → 定时切片;schedule.updated 整条换,schedule.removed 删掉。
import type { ScheduleView } from '@g-group/api-contract'
import { people, type Cron, type CronRun } from '@/data'
import { msgId } from './messages'
import { defineWiring, read, type WireCtx } from './types'

const RUN: Record<NonNullable<ScheduleView['lastRun']>['status'], { result: CronRun['result']; note: string }> = {
  ok: { result: 'said', note: '到点做了，发了结果' },
  running: { result: 'said', note: '正在做' },
  failed: { result: 'error', note: '没做成' },
  missed: { result: 'error', note: '错过了这一次' },
}

export function toCron(s: ScheduleView): Cron | null {
  if (!people[s.contactId]) return null
  const last = s.lastRun
  return {
    id: s.id, owner: s.contactId, conv: s.roomId, text: s.prompt,
    trigger: { kind: 'cron', expr: s.cron }, speak: 'always', paused: !s.enabled,
    runs: last ? [{ at: last.at, ...RUN[last.status] }] : [],
  }
}

export const schedulesWiring = defineWiring({
  entity: '定时',
  load: async (w) => {
    const { schedules } = await read(w, 'schedules.list', {})
    w.get().setCrons(schedules.flatMap((s) => toCron(s) ?? []))
  },
  on: {
    'schedule.updated': (ev, w) => { const c = toCron(ev.schedule); if (c) w.get().putCron(c) },
    'schedule.removed': (ev, w) => w.get().dropCron(ev.scheduleId),
  },
})

export async function loadCronRuns(w: WireCtx, id: string) {
  const c = w.get().crons.find((x) => x.id === id)
  if (!c) return
  const { runs } = await read(w, 'schedules.history', { scheduleId: id, limit: 20 })
  const list: CronRun[] = runs.map((r) => ({
    at: r.at, ...RUN[r.status], ...(r.error ? { note: `${RUN[r.status].note}：${r.error}` } : {}),
    ...(r.messageSeq !== null ? { msg: msgId(c.conv, r.messageSeq) } : {}),
  }))
  const cur = w.get().crons.find((x) => x.id === id)
  if (cur) w.get().setCrons(w.get().crons.map((x) => (x.id === id ? { ...x, runs: list } : x)))
}
