/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: 红提交空壳,签名先行 */
// 插件注册表(AC-35 阶段 I 宿主契约桩)。类型见 plugin-contract.ts。红提交空壳。
import type { PluginRegistry, RegistryOptions } from "./plugin-contract.ts";

export * from "./plugin-contract.ts";

export function createRegistry(opts: RegistryOptions = {}): PluginRegistry {
  throw new Error("未实现");
}
