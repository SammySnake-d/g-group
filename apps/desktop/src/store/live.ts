// 演示推进:登录页深色这件 Compute 按脚本每隔一拍往前走,最后在群里汇报。接上真后端后由事件流替代。
import { people, type Activity, type PersonId } from '@/data'
import { SWATCHES } from '@/data'
import { broken } from '@/mut'
import { frozen, speed } from './boot'
import { LIVE, LIVE_DONE_TEXT, LIVE_FINISH, LIVE_TICK_MS, ROGUE_COMPUTE } from './demo'
import type { AppState } from './state'
import type { StoreApi } from 'zustand'

/** 启动推进,返回停止函数。冻结(?freeze)时不推进 */
export function startLiveDemo(store: StoreApi<AppState>): () => void {
  if (frozen) return () => {}
  const { setState: set, getState: get } = store
  let n = 0
  const t = setInterval(() => {
    if (n > LIVE.length) return
    const i = n++
    /* 副作用放在 updater 外,避免重复消息(修 #1194 图二「做完了」出现两次) */
    if (i === LIVE.length) {
      const F = LIVE_FINISH
      set((s) => {
        const c = s.computes.login
        return {
          computes: { ...s.computes, login: { ...c, status: 'done', phase: F.phase, reportMsg: F.reportMsg, elapsed: F.elapsed, cost: F.cost, result: F.result, evidence: F.evidence,
            steps: c.steps.map((x) => ({ ...x, state: 'done' })), checks: c.checks.map((k) => ({ ...k, ok: true, out: k.out ?? F.checkOut })),
            activity: [...c.activity.map((a) => ({ ...a, live: false })), F.act], checkpoints: [...c.checkpoints, F.checkpoint] } },
          checklist: s.checklist.map((x) => (x.attempts.includes('login') ? { ...x, status: '待验收' } : x)),
        }
      })
      /* 坏实现(埋雷 AC-40-8):Compute 以自己的身份在群里发汇报。先给它一个可显示的身份,免得页面因为未知发送人直接崩掉——崩溃变红不算标定 */
      if (broken('AC-40-8')) people[ROGUE_COMPUTE.id] ??= { ...ROGUE_COMPUTE, color: SWATCHES[SWATCHES.length - 1] } as (typeof people)[string]
      get().say('g', broken('AC-40-8') ? (ROGUE_COMPUTE.id as PersonId) : 'claude', LIVE_DONE_TEXT, 1200, { id: F.reportMsg })
      return
    }
    const L = LIVE[i]
    set((s) => {
      const c = s.computes.login
      return { computes: { ...s.computes, login: { ...c, phase: L.phase, elapsed: `${5 + i} 分钟`,
        steps: c.steps.map((x, j) => (j < L.step ? { ...x, state: 'done' } : j === L.step ? { ...x, state: 'now' } : x)),
        checks: c.checks.map((k) => ({ ...k, ok: true, out: k.out ?? LIVE_FINISH.checkOut })),
        activity: [...c.activity.map((a) => ({ ...a, live: false })), { id: 'live' + i, step: L.step, at: '刚刚', live: true, ...L.act } as Activity] } } }
    })
  }, LIVE_TICK_MS / speed)
  return () => clearInterval(t)
}
