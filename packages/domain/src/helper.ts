// Helper 三种入口(用户 g-group#1365):全局入口隔离且不进对话;在聊天里 @Helper 回复作为消息进对话;
// 在聊天里打开 Helper 侧边栏带当前聊天上下文但不作为消息。—— 红提交:空壳
export type HelperEntry = { kind: "global" } | { kind: "mention"; conversationId: string; seq: number } | { kind: "sidebar"; conversationId: string };
export interface HelperRoute { replyIn: "global-panel" | "conversation" | "sidebar"; becomesMessage: boolean; contextConversation: string | null; replyToSeq: number | null }
export type RouteResult = { ok: true; route: HelperRoute } | { ok: false; reason: string };
export function routeHelper(_entry: HelperEntry, _caller: { kind: "user" | "contact"; id: string }, _owner: string): RouteResult { throw new Error("未实现"); }
export function helperMayClaimTasks(): boolean { throw new Error("未实现"); }
