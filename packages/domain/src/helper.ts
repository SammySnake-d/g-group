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

// 红提交:空壳
export function routeHelper(entry: HelperEntry, caller: { kind: "user" | "contact"; id: string }, owner: string): RouteResult {
  throw new Error("未实现");
}

/** Helper 不是项目成员:不参与扫一眼抢活,不认领任务。 */
export function helperMayClaimTasks(): boolean {
  throw new Error("未实现");
}
