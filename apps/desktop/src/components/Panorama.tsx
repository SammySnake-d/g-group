import { useEffect, useMemo, useState } from 'react'
import { useApp } from '@/ctx'
import { live } from '@/api/wire/live'
import { people } from '@/data'
import { cronOverview } from '@/cronView'
import { Board } from './progress/Board'
import { CronOverview } from './progress/CronOverview'
import { demoNow, toWorld } from './progress/adapter'
import { useJump } from './progress/useJump'

/*
  进展遮罩里的内容(外壳 pano-overlay / pano-close 在 App.tsx)。两种打开方式:
  - 左栏「进展」→ 进展全景看板(progress/Board,#806:遮罩里只有这张图,用来跳转);
  - 「所有会话的定时」「看所有定时」(cronView.openCronOverview 置 cronOverview.focus)→ 定时总览(progress/CronOverview)。
*/
export function Panorama() {
  const [mode] = useState<'board' | 'cron'>(() => (cronOverview.focus ? 'cron' : 'board'))
  useEffect(() => { cronOverview.focus = false }, [])
  return mode === 'cron' ? <CronOverview /> : <ProgressBoard />
}

/** 连着后端时「现在」走真实时钟,每 30 秒走一格(已跑多久、多久没进展跟着变);演示模式停在演示时钟 */
const TICK_MS = 30_000

function ProgressBoard() {
  const { computes, convs, pending, real } = useApp((s) => ({ computes: s.computes, convs: s.convs, pending: s.pending, real: live(s) }))
  const onJump = useJump()
  const [now, setNow] = useState(() => (real ? Date.now() : demoNow()))
  useEffect(() => {
    if (!real) { setNow(demoNow()); return }
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(t)
  }, [real])
  /* 后端推来新进度时也按当下时刻算,不等下一格 */
  const world = useMemo(() => toWorld({ computes, convs, pending, people }, real ? Math.max(now, Date.now()) : now, real), [computes, convs, pending, now, real])
  return <Board world={world} onJump={onJump} />
}
