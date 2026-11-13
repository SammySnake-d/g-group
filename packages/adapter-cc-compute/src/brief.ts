// CC 的具体工具策略留在 adapter;纯数据、凭据与交接校验归共享 Compute 端口。
import { checkComputeBrief } from "@g-group/kernel/compute";
import type { Brief, Refusal } from "./types.ts";
export { checkSnapshot, isCredentialRef } from "@g-group/kernel/compute";

/** 能原样交给 claude --tools 的具体内置工具名。不在这里的(含 CLI 的控制词 default、空串、通配)一律拒绝:
 *  --tools 会把 default 展开成整套内置工具,不能当普通工具名(Codex 审查 F-01)。冻结数组,导出后不可改 */
export const CC_BUILTIN_TOOLS: readonly string[] = Object.freeze(["Read", "Write", "Edit", "Glob", "Grep", "Bash", "NotebookEdit", "WebFetch", "WebSearch"]);

export function checkBrief(input: unknown): { readonly ok: true; readonly brief: Brief } | Refusal {
  return checkComputeBrief(input, CC_BUILTIN_TOOLS);
}
