/* 连上后端时,分屏里「会话 / 过程」两页读真实记录:点开时(和它有新进展、停下、做完时)取一次
   tasks.get + tasks.progress(全量)+ 运行台账里这件事最近一次的 Compute 会话(runs.get),拼成会话记录;
   读到的全部进度并进这件 Compute 的过程(列表和推来的事件只带最近若干条)。没连上后端时不取,演示照旧。 */
import { useEffect, useMemo, useState } from 'react'
import type { HarnessTranscript } from '@g-group/ui-core'
import { call } from '@/api/backend'
import { liveTranscript, type SessionFacts } from '@/api/wire/session'
import { actOf, mergeActs } from '@/api/wire/tasks'
import { people, type Compute } from '@/data'
import { useApp, useAppStore } from '@/store'

const LIMIT = 500

/** 联系人交给 Compute 的那段话:它接活那句上的任务卡正文 */
function useBrief(c: Compute) {
  return useApp((s) => {
    const conv = s.convs.find((x) => x.id === c.conv)
    for (const m of conv?.messages ?? []) if (m.k === 'text' && m.card?.kind === 'task-status' && m.card.taskId === c.id && m.card.body) return m.card.body
    return c.title
  })
}

export function useLiveSession(c: Compute): { live: boolean; loading: boolean; transcript: HarnessTranscript | null } {
  const live = useApp((s) => s.backend.mode === 'connected')
  const brief = useBrief(c)
  const [facts, setFacts] = useState<Omit<SessionFacts, 'brief' | 'owner'> | null>(null)
  /* 有新进展、停下、做完时再取一次 */
  const key = `${c.id}|${c.status}|${c.stopping ? 1 : 0}|${c.activity.at(-1)?.id ?? ''}|${c.needsHuman?.qid ?? ''}`
  useEffect(() => {
    if (!live) return
    let off = false
    void (async () => {
      const [t, p, l] = await Promise.all([call('tasks.get', { taskId: c.id }), call('tasks.progress', { taskId: c.id, limit: LIMIT }), call('runs.list', { roomId: c.conv })])
      if (off || !t.ok || !p.ok) return
      const unit = l.ok ? l.value.runs.filter((u) => u.taskId === c.id && u.layer === 'compute-session').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] : undefined
      const g = unit ? await call('runs.get', { runId: unit.id }) : null
      if (off) return
      setFacts({ task: t.value, progress: p.value.progress, hasEarlier: p.value.progress.length >= LIMIT, ...(g?.ok ? { session: g.value } : {}) })
      /* 全部进度并进过程(同一事件 id 相同,不重复) */
      const s = useAppStore.getState(), cur = s.computes[c.id]
      if (cur) {
        const activity = mergeActs(cur.activity, p.value.progress.map(actOf))
        if (activity.length !== cur.activity.length) s.putCompute({ ...cur, activity })
      }
    })()
    return () => { off = true }
  }, [live, key]) // eslint-disable-line react-hooks/exhaustive-deps
  const owner = people[c.owner]?.name ?? ''
  const transcript = useMemo(() => (live && facts ? liveTranscript({ ...facts, brief, owner }) : null), [live, facts, brief, owner])
  return { live, loading: live && !facts, transcript }
}
