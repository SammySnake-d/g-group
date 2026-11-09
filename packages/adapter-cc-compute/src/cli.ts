// 拼装 claude CLI 的启动参数、环境与首个提示。全部是纯函数,适配器只负责把它们交给子进程。
// 这些函数经包根导出,是外部入口(R6-01):对象参数先过纯数据合同(brief 过 checkBrief、交接快照过 checkSnapshot、
// hostEnv/initTools 过 plainData),状态参数先判 typeof;getter/setter、Proxy(含嵌套、已撤销)、带 toPrimitive/toString 的对象
// 不调用即抛受控 TypeError,之后只读冻结副本。合同限定内置原型未被改的环境(g-group#2662)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkBrief, checkSnapshot } from "./brief.ts";
import { freezeDeep, isPlainRecord, plainData } from "./plain.ts";
import type { Brief, HandoffSnapshot, ManifestSection } from "./types.ts";

export const REPORT_TOOL = "mcp__host__report_progress";

export const SYSTEM_PROMPT =
  "你是宿主派出的 Compute。宿主只通过 report_progress 工具了解你的进展:开始时报 started,每完成一个阶段报 milestone(带 stage)," +
  "无法继续需要用户时报 blocked(带 needs)然后立即停止,全部完成报 completed。知道当前约束版本、未决问题或已完成的副作用时," +
  "随汇报带上 constraintVer/openQuestions/doneSideEffects。凭据只有引用句柄,需要时向宿主申请,不要猜测明文。不要只用文字汇报。";

/** 外部给的 brief:先过 checkBrief(纯数据合同 + 五字段白名单),不合格抛受控 TypeError,之后只用冻结副本 */
function safeBrief(input: unknown, at: string): Brief {
  const b = checkBrief(input);
  if (!b.ok) throw new TypeError(`${at} 的 brief 不合格:${b.reason}`);
  return b.brief;
}
/** 状态参数只收字符串:typeof 判定,不做隐式转换(toString/toPrimitive 不调用) */
function safeString(x: unknown, name: string): string {
  if (typeof x !== "string") throw new TypeError(`${name} 必须是字符串`);
  return x;
}
/** 字符串数组:先过纯数据合同,再查元素类型 */
function safeStrings(x: unknown, name: string): readonly string[] {
  const p = plainData(x, name);
  if (!p.ok || !Array.isArray(p.value) || !p.value.every((s) => typeof s === "string")) throw new TypeError(`${name} 必须是纯数据字符串数组`);
  return p.value as readonly string[];
}

export function firstPrompt(input: Brief, handoffInput?: HandoffSnapshot): { readonly prompt: string; readonly sections: readonly ManifestSection[] } {
  const brief = safeBrief(input, "firstPrompt");
  let handoff: HandoffSnapshot | undefined;
  if (handoffInput !== undefined) {
    const h = checkSnapshot(handoffInput);
    if (!h.ok) throw new TypeError(`firstPrompt 的交接快照不合格:${h.reason}`);
    handoff = h.snapshot;
  }
  const parts: string[] = [`[任务]\n${brief.task}`];
  const sections: ManifestSection[] = [{ name: "task", detail: { text: brief.task } }];
  parts.push(`[生效群规与硬约束]\n${brief.rules.length ? brief.rules.map((r) => `- ${r}`).join("\n") : "(无)"}`);
  sections.push({ name: "rules", detail: { items: [...brief.rules] } });
  if (handoff) {
    const list = (xs: readonly string[]) => (xs.length ? xs.map((s) => `- ${s}`).join("\n") : "(无)");
    parts.push(`[交接快照]\n约束版本: ${handoff.constraintVer}\n未决问题:\n${list(handoff.openQuestions)}\n已完成副作用(不要重做):\n${list(handoff.doneSideEffects)}`);
    sections.push({ name: "handoff", detail: { constraintVer: handoff.constraintVer, openQuestions: [...handoff.openQuestions], doneSideEffects: [...handoff.doneSideEffects] } });
  }
  if (brief.credentialRefs.length) {
    parts.push(`[凭据引用]\n${brief.credentialRefs.map((c) => `- ${c}(句柄,不是明文)`).join("\n")}`);
    sections.push({ name: "credentialRefs", detail: { refs: [...brief.credentialRefs] } });
  }
  // 返回值深冻结:调用方拿到的清单改不动
  return freezeDeep({ prompt: parts.join("\n\n"), sections });
}

/** 勾选 MCP 服务器名:字母数字、下划线、连字符,1–64 个字符;host 留给 report_progress(AC-29) */
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const HOST_MCP = "host";
/** 勾选 MCP 服务器名列表:纯数据字符串数组,每个合规、不是 host、不重复 */
function safeMcpNames(x: unknown, name: string): readonly string[] {
  if (x === undefined) return Object.freeze([]);
  const names = safeStrings(x as readonly string[], name);
  for (const n of names) {
    if (!MCP_SERVER_NAME.test(n)) throw new TypeError(`${name} 里的 MCP 服务器名 ${n} 不合规`);
    if (n === HOST_MCP) throw new TypeError(`${name} 里不能有 ${HOST_MCP}(留给 report_progress)`);
  }
  if (new Set(names).size !== names.length) throw new TypeError(`${name} 有重复的 MCP 服务器名`);
  return names;
}

/** --allowedTools:brief 的工具 + report_progress + 每个勾选 MCP 服务器整组放行(mcp__<名>) */
export function allowedTools(input: Brief, mcpServersInput?: readonly string[]): readonly string[] {
  const brief = safeBrief(input, "allowedTools");
  const mcp = safeMcpNames(mcpServersInput, "allowedTools 的 mcpServers");
  return Object.freeze([...brief.tools, REPORT_TOOL, ...mcp.map((n) => `mcp__${n}`)]);
}

/** CLI init 里实际挂上的工具超出授权的部分(空数组表示没有越界):勾选 MCP 服务器只放行 mcp__<名>__ 开头的工具 */
export function toolOverreach(input: Brief, initToolsInput: readonly string[], mcpServersInput?: readonly string[]): readonly string[] {
  const brief = safeBrief(input, "toolOverreach");
  const mcp = safeMcpNames(mcpServersInput, "toolOverreach 的 mcpServers");
  const allowed = new Set(allowedTools(brief));
  const initTools = safeStrings(initToolsInput, "toolOverreach 的 initTools");
  return Object.freeze(initTools.filter((t) => !allowed.has(t) && !mcp.some((n) => t.startsWith(`mcp__${n}__`))));
}

/** 勾选 skill 的目录(AC-29):每个插件目录 .claude-plugin/plugin.json 的 name 作命名空间,skills/<名>/SKILL.md 是正文。
 *  --bare 下 CLI 没有 Skill 工具,skill 只能经提示开头的 /<命名空间>:<名> 展开(V-02 实测),所以首个提示里列出可用 skill
 *  与 SKILL.md 的绝对路径,Compute 需要时用 Read 读来照做。读不到的目录或文件跳过,不抛错 */
export function skillCatalog(pluginDirsInput: readonly string[]): readonly { readonly name: string; readonly description: string; readonly file: string }[] {
  const dirs = safeStrings(pluginDirsInput, "skillCatalog 的 pluginDirs");
  const out: { name: string; description: string; file: string }[] = [];
  for (const d of dirs) {
    let ns = "";
    try {
      const m: unknown = JSON.parse(fs.readFileSync(path.join(d, ".claude-plugin", "plugin.json"), "utf8"));
      ns = isPlainRecord(m) && typeof m.name === "string" ? m.name : "";
    } catch { continue; }
    if (!ns) continue;
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(d, "skills")).sort(); } catch { continue; }
    for (const n of names) {
      const file = path.join(d, "skills", n, "SKILL.md");
      let text = "";
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
      const line = fm.split(/\r?\n/).find((l) => /^description\s*:/.test(l)) ?? "";
      out.push({ name: `${ns}:${n}`, description: line.replace(/^description\s*:\s*/, "").trim(), file });
    }
  }
  return freezeDeep(out);
}

/** 首个提示里的 [可用 skill] 段;没有 skill 返回 null */
export function skillsSection(catalog: readonly { readonly name: string; readonly description: string; readonly file: string }[]): string | null {
  if (!catalog.length) return null;
  return `[可用 skill](联系人勾选的;要用时先用 Read 读对应 SKILL.md 再照做)\n${catalog.map((s) => `- ${s.name}:${s.description || "(无描述)"} —— ${s.file}`).join("\n")}`;
}

/** cliArgs 的可选部分(AC-29):勾选 skill 的插件目录、勾选 MCP 服务器名 */
export interface CliExtra {
  readonly pluginDirs?: readonly string[];
  readonly mcpServers?: readonly string[];
}

export function cliArgs(input: Brief, promptInput: string, mcpConfigPathInput: string, resumeSessionInput?: string, extraInput?: CliExtra): readonly string[] {
  const brief = safeBrief(input, "cliArgs");
  const prompt = safeString(promptInput, "cliArgs 的 prompt");
  const mcpConfigPath = safeString(mcpConfigPathInput, "cliArgs 的 mcpConfigPath");
  const resumeSession = resumeSessionInput === undefined ? undefined : safeString(resumeSessionInput, "cliArgs 的 resumeSession");
  let extra: CliExtra = {};
  if (extraInput !== undefined) {
    const p = plainData(extraInput, "cliArgs 的 extra");
    if (!p.ok || !isPlainRecord(p.value) || Object.keys(p.value).some((k) => k !== "pluginDirs" && k !== "mcpServers")) throw new TypeError("cliArgs 的 extra 只收纯数据 {pluginDirs?, mcpServers?}");
    extra = p.value as CliExtra;
  }
  const pluginDirs = extra.pluginDirs === undefined ? [] : safeStrings(extra.pluginDirs, "cliArgs 的 pluginDirs");
  if (pluginDirs.some((d) => !path.isAbsolute(d))) throw new TypeError("cliArgs 的 pluginDirs 必须是绝对路径");
  const mcp = safeMcpNames(extra.mcpServers, "cliArgs 的 mcpServers");
  return Object.freeze([
    "-p", prompt,
    ...(resumeSession ? ["--resume", resumeSession] : []),
    "--output-format", "stream-json", "--verbose",
    // 流式增量:模型开始回应(首字节)和长输出进行中都有行可看,宿主的整轮卡死检测才不会把长生成误判成没回应(D26 第 8.3 节)
    "--include-partial-messages",
    // --bare:不读 CLAUDE.md、auto-memory、hooks 与插件,Compute 不带宿主一侧的记忆
    "--bare",
    // --bare 下 skill 只从 --plugin-dir 加载:只给联系人勾选的那些(AC-29,V-02 实测)
    ...pluginDirs.flatMap((d) => ["--plugin-dir", d]),
    "--mcp-config", mcpConfigPath, "--strict-mcp-config",
    // --tools 限定可见的内置工具,--allowedTools + dontAsk 让清单外的调用一律被拒
    "--tools", brief.tools.join(","),
    "--allowedTools", allowedTools(brief, mcp).join(","),
    "--permission-mode", "dontAsk",
    "--append-system-prompt", SYSTEM_PROMPT,
  ]);
}

/** 子进程环境:不继承宿主进程的整份 env;凭据只以引用句柄出现。
 *  configDir(联系人专属配置目录,AC-29)给了就作为 CLAUDE_CONFIG_DIR,盖过 hostEnv 里的同名变量 */
export function cliEnv(input: Brief, computeIdInput: string, hostEnvInput: Readonly<Record<string, string>> = {}, configDirInput?: string): Record<string, string> {
  const brief = safeBrief(input, "cliEnv");
  const computeId = safeString(computeIdInput, "cliEnv 的 computeId");
  const configDir = configDirInput === undefined ? undefined : safeString(configDirInput, "cliEnv 的 configDir");
  if (configDir !== undefined && !path.isAbsolute(configDir)) throw new TypeError("cliEnv 的 configDir 必须是绝对路径");
  // hostEnv 与 createComputeAdapter 的判定一致:纯数据、字符串到字符串,值为 undefined 也拒绝
  const p = plainData(hostEnvInput, "hostEnv");
  if (!p.ok || !isPlainRecord(p.value) || !Object.values(p.value).every((v) => typeof v === "string")) throw new TypeError("cliEnv 的 hostEnv 必须是纯数据的字符串到字符串对象");
  const hostEnv = p.value as Readonly<Record<string, string>>;
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? os.homedir(),
    TMPDIR: os.tmpdir(),
    ...hostEnv,
    ...(configDir !== undefined ? { CLAUDE_CONFIG_DIR: configDir } : {}),
    G_GROUP_COMPUTE_ID: computeId,
    G_GROUP_CREDENTIAL_REFS: JSON.stringify(brief.credentialRefs),
  };
}
