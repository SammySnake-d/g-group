// G6 冻结清单:同一批题、各组提交、runner、模型/渠道/配置指纹、源权限与消息版本。
// 网关地址只留协议+主机+端口和整串的摘要(本机网关路径里带会话令牌),密钥一律不进清单,认证只记引用名。
import { createHash } from "node:crypto";
import { canonicalJson } from "./fixture.ts";
import type { FixtureItem, RawRecord } from "./types.ts";

export function endpointOf(baseUrl: string): { endpoint: string; endpointHash: string } {
  let origin = "(不是合法 URL)";
  try {
    origin = new URL(baseUrl).origin;
  } catch {}
  return { endpoint: origin, endpointHash: createHash("sha256").update(baseUrl).digest("hex").slice(0, 16) };
}

export interface ModelConfig {
  readonly mode: "standin" | "real";
  readonly model: string;
  readonly endpoint: string;
  readonly endpointHash: string;
  /** 认证引用(环境变量名),不是值 */
  readonly authRef: string;
  /** 本组的宿主选项覆盖(预取开关、精筛安静期等) */
  readonly settings: Readonly<Record<string, unknown>> | null;
  /** 一次只放一个模型调用 */
  readonly serial: boolean;
}
/** 配置指纹:非敏感配置的规范化摘要(含 runner 驱动代码摘要)。同模型换渠道、换认证引用或换设置都会变。 */
export function configFingerprint(c: ModelConfig, runnerDigest = ""): string {
  return createHash("sha256").update(canonicalJson({ ...c, runnerDigest })).digest("hex").slice(0, 32);
}
/**
 * 续跑身份:和配置指纹一样,但不含渠道地址。本机网关每次会话换端口和路径令牌,同一模型同一网关在会话之间要能续跑;
 * 渠道仍按配置指纹逐份记录,报告列出每行用到的全部指纹。
 */
export function reuseKey(c: ModelConfig, runnerDigest: string): string {
  const { endpoint: _e, endpointHash: _h, ...rest } = c;
  return createHash("sha256").update(canonicalJson({ ...rest, runnerDigest })).digest("hex").slice(0, 32);
}
/** runner 驱动代码与题集的摘要:这些一改,旧的原始记录就不能续用。 */
export function runnerDigest(files: readonly { readonly name: string; readonly text: string }[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) h.update(`${f.name}\u0000${f.text}\u0000`);
  return h.digest("hex").slice(0, 16);
}

export function modelConfig(mode: "standin" | "real", model: string, env: Readonly<Record<string, string | undefined>>, settings: ModelConfig["settings"] = null, serial = false): ModelConfig {
  if (mode === "standin") return { mode, model, endpoint: "进程内规则替身", endpointHash: "-", authRef: "(无)", settings, serial };
  const { endpoint, endpointHash } = endpointOf(env.ANTHROPIC_BASE_URL ?? "");
  return { mode, model, endpoint, endpointHash, authRef: env.ANTHROPIC_AUTH_TOKEN ? "env:ANTHROPIC_AUTH_TOKEN" : env.ANTHROPIC_API_KEY ? "env:ANTHROPIC_API_KEY" : "(缺)", settings, serial };
}

/** 一道题的源权限(谁在哪个会话)与这次运行的消息版本(发、改、撤回的先后)。 */
export function sourceFreeze(item: FixtureItem, rec: RawRecord): { rooms: { key: string; kind: string; contacts: readonly string[] }[]; versions: { room: string; seq: number; version: number; retracted: boolean }[] } {
  const versions = new Map<string, { room: string; seq: number; version: number; retracted: boolean }>();
  for (const o of [...rec.ops].sort((a, b) => a.order - b.order)) {
    const k = `${o.room}#${o.seq}`;
    versions.set(k, { room: o.room, seq: o.seq, version: o.order, retracted: (versions.get(k)?.retracted ?? false) || o.op === "retract" });
  }
  return { rooms: item.rooms.map((r) => ({ key: r.key, kind: r.kind, contacts: r.contacts })), versions: [...versions.values()] };
}
