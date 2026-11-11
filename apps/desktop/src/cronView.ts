/* 定时在界面上的读法：三个视角（本群 / 联系人 / 进展总览）和详情都从这里取，改一处各处一致（AC-53）。
   下次运行、是否出错都由 trigger、paused、runs 现算——改时间、暂停、删除立刻反映出来（AC-35①）。 */
import { useEffect, useState } from 'react'
import { describeTrigger, formatRunAt, messagesLeft, triggerNext } from '@g-group/ui-core'
import type { Cron, CronRun, PluginState } from './data'
import { findInfo } from './pluginInfo'

/** 「现在」：每 20 秒刷新一次，让「下次运行」「接下来」跟着钟走 */
export function useNow(ms = 20_000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export const RESULT: Record<CronRun['result'], string> = { said: '发了消息', silent: '没打扰你', error: '失败' }

/** 最近一次醒来出错了 */
export const cronFailed = (c: Cron) => c.runs[0]?.result === 'error'

/** 人话的叫醒规则：「每天 08:00」「每 30 条消息」「当出现严重级 CVE」 */
export const cronRule = (c: Cron) => describeTrigger(c.trigger)

/** cron 表达式（只有按表达式重复的才有） */
export const cronExpr = (c: Cron) => (c.trigger.kind === 'cron' ? c.trigger.expr : null)

/** 下一次按钟点醒来的时刻；暂停、按条数、按事件、只跑一次且已过去 → null */
export const cronNextAt = (c: Cron, now: Date) => (c.paused ? null : triggerNext(c.trigger, now))

/** 「下次 …」那一格的文字 */
export function cronNextText(c: Cron, now: Date, plugins: PluginState[]): string {
  if (c.paused) return '已暂停'
  const t = c.trigger
  if (t.kind === 'messages') return `再有 ${messagesLeft(t)} 条消息`
  if (t.kind === 'event') return `等「${findInfo(plugins, t.source)?.name ?? t.source}」报来新事`
  const at = triggerNext(t, now)
  if (at) return formatRunAt(at, now)
  return t.kind === 'once' ? '已跑完' : '不会再触发'
}

/** 最近一次结果的一行字：「今天 08:00 发了消息 · 发了总结…」 */
export function cronLastText(c: Cron, now: Date): string {
  const r = c.runs[0]
  if (!r) return '还没跑过'
  return `${formatRunAt(new Date(r.at), now)} ${RESULT[r.result]} · ${r.note}`
}

/** 进展总览按日分组：今天 / 明天 / 本周（7 天内）；不按钟点的放「随时」 */
export function cronDay(c: Cron, now: Date): '今天' | '明天' | '本周' | '随时' | null {
  if (c.trigger.kind === 'messages' || c.trigger.kind === 'event') return c.paused ? null : '随时'
  const at = cronNextAt(c, now)
  if (!at) return null
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000
  const diff = day(at) - day(now)
  return diff === 0 ? '今天' : diff === 1 ? '明天' : diff < 7 ? '本周' : null
}

/** 窄列里的时间：下次的 HH:MM，按条数写「每30条」，按事件写「条件」 */
export function cronWhen(c: Cron, now: Date): string {
  if (c.trigger.kind === 'messages') return `每${c.trigger.n}条`
  if (c.trigger.kind === 'event') return '条件'
  const at = triggerNext(c.trigger, now)
  return at ? at.toTimeString().slice(0, 5) : '—'
}

/** 排序：出错的先看，其次按下次时间，没有钟点的随后，暂停的最后 */
export function cronOrder(now: Date) {
  const rank = (c: Cron) => (c.paused ? 3 : cronFailed(c) ? 0 : cronNextAt(c, now) ? 1 : 2)
  return (a: Cron, b: Cron) => rank(a) - rank(b) || (cronNextAt(a, now)?.getTime() ?? 0) - (cronNextAt(b, now)?.getTime() ?? 0)
}

/** 定时的全局总览（AC-53）：打开「进展」并停在定时那一节，不用逐个点头像。Panorama 挂载时读这个标记 */
export const cronOverview = { focus: false }
export function openCronOverview(setPanoOpen: (v: boolean) => void) {
  cronOverview.focus = true
  setPanoOpen(true)
}
