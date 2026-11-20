// 界面模型 ↔ 接口合同(@g-group/api-contract)的转换。界面里的定时、插件、命令比合同多一些字段
import { type ContactView, EFFORTS, HARNESSES, type MarketplaceEntry, type ParamsOf, type PluginView, type ScheduleView, type SlashCommand as WireCommand } from '@g-group/api-contract'
import { cronError, nextRuns, type PluginCategory, type PluginManifest, type SlashArg, type SlashCommand } from '@g-group/ui-core'
import type { Cron, Person, PluginState } from '@/data'

type PluginKind = PluginView['kinds'][number]

export const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const title = (text: string) => text.split('\n')[0]!.trim().slice(0, 200) || '定时'
const isCron = (c: Pick<Cron, 'trigger'>): c is Pick<Cron, 'trigger'> & { trigger: { kind: 'cron'; expr: string } } => c.trigger.kind === 'cron'


type Harness = ContactView['harness']
type Effort = NonNullable<ContactView['computeModel']['effort']>
const isHarness = (h: string | undefined): h is Harness => (HARNESSES as readonly string[]).includes(h ?? '')
const isEffort = (e: string | undefined): e is Effort => (EFFORTS as readonly string[]).includes(e ?? '')

export function toContactView(p: Person, now = new Date()): ContactView | null {
  if (p.human || p.id === 'helper') return null
  const slot = p.computeModel
  return {
    id: p.id, name: p.name.slice(0, 80), avatar: null, bio: p.role.slice(0, 2000), speakingModel: p.model ?? '', harness: isHarness(p.harness) ? p.harness : 'claude-code',
    computeModel: { mode: slot?.mode ?? 'inherit', ...(slot?.model ? { model: slot.model } : {}), ...(isEffort(slot?.effort) ? { effort: slot.effort } : {}) },
    tools: [], computeAssets: (p.tools ?? []).filter((t) => t.on).map((t) => ({ name: t.name, kind: t.kind })),
    computeSlots: p.computeQuota ?? null, activity: 'idle', createdAt: now.toISOString(),
  }
}


export function toScheduleView(c: Cron, now = new Date()): ScheduleView | null {
  if (!isCron(c)) return null
  const expr = c.trigger.expr
  const last = c.runs[0]
  return {
    id: c.id, contactId: c.owner, roomId: c.conv, title: title(c.text), cron: expr, tz: localTz(), prompt: c.text || title(c.text),
    enabled: !c.paused, toleranceSec: 300, missedPolicy: 'skip',
    nextRunAt: !c.paused && !cronError(expr) ? (nextRuns(expr, now, 1)[0]?.toISOString() ?? null) : null,
    lastRun: last ? { at: last.at, status: last.result === 'error' ? 'failed' : 'ok', messageSeq: null } : null,
    commitmentId: null, createdAt: now.toISOString(),
  }
}

export function scheduleCreate(c: Omit<Cron, 'id' | 'runs'>, clientActionId: string): ParamsOf<'schedules.create'> | null {
  if (!isCron(c)) return null
  return { clientActionId, contactId: c.owner, roomId: c.conv, title: title(c.text), cron: c.trigger.expr, tz: localTz(), prompt: c.text || title(c.text), enabled: !c.paused }
}

export function scheduleUpdate(scheduleId: string, patch: Partial<Cron>): ParamsOf<'schedules.update'> | null {
  const p: ParamsOf<'schedules.update'> = { scheduleId }
  if (patch.text !== undefined) { p.title = title(patch.text); p.prompt = patch.text || title(patch.text) }
  if (patch.trigger?.kind === 'cron') p.cron = patch.trigger.expr
  if (patch.paused !== undefined) p.enabled = !patch.paused
  return Object.keys(p).length > 1 ? p : null
}


const KIND: Record<PluginCategory, PluginKind[]> = { source: ['data-source'], outbound: ['outbound-channel'], ui: ['ui-extension'], command: [] }
const permissions = (m: PluginManifest) => m.permissions.map((p) => ({ key: p.scope, description: p.detail.slice(0, 500) }))

export function toMarketEntry(m: PluginManifest): MarketplaceEntry {
  return { id: m.id, name: m.name, publisher: m.publisher, description: m.summary, icon: null, kinds: KIND[m.category], latestVersion: m.version, commands: m.contributes.commands.map((c) => c.name), permissions: permissions(m), installed: false }
}

export function toPluginView(s: PluginState, catalog: PluginManifest[], now = new Date()): PluginView | null {
  const m = s.manifest
  if (!m || s.phase === 'not_installed') return null
  const latest = catalog.find((x) => x.id === s.id)?.version
  return {
    id: s.id, name: m.name, version: m.version, latestVersion: latest && latest !== m.version ? latest : null, kinds: KIND[m.category], source: 'marketplace',
    enabled: s.phase === 'enabled', status: s.phase === 'installing' ? 'installing' : s.phase === 'uninstalling' ? 'uninstalling' : 'ready', error: null,
    permissions: permissions(m), configSchema: null, config: null, commands: m.contributes.commands.map((c) => c.name), installedAt: now.toISOString(),
  }
}


const ARG_KIND: Record<SlashArg['kind'], WireCommand['args'][number]['kind']> = { text: 'text', number: 'number', person: 'contact', choice: 'choice', time: 'cron' }

export function toWireCommand(c: SlashCommand): WireCommand {
  const [kind, id] = c.source === 'builtin' ? ['builtin', null] : (c.source.split(':') as [string, string])
  return {
    name: c.name, description: c.desc.slice(0, 200),
    args: c.args.map((a) => ({ name: a.name.slice(0, 40), description: a.hint.slice(0, 200), kind: ARG_KIND[a.kind], required: a.required, ...(a.options ? { choices: [...a.options] } : {}) })),
    source: kind === 'plugin' ? 'plugin' : kind === 'assistant' ? 'contact' : 'builtin',
    pluginId: kind === 'plugin' ? id : null,
    targetContactId: kind === 'assistant' ? id : null,
  }
}
