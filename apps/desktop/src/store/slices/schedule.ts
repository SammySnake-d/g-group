// 定时切片(#1858):在面板里改动,原会话只插一行居中灰字,不让助手发气泡刷屏。
// 下次运行由 trigger / paused 现算,改时间、暂停、删除各个视角立刻一致(AC-35① AC-53)。
// 按 cron 表达式触发的定时同时经合同写到后端(schedules.create / update / remove / runNow);
// 事件触发、每 N 条消息触发、说话方式、改负责人 / 挪会话是合同缺口,只在本地。
import { describeTrigger } from '@g-group/ui-core'
import { crons0, people, pulse0, type Cron, type Msg, type PulseItem } from '@/data'
import { broken } from '@/mut'
import { scheduleCreate, scheduleUpdate } from '@/api/adapters'
import { uid } from '../boot'
import { sync } from '../remote'
import { lens, type Slice } from '../state'
import type { Ctx } from '../types'

export type ScheduleSlice = Pick<Ctx, 'crons' | 'pulse' | 'scheduleDraft' | 'openSchedule' | 'updateCron' | 'addCron' | 'removeCron' | 'runCronNow'> & {
  /** #2273 U80:「每 N 条消息醒一次」的计数;满 N 条写一段摘要挂到时间线 */
  countMessage: (m: Extract<Msg, { k: 'text' | 'file' }>, cid: string) => void
}

export const createScheduleSlice: Slice<ScheduleSlice> = (set, get) => {
  const L = lens(set)
  const sys = (cid: string, text: string) => get().pushMsg({ k: 'sys', id: 's' + uid(), text }, cid)
  /* 本地定时 id → 后端定时 id。演示服务用同一份初始数据做种子,初始的那些 id 相同;新建的等 create 回包再记 */
  const remote = new Map<string, Promise<string | null>>(crons0.filter((c) => c.trigger.kind === 'cron').map((c) => [c.id, Promise.resolve(c.id)]))
  const create = (id: string, c: Omit<Cron, 'id' | 'runs'>) => {
    const p = scheduleCreate(c, uid())
    if (p) remote.set(id, sync('schedules.create', p, '定时').then((v) => v?.id ?? null))
  }

  return {
    crons: crons0,
    pulse: pulse0,
    scheduleDraft: null,
    openSchedule: (scheduleDraft) => set({ scheduleDraft }),

    countMessage: (m, cid) => {
      const added: PulseItem[] = []
      const crons = get().crons.map((x) => {
        if (x.conv !== cid || x.paused || x.trigger.kind !== 'messages') return x
        const w = x.trigger
        const seen = w.seen + 1
        if (seen < w.n) return { ...x, trigger: { ...w, seen } }
        const now = new Date()
        const at = now.toTimeString().slice(0, 5)
        added.push({ id: 'pl' + uid(), conv: cid, at: `今天 ${at}`, by: x.owner, text: '最近这段：' + ('text' in m ? m.text.replace(/@\S+\s*/g, '').slice(0, 24) : '传了文件') + '…', from: m.id, to: m.id, n: w.n })
        return { ...x, trigger: { ...w, seen: 0 }, runs: [{ at: now.toISOString(), result: 'said' as const, note: '满 ' + w.n + ' 条，写了一段摘要挂到时间线' }, ...x.runs].slice(0, 20) }
      })
      set((s) => ({ crons, pulse: added.length ? [...s.pulse, ...added] : s.pulse }))
    },

    updateCron: (id, patch) => {
      const { crons, convs } = get()
      const c = crons.find((x) => x.id === id)
      L.crons((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)))
      if (!c) return
      const who = people[c.owner].name
      const rule = patch.trigger ? describeTrigger(patch.trigger) : ''
      const changes = [
        patch.trigger && rule !== describeTrigger(c.trigger) ? `改成 ${rule}` : '',
        patch.text && patch.text !== c.text ? `内容改成「${patch.text}」` : '',
        patch.owner && patch.owner !== c.owner ? `交给 ${people[patch.owner].name}` : '',
        patch.conv && patch.conv !== c.conv ? `挪到「${convs.find((x) => x.id === patch.conv)?.title ?? patch.conv}」` : '',
        patch.speak && patch.speak !== c.speak ? (patch.speak === 'only-if' ? '改成有情况才说' : '改成每次都发结果') : '',
      ].filter(Boolean)
      const paused = patch.paused === true && !c.paused ? '暂停了' : patch.paused === false && c.paused ? '重新打开了' : ''
      const what = [paused, changes.length ? changes.join('，') : ''].filter(Boolean).join('，')
      if (what) sys(patch.conv ?? c.conv, `你把 ${who} 的定时「${c.text}」${what}`)
      /* 写到后端:触发方式改成了事件 / 按消息数,合同表达不了,后端那份删掉;从那两种改回 cron 就新建一份 */
      const next = { ...c, ...patch }
      const rid = remote.get(id)
      if (next.trigger.kind !== 'cron') { if (rid) { remote.delete(id); void rid.then((r) => { if (r) void sync('schedules.remove', { scheduleId: r }, '定时') }) } }
      else if (!rid) create(id, next)
      else void rid.then((r) => { const u = r && scheduleUpdate(r, patch); if (u) void sync('schedules.update', u, '定时') })
    },
    addCron: (c, via) => {
      const id = 'cr' + uid()
      L.crons((l) => [...l, { ...c, id, runs: [] }])
      create(id, c)
      if (via === 'panel') sys(c.conv, `你给 ${people[c.owner].name} 加了定时：${describeTrigger(c.trigger)}「${c.text}」${c.paused ? '（先不开）' : ''}`)
      return id
    },
    removeCron: (id) => {
      const c = get().crons.find((x) => x.id === id)
      L.crons((l) => l.filter((x) => x.id !== id))
      if (c) { sys(c.conv, `你删掉了 ${people[c.owner].name} 的定时「${c.text}」`); get().toast('已删除定时') }
      const rid = remote.get(id)
      remote.delete(id)
      void rid?.then((r) => { if (r) void sync('schedules.remove', { scheduleId: r }, '定时') })
    },
    runCronNow: (id) => {
      const { crons, convs } = get()
      const c = crons.find((x) => x.id === id)
      if (!c) return
      const silent = c.speak === 'only-if'
      const mid = 'r-' + uid()
      const cv = convs.find((x) => x.id === c.conv)
      const loaded = Object.fromEntries((cv?.notices ?? []).map((n) => [n.id, broken('AC-35-11') ? (c.runs[0]?.notices?.[n.id] ?? n.ver) : n.ver]))
      const now = new Date()
      L.crons((l) => l.map((x) => (x.id === id ? { ...x, runs: [{ at: now.toISOString(), notices: loaded, result: (silent ? 'silent' : 'said') as 'silent' | 'said', note: silent ? '手动试跑：看过了，没有情况，没发消息' : '手动试跑：发了结果', ...(silent ? {} : { msg: mid }) }, ...x.runs].slice(0, 20) } : x)))
      if (!silent) get().say(c.conv, c.owner, `（手动试跑）${c.text}：已经做完，这是这次的结果。`, 900, { id: mid, cron: c.id, at: now.toTimeString().slice(0, 5) })
      else get().toast(`${people[c.owner].name} 看过了，没有情况，所以没发消息`)
      void remote.get(id)?.then((r) => { if (r) void sync('schedules.runNow', { scheduleId: r, clientActionId: uid() }, '试跑') })
    },
  }
}
