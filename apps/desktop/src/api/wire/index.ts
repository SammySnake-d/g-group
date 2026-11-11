// 读取 + 事件订阅 → 分发到切片。连上后端时启动一次:
//   1. 先订阅事件流(从 session.hello 给的 eventSeq 接),读取期间到的事件先攒着;
//   2. 各实体并行全量读(Wiring.load),写进各自切片;
//   3. 读完按顺序补放攒下的事件,之后事件到一条分发一条(按 type 找关心它的 Wiring);
//   4. 收到 stream.resync(缺口已丢弃)就回到第 1 步重新全量读。
// 读取状态写进 layout 切片的 wire,界面据此提示「正在读取 / 有哪类没读到」。
import type { GGroupBridge, ServerEvent } from '@g-group/api-contract'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/state'
import { call } from '../backend'
import { contactsWiring } from './contacts'
import type { Wiring, WireCtx } from './types'

/** 已接线的实体。新实体:在 api/wire/ 下加一个文件,export 一个 defineWiring({...}),再在这里加一行 */
export const WIRINGS: Wiring[] = [contactsWiring]

export type WireStatus =
  | { phase: 'off' }
  | { phase: 'loading' }
  | { phase: 'live'; failed: string[] }

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
    const results = await Promise.allSettled(wirings.map((x) => x.load(w)))
    /* 读的途中又来了 resync:这一轮作废,交给新一轮 */
    if (stopped || mine !== round) return
    const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${wirings[i]!.entity}(${message(r.reason)})`] : []))
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
  void loadAll()
  return () => { stopped = true; off(); status({ phase: 'off' }) }
}
