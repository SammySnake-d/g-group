/* AC-14 停滞:在跑的 Compute 多久没有新进度。
   演示数据直接给 idleMin;连上后端时由任务带来的真实时刻(Compute.lastAt,最近一条进度)和真实时钟现算——
   等你接手、正在停止的不算停滞(那是在等人)。 */
import { useEffect, useState } from 'react'
import type { Compute } from '@/data'

export function idleMinOf(c: Compute, now: number): number | undefined {
  if (c.idleMin !== undefined) return c.idleMin
  if (c.status !== 'running' || c.needsHuman || c.stopping) return undefined
  /* 最近一条是失败(原位失败卡在等你选)或受阻(在问你):在等人,不是卡住 */
  const kind = c.activity[c.activity.length - 1]?.kind
  if (kind === 'error' || kind === 'ask') return undefined
  const last = c.lastAt ?? c.startedAt
  return last === undefined ? undefined : Math.max(0, Math.floor((now - last) / 60_000))
}

/** 停在哪:有步骤计划写「卡在」正在做的那步;没有(连后端时合同不给步骤计划)如实写「最后进展」是哪一条,不替它猜卡在哪 */
export function stuckAt(c: Compute): { label: '卡在' | '最后进展'; text: string } | null {
  const step = c.steps.find((x) => x.state === 'now')?.text
  if (step) return { label: '卡在', text: step }
  const last = c.activity[c.activity.length - 1]?.title
  return last ? { label: '最后进展', text: last } : null
}

/** 「现在」(毫秒):只在 on 时每 ms 走一格,省得没有在跑的 Compute 也一直重渲染 */
export function useTick(on: boolean, ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [on, ms])
  return now
}
