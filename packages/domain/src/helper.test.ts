// Helper 三种入口(用户 g-group#1365、#1353):
// 全局入口隔离,不在任何对话里展示;在聊天里 @Helper,回复作为消息出现在这个聊天里;在聊天里打开 Helper 侧边栏,带当前聊天上下文,但不作为消息。
// Helper 只为用户本人服务,不是项目成员,不认领任务。
import assert from "node:assert/strict";
import { test } from "node:test";
import { helperMayClaimTasks, routeHelper } from "./helper.ts";

const me = { kind: "user", id: "u1" } as const;

test("全局入口:回复在全局面板,不进任何对话,不读任何会话上下文", () => {
  const r = routeHelper({ kind: "global" }, me, "u1");
  assert.deepEqual(r, { ok: true, route: { replyIn: "global-panel", becomesMessage: false, contextConversation: null, replyToSeq: null } });
});

test("在聊天里 @Helper:回复作为消息出现在这个聊天里,并引用那条 @ 消息", () => {
  const r = routeHelper({ kind: "mention", conversationId: "g-group", seq: 1365 }, me, "u1");
  assert.deepEqual(r, { ok: true, route: { replyIn: "conversation", becomesMessage: true, contextConversation: "g-group", replyToSeq: 1365 } });
});

test("在聊天里打开侧边栏:带当前聊天上下文,但回复不作为消息", () => {
  const r = routeHelper({ kind: "sidebar", conversationId: "g-group" }, me, "u1");
  assert.deepEqual(r, { ok: true, route: { replyIn: "sidebar", becomesMessage: false, contextConversation: "g-group", replyToSeq: null } });
});

test("Helper 只听用户本人:三种入口下联系人(哪怕 id 与用户相同)和其他用户都被拒", () => {
  const entries = [{ kind: "global" }, { kind: "mention", conversationId: "g-group", seq: 9 }, { kind: "sidebar", conversationId: "g-group" }] as const;
  for (const e of entries) {
    for (const caller of [{ kind: "contact", id: "c-astra" }, { kind: "contact", id: "u1" }, { kind: "user", id: "u2" }] as const) {
      const r = routeHelper(e, caller, "u1");
      assert.equal(r.ok, false, `${e.kind} ${caller.kind}:${caller.id}`);
    }
    assert.equal(routeHelper(e, me, "u1").ok, true, e.kind);
  }
});

test("Helper 不是项目成员,不认领任务", () => {
  assert.equal(helperMayClaimTasks(), false);
});
