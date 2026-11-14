import type { BoardConv, BoardWorld, ComputeUnit, SubUnit, UnitState } from '@g-group/ui-core'
import type { Compute, Conversation, Pending, Person, PersonId } from '@/data'
import { seqOf as backendSeq } from '@/api/wire/messages'
import type { TaskLedger } from '@/api/wire/runs'
import { DEMO_CLOCK, DEMO_COMPUTES, DEMO_SUBS, LEDGER, type DemoCompute } from './demo'

/*
  把 app 现有的会话、联系人、Compute、待你处理映射成看板的台账(@g-group/ui-core 的 BoardWorld)。
  演示模式:data.ts 的时间是「HH:MM」和「4 分钟」这样的字符串,这里按演示时钟换成时刻;缺的台账字段从 demo.ts 按 compute id 取。
  连着后端:时刻用任务带来的真实时刻(Compute.startedAt / lastAt / endedAt),「现在」是真实时钟,不混演示数据。
*/

const MIN = 60_000

/** 演示时钟:当天 DEMO_CLOCK(对齐 data.ts 聊天里的时刻) */
export function demoNow(base = new Date()): number {
  const d = new Date(base)
  d.setHours(DEMO_CLOCK.h, DEMO_CLOCK.m, 0, 0)
  return d.getTime()
}

/** 「02:12」→ 不晚于 now 的最近一次该时刻;「刚刚」→ now;认不出 → null */
export function clockAt(s: string | undefined, now: number): number | null {
  if (!s) return null
  if (s === '刚刚') return now
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const d = new Date(now)
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (d.getTime() > now) d.setDate(d.getDate() - 1)
  return d.getTime()
}

/** 「4 分钟」「20 秒」「1 小时 5 分钟」→ 毫秒;认不出按 0 */
export function elapsedMs(s: string): number {
  const h = /(\d+)\s*小时/.exec(s), m = /(\d+)\s*分/.exec(s), sec = /(\d+)\s*秒/.exec(s)
  return (Number(h?.[1] ?? 0) * 60 + Number(m?.[1] ?? 0)) * MIN + Number(sec?.[1] ?? 0) * 1000
}

/** 来源消息在它所在对话里的序号(#seq);找不到是 0,卡片上不显示 */
function seqOf(convs: Conversation[], convId: string, msgId: string): number {
  const ids = (convs.find((c) => c.id === convId)?.messages ?? []).flatMap((m) => ('id' in m ? [m.id] : []))
  return ids.indexOf(msgId) + 1
}

/** 「等你处理」:问了什么、问在哪条消息。来源:Compute 自己是 waiting、挂着验收、卡在只有人能过的一步、或台账里关联的待你处理还在 */
function askOf(c: Pick<Compute, 'id' | 'status' | 'reportMsg' | 'needsHuman' | 'result'>, pending: Pending[], link?: string): { asking: string; askMsg?: string } | null {
  const linked = link ? pending.find((p) => p.id === link) : undefined
  if (linked && 'title' in linked) return { asking: linked.title, ...(linked.ask ? { askMsg: linked.ask } : {}) }
  const accept = pending.find((p) => p.kind === 'accept' && p.computeId === c.id)
  if (accept && accept.kind === 'accept') return { asking: '做完了，请你验收', ...((accept.ask ?? c.reportMsg) ? { askMsg: accept.ask ?? c.reportMsg } : {}) }
  if (c.needsHuman && !c.needsHuman.taken) return { asking: c.needsHuman.what, ...(c.needsHuman.qid ? { askMsg: c.needsHuman.qid } : {}) }
  if (c.status === 'waiting') return { asking: c.result ?? '做完了，等你回复', ...(c.reportMsg ? { askMsg: c.reportMsg } : {}) }
  return null
}

const STATE: Record<Compute['status'], UnitState> = { running: 'running', waiting: 'waiting_user', error: 'failed', done: 'done', stopped: 'interrupted' }

function fromApp(c: Compute, convs: Conversation[], pending: Pending[], now: number): ComputeUnit {
  const led = LEDGER[c.id]
  const ask = askOf(c, pending, led?.askPending)
  const lastAct = clockAt(c.activity[c.activity.length - 1]?.at, now)
  const live = c.status === 'running' || c.status === 'waiting'
  const endedAt = live ? undefined : (lastAct ?? now)
  const startedAt = (endedAt ?? now) - elapsedMs(c.elapsed)
  const state = ask && c.status === 'running' ? 'waiting_user' : STATE[c.status]
  return {
    id: c.id, conv: c.conv, owner: c.owner, title: c.title, model: c.model, upstream: led?.upstream ?? c.harness,
    state, startedAt, lastProgressAt: c.idleMin ? now - c.idleMin * MIN : (lastAct ?? now), turns: led?.turns ?? c.activity.length,
    seq: seqOf(convs, c.conv, c.askMsg),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(c.status === 'error' ? { reason: led?.reason ?? 'unknown', ...(c.error ? { reasonRaw: c.error } : {}) } : {}),
    ...(c.status === 'stopped' ? { reason: 'user_stopped' as const } : {}),
    ...(ask && state === 'waiting_user' ? ask : {}),
    ...(led?.threshold ? { threshold: led.threshold } : {}),
  }
}

/** 连着后端:这件任务还开着的卡片(失败卡、授权提问)在哪条消息上——等你处理时跳到那里;找不到就落在挂着它那一行的消息上 */
function askMsgOf(c: Compute, convs: Conversation[]): string {
  const msgs = convs.find((x) => x.id === c.conv)?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    if (m.k === 'text' && m.card?.taskId === c.id && m.card.state === 'open' && m.card.kind !== 'task-status') return m.id
  }
  return c.reportMsg ?? c.askMsg
}

/** 连着后端:任务(界面的 Compute)+ 运行台账摘要 → 看板单元。时刻都是后端给的真实时刻;
 *  轮数、上游、失败原因、阈值取台账(AC-43 全景读台账),台账里没有的不拿演示数据补 */
function fromLive(c: Compute, convs: Conversation[], pending: Pending[], led: TaskLedger | undefined, now: number): ComputeUnit {
  const failing = c.status === 'running' && pending.some((p) => p.kind === 'error' && p.computeId === c.id)
  const asking = c.status === 'running' && c.needsHuman ? c.needsHuman.what : c.status === 'waiting' ? c.phase : null
  const state: UnitState = c.queued ? 'queued' : failing ? 'failed' : asking ? 'waiting_user' : STATE[c.status]
  const last = Math.max(c.lastAt ?? 0, led?.lastProgressAt ?? 0) || c.startedAt || now
  const open = c.status === 'running' || c.status === 'waiting'
  const endedAt = open && !failing ? undefined : (c.endedAt ?? last)
  return {
    id: c.id, conv: c.conv, owner: c.owner, title: c.title, model: c.model, upstream: led?.upstream ?? c.model,
    state, startedAt: c.startedAt ?? last, lastProgressAt: last, turns: led?.turns ?? 0,
    seq: backendSeq(c.askMsg) ?? 0,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(state === 'failed' ? { reason: led?.reason ?? 'unknown', ...((led?.reasonRaw ?? c.error) ? { reasonRaw: led?.reasonRaw ?? c.error } : {}) } : {}),
    ...(state === 'interrupted' ? { reason: led?.reason ?? ('user_stopped' as const) } : {}),
    ...(state === 'waiting_user' && asking ? { asking, askMsg: askMsgOf(c, convs) } : {}),
    ...(state === 'failed' && failing ? { askMsg: askMsgOf(c, convs) } : {}),
    ...(state === 'queued' ? { queuedBehind: c.phase } : {}),
    ...(led?.threshold ? { threshold: led.threshold } : {}),
  }
}

function fromDemo(d: DemoCompute, pending: Pending[], now: number): ComputeUnit {
  const at = (m: number) => now - m * MIN
  const linked = d.askPending ? pending.find((p) => p.id === d.askPending) : undefined
  const ask = linked && 'title' in linked ? { asking: linked.title, ...(linked.ask ? { askMsg: linked.ask } : {}) } : null
  return {
    id: d.id, conv: d.conv, owner: d.owner, title: d.title, model: d.model, upstream: d.upstream, turns: d.turns, seq: d.seq,
    state: ask ? 'waiting_user' : d.state, startedAt: at(d.started), lastProgressAt: at(d.last ?? d.started),
    ...(d.ended !== undefined ? { endedAt: at(d.ended) } : {}),
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.reasonRaw ? { reasonRaw: d.reasonRaw } : {}),
    ...(d.queuedBehind ? { queuedBehind: d.queuedBehind } : {}),
    ...(d.threshold ? { threshold: d.threshold } : {}),
    ...(ask ?? {}),
  }
}

function toConv(c: Conversation): BoardConv {
  return { id: c.id, kind: c.kind, name: c.title, members: c.members.filter((m) => m !== 'me') }
}

export interface AppSlice { computes: Record<string, Compute>; convs: Conversation[]; pending: Pending[]; people: Record<PersonId, Person> }

/** app 状态 → 看板台账。只收所属对话还在、联系人还在的 Compute;子任务跟着父 Compute 走。
 *  ledger 给了(连着后端,哪怕是空的):只收后端的任务和台账里的子代理 / 后台任务,不混演示的补充数据,时刻按真实时钟(now 由调用方给 Date.now()) */
export function toWorld({ computes, convs, pending, people }: AppSlice, now: number, ledger?: Record<string, TaskLedger>): BoardWorld {
  const known = new Set(convs.map((c) => c.id))
  const units = (ledger
    ? Object.values(computes).map((c) => fromLive(c, convs, pending, ledger[c.id], now))
    : [...Object.values(computes).map((c) => fromApp(c, convs, pending, now)), ...DEMO_COMPUTES.map((d) => fromDemo(d, pending, now))]
  ).filter((u) => known.has(u.conv) && people[u.owner])
  const parents = new Set(units.map((u) => u.id))
  const subs: SubUnit[] = ledger
    ? units.flatMap((u) => (ledger[u.id]?.subs ?? []).map((x) => ({ ...x, parent: u.id })))
    : DEMO_SUBS.filter((x) => parents.has(x.parent)).map((x) => ({
      id: x.id, parent: x.parent, kind: x.kind, title: x.title, state: x.state,
      startedAt: now - x.started * MIN, lastProgressAt: now - (x.last ?? x.ended ?? x.started) * MIN,
      ...(x.ended !== undefined ? { endedAt: now - x.ended * MIN } : {}),
      ...(x.reason ? { reason: x.reason } : {}),
      ...(x.reasonRaw ? { reasonRaw: x.reasonRaw } : {}),
    }))
  const names = Object.fromEntries(Object.values(people).map((p) => [p.id, { name: p.name }]))
  return { now, people: names, convs: convs.map(toConv), computes: units, subs }
}
