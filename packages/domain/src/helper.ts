import { isSeq } from "./contact.ts";
import { normalize, type Schema } from "./plain.ts";

// Helper 三种入口(用户 g-group#1365、#1353)。Helper 的本质只有两条:只为用户本人服务;能读哪些内容。
// 隔离的是工具和上下文:操作软件的工具只在 Helper 身上;联系人 @Helper 不触发软件操作。
export type HelperEntry =
  | { kind: "global" }
  | { kind: "mention"; conversationId: string; seq: number }
  | { kind: "sidebar"; conversationId: string };
export interface HelperRoute {
  readonly replyIn: "global-panel" | "conversation" | "sidebar";
  readonly becomesMessage: boolean;
  readonly contextConversation: string | null;
  readonly replyToSeq: number | null;
}
export type RouteResult = { ok: true; route: HelperRoute } | { ok: false; reason: string };

const CALLER_SCHEMA: Schema = { kind: { kind: "string" }, id: { kind: "string" } };
const ENTRY_SCHEMAS: ReadonlyMap<string, Schema> = new Map<string, Schema>([
  ["global", {}],
  ["mention", { conversationId: { kind: "string" }, seq: { kind: "number" } }],
  ["sidebar", { conversationId: { kind: "string" } }],
]);
const no = (reason: string): RouteResult => ({ ok: false, reason });
const yes = (route: HelperRoute): RouteResult => ({ ok: true, route: Object.freeze(route) });

export function routeHelper(entry: HelperEntry, caller: { kind: "user" | "contact"; id: string }, owner: string): RouteResult {
  if (typeof owner !== "string" || !owner.trim()) return no("owner 必须是非空字符串");
  const who = normalize<{ kind: string; id: string }>(caller, CALLER_SCHEMA, "调用方");
  if (!who.ok) return no(who.reason);
  if (who.value.kind !== "user" && who.value.kind !== "contact") return no(`调用方种类 ${who.value.kind} 不认识`);
  if (!who.value.id.trim()) return no("调用方 id 不能为空");
  const head = normalize<{ kind: string }>(entry, { kind: { kind: "string" } }, "Helper 入口");
  if (!head.ok) return no(head.reason);
  const variant = ENTRY_SCHEMAS.get(head.value.kind);
  if (!variant) return no(`Helper 入口种类 ${head.value.kind} 不认识`);
  const n = normalize<{ conversationId?: string; seq?: number }>(entry, variant, "Helper 入口");
  if (!n.ok) return no(n.reason);
  const e = n.value;
  if (head.value.kind !== "global" && !e.conversationId?.trim()) return no("conversationId 必须是非空字符串");
  if (head.value.kind === "mention" && !isSeq(e.seq as number)) return no(`seq ${e.seq} 不是合法的消息位置(非负整数)`);
  if (who.value.kind !== "user" || who.value.id !== owner) return no("Helper 只为用户本人服务,其他人叫它不执行");
  switch (head.value.kind) {
    case "global": return yes({ replyIn: "global-panel", becomesMessage: false, contextConversation: null, replyToSeq: null });
    case "mention": return yes({ replyIn: "conversation", becomesMessage: true, contextConversation: e.conversationId as string, replyToSeq: e.seq as number });
    default: return yes({ replyIn: "sidebar", becomesMessage: false, contextConversation: e.conversationId as string, replyToSeq: null });
  }
}

export function helperMayClaimTasks(): boolean {
  return false;
}
