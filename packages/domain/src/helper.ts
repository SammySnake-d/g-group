import { isSeq, normalize, type Schema } from "./contact.ts";

// Helper 三种入口(用户 g-group#1365、#1353)。Helper 的本质只有两条:只为用户本人服务;能读哪些内容。
// 回复出现在哪,跟着在哪叫它走:
//   全局入口 → 回复在全局面板,隔离,不进任何对话,不读任何会话;
//   在聊天里 @Helper → 回复作为一条消息出现在这个聊天里(像 QQ bot),能读当前聊天;
//   在聊天里打开 Helper 侧边栏 → 能读当前聊天,但回复留在侧边栏,不作为消息。
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
/** 入口按 kind 分变体,每个变体只取自己声明的字段,别的字段丢掉。 */
const ENTRY_SCHEMAS: ReadonlyMap<string, Schema> = new Map<string, Schema>([
  ["global", {}],
  ["mention", { conversationId: { kind: "string" }, seq: { kind: "number" } }],
  ["sidebar", { conversationId: { kind: "string" } }],
]);
const no = (reason: string): RouteResult => ({ ok: false, reason });

/**
 * entry、caller 都走领域层统一的普通数据对象合同(contact.ts normalize:Proxy、非普通原型、含访问器一律拒绝)。
 * 入口形状不对、kind 不认识、caller 不合形状或 owner 不是非空字符串时返回 { ok:false, reason },不抛、不返回 undefined。
 */
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
    case "global": return { ok: true, route: { replyIn: "global-panel", becomesMessage: false, contextConversation: null, replyToSeq: null } };
    case "mention": return { ok: true, route: { replyIn: "conversation", becomesMessage: true, contextConversation: e.conversationId as string, replyToSeq: e.seq as number } };
    default: return { ok: true, route: { replyIn: "sidebar", becomesMessage: false, contextConversation: e.conversationId as string, replyToSeq: null } };
  }
}

/** Helper 不是项目成员:不参与扫一眼抢活,不认领任务。 */
export function helperMayClaimTasks(): boolean {
  return false;
}
