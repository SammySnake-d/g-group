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

function onlyOwner(host: Host, actor: MemoryActor) {
  if (actor.kind !== "user" || actor.id !== host.userId) throw new HostError("forbidden", "联系人的长期记忆只有用户本人能查看和改动");
}

/** 一个联系人的条目视图(联系人不存在 not_found) */
function views(host: Host, contactId: string): MemoryView[] {
  host.contactDoc(contactId);
  const store = host.memory;
  const entries = store.listAll(contactId).filter((e) => !e.anchors.includes(PERSONA_ANCHOR));
  const hidden = store.hiddenIds(entries);
  const now = store.now();
  return entries.map((e) => {
    const live = (e.status === "active" || e.status === "degraded") && (e.validFrom === null || e.validFrom <= now) && (e.validTo === null || e.validTo > now);
    const good = e.uses.filter((u) => u.good).length;
    return {
      id: e.id,
      contactId,
      version: e.version,
      status: e.status,
      state: hidden.has(e.id) ? "source-retracted" : e.status,
      scope: e.anchors.includes(GLOBAL_ANCHOR) ? "prefix" : "anchored",
      title: e.title,
      body: e.body,
      anchors: [...e.anchors],
      source: e.source === null ? null : { roomId: e.source.roomId, seq: e.source.seq, userQuote: e.source.userQuote },
      effective: live && !hidden.has(e.id),
      supersedes: [...e.supersedes],
      supersededBy: e.supersededBy,
      refines: [...e.refines],
      conflictsWith: [...e.conflictsWith],
      evidenceCount: e.evidence.length,
      uses: { good, bad: e.uses.length - good },
      validFrom: e.validFrom,
      validTo: e.validTo,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    };
  });
}

function viewOf(host: Host, contactId: string, memoryId: string): MemoryView {
  const v = views(host, contactId).find((x) => x.id === memoryId);
  if (!v) throw new HostError("not_found", `联系人 ${contactId} 没有记忆 ${memoryId}`);
  return v;
}

export function listMemoryViews(host: Host, actor: MemoryActor, p: ParamsOf<"memory.list">): { memories: MemoryView[] } {
  onlyOwner(host, actor);
  return { memories: views(host, p.contactId).filter((v) => (p.scope === undefined || v.scope === p.scope) && (p.status === undefined || v.state === p.status)) };
}

export function getMemoryView(host: Host, actor: MemoryActor, p: ParamsOf<"memory.get">): MemoryView {
  onlyOwner(host, actor);
  return viewOf(host, p.contactId, p.memoryId);
}

/** 用户撤销:active / degraded → revoked(升版本);已撤销原样返回;已替代 conflict。md 与索引行都保留,不物理删除。 */
export function revokeMemory(host: Host, actor: MemoryActor, p: ParamsOf<"memory.revoke">): MemoryView {
  onlyOwner(host, actor);
  viewOf(host, p.contactId, p.memoryId);
  const e = host.memory.listAll(p.contactId).find((x) => x.id === p.memoryId)!;
  if (e.status === "superseded") throw new HostError("conflict", `记忆 ${e.id} 已被 ${e.supersededBy ?? "新条目"} 替代,请撤销替代它的条目`);
  if (e.status !== "revoked") host.memory.put(p.contactId, { ...e, status: "revoked", version: e.version + 1, updatedAt: host.memory.now() });
  return viewOf(host, p.contactId, p.memoryId);
}

/** 用户触发重建:删掉索引从 md 真源重建,返回每个联系人重建出的条数 */
export function rebuildMemories(host: Host, actor: MemoryActor, p: ParamsOf<"memory.rebuild">): { contacts: { contactId: string; entries: number }[] } {
  onlyOwner(host, actor);
  if (p.contactId !== undefined) host.contactDoc(p.contactId);
  const ids = p.contactId !== undefined ? [p.contactId] : host.listContacts().map((c) => c.id);
  return { contacts: ids.map((contactId) => ({ contactId, entries: host.memory.rebuild(contactId) })) };
}

/** 资料页的长期记忆概览:按准入分两类,生效条数与最近更新的前几条;另计来源已撤回与已失效(已替代、已撤销)的条数 */
export function longTermMemory(host: Host, contactId: string): LongTermMemoryView {
  const all = views(host, contactId);
  const recent = (scope: MemoryView["scope"]) => {
    const items = all.filter((v) => v.effective && v.scope === scope).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1));
    return { count: items.length, items: items.slice(0, LONG_TERM_TOP) };
  };
  return {
    prefix: recent("prefix"),
    anchored: recent("anchored"),
    sourceRetracted: all.filter((v) => v.state === "source-retracted").length,
    inactive: all.filter((v) => v.state === "superseded" || v.state === "revoked").length,
  };
}

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
