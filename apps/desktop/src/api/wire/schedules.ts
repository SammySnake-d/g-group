// 定时接线(AC-53 三视角共用一份真源):schedules.list 全量读 → 定时切片;schedule.updated 整条换,schedule.removed 删掉。
// 群资料「定时」页按会话筛(群视角只看本群),联系人工作台、总览读的是同一份。写走切片里已有的合同调用(schedules.create / update / remove / runNow)。
// 合同只表达按 cron 触发、每次都发结果;事件触发、按消息数触发、「有情况才说」是合同缺口,读回来的都是 cron。
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

/** 合同的定时 → 界面的定时;执行的联系人还没登记(没读到 / 已删除)时返回 null */
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

/** 运行记录(schedules.history,新的在前):打开定时详情时读;发了消息的那次能点回那条消息 */
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
