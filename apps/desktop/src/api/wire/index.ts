// 读取 + 事件订阅 → 分发到切片。连上后端时启动一次:
//   1. 先订阅事件流(从 session.hello 给的 eventSeq 接),读取期间到的事件先攒着;
//   2. 各实体按 WIRINGS 的顺序全量读(Wiring.load),写进各自切片——后读的要用先读的:会话成员要先有联系人,
//      消息按读到的会话逐个读,任务的负责人要先有联系人;某一类没读到不拦后面的;
//   3. 读完按顺序补放攒下的事件,之后事件到一条分发一条(按 type 找关心它的 Wiring);
//   4. 收到 stream.resync(缺口已丢弃)就回到第 1 步重新全量读。
// 读取状态写进 layout 切片的 wire,界面据此提示「正在读取 / 有哪类没读到」。
import type { GGroupBridge, ServerEvent } from '@g-group/api-contract'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/state'
import { call } from '../backend'
import { followUpsWiring } from './chat-ops'
import { contactsWiring } from './contacts'
import { filesWiring } from './files'
import { messagesWiring } from './messages'
import { noticesWiring } from './notices'
import { pluginsWiring } from './plugins'
import { roomsWiring } from './rooms'
import { schedulesWiring } from './schedules'
import { tasksWiring } from './tasks'
import type { Wiring, WireCtx } from './types'

/** 已接线的实体,按读取顺序排。新实体:在 api/wire/ 下加一个文件,export 一个 defineWiring({...}),再在这里按依赖插一行 */
export const WIRINGS: Wiring[] = [contactsWiring, roomsWiring, messagesWiring, tasksWiring, filesWiring, noticesWiring, checklistWiring, schedulesWiring, pluginsWiring, followUpsWiring]

export type WireStatus =
  | { phase: 'off' }
  | { phase: 'loading' }
  | { phase: 'live'; failed: { entity: string; reason: string }[] }

let reload: (() => void) | null = null
/** 重新全量读一遍(界面上「没读全」时用户点一下重读) */
export const rewire = () => reload?.()

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function startWiring(store: StoreApi<AppState>, bridge: Pick<GGroupBridge, 'subscribe'>, sinceEventSeq: number, wirings: Wiring[] = WIRINGS): () => void {
  const w: WireCtx = { call, get: store.getState, set: store.setState }
  const status = (s: WireStatus) => store.getState().setWire(s)
  let lastSeq = sinceEventSeq
  /** 正在全量读时攒下的事件;null = 没在读,事件直接分发 */
  let pending: ServerEvent[] | null = null
  let round = 0
  let stopped = false

  const dispatch = (ev: ServerEvent) => {
    for (const x of wirings) {
      const h = x.on[ev.type] as ((e: ServerEvent, c: WireCtx) => void) | undefined
      if (!h) continue
      try { h(ev, w) } catch (e) { console.error(`[wire] ${x.entity} 处理 ${ev.type} 出错`, e) }
    }
  }

  const loadAll = async () => {
    const mine = ++round
    pending = []
    status({ phase: 'loading' })
    const failed: { entity: string; reason: string }[] = []
    for (const x of wirings) {
      try { await x.load(w) } catch (e) { failed.push({ entity: x.entity, reason: message(e) }) }
      /* 读的途中又来了 resync(或已退订):这一轮作废,交给新一轮 */
      if (stopped || mine !== round) return
    }
    const queued = pending
    pending = null
    for (const ev of queued) dispatch(ev)
    status({ phase: 'live', failed })
  }

  const onEvent = (ev: ServerEvent) => {
    if (stopped || ev.eventSeq <= lastSeq) return
    lastSeq = ev.eventSeq
    if (ev.type === 'stream.resync') { void loadAll(); return }
    if (pending) pending.push(ev)
    else dispatch(ev)
  }

  const off = bridge.subscribe(onEvent, { sinceEventSeq })
  reload = () => void loadAll()
  void loadAll()
  return () => { stopped = true; reload = null; off(); status({ phase: 'off' }) }
}
