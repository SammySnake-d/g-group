// 演示模式下的进程内「宿主」:实现接口合同里定时、插件、命令这几组方法,
// 每次调用都先用合同 checkParams 校验参数、回包前用 checkResult 校验结果——
// 界面走的调用路径和接上真后端时完全一样,演示数据只是换了一个服务端。
import { type ApiResult, checkParams, checkResult, formatIssues, isMethodName, type MarketplaceEntry, type MethodName, type PluginView, type ScheduleView, type ServerEvent, type SlashCommand } from '@g-group/api-contract'
import { cronError, describeCron, nextRuns } from '@g-group/ui-core'

type Fail = { ok: false; error: { code: 'invalid_params' | 'not_found' | 'unavailable' | 'unknown_method' | 'internal' | 'conflict' | 'forbidden'; message: string; detail?: unknown } }
const fail = (code: Fail['error']['code'], message: string, detail?: unknown): Fail => ({ ok: false, error: detail === undefined ? { code, message } : { code, message, detail } })

export type DemoSeed = { schedules: ScheduleView[]; plugins: PluginView[]; market: MarketplaceEntry[]; commands: (roomId: string) => SlashCommand[] }
export type DemoCall = { method: string; params: unknown; ok: boolean }

export function createDemoServer(seed: DemoSeed, now: () => Date = () => new Date()) {
  const schedules = new Map(seed.schedules.map((s) => [s.id, s]))
  const plugins = new Map(seed.plugins.map((p) => [p.id, p]))
  const history = new Map<string, { at: string; status: 'ok' | 'failed' | 'missed' | 'running'; messageSeq: number | null; error: string | null }[]>()
  const listeners = new Set<(e: ServerEvent) => void>()
  const calls: DemoCall[] = []
  let eventSeq = 0
  let n = 0
  const emit = (e: Record<string, unknown>) => { const ev = { ...e, eventSeq: ++eventSeq, at: now().toISOString() } as ServerEvent; listeners.forEach((l) => l(ev)) }
  const nextAt = (cron: string, enabled: boolean) => (enabled && !cronError(cron) ? nextRuns(cron, now(), 1)[0]?.toISOString() ?? null : null)

  async function run(method: MethodName, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'schedules.list':
        return { schedules: [...schedules.values()].filter((s) => (!p.roomId || s.roomId === p.roomId) && (!p.contactId || s.contactId === p.contactId)) }
      case 'schedules.preview': {
        const err = cronError(p.cron as string)
        if (err) return { valid: false, description: null, next: [], error: err }
        return { valid: true, description: describeCron(p.cron as string), next: nextRuns(p.cron as string, now(), (p.count as number | undefined) ?? 5).map((d) => d.toISOString()), error: null }
      }
      case 'schedules.create': {
        const err = cronError(p.cron as string)
        if (err) throw fail('invalid_params', err)
        const s: ScheduleView = { id: `sch-${++n}`, contactId: p.contactId as string, roomId: p.roomId as string, title: p.title as string, cron: p.cron as string, tz: p.tz as string, prompt: p.prompt as string, enabled: (p.enabled as boolean | undefined) ?? true, toleranceSec: (p.toleranceSec as number | undefined) ?? 300, missedPolicy: (p.missedPolicy as 'skip' | 'run-once' | undefined) ?? 'skip', nextRunAt: null, lastRun: null, commitmentId: null, createdAt: now().toISOString() }
        s.nextRunAt = nextAt(s.cron, s.enabled)
        schedules.set(s.id, s)
        emit({ type: 'schedule.updated', schedule: s })
        return s
      }
      case 'schedules.update': {
        const cur = schedules.get(p.scheduleId as string)
        if (!cur) throw fail('not_found', '没有这个定时')
        const { scheduleId: _id, ...patch } = p
        const s = { ...cur, ...patch } as ScheduleView
        const err = cronError(s.cron)
        if (err) throw fail('invalid_params', err)
        s.nextRunAt = nextAt(s.cron, s.enabled)
        schedules.set(s.id, s)
        emit({ type: 'schedule.updated', schedule: s })
        return s
      }
      case 'schedules.remove':
        if (!schedules.delete(p.scheduleId as string)) throw fail('not_found', '没有这个定时')
        emit({ type: 'schedule.removed', scheduleId: p.scheduleId })
        return { ok: true }
      case 'schedules.runNow': {
        const cur = schedules.get(p.scheduleId as string)
        if (!cur) throw fail('not_found', '没有这个定时')
        const run = { at: now().toISOString(), status: 'running' as const, messageSeq: null }
        history.set(cur.id, [{ ...run, error: null }, ...(history.get(cur.id) ?? [])])
        const s = { ...cur, lastRun: run }
        schedules.set(s.id, s)
        emit({ type: 'schedule.updated', schedule: s })
        return s
      }
      case 'schedules.history':
        return { runs: (history.get(p.scheduleId as string) ?? []).slice(0, (p.limit as number | undefined) ?? 50) }
      case 'plugins.marketplace': {
        const q = ((p.query as string | undefined) ?? '').toLowerCase()
        return { entries: seed.market.filter((e) => (!q || `${e.name} ${e.description} ${e.commands.join(' ')}`.toLowerCase().includes(q)) && (!p.kind || e.kinds.includes(p.kind as never))).map((e) => ({ ...e, installed: plugins.has(e.id) })) }
      }
      case 'plugins.list':
        return { plugins: [...plugins.values()] }
      case 'plugins.get': {
        const pl = plugins.get(p.pluginId as string)
        if (!pl) throw fail('not_found', '没装这个插件')
        return pl
      }
      case 'plugins.install': {
        const src = p.source as { kind: string; id?: string }
        if (src.kind !== 'marketplace') throw fail('unavailable', '从文件或地址安装要连接后端')
        const entry = seed.market.find((e) => e.id === src.id)
        if (!entry) throw fail('not_found', '市场里没有这个插件')
        const granted = new Set(p.grantedPermissions as string[])
        const missing = entry.permissions.filter((x) => !granted.has(x.key))
        if (missing.length) throw fail('forbidden', `还有 ${missing.length} 项权限没同意`, missing.map((x) => x.key))
        const pl: PluginView = { id: entry.id, name: entry.name, version: entry.latestVersion, latestVersion: null, kinds: entry.kinds, source: 'marketplace', enabled: true, status: 'ready', error: null, permissions: entry.permissions, configSchema: null, config: null, commands: entry.commands, installedAt: now().toISOString() }
        plugins.set(pl.id, pl)
        emit({ type: 'plugin.updated', plugin: pl })
        return pl
      }
      case 'plugins.setEnabled': {
        const cur = plugins.get(p.pluginId as string)
        if (!cur) throw fail('not_found', '没装这个插件')
        const pl = { ...cur, enabled: p.enabled as boolean }
        plugins.set(pl.id, pl)
        emit({ type: 'plugin.updated', plugin: pl })
        return pl
      }
      case 'plugins.update': {
        const cur = plugins.get(p.pluginId as string)
        if (!cur) throw fail('not_found', '没装这个插件')
        const pl = { ...cur, version: cur.latestVersion ?? cur.version, latestVersion: null }
        plugins.set(pl.id, pl)
        emit({ type: 'plugin.updated', plugin: pl })
        return pl
      }
      case 'plugins.uninstall':
        if (!plugins.delete(p.pluginId as string)) throw fail('not_found', '没装这个插件')
        emit({ type: 'plugin.removed', pluginId: p.pluginId })
        return { ok: true }
      case 'commands.list': {
        const pre = ((p.prefix as string | undefined) ?? '').toLowerCase()
        return { commands: seed.commands(p.roomId as string).filter((c) => c.name.startsWith(pre)) }
      }
      default:
        throw fail('unavailable', `演示模式没有实现 ${method},要连接后端`)
    }
  }

  return {
    calls,
    async handle(method: string, params: unknown): Promise<ApiResult<MethodName>> {
      const done = (r: ApiResult<MethodName>) => { calls.push({ method, params, ok: r.ok }); return r }
      if (!isMethodName(method)) return done(fail('unknown_method', `不认识的方法 ${method}`))
      const c = checkParams(method, params)
      if (!c.ok) return done(fail('invalid_params', formatIssues(c.issues), c.issues))
      try {
        const value = await run(method, c.value as Record<string, unknown>)
        const r = checkResult(method, value)
        if (!r.ok) return done(fail('internal', `演示服务回包不符合合同:${formatIssues(r.issues)}`))
        return done({ ok: true, value } as ApiResult<MethodName>)
      } catch (e) {
        if (e && typeof e === 'object' && 'ok' in e) return done(e as Fail)
        return done(fail('internal', e instanceof Error ? e.message : String(e)))
      }
    },
    subscribe(listener: (e: ServerEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
