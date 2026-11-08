// 联系人能力默认隔离加白名单(AC-29):全局能力库 + 每位联系人的专属运行目录。空壳(先红),实现见下一个提交。
import type { McpServerSpec } from "@g-group/adapter-cc-compute";

export const SKILL_PLUGIN = "gg-skills";
export interface Asset {
  readonly name: string;
  readonly kind: "mcp" | "skill" | "script";
}
export interface LibraryView {
  readonly skills: { readonly name: string; readonly description: string }[];
  readonly mcp: { readonly name: string }[];
}
export interface RunHome {
  readonly configDir: string;
  readonly pluginDirs: readonly string[];
  readonly mcpServers: Readonly<Record<string, McpServerSpec>>;
  readonly skills: readonly string[];
}
export type PrepareResult = { readonly ok: true; readonly home: RunHome } | { readonly ok: false; readonly missing: readonly string[] };

export class CapabilityLibrary {
  readonly root: string;
  readonly runHomes: string;
  constructor(dataDir: string) {
    this.root = dataDir;
    this.runHomes = dataDir;
  }
  list(): LibraryView {
    return { skills: [], mcp: [] };
  }
  prepare(_contactId: string, _harness: string, _assets: readonly Asset[]): PrepareResult {
    return { ok: false, missing: [] };
  }
  linkedSkills(_pluginDir: string): { name: string; target: string }[] {
    return [];
  }
}
