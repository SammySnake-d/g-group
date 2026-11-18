// 联系人长期记忆的对外接口(需求文档 D25 第 4 节;验收 AC-42 ⑤⑧⑨、AC-54)。只给用户本人:联系人、Helper 或别的身份来调一律 forbidden。
//   list / get:全部条目(不含「建议改人格」),标出准入(前缀 / 锚点)、对外状态(含「来源已撤回」)、现在是否进上下文;
//   revoke:按 D25 状态机改「已撤销」并升版本,md 与索引都保留(不物理删除);之后不进任何上下文;
//   rebuild:删掉索引从 md 真源重建;longTermMemory:联系人资料页的长期记忆概览。
import type { LongTermMemoryView, MemoryView, ParamsOf } from "@g-group/api-contract";
import { GLOBAL_ANCHOR } from "@g-group/kernel";
import { HostError } from "./db.ts";
import type { Host } from "./host.ts";

/** 与 host.ts 的同名常量一致:压缩检查记下的「建议改人格」不是长期记忆条目,这里不列。 */
const PERSONA_ANCHOR = "persona-suggestion";
/** 资料页每类给最近更新的前几条 */
export const LONG_TERM_TOP = 5;

export interface MemoryActor {
  readonly kind: string;
  readonly id: string;
}

function onlyOwner(host: Host, actor: MemoryActor) { throw new Error("P1-A compile-only stub"); }

/** 一个联系人的条目视图(联系人不存在 not_found) */
function views(host: Host, contactId: string): MemoryView[] { throw new Error("P1-A compile-only stub"); }

function viewOf(host: Host, contactId: string, memoryId: string): MemoryView { throw new Error("P1-A compile-only stub"); }

export function listMemoryViews(host: Host, actor: MemoryActor, p: ParamsOf<"memory.list">): { memories: MemoryView[] } { throw new Error("P1-A compile-only stub"); }

export function getMemoryView(host: Host, actor: MemoryActor, p: ParamsOf<"memory.get">): MemoryView { throw new Error("P1-A compile-only stub"); }

/** 用户撤销:active / degraded → revoked(升版本);已撤销原样返回;已替代 conflict。md 与索引行都保留,不物理删除。 */
export function revokeMemory(host: Host, actor: MemoryActor, p: ParamsOf<"memory.revoke">): MemoryView { throw new Error("P1-A compile-only stub"); }

/** 用户触发重建:删掉索引从 md 真源重建,返回每个联系人重建出的条数 */
export function rebuildMemories(host: Host, actor: MemoryActor, p: ParamsOf<"memory.rebuild">): { contacts: { contactId: string; entries: number }[] } { throw new Error("P1-A compile-only stub"); }

/** 资料页的长期记忆概览:按准入分两类,生效条数与最近更新的前几条;另计来源已撤回与已失效(已替代、已撤销)的条数 */
export function longTermMemory(host: Host, contactId: string): LongTermMemoryView { throw new Error("P1-A compile-only stub"); }

/** service 的 memory.* 处理器:service 只代表用户本人调用 */
export function memoryHandlers(host: Host) {
  const me = (): MemoryActor => ({ kind: "user", id: host.userId });
  return {
    "memory.list": (p: ParamsOf<"memory.list">) => listMemoryViews(host, me(), p),
    "memory.get": (p: ParamsOf<"memory.get">) => getMemoryView(host, me(), p),
    "memory.revoke": (p: ParamsOf<"memory.revoke">) => revokeMemory(host, me(), p),
    "memory.rebuild": (p: ParamsOf<"memory.rebuild">) => rebuildMemories(host, me(), p),
  };
}
