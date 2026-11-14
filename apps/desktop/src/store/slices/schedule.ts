// 定时切片(#1858):在面板里改动,原会话只插一行居中灰字,不让助手发气泡刷屏。
// 下次运行由 trigger / paused 现算,改时间、暂停、删除各个视角立刻一致(AC-35① AC-53)。
// 按 cron 表达式触发的定时同时经合同写到后端(schedules.create / update / remove / runNow);
// 事件触发、每 N 条消息触发、说话方式、改负责人 / 挪会话是合同缺口,只在本地。
import { describeTrigger } from '@g-group/ui-core'
import { crons0, people, type Cron, type Msg, type PulseItem } from '@/data'
import { broken } from '@/mut'
import { scheduleCreate, scheduleUpdate } from '@/api/adapters'
import { live } from '@/api/wire/live'
import { liveCtx } from '@/api/wire/live'
import { loadCronRuns, toCron } from '@/api/wire/schedules'
import { uid } from '../boot'
import { sync } from '../remote'
import { lens, type Slice } from '../state'
import type { ScheduleDraft } from '../types'

/** 这一片经 useApp() 对外暴露的字段(Ctx 的一部分)。加字段:写在这里,再把名字加进下面的 SCHEDULE_CTX_KEYS */
export interface ScheduleCtx {
  crons: Cron[]
  pulse: PulseItem[]
  /** 定时草稿：/schedule 带过来的「何时 / 做什么」。openSchedule(草稿) 打开定时编辑并预填，null 关掉；
   *  定时编辑器读 scheduleDraft 预填（现在由输入框里的定时弹窗读，定时模块换新编辑器时接同一份） */
  scheduleDraft: ScheduleDraft | null
  openSchedule: (d: ScheduleDraft | null) => void
  updateCron: (id: string, patch: Partial<Cron>) => void
  /** 新建定时；下次运行由 trigger 现算，runs 从空开始 */
  addCron: (c: Omit<Cron, 'id' | 'runs'>, via: 'chat' | 'panel') => string
  removeCron: (id: string) => void
  runCronNow: (id: string) => void
}
export const SCHEDULE_CTX_KEYS = ['crons', 'pulse', 'scheduleDraft', 'openSchedule', 'updateCron', 'addCron', 'removeCron', 'runCronNow'] as const satisfies readonly (keyof ScheduleCtx)[]

export type ScheduleSlice = ScheduleCtx & {
  /** 定时整表换掉 / 换一条 / 删一条(连上后端时由 api/wire/schedules 写) */
  setCrons: (list: Cron[]) => void
  putCron: (c: Cron) => void
  dropCron: (id: string) => void
  /** 连上后端时读这条定时的运行记录(schedules.history);没连上什么都不做 */
  loadCronRuns: (id: string) => void
  /** #2273 U80:「每 N 条消息醒一次」的计数;满 N 条写一段摘要挂到时间线 */
  countMessage: (m: Extract<Msg, { k: 'text' | 'file' }>, cid: string) => void
}

export const createScheduleSlice: Slice<ScheduleSlice> = (set, get) => {
  const L = lens(set)
  /* 连上后端时不往聊天里插本地灰字(刷新就没了,也不在后端记录里),改成提示一句 */
  const sys = (cid: string, text: string) => (live(get()) ? get().toast(text) : get().pushMsg({ k: 'sys', id: 's' + uid(), text }, cid))
  /* 本地定时 id → 后端定时 id。演示服务用同一份初始数据做种子,初始的那些 id 相同;新建的等 create 回包再记 */
  const remote = new Map<string, Promise<string | null>>(crons0.filter((c) => c.trigger.kind === 'cron').map((c) => [c.id, Promise.resolve(c.id)]))
  const create = (id: string, c: Omit<Cron, 'id' | 'runs'>) => {
    const p = scheduleCreate(c, uid())
    if (p) remote.set(id, sync('schedules.create', p, '定时').then((v) => v?.id ?? null))
  }
  /** 本地定时对应的后端 id:连上后端时列表里的定时就是后端读来的,id 相同 */
  const rid = (id: string) => remote.get(id) ?? (live(get()) && get().crons.some((x) => x.id === id) ? Promise.resolve(id) : undefined)

  return {
    /* 初值空:演示数据由 api/demo-state.ts 装 */
    crons: [],
    pulse: [],
    scheduleDraft: null,
    openSchedule: (scheduleDraft) => set({ scheduleDraft }),
    setCrons: (crons) => set({ crons }),
    /* 后端只给最近一次运行:和本地已有的运行记录合并,按时间新的在前 */
    putCron: (c) => L.crons((l) => {
      const old = l.find((x) => x.id === c.id)
      if (!old) return [...l, c]
      const runs = [...c.runs, ...old.runs.filter((r) => !c.runs.some((n) => n.at === r.at))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20)
      return l.map((x) => (x.id === c.id ? { ...c, runs } : x))
    }),
    dropCron: (id) => L.crons((l) => l.filter((x) => x.id !== id)),
    loadCronRuns: (id) => { if (live(get())) void loadCronRuns(liveCtx(get, set), id).catch(() => undefined) },

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
      const r0 = rid(id)
      if (next.trigger.kind !== 'cron') { if (r0) { remote.delete(id); void r0.then((r) => { if (r) void sync('schedules.remove', { scheduleId: r }, '定时') }) } }
      else if (!r0) create(id, next)
      else void r0.then((r) => { const u = r && scheduleUpdate(r, patch); if (u) void sync('schedules.update', u, '定时') })
    },
    addCron: (c, via) => {
      /* 连上后端、按 cron 触发:由后端建,列表等回包(和 schedule.updated 事件)写入,不先放一条本地的 */
      const p = live(get()) ? scheduleCreate(c, uid()) : null
      if (p) {
        void sync('schedules.create', p, '定时').then((v) => { const x = v && toCron(v); if (x) { get().putCron(x); get().toast(`加好了：${people[c.owner].name} ${describeTrigger(c.trigger)}「${c.text}」`) } })
        return ''
      }
      const id = 'cr' + uid()
      L.crons((l) => [...l, { ...c, id, runs: [] }])
      create(id, c)
      if (via === 'panel') sys(c.conv, `你给 ${people[c.owner].name} 加了定时：${describeTrigger(c.trigger)}「${c.text}」${c.paused ? '（先不开）' : ''}`)
      return id
    },
    removeCron: (id) => {
      const c = get().crons.find((x) => x.id === id)
      const r0 = rid(id)
      L.crons((l) => l.filter((x) => x.id !== id))
      if (c) { sys(c.conv, `你删掉了 ${people[c.owner].name} 的定时「${c.text}」`); get().toast('已删除定时') }
      remote.delete(id)
      void r0?.then((r) => { if (r) void sync('schedules.remove', { scheduleId: r }, '定时') })
    },
    runCronNow: (id) => {
      const { crons, convs } = get()
      const c = crons.find((x) => x.id === id)
      if (!c) return
      /* 连上后端:真的跑一次,结果是联系人在群里发的真消息,运行记录由 schedule.updated 带回;不在本地演 */
      if (live(get())) { void rid(id)?.then((r) => { if (r) void sync('schedules.runNow', { scheduleId: r, clientActionId: uid() }, '试跑').then((v) => v && get().toast(`已让 ${people[c.owner].name} 现在跑一次`)) }); return }
      const silent = c.speak === 'only-if'
      const mid = 'r-' + uid()
      const cv = convs.find((x) => x.id === c.conv)
      const loaded = Object.fromEntries((cv?.notices ?? []).map((n) => [n.id, broken('AC-35-11') ? (c.runs[0]?.notices?.[n.id] ?? n.ver) : n.ver]))
      const now = new Date()
      L.crons((l) => l.map((x) => (x.id === id ? { ...x, runs: [{ at: now.toISOString(), notices: loaded, result: (silent ? 'silent' : 'said') as 'silent' | 'said', note: silent ? '手动试跑：看过了，没有情况，没发消息' : '手动试跑：发了结果', ...(silent ? {} : { msg: mid }) }, ...x.runs].slice(0, 20) } : x)))
      if (!silent) get().say(c.conv, c.owner, `（手动试跑）${c.text}：已经做完，这是这次的结果。`, 900, { id: mid, cron: c.id, at: now.toTimeString().slice(0, 5) })
      else get().toast(`${people[c.owner].name} 看过了，没有情况，所以没发消息`)
      void rid(id)?.then((r) => { if (r) void sync('schedules.runNow', { scheduleId: r, clientActionId: uid() }, '试跑') })
    },
  }
}
