// 前后端接口合同:渲染进程经 preload 调的方法、主进程推的事件,参数与结果在边界上按同一份 schema 校验。
// 服务于 AC-30 最小闭环(私聊/群聊派活 → 任务 → Compute 进度 → 回到聊天)的前端接线;本文件只验合同本身的判别力。
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEvent, checkParams, checkResult, formatIssues, IPC, isMethodName, METHOD_NAMES, METHODS } from "./index.ts";

const AT = "2026-11-08T21:40:00+08:00";

test("messages.send:回复 + 多条引用 + 手打 @ 原样通过,未声明字段被丢弃", () => {
  const r = checkParams("messages.send", {
    roomId: "g1",
    clientActionId: "act-1",
    text: "看下这两条",
    replyToSeq: 10,
    quotedSeqs: [10, 12, 18],
    mentions: [{ id: "c-claude", source: "auto" }, { id: "c-argon", source: "manual" }],
    injected: "不应回传",
  });
  assert.ok(r.ok, r.ok ? "" : formatIssues(r.issues));
  assert.deepEqual(r.value, {
    roomId: "g1",
    clientActionId: "act-1",
    text: "看下这两条",
    replyToSeq: 10,
    quotedSeqs: [10, 12, 18],
    mentions: [{ id: "c-claude", source: "auto" }, { id: "c-argon", source: "manual" }],
  });
});

test("messages.send:缺 clientActionId、负序号、超过 50 条引用都被拒,并指出字段路径", () => {
  const r = checkParams("messages.send", { roomId: "g1", text: "x", replyToSeq: -1, quotedSeqs: Array.from({ length: 51 }, (_, i) => i) });
  assert.equal(r.ok, false);
  const paths = r.ok ? [] : r.issues.map((i) => i.path).sort();
  assert.deepEqual(paths, ["clientActionId", "quotedSeqs", "replyToSeq"]);
});

test("slash 命令随消息发出:命令名与参数按 JSON 校验,非普通对象参数被拒", () => {
  const good = checkParams("messages.send", { roomId: "g1", clientActionId: "a2", text: "/summary 今天", command: { name: "summary", args: { range: "today" } } });
  assert.ok(good.ok);
  assert.deepEqual(good.value.command, { name: "summary", args: { range: "today" } });
  const bad = checkParams("messages.send", { roomId: "g1", clientActionId: "a3", text: "/x", command: { name: "x", args: new Map() } });
  assert.equal(bad.ok, false);
});

test("访问器字段一律拒绝,不调用 getter", () => {
  let called = 0;
  const params = { roomId: "g1", clientActionId: "a4" } as Record<string, unknown>;
  Object.defineProperty(params, "text", { enumerable: true, get: () => { called++; return "hi"; } });
  const r = checkParams("messages.send", params);
  assert.equal(r.ok, false);
  assert.equal(called, 0);
  assert.match(r.ok ? "" : formatIssues(r.issues), /text: 字段不能是访问器/);
});

test("类实例与数组不当作参数对象", () => {
  class Fake { roomId = "g1"; seq = 1; }
  assert.equal(checkParams("rooms.markRead", new Fake()).ok, false);
  assert.equal(checkParams("rooms.markRead", [["roomId", "g1"]]).ok, false);
  assert.equal(checkParams("rooms.markRead", { roomId: "g1", seq: 1 }).ok, true);
});

test("plugins.install:三种来源按 kind 分派;url 必须 https,未知来源被拒", () => {
  const market = checkParams("plugins.install", { clientActionId: "p1", source: { kind: "marketplace", id: "telegram-reader" }, grantedPermissions: ["read:telegram"] });
  assert.ok(market.ok);
  assert.deepEqual(market.value.source, { kind: "marketplace", id: "telegram-reader" });
  assert.ok(checkParams("plugins.install", { clientActionId: "p2", source: { kind: "local-path", path: "/tmp/p" }, grantedPermissions: [] }).ok);
  assert.equal(checkParams("plugins.install", { clientActionId: "p3", source: { kind: "url", url: "http://x" }, grantedPermissions: [] }).ok, false);
  const unknown = checkParams("plugins.install", { clientActionId: "p4", source: { kind: "ftp", url: "ftp://x" }, grantedPermissions: [] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok ? "" : formatIssues(unknown.issues), /source\.kind: 应为 marketplace \| local-path \| url 之一/);
});

test("schedules.create:cron 与时区必填,容差超过一天被拒", () => {
  const base = { clientActionId: "s1", contactId: "c1", roomId: "g1", title: "每日总结", cron: "0 8 * * *", tz: "Asia/Shanghai", prompt: "总结 G1" };
  assert.ok(checkParams("schedules.create", base).ok);
  const { tz: _tz, ...noTz } = base;
  assert.equal(checkParams("schedules.create", noTz).ok, false);
  assert.equal(checkParams("schedules.create", { ...base, toleranceSec: 86401 }).ok, false);
  const preview = checkResult("schedules.preview", { valid: true, description: "每天 08:00(Asia/Shanghai)", next: ["2026-11-09T08:00:00+08:00"], error: null });
  assert.ok(preview.ok);
  assert.equal(checkResult("schedules.preview", { valid: true, description: null, next: ["明早八点"], error: null }).ok, false);
});

test("tasks.list:状态只接受领域状态机里的名字", () => {
  assert.ok(checkParams("tasks.list", { states: ["T3_Running", "T8a_Delivered"] }).ok);
  assert.equal(checkParams("tasks.list", { states: ["Running"] }).ok, false);
});

test("事件流:按 type 分派,compute.progress 校验进度负载,未知类型被拒", () => {
  const ev = checkEvent({ type: "compute.progress", eventSeq: 7, at: AT, progress: { computeId: "cp1", taskId: "t1", kind: "milestone", stage: "测试", summary: "跑完 12 条", at: AT } });
  assert.ok(ev.ok, ev.ok ? "" : formatIssues(ev.issues));
  assert.equal(ev.value.type, "compute.progress");
  assert.equal(checkEvent({ type: "compute.progress", eventSeq: 7, at: AT, progress: { computeId: "cp1", taskId: "t1", kind: "thinking", summary: "", at: AT } }).ok, false);
  assert.equal(checkEvent({ type: "task.deleted", eventSeq: 8, at: AT }).ok, false);
  assert.equal(checkEvent({ type: "contact.activity", eventSeq: 9, at: "昨天", contactId: "c1", roomId: null, activity: "replying" }).ok, false);
});

test("message.appended 事件携带完整消息视图(含回复、引用快照与卡片)", () => {
  const message = {
    roomId: "g1", seq: 20, threadRootSeq: null, sender: { kind: "contact", id: "c-claude" }, text: "交付了", mentions: [], replyToSeq: 12,
    quotedSeqs: [12, 15], quotes: [{ seq: 12, senderName: "Argon", excerpt: "…", state: "ok" }, { seq: 15, senderName: "Astra", excerpt: "", state: "retracted" }],
    attachments: [], card: { kind: "delivery", cardId: "k1", taskId: "t1", title: "交付", body: "diff", state: "open", actions: [{ actionId: "accept", label: "通过", style: "primary" }] },
    command: null, reactions: [], edited: false, retracted: false, clientActionId: null, at: AT,
  };
  const r = checkEvent({ type: "message.appended", eventSeq: 10, at: AT, message });
  assert.ok(r.ok, r.ok ? "" : formatIssues(r.issues));
  assert.deepEqual(r.value, { type: "message.appended", eventSeq: 10, at: AT, message });
  assert.equal(checkEvent({ type: "message.appended", eventSeq: 10, at: AT, message: { ...message, card: { ...message.card, state: "clicked" } } }).ok, false);
});

test("方法表:名字形如「域.动作」,每个都有参数与结果 schema;未知方法名不认", () => {
  assert.ok(METHOD_NAMES.length >= 40);
  for (const m of METHOD_NAMES) {
    assert.match(m, /^[a-z]+\.[a-zA-Z]+$/);
    assert.equal(typeof METHODS[m].params.check, "function");
    assert.equal(typeof METHODS[m].result.check, "function");
  }
  assert.equal(isMethodName("messages.send"), true);
  assert.equal(isMethodName("toString"), false);
  assert.equal(isMethodName("__proto__"), false);
  assert.deepEqual(Object.values(IPC).sort(), ["gg:event", "gg:invoke", "gg:subscribe", "gg:unsubscribe"]);
});

test("标识符拒绝空串与控制字符", () => {
  assert.equal(checkParams("rooms.get", { roomId: "" }).ok, false);
  assert.equal(checkParams("rooms.get", { roomId: "g\u00001" }).ok, false);
  assert.equal(checkParams("rooms.get", { roomId: "g\n1" }).ok, false);
  assert.equal(checkParams("rooms.get", { roomId: "群-1" }).ok, true);
});
