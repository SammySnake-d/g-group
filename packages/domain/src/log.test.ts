// AC-05 只追加:撤回、编辑、纠正都是新事件,禁止原地改写原记录;日志带 hash 链。
// AC-03 Compute 不上群公屏:发言者只能是用户、联系人(以及被 @ 时作答的 Helper)。
import assert from "node:assert/strict";
import { test } from "node:test";
import { append, emptyLog, type Log, project, verify } from "./log.ts";

const user = { kind: "user", id: "u1" } as const;
const contactA = { kind: "contact", id: "c-astra" } as const;
const at = "2026-11-05T13:40:00Z";

function sample(): Log {
  let log = emptyLog();
  log = append(log, user, { kind: "message", text: "谁修一下登录页" }, at);
  log = append(log, contactA, { kind: "message", text: "我来" }, at);
  return log;
}

test("追加的事件序号递增并串成 hash 链", () => {
  const log = sample();
  const seqs = log.events.map((e) => e.seq);
  assert.deepEqual(seqs, [1, 2]);
  assert.equal(log.events[1]?.prev, log.events[0]?.hash);
  assert.deepEqual(verify(log), { ok: true });
});

test("原地改写旧记录会被 hash 链查出(阳性埋雷)", () => {
  const log = sample();
  const tampered: Log = { events: log.events.map((e) => (e.seq === 1 ? { ...e, body: { kind: "message", text: "改过了" } } : e)) };
  assert.deepEqual(verify(tampered), { ok: false, brokenAt: 1 });
});

test("编辑是一条新事件,原记录逐字节不变,投影显示新文字", () => {
  const before = sample();
  const after = append(before, user, { kind: "edit", target: 1, text: "谁修一下登录页的样式" }, at);
  assert.equal(after.events.length, 3);
  assert.deepEqual(after.events[0], before.events[0]);
  const view = project(after);
  assert.equal(view.find((m) => m.seq === 1)?.text, "谁修一下登录页的样式");
  assert.equal(view.find((m) => m.seq === 1)?.edited, true);
  assert.deepEqual(verify(after), { ok: true });
});

test("撤回只追加撤回事件,投影标记已撤回,原记录保留", () => {
  const after = append(sample(), contactA, { kind: "retract", target: 2 }, at);
  assert.equal(after.events[1]?.body.kind, "message");
  const m2 = project(after).find((m) => m.seq === 2);
  assert.equal(m2?.retracted, true);
  assert.equal(m2?.text, "");
});

test("只改可见性的投影不改原记录 hash(阴性对照)", () => {
  const log = sample();
  const hashes = log.events.map((e) => e.hash);
  project(log);
  const after = append(log, contactA, { kind: "retract", target: 2 }, at);
  assert.deepEqual(after.events.slice(0, 2).map((e) => e.hash), hashes);
});

test("Compute 不能直接在群里发言(AC-03)", () => {
  assert.throws(() => append(sample(), { kind: "compute", id: "cc-1" }, { kind: "message", text: "我改完了" }, at), { code: "sender-not-allowed" });
});

test("联系人转述 Compute 结果可以发出(AC-03 阴性对照)", () => {
  const log = append(sample(), contactA, { kind: "message", text: "Compute 报告:登录页已修好" }, at);
  assert.equal(project(log).at(-1)?.sender.kind, "contact");
});

test("只有原发言者能编辑或撤回自己的消息", () => {
  assert.throws(() => append(sample(), contactA, { kind: "edit", target: 1, text: "篡改用户原话" }, at), { code: "not-original-sender" });
  assert.throws(() => append(sample(), user, { kind: "retract", target: 2 }, at), { code: "not-original-sender" });
});

test("编辑或撤回的目标必须是存在且未撤回的消息", () => {
  const retracted = append(sample(), contactA, { kind: "retract", target: 2 }, at);
  assert.throws(() => append(retracted, contactA, { kind: "edit", target: 2, text: "复活" }, at), { code: "target-retracted" });
  assert.throws(() => append(sample(), user, { kind: "edit", target: 99, text: "x" }, at), { code: "target-not-found" });
  assert.throws(() => append(retracted, contactA, { kind: "retract", target: 3 }, at), { code: "target-not-message" });
});
