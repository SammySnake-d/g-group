// 联系人长期记忆的对外接口(需求文档 D25 第 4 节;验收 AC-42 ⑤⑧⑨、AC-54)。红提交:只有空壳,签名在、返回假值。
import type { LongTermMemoryView, MemoryView, ParamsOf } from "@g-group/api-contract";
import { HostError } from "./db.ts";
import type { Host } from "./host.ts";

export const LONG_TERM_TOP = 5;

export interface MemoryActor {
  readonly kind: string;
  readonly id: string;
}

export function listMemoryViews(_host: Host, _actor: MemoryActor, _p: ParamsOf<"memory.list">): { memories: MemoryView[] } {
  return { memories: [] };
}

export function getMemoryView(_host: Host, _actor: MemoryActor, p: ParamsOf<"memory.get">): MemoryView {
  throw new HostError("not_found", `没有记忆 ${p.memoryId}`);
}

export function revokeMemory(_host: Host, _actor: MemoryActor, p: ParamsOf<"memory.revoke">): MemoryView {
  throw new HostError("not_found", `没有记忆 ${p.memoryId}`);
}

export function rebuildMemories(_host: Host, _actor: MemoryActor, _p: ParamsOf<"memory.rebuild">): { contacts: { contactId: string; entries: number }[] } {
  return { contacts: [] };
}

export function longTermMemory(_host: Host, _contactId: string): LongTermMemoryView {
  return { prefix: { count: 0, items: [] }, anchored: { count: 0, items: [] }, sourceRetracted: 0, inactive: 0 };
}

export function memoryHandlers(host: Host) {
  const me = (): MemoryActor => ({ kind: "user", id: host.userId });
  return {
    "memory.list": (p: ParamsOf<"memory.list">) => listMemoryViews(host, me(), p),
    "memory.get": (p: ParamsOf<"memory.get">) => getMemoryView(host, me(), p),
    "memory.revoke": (p: ParamsOf<"memory.revoke">) => revokeMemory(host, me(), p),
    "memory.rebuild": (p: ParamsOf<"memory.rebuild">) => rebuildMemories(host, me(), p),
  };
}
