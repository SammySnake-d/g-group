// 联系人能力默认隔离加白名单(AC-29,需求 P0-1「参考 mirasim 的能力白名单与独立配置目录隔离」)。
// 全局能力库(宿主数据目录下,和本机个人 ~/.claude 无关):
//   <dataDir>/library/skills/<名>/SKILL.md     公共 skill
//   <dataDir>/library/mcp/<名>.json            公共 MCP 服务器 {command, args?, env?}
// 派活时按联系人勾选的 computeAssets 生成专属运行目录 <dataDir>/run_homes/<联系人>/<harness>/:
//   config/                                    CLAUDE_CONFIG_DIR:CLI 的设置与会话记录落在这里,不读写本机 ~/.claude(V-05 共用资源不冲突)
//   skills-<勾选指纹>/.claude-plugin/plugin.json
//   skills-<勾选指纹>/skills/<名> → 软链到库里的 skill 目录(经 --plugin-dir 交给 CLI)
// 本机全局 skill/MCP 默认不进入:CLI 以 --bare 启动时不读 ~/.claude/skills 与 CLAUDE_CONFIG_DIR/skills,
// skill 只从 --plugin-dir 加载;MCP 只连 --mcp-config 里给的(--strict-mcp-config)。V-02 实测见 proof/v02-config-dir.txt。
// 勾选了但库里没有(或配置坏了)的能力:派活失败并说明缺哪项,不带着缺项启动(「勾选的项全部可用」)。
// script 类资产不是 skill/MCP,这里不挂载。
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { McpServerSpec } from "@g-group/adapter-cc-compute";

export const SKILL_PLUGIN = "gg-skills";
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface Asset {
  readonly name: string;
  readonly kind: "mcp" | "skill" | "script";
}
export interface LibraryView {
  readonly skills: { readonly name: string; readonly description: string }[];
  readonly mcp: { readonly name: string }[];
}
/** 一次派活要交给 Compute 的隔离配置 */
export interface RunHome {
  readonly configDir: string;
  readonly pluginDirs: readonly string[];
  readonly mcpServers: Readonly<Record<string, McpServerSpec>>;
  /** CLI 里会看到的 skill 名(插件命名空间 gg-skills:<名>) */
  readonly skills: readonly string[];
}
export type PrepareResult = { readonly ok: true; readonly home: RunHome } | { readonly ok: false; readonly missing: readonly string[] };

const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
/** 路径片段:合规名字原样,其它取 sha256 前 16 位,不让联系人 id 拼出目录外的路径 */
const segment = (s: string): string => (NAME.test(s) ? s : `h-${createHash("sha256").update(s).digest("hex").slice(0, 16)}`);

function skillDescription(file: string): string {
  const text = readFileSync(file, "utf8");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const line = fm?.[1]?.split(/\r?\n/).find((l) => /^description\s*:/.test(l));
  return line ? line.replace(/^description\s*:\s*/, "").replace(/^["']|["']$/g, "").trim() : "";
}

/** 读 <名>.json 成 MCP 启动配置;不合格返回原因 */
function mcpSpec(file: string): McpServerSpec | string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return "配置不是合法 JSON";
  }
  if (!isRecord(raw) || typeof raw.command !== "string" || !raw.command) return "配置缺 command";
  if (Object.keys(raw).some((k) => k !== "command" && k !== "args" && k !== "env")) return "配置只收 command/args/env";
  if (raw.args !== undefined && !isStrArr(raw.args)) return "args 必须是字符串数组";
  if (raw.env !== undefined && !(isRecord(raw.env) && Object.values(raw.env).every((v) => typeof v === "string"))) return "env 必须是字符串到字符串";
  return { command: raw.command, ...(raw.args ? { args: [...raw.args] } : {}), ...(raw.env ? { env: { ...(raw.env as Record<string, string>) } } : {}) };
}

export class CapabilityLibrary {
  readonly root: string;
  readonly runHomes: string;
  constructor(dataDir: string) {
    this.root = path.join(dataDir, "library");
    this.runHomes = path.join(dataDir, "run_homes");
  }
  private skillDir(name: string) {
    return path.join(this.root, "skills", name);
  }
  private mcpFile(name: string) {
    return path.join(this.root, "mcp", `${name}.json`);
  }
  /** 库里可勾选的 skill 与 MCP(联系人设置页的勾选清单) */
  list(): LibraryView {
    const skills: { name: string; description: string }[] = [];
    const sd = path.join(this.root, "skills");
    if (existsSync(sd)) {
      for (const n of readdirSync(sd).sort()) {
        const f = path.join(sd, n, "SKILL.md");
        if (NAME.test(n) && existsSync(f)) skills.push({ name: n, description: skillDescription(f) });
      }
    }
    const mcp: { name: string }[] = [];
    const md = path.join(this.root, "mcp");
    if (existsSync(md)) for (const f of readdirSync(md).sort()) if (f.endsWith(".json") && NAME.test(f.slice(0, -5)) && typeof mcpSpec(path.join(md, f)) !== "string") mcp.push({ name: f.slice(0, -5) });
    return { skills, mcp };
  }

  /** 按勾选集合生成专属运行目录。缺项(库里没有、配置坏了)一律不启动,返回缺哪些 */
  prepare(contactId: string, harness: string, assets: readonly Asset[]): PrepareResult {
    const missing: string[] = [];
    const skills: string[] = [];
    const mcpServers: Record<string, McpServerSpec> = {};
    for (const a of assets) {
      if (a.kind === "script") continue;
      if (!NAME.test(a.name)) {
        missing.push(`${a.name}(名字不合规)`);
        continue;
      }
      if (a.kind === "skill") {
        if (existsSync(path.join(this.skillDir(a.name), "SKILL.md"))) skills.push(a.name);
        else missing.push(`skill ${a.name}(能力库里没有)`);
      } else {
        const f = this.mcpFile(a.name);
        const spec = existsSync(f) ? mcpSpec(f) : "能力库里没有";
        if (typeof spec === "string") missing.push(`MCP ${a.name}(${spec})`);
        else if (a.name === "host") missing.push("MCP host(名字留给 report_progress)");
        else mcpServers[a.name] = spec;
      }
    }
    if (missing.length) return { ok: false, missing };
    const home = path.join(this.runHomes, segment(contactId), segment(harness));
    const configDir = path.join(home, "config");
    mkdirSync(configDir, { recursive: true });
    const pluginDirs: string[] = [];
    if (skills.length) {
      skills.sort();
      // 勾选指纹:同一组勾选复用同一个插件目录,改了勾选就是新目录,正在跑的 Compute 看的旧目录不被改动
      const fp = createHash("sha256").update(JSON.stringify(skills.map((s) => [s, this.skillDir(s)]))).digest("hex").slice(0, 12);
      const dir = path.join(home, `skills-${fp}`);
      if (!existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) {
        const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
        rmSync(tmp, { recursive: true, force: true });
        mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
        mkdirSync(path.join(tmp, "skills"), { recursive: true });
        writeFileSync(path.join(tmp, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: SKILL_PLUGIN, version: "0.0.0", description: "联系人勾选的 skill(宿主生成)" })}\n`);
        for (const s of skills) symlinkSync(this.skillDir(s), path.join(tmp, "skills", s), "dir");
        rmSync(dir, { recursive: true, force: true });
        renameSync(tmp, dir);
      }
      pluginDirs.push(dir);
    }
    return { ok: true, home: { configDir, pluginDirs, mcpServers, skills: skills.map((s) => `${SKILL_PLUGIN}:${s}`) } };
  }

  /** 运行目录里实际软链出来的 skill(测试与诊断用):插件目录 skills/ 下每一项指向库里的哪个目录 */
  linkedSkills(pluginDir: string): { name: string; target: string }[] {
    const d = path.join(pluginDir, "skills");
    if (!existsSync(d) || !statSync(d).isDirectory()) return [];
    return readdirSync(d)
      .sort()
      .filter((n) => lstatSync(path.join(d, n)).isSymbolicLink())
      .map((n) => ({ name: n, target: path.resolve(d, readlinkSync(path.join(d, n))) }));
  }
}
