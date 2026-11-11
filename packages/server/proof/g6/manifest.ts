// G6 冻结清单:同一批题、各组提交、runner、模型/渠道/配置指纹、源权限与消息版本。
// 红提交空壳:签名在、返回假值(undefined),实现见下一个提交。
// 网关地址只留协议+主机+端口和整串的摘要(本机网关路径里带会话令牌),密钥一律不进清单,认证只记引用名。
import { createHash } from "node:crypto";
import { canonicalJson } from "./fixture.ts";
import type { FixtureItem, RawRecord } from "./types.ts";

export function endpointOf(baseUrl: string): { endpoint: string; endpointHash: string } { return undefined as never; }

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
export function configFingerprint(c: ModelConfig, runnerDigest = ""): string { return undefined as never; }
/**
 * 续跑身份:和配置指纹一样,但不含渠道地址。本机网关每次会话换端口和路径令牌,同一模型同一网关在会话之间要能续跑;
 * 渠道仍按配置指纹逐份记录,报告列出每行用到的全部指纹。
 */
export function reuseKey(c: ModelConfig, runnerDigest: string): string { return undefined as never; }
/** runner 驱动代码与题集的摘要:这些一改,旧的原始记录就不能续用。 */
export function runnerDigest(files: readonly { readonly name: string; readonly text: string }[]): string { return undefined as never; }

export function modelConfig(mode: "standin" | "real", model: string, env: Readonly<Record<string, string | undefined>>, settings: ModelConfig["settings"] = null, serial = false): ModelConfig { return undefined as never; }

/** 一道题的源权限(谁在哪个会话)与这次运行的消息版本(发、改、撤回的先后)。 */
export function sourceFreeze(item: FixtureItem, rec: RawRecord): { rooms: { key: string; kind: string; contacts: readonly string[] }[]; versions: { room: string; seq: number; version: number; retracted: boolean }[] } { return undefined as never; }
