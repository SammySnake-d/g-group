// 拼装 claude CLI 的启动参数、环境与首个提示。全部是纯函数,适配器只负责把它们交给子进程。
// 这些函数经包根导出,是外部入口(R6-01):对象参数先过纯数据合同(brief 过 checkBrief、交接快照过 checkSnapshot、
// hostEnv/initTools 过 plainData),状态参数先判 typeof;getter/setter、Proxy(含嵌套、已撤销)、带 toPrimitive/toString 的对象
// 不调用即抛受控 TypeError,之后只读冻结副本。合同限定内置原型未被改的环境(g-group#2662)。
import os from "node:os";
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

export function allowedTools(input: Brief): readonly string[] {
  return Object.freeze([...safeBrief(input, "allowedTools").tools, REPORT_TOOL]);
}

/** CLI init 里实际挂上的工具超出 brief 授权的部分(空数组表示没有越界) */
export function toolOverreach(input: Brief, initToolsInput: readonly string[]): readonly string[] {
  const allowed = new Set(allowedTools(safeBrief(input, "toolOverreach")));
  const initTools = safeStrings(initToolsInput, "toolOverreach 的 initTools");
  return Object.freeze(initTools.filter((t) => !allowed.has(t)));
}

export function cliArgs(input: Brief, promptInput: string, mcpConfigPathInput: string, resumeSessionInput?: string): readonly string[] {
  const brief = safeBrief(input, "cliArgs");
  const prompt = safeString(promptInput, "cliArgs 的 prompt");
  const mcpConfigPath = safeString(mcpConfigPathInput, "cliArgs 的 mcpConfigPath");
  const resumeSession = resumeSessionInput === undefined ? undefined : safeString(resumeSessionInput, "cliArgs 的 resumeSession");
  return Object.freeze([
    "-p", prompt,
    ...(resumeSession ? ["--resume", resumeSession] : []),
    "--output-format", "stream-json", "--verbose",
    // --bare:不读 CLAUDE.md、auto-memory、hooks 与插件,Compute 不带宿主一侧的记忆
    "--bare",
    "--mcp-config", mcpConfigPath, "--strict-mcp-config",
    // --tools 限定可见的内置工具,--allowedTools + dontAsk 让清单外的调用一律被拒
    "--tools", brief.tools.join(","),
    "--allowedTools", allowedTools(brief).join(","),
    "--permission-mode", "dontAsk",
    "--append-system-prompt", SYSTEM_PROMPT,
  ]);
}

/** 子进程环境:不继承宿主进程的整份 env;凭据只以引用句柄出现 */
export function cliEnv(input: Brief, computeIdInput: string, hostEnvInput: Readonly<Record<string, string>> = {}): Record<string, string> {
  const brief = safeBrief(input, "cliEnv");
  const computeId = safeString(computeIdInput, "cliEnv 的 computeId");
  // hostEnv 与 createComputeAdapter 的判定一致:纯数据、字符串到字符串,值为 undefined 也拒绝
  const p = plainData(hostEnvInput, "hostEnv");
  if (!p.ok || !isPlainRecord(p.value) || !Object.values(p.value).every((v) => typeof v === "string")) throw new TypeError("cliEnv 的 hostEnv 必须是纯数据的字符串到字符串对象");
  const hostEnv = p.value as Readonly<Record<string, string>>;
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? os.homedir(),
    TMPDIR: os.tmpdir(),
    ...hostEnv,
    G_GROUP_COMPUTE_ID: computeId,
    G_GROUP_CREDENTIAL_REFS: JSON.stringify(brief.credentialRefs),
  };
}
