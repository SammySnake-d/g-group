// P7 命令路由。内置 task/remind/stop 留在原宿主；插件命令经隔离进程执行。
import type { Host } from "./host.ts";

export class SlashCommands {
  private readonly host: Host;
  constructor(host: Host) { this.host = host; }
  async send(input: Parameters<Host["send"]>[0]) { return this.host.send(input); }
}

export function assertCommandNames(_commands: readonly { readonly name: string }[], _existing: readonly { readonly name: string; readonly pluginId: string | null }[], _pluginId: string) {}
