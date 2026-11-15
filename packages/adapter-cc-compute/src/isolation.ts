// 勾选能力(AC-29,需求文档 D07 §3):联系人专属配置目录、勾选 skill 的插件目录、勾选 MCP 服务器。
// 一次性适配器(adapter.ts)与常驻适配器(resident.ts)共用:spawn 选项的判定、--mcp-config 的合并、首个提示里的 skill 段、
// init 自报的实际加载清单与勾选的核对。只在启动时按白名单配置 harness、按 harness 自报核对配置已生效;不在运行中拦截 Compute 的工具调用。
import path from "node:path";
import { HOST_MCP, MCP_SERVER_NAME, firstPrompt, skillCatalog, skillsSection, toolOverreach } from "./cli.ts";
import { initLoaded } from "./events.ts";
import { isPlainRecord } from "./plain.ts";
import type { Brief, HandoffSnapshot, LoadedCapabilities, ManifestSection, McpServerSpec } from "./types.ts";

/** 勾选能力:都已是纯数据副本 */
export interface Isolation {
  readonly configDir: string | undefined;
  readonly pluginDirs: readonly string[];
  readonly mcpServers: Readonly<Record<string, McpServerSpec>>;
}
export const NO_ISOLATION: Isolation = Object.freeze({ configDir: undefined, pluginDirs: Object.freeze([]), mcpServers: Object.freeze({}) });
const isStrArr = (x: unknown): x is readonly string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

/** spawn 选项里的勾选能力字段:o 已是纯数据副本。不合格返回拒收理由 */
export function isolationOf(o: Readonly<Record<string, unknown>>): Isolation | string {
  const { configDir, pluginDirs, mcpServers } = o;
  if (configDir !== undefined && (typeof configDir !== "string" || !path.isAbsolute(configDir))) return "spawn 选项 configDir 必须是绝对路径";
  if (pluginDirs !== undefined && !(isStrArr(pluginDirs) && pluginDirs.every((d) => path.isAbsolute(d)))) return "spawn 选项 pluginDirs 必须是绝对路径数组";
  const servers: Record<string, McpServerSpec> = {};
  if (mcpServers !== undefined) {
    if (!isPlainRecord(mcpServers)) return "spawn 选项 mcpServers 必须是 {名字: {command, args?, env?}}";
    for (const [name, spec] of Object.entries(mcpServers)) {
      if (name === HOST_MCP) return `spawn 选项 mcpServers 不能用 ${HOST_MCP}(留给 report_progress)`;
      if (!MCP_SERVER_NAME.test(name)) return `spawn 选项 mcpServers 的名字 ${name} 不合规`;
      if (!isPlainRecord(spec) || typeof spec.command !== "string" || !spec.command || Object.keys(spec).some((k) => k !== "command" && k !== "args" && k !== "env")
        || (spec.args !== undefined && !isStrArr(spec.args))
        || (spec.env !== undefined && !(isPlainRecord(spec.env) && Object.values(spec.env).every((v) => typeof v === "string")))) {
        return `spawn 选项 mcpServers.${name} 必须是 {command: 非空字符串, args?: 字符串数组, env?: 字符串到字符串}`;
      }
      servers[name] = spec as unknown as McpServerSpec;
    }
  }
  return { configDir: configDir as string | undefined, pluginDirs: (pluginDirs as readonly string[] | undefined) ?? [], mcpServers: servers };
}

/** --mcp-config 的内容:勾选的 MCP 服务器与 host(report_progress)合并;勾选名不会是 host(isolationOf 已拒收) */
export function mcpConfigFor(iso: Isolation, server: { readonly command: string; readonly args?: readonly string[] }): { readonly mcpServers: Readonly<Record<string, { command: string; args: string[]; env: Record<string, string> }>> } {
  const picked = Object.fromEntries(Object.entries(iso.mcpServers).map(([n, x]) => [n, { command: x.command, args: [...(x.args ?? [])], env: { ...(x.env ?? {}) } }]));
  return { mcpServers: { ...picked, host: { command: server.command, args: [...(server.args ?? [])], env: {} } } };
}

/** 首个提示加勾选 skill 段:--bare 下 CLI 没有 Skill 工具,在首个提示里列出可用 skill 与 SKILL.md 路径(V-02 实测) */
export function promptWithSkills(brief: Brief, handoff: HandoffSnapshot | undefined, pluginDirs: readonly string[]): { readonly prompt: string; readonly sections: readonly ManifestSection[] } {
  const fp = firstPrompt(brief, handoff);
  const catalog = skillCatalog(pluginDirs);
  const skillText = skillsSection(catalog);
  if (!skillText) return fp;
  return { prompt: `${fp.prompt}\n\n${skillText}`, sections: [...fp.sections, { name: "skills" as const, detail: { items: catalog.map((s) => ({ name: s.name, file: s.file })) } }] };
}

/** init 那一行的 JSON 对象(已被 checkInit 判合格,这里只为读加载清单);解析不了给空对象 */
const rawRecord = (line: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** 以 CLI init 自报的实际挂载清单核对勾选配置已生效:工具不越出 brief 与勾选的 MCP(F-01);只许 host 与勾选的 MCP 服务器出现;
 *  勾选的必须连上(勾选的项全部可用)。合格时给出实际加载清单(AC-29 观测点) */
export function checkInitIsolation(brief: Brief, iso: Isolation, initTools: readonly string[], initLine: string): { readonly ok: true; readonly loaded: LoadedCapabilities } | { readonly ok: false; readonly reason: string } {
  const picked = Object.keys(iso.mcpServers);
  const loaded = initLoaded(rawRecord(initLine));
  const over = toolOverreach(brief, initTools, picked);
  if (over.length) return { ok: false, reason: `CLI 实际挂载了 brief 未授权的工具 ${over.join(", ")}` };
  const unpicked = loaded.mcpServers.filter((x) => x.name !== HOST_MCP && !picked.includes(x.name)).map((x) => x.name || "(无名)");
  if (unpicked.length) return { ok: false, reason: `CLI 实际挂载了未勾选的 MCP 服务器 ${unpicked.join(", ")}` };
  const down = picked.filter((n) => loaded.mcpServers.find((x) => x.name === n)?.status !== "connected");
  if (down.length) return { ok: false, reason: `勾选的 MCP 服务器没有连上:${down.join(", ")}` };
  return { ok: true, loaded: { skills: [...loaded.skills], mcpServers: loaded.mcpServers.map((x) => x.name) } };
}
