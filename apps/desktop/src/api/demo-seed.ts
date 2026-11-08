// 演示服务的种子:把界面的初始演示数据(定时、已装插件、市场目录)转成合同形状;
// 命令清单按会话现算(谁在场、插件挂没挂),由状态层传进来。
import type { PluginManifest, SlashCommand } from '@g-group/ui-core'
import type { Cron, PluginState } from '@/data'
import { toMarketEntry, toPluginView, toScheduleView, toWireCommand } from './adapters'
import type { DemoSeed } from './demo-server'

export function demoSeed(input: { crons: Cron[]; plugins: PluginState[]; catalog: PluginManifest[]; commands: (roomId: string) => SlashCommand[] }): DemoSeed {
  const now = new Date()
  return {
    schedules: input.crons.flatMap((c) => toScheduleView(c, now) ?? []),
    plugins: input.plugins.flatMap((p) => toPluginView(p, input.catalog, now) ?? []),
    market: input.catalog.map(toMarketEntry),
    commands: (roomId) => input.commands(roomId).map(toWireCommand),
  }
}
