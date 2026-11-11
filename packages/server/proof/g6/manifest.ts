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
  /** 本组给宿主的设置补丁(预取开关等) */
  readonly settings: Readonly<Record<string, unknown>> | null;
}
/** 配置指纹:非敏感配置的规范化摘要。同模型换渠道、换认证引用或换设置都会变。 */
export function configFingerprint(c: ModelConfig): string { return undefined as never; }

export function modelConfig(mode: "standin" | "real", model: string, env: Readonly<Record<string, string | undefined>>, settings: ModelConfig["settings"] = null): ModelConfig { return undefined as never; }

/** 一道题的源权限(谁在哪个会话)与这次运行的消息版本(发、改、撤回的先后)。 */
export function sourceFreeze(item: FixtureItem, rec: RawRecord): { rooms: { key: string; kind: string; contacts: readonly string[] }[]; versions: { room: string; seq: number; version: number; retracted: boolean }[] } { return undefined as never; }
