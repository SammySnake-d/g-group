// U03/U26 群主撤回别人的消息、宿主 system 通知(D05):领域层只认宿主交来的群主身份;system 能写进只追加记录,
// 但只作上下文,不给联系人留处置义务。撤回仍是新事件,原事件 hash 不变(AC-05)。
import assert from "node:assert/strict";
import { test } from "node:test";
import { append, contextOnly, emptyLog, type Log, project, verify } from "./log.ts";

const owner = { kind: "user", id: "u-owner" } as const;
const member = { kind: "user", id: "u-member" } as const;
const contactA = { kind: "contact", id: "c-a" } as const;
const at = "2026-11-11T09:00:00Z";

function group(): Log {
  let log = emptyLog();
  log = append(log, owner, { kind: "message", text: "今天发版" }, at);
  log = append(log, contactA, { kind: "message", text: "收到,我来跑回归" }, at);
  log = append(log, member, { kind: "message", text: "我补一下文档" }, at);
  return log;
}
const ownerAuth = { groupOwner: owner };
/** 事件 hash 是 sha256 十六进制;verify 只比对自洽,算错的 hash 只要前后一致它也认 */
const SHA256 = /^[0-9a-f]{64}$/;

test("system 发言者可以写进会话记录:投影保留发言者种类与原文,hash 链完整", () => {
  const log = append(group(), { kind: "system", id: "host" }, { kind: "message", text: "本群已解散" }, at);
  const last = project(log).at(-1);
  assert.deepEqual([last?.sender, last?.text], [{ kind: "system", id: "host" }, "本群已解散"]);
  assert.match(log.events.at(-1)!.hash, SHA256);
  assert.deepEqual(verify(log), { ok: true });
});

test("system 通知只作上下文、不产生处置义务;用户、联系人、Helper 的消息照旧要处理", () => {
  const sys = append(group(), { kind: "system", id: "host" }, { kind: "message", text: "本群已解散" }, at).events.at(-1)!;
  assert.deepEqual(
    [sys.sender, owner, contactA, { kind: "helper", id: "helper" }].map((s) => contextOnly(s)),
    [true, false, false, false],
  );
});

test("群主能撤回群里别人的消息:只追加一条撤回事件,原事件与 hash 不变,投影标已撤回", () => {
  const before = group();
  const saved = JSON.stringify(before.events);
  const after = append(before, owner, { kind: "retract", target: 2 }, at, ownerAuth);
  assert.equal(JSON.stringify(after.events.slice(0, 3)), saved);
  assert.deepEqual(after.events.at(-1)?.body, { kind: "retract", target: 2 });
  const m2 = project(after).find((m) => m.seq === 2);
  assert.deepEqual([m2?.retracted, m2?.text], [true, ""]);
  assert.match(after.events.at(-1)!.hash, SHA256);
  assert.equal(after.events.at(-1)!.prev, before.events.at(-1)!.hash);
  assert.deepEqual(verify(after), { ok: true });
});

test("非群主撤回别人的消息被拒;群主也不能编辑别人的消息;不给群主身份时群主也只能撤回自己的", () => {
  // 对照:群主身份生效时能撤回(否则下面的拒绝可能只是撤回整体坏了)
  const allowed = append(group(), owner, { kind: "retract", target: 3 }, at, ownerAuth);
  assert.equal(project(allowed).find((m) => m.seq === 3)?.retracted, true);
  assert.match(allowed.events.at(-1)!.hash, SHA256);
  assert.throws(() => append(group(), member, { kind: "retract", target: 2 }, at, ownerAuth), { code: "not-original-sender" });
  assert.throws(() => append(group(), owner, { kind: "edit", target: 2, text: "改别人的话" }, at, ownerAuth), { code: "not-original-sender" });
  assert.throws(() => append(group(), owner, { kind: "retract", target: 2 }, at), { code: "not-original-sender" });
  assert.throws(() => append(group(), owner, { kind: "retract", target: 2 }, at, { groupOwner: null }), { code: "not-original-sender" });
  // 已撤回的不能再撤
  const once = append(group(), owner, { kind: "retract", target: 2 }, at, ownerAuth);
  assert.throws(() => append(once, owner, { kind: "retract", target: 2 }, at, ownerAuth), { code: "target-retracted" });
});
