// 定时切片(#1858):在面板里改动,原会话只插一行居中灰字,不让助手发气泡刷屏。
// 下次运行由 trigger / paused 现算,改时间、暂停、删除各个视角立刻一致(AC-35① AC-53)。
// 按 cron 表达式触发的定时同时经合同写到后端(schedules.create / update / remove / runNow);
// 事件触发、每 N 条消息触发、说话方式、改负责人 / 挪会话是合同缺口:演示里只在本地;
// 连上后端时一律以回包为准(不先改本地),合同表达不了的那几项在编辑器里关着并写明原因(CRON_LIVE)。
import { describeTrigger } from '@g-group/ui-core'
import { crons0, people, type Cron, type Msg, type PulseItem } from '@/data'
import { broken } from '@/mut'
import { scheduleCreate, scheduleUpdate } from '@/api/adapters'
import { call } from '@/api/backend'
import { live } from '@/api/wire/live'
import { liveCtx } from '@/api/wire/live'
import { loadCronRuns, toCron } from '@/api/wire/schedules'
import { CRON_LIVE } from '@/components/cron/constants'
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
  /* 演示里在原会话插一行灰字;连上后端时不插(刷新就没了,也不在后端记录里),那几条路径各自等回包后提示一句 */
  const sys = (cid: string, text: string) => get().pushMsg({ k: 'sys', id: 's' + uid(), text }, cid)
  /* 连上后端时正在等后端删的定时:回包前再点一次不重复发 */
  const removing = new Set<string>()
  /* 本地定时 id → 后端定时 id。演示服务用同一份初始数据做种子,初始的那些 id 相同;新建的等 create 回包再记 */
  const remote = new Map<string, Promise<string | null>>(crons0.filter((c) => c.trigger.kind === 'cron').map((c) => [c.id, Promise.resolve(c.id)]))
  const create = (id: string, c: Omit<Cron, 'id' | 'runs'>) => {
    const p = scheduleCreate(c, uid())
    if (p) remote.set(id, sync('schedules.create', p, '定时').then((v) => v?.id ?? null))
  }
  /** 本地定时对应的后端 id:连上后端时列表里的定时就是后端读来的,id 相同 */
  const rid = (id: string) => remote.get(id) ?? (live(get()) && get().crons.some((x) => x.id === id) ? Promise.resolve(id) : undefined)
  /** 一次改动用人话怎么说(「暂停了，改成 每天 08:00」);没变化返回空串 */
  const describe = (c: Cron, patch: Partial<Cron>) => {
    const rule = patch.trigger ? describeTrigger(patch.trigger) : ''
    const changes = [
      patch.trigger && rule !== describeTrigger(c.trigger) ? `改成 ${rule}` : '',
      patch.text && patch.text !== c.text ? `内容改成「${patch.text}」` : '',
      patch.owner && patch.owner !== c.owner ? `交给 ${people[patch.owner].name}` : '',
      patch.conv && patch.conv !== c.conv ? `挪到「${get().convs.find((x) => x.id === patch.conv)?.title ?? patch.conv}」` : '',
      patch.speak && patch.speak !== c.speak ? (patch.speak === 'only-if' ? '改成有情况才说' : '改成每次都发结果') : '',
    ].filter(Boolean)
    const paused = patch.paused === true && !c.paused ? '暂停了' : patch.paused === false && c.paused ? '重新打开了' : ''
    return [paused, changes.length ? changes.join('，') : ''].filter(Boolean).join('，')
  }
  /** 连上后端:合同表达不了的改动(换负责人、挪会话、说话方式、非 cron 触发)不做;能表达的经 schedules.update,回包到了才换成后端那条 */
  const updateLive = (c: Cron, patch: Partial<Cron>) => {
    const off = (patch.owner && patch.owner !== c.owner) || (patch.conv && patch.conv !== c.conv) ? CRON_LIVE.fixed
      : patch.speak && patch.speak !== c.speak ? CRON_LIVE.speak
      : patch.trigger && patch.trigger.kind !== 'cron' ? CRON_LIVE.kinds : ''
    if (off) { get().toast(off); return }
    const u = scheduleUpdate(c.id, patch)
    if (!u) return
    const what = describe(c, patch)
    void sync('schedules.update', u, '定时').then((v) => {
      const x = v && toCron(v)
      if (!x) return
      get().putCron(x)
      if (what) get().toast(`你把 ${people[c.owner].name} 的定时「${c.text}」${what}`)
    })
  }

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
      const c = get().crons.find((x) => x.id === id)
      if (live(get())) { if (c) updateLive(c, patch); return }
      L.crons((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)))
      if (!c) return
      const what = describe(c, patch)
      if (what) sys(patch.conv ?? c.conv, `你把 ${people[c.owner].name} 的定时「${c.text}」${what}`)
      /* 写到后端:触发方式改成了事件 / 按消息数,合同表达不了,后端那份删掉;从那两种改回 cron 就新建一份 */
      const next = { ...c, ...patch }
      const r0 = rid(id)
      if (next.trigger.kind !== 'cron') { if (r0) { remote.delete(id); void r0.then((r) => { if (r) void sync('schedules.remove', { scheduleId: r }, '定时') }) } }
      else if (!r0) create(id, next)
      else void r0.then((r) => { const u = r && scheduleUpdate(r, patch); if (u) void sync('schedules.update', u, '定时') })
    },
    addCron: (c, via) => {
      /* 连上后端:由后端建,列表等回包(和 schedule.updated 事件)写入,不先放一条本地的;
         合同只收按 cron 触发的,别的触发方式编辑器里已经关着,这里也不在本地补一条 */
      if (live(get())) {
        const p = scheduleCreate(c, uid())
        if (!p) { get().toast(CRON_LIVE.kinds); return '' }
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
      /* 连上后端:后端删成了才从列表拿掉(schedule.removed 事件也会删);删不掉就提示原因,列表不动。
         后端说这条本来就不在了,列表里也拿掉(留着是一条点不动的假定时) */
      if (live(get())) {
        if (!c || removing.has(id)) return
        removing.add(id)
        void call('schedules.remove', { scheduleId: id }).then((r) => {
          removing.delete(id)
          if (r.ok) { get().dropCron(id); get().toast('已删除定时'); return }
          if (r.error.code === 'not_found') { get().dropCron(id); get().toast('这个定时在后端已经不在了，已从列表里拿掉'); return }
          get().toast(`没删掉：${r.error.message}`)
        })
        return
      }
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
