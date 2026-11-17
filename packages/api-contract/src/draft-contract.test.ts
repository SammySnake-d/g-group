// 草稿相关的接口合同增量(AC-24、AC-37 ②):drafts.get / drafts.save、messages.send.draftVer、RoomView.draftPreview、draft.updated 事件。
// 单独成文件:只追加,不改 contract.test.ts 里已有的用例。
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEvent, checkParams, checkResult, formatIssues } from "./index.ts";

const AT = "2026-11-09T01:40:00+08:00";

test("drafts.save:草稿内容按 schema 校验(引用上限、@ 来源、版本非负),未声明字段被丢弃;drafts.get 只要 roomId", () => {
  const draft = { text: "关于登录模块", replyToSeq: 10, replyAuthorId: "c-claude", quotedSeqs: [10, 12], mentions: [{ id: "c-claude", source: "auto" }], draftVer: 3 };
  const r = checkParams("drafts.save", { roomId: "g1", expectedVer: 2, draft: { ...draft, cursor: 4 }, injected: 1 });
  assert.ok(r.ok, r.ok ? "" : formatIssues(r.issues));
  assert.deepEqual(r.value, { roomId: "g1", expectedVer: 2, draft });
  const bad = checkParams("drafts.save", { roomId: "g1", expectedVer: -1, draft: { ...draft, quotedSeqs: Array.from({ length: 51 }, (_, i) => i), mentions: [{ id: "c", source: "bot" }] } });
  assert.deepEqual(bad.ok ? [] : bad.issues.map((i) => i.path).sort(), ["draft.mentions[0].source", "draft.quotedSeqs", "expectedVer"]);
  assert.equal(formatIssues(bad.ok ? [] : bad.issues), "expectedVer: 应 ≥ 0; draft.quotedSeqs: 元素至多 50 个; draft.mentions[0].source: 应为 auto | manual 之一");
  assert.equal(checkParams("drafts.get", { roomId: "g1" }).ok, true);
  assert.equal(checkResult("drafts.get", { roomId: "g1", ...draft, updatedAt: null }).ok, true);
  assert.equal(checkResult("drafts.get", { roomId: "g1", ...draft, updatedAt: "刚才" }).ok, false);
});

test("增量字段:messages.send 可带 draftVer,RoomView 可带 draftPreview,draft.updated 事件携带草稿视图", () => {
  const sent = checkParams("messages.send", { roomId: "g1", clientActionId: "a9", text: "发了", draftVer: 5 });
  assert.ok(sent.ok);
  assert.equal(sent.value.draftVer, 5);
  assert.equal(checkParams("messages.send", { roomId: "g1", clientActionId: "a9", text: "发了", draftVer: -1 }).ok, false);
  const room = { id: "g1", kind: "group", title: "群", avatar: null, members: [], rules: "", rulesVersion: 0, pinned: false, muted: false, lastSeq: 3, readSeq: 3, unread: 0, pendingForUser: 0, lastMessagePreview: null, updatedAt: AT };
  const withDraft = checkResult("rooms.get", { ...room, draftPreview: "[草稿] 关于登录模块" });
  assert.ok(withDraft.ok);
  assert.equal((withDraft.value as { draftPreview?: string | null }).draftPreview, "[草稿] 关于登录模块");
  assert.equal(checkResult("rooms.get", room).ok, true, "老的会话视图(不带草稿字段)照样合法");
  const draft = { roomId: "g1", text: "", replyToSeq: null, replyAuthorId: null, quotedSeqs: [], mentions: [], draftVer: 6, updatedAt: AT };
  const ev = checkEvent({ type: "draft.updated", eventSeq: 11, at: AT, draft });
  assert.ok(ev.ok, ev.ok ? "" : formatIssues(ev.issues));
  assert.deepEqual(ev.value, { type: "draft.updated", eventSeq: 11, at: AT, draft });
});
