import { useEffect, useMemo, useState } from 'react'
import { useApp } from '@/ctx'
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

function ProgressBoard() {
  const { computes, convs, pending } = useApp()
  const onJump = useJump()
  const [now] = useState(() => demoNow())
  const world = useMemo(() => toWorld({ computes, convs, pending, people }, now), [computes, convs, pending, now])
  return <Board world={world} onJump={onJump} />
}
