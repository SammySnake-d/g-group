// AC-05 只追加:撤回、编辑、纠正都是新事件,禁止原地改写原记录;日志带 hash 链。
// AC-03 Compute 不上群公屏:会话里的发言者只能是用户、联系人,以及被 @ 时就地作答的 Helper。
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
const snap = (x: unknown) => JSON.stringify(x);

test("追加的事件序号递增并串成 hash 链", () => {
  const log = sample();
  assert.deepEqual(log.events.map((e) => e.seq), [1, 2]);
  assert.equal(log.events[1]?.prev, log.events[0]?.hash);
  assert.deepEqual(verify(log), { ok: true });
});

test("原地改写旧记录正文会被 hash 链查出(阳性埋雷)", () => {
  const log = sample();
  const tampered: Log = { events: log.events.map((e) => (e.seq === 1 ? { ...e, body: { kind: "message", text: "改过了" } } : e)) };
  assert.deepEqual(verify(tampered), { ok: false, brokenAt: 1 });
});

test("单条 hash 自洽但与前一条脱链会被查出(阳性埋雷)", () => {
  const log = sample();
  const forged = append(append(emptyLog(), user, { kind: "message", text: "另一条历史" }, at), contactA, { kind: "message", text: "我来" }, at);
  // 用另一条链上 seq=2 的事件替换:它自身 hash 正确,但 prev 指向的不是本链第 1 条
  const spliced: Log = { events: [log.events[0]!, forged.events[1]!] };
  assert.notEqual(spliced.events[1]?.prev, spliced.events[0]?.hash);
  assert.deepEqual(verify(spliced), { ok: false, brokenAt: 2 });
});

test("编辑是一条新事件,调用前的整份日志快照逐字节不变,投影显示新文字", () => {
  const before = sample();
  const saved = snap(before);
  const after = append(before, user, { kind: "edit", target: 1, text: "谁修一下登录页的样式" }, at);
  assert.equal(snap(before), saved);
  assert.equal(after.events.length, 3);
  assert.equal(snap(after.events.slice(0, 2)), saved.slice(saved.indexOf("["), saved.lastIndexOf("]") + 1));
  const m1 = project(after).find((m) => m.seq === 1);
  assert.equal(m1?.text, "谁修一下登录页的样式");
  assert.equal(m1?.edited, true);
  assert.deepEqual(verify(after), { ok: true });
});

test("撤回只追加撤回事件,投影标记已撤回,调用前快照不变", () => {
  const before = sample();
  const saved = snap(before);
  const after = append(before, contactA, { kind: "retract", target: 2 }, at);
  assert.equal(snap(before), saved);
  assert.equal(after.events[1]?.body.kind, "message");
  const m2 = project(after).find((m) => m.seq === 2);
  assert.equal(m2?.retracted, true);
  assert.equal(m2?.text, "");
});

test("追加后再改调用方手里的 message body,已提交历史、投影和 hash 都不变", () => {
  const body = { kind: "message" as const, text: "原文" };
  const log = append(emptyLog(), user, body, at);
  const saved = snap(log);
  body.text = "后来修改";
  assert.equal(snap(log), saved);
  assert.equal(project(log)[0]?.text, "原文");
  assert.deepEqual(verify(log), { ok: true });
});

test("追加后再改调用方手里的 edit body 与 sender,已提交历史不变", () => {
  const first = append(emptyLog(), user, { kind: "message", text: "原文" }, at);
  const body = { kind: "edit" as const, target: 1, text: "已提交的修改" };
  const sender = { kind: "user", id: "u1" };
  const log = append(first, sender, body, at);
  const saved = snap(log);
  body.text = "未提交的新修改";
  sender.id = "冒充者";
  assert.equal(snap(log), saved);
  assert.equal(project(log)[0]?.text, "已提交的修改");
  assert.deepEqual(verify(log), { ok: true });
});

test("已提交的事件对象不可被改写", () => {
  const log = sample();
  const e = log.events[0]!;
  assert.throws(() => { (e.body as { text: string }).text = "x"; }, TypeError);
  assert.throws(() => { (log.events as unknown as unknown[]).push(e); }, TypeError);
  assert.equal(project(log)[0]?.text, "谁修一下登录页");
});

test("投影只读:多次投影不改记录(阴性对照)", () => {
  const log = sample();
  const saved = snap(log);
  const view = project(log);
  view[0]!.text = "只改投影";
  assert.equal(snap(log), saved);
  assert.equal(project(log)[0]?.text, "谁修一下登录页");
});

test("同一条消息只切发言者种类:compute 被拒绝,contact 可以发出(AC-03 单开关)", () => {
  const body = { kind: "message" as const, text: "执行结果:登录页已修好" };
  assert.throws(() => append(sample(), { kind: "compute", id: "x1" }, body, at), { code: "sender-not-allowed" });
  const ok = append(sample(), { kind: "contact", id: "x1" }, body, at);
  assert.equal(project(ok).at(-1)?.sender.kind, "contact");
  assert.equal(project(ok).at(-1)?.text, "执行结果:登录页已修好");
});

test("被 @ 的 Helper 可以在会话里就地作答", () => {
  const log = append(sample(), { kind: "helper", id: "helper" }, { kind: "message", text: "已为你拉好新群" }, at);
  assert.equal(project(log).at(-1)?.sender.kind, "helper");
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
