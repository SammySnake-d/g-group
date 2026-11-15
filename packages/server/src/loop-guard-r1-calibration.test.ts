// R1-03: 给审查列出的故障补业务断言；scripted mind/compute 不代表真实模型验收。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { ContactMind, Inbound, MindAction } from "@g-group/kernel";
import { openDb } from "./db.ts";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";
import { LoopGuard } from "./loop-guard.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-loop-r1-cal-"));
let serial = 0;
const nextFile = () => path.join(dir, `${++serial}.db`);
const hosts: Host[] = [];
const dbs: ReturnType<typeof openDb>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); for (const db of dbs.splice(0)) db.close(); });
after(() => rmSync(dir, { recursive: true, force: true }));
const message = (roomId: string, seq: number, kind: "user" | "contact"): Inbound => ({ kind: "message", roomId, seq, sender: { kind, id: kind, name: kind }, text: "文字", replyToSeq: null, quotedSeqs: [], mentions: [], command: null, at: "2026-11-16T00:00:00.000Z" });
async function settle(host: Host, drained: () => boolean = () => true) {
  for (let i = 0; i < 300; i++) {
    await Promise.race([host.idle(), new Promise((resolve) => setTimeout(resolve, 10))]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (!host.loop.busy() && drained()) return;
  }
  assert.fail("宿主未在有限窗口内安静");
}
async function dispatchedAndDelivered() {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "completed", result: "结果" }] });
  const mind = (): ContactMind => ({ async round(input) {
    const actions: MindAction[] = [];
    for (const item of input.fresh) {
      if (item.kind === "message" && item.sender.kind === "user" && item.text === "开始派活") actions.push({ kind: "dispatch", roomId: item.roomId, sourceSeq: item.seq, title: "测试任务", task: "执行测试" });
      if (item.kind === "compute" && item.signal === "completed") actions.push({ kind: "deliver", taskId: item.taskId, text: "已经交付结果" });
    }
    return { actions, stateNote: null };
  } });
  const file = nextFile();
  const host = new Host({ file, mind, compute: () => compute.adapter, maxDeferMs: 2, loopGuard: { maxHops: 10 } }); hosts.push(host);
  const contact = host.createContact({ name: "甲" });
  const group = host.createGroup("任务", [{ kind: "contact", id: contact.id }]);
  host.send({ roomId: group.id, clientActionId: "start", text: "开始派活" });
  await settle(host, () => compute.drained());
  compute.close();
  return { host, group, file, mind };
}

test("R1-F01 派活任务卡继承触发消息的因果根", async () => {
  const { host, group } = await dispatchedAndDelivered();
  const messages = host.listMessages(group.id, {}).messages;
  const source = messages.find((m) => m.text === "开始派活");
  const card = messages.find((m) => m.text === "接了任务:测试任务");
  assert.ok(source && card, "来源与任务卡必须实际落盘");
  assert.deepEqual(host.loopGuard.rootsOf(group.id, card.seq), host.loopGuard.rootsOf(group.id, source.seq));
});

test("R1-F02 Compute 交付消息继承触发任务的因果根", async () => {
  const { host, group } = await dispatchedAndDelivered();
  const messages = host.listMessages(group.id, {}).messages;
  const source = messages.find((m) => m.text === "开始派活");
  const delivery = messages.find((m) => m.text === "已经交付结果");
  assert.ok(source && delivery, "来源与交付消息必须实际落盘");
  assert.deepEqual(host.loopGuard.rootsOf(group.id, delivery.seq), host.loopGuard.rootsOf(group.id, source.seq));
});

test("任务因果根实际持久化，宿主重启后 Compute 事件仍继承来源", async () => {
  const { host, group, file, mind } = await dispatchedAndDelivered();
  const task = host.listTasks({})[0];
  const source = host.listMessages(group.id, {}).messages.find((m) => m.text === "开始派活");
  assert.ok(task && source);
  await host.close();
  const resumed = new Host({ file, mind, maxDeferMs: 2 }); hosts.push(resumed);
  assert.deepEqual(resumed.loopGuard.taskRoots(task.id), resumed.loopGuard.rootsOf(group.id, source.seq));
  const f: Inbound = { kind: "compute", roomId: group.id, taskId: task.id, computeId: "c-restarted", signal: "completed", summary: "完成", at: "2026-11-16T00:00:00.000Z" };
  assert.deepEqual(resumed.loopGuard.rootsFor([f], group.id), resumed.loopGuard.rootsOf(group.id, source.seq));
});

test("R1-F06 别的会话用户输入不能重置本会话的派生根", () => {
  const db = openDb(nextFile()); dbs.push(db);
  const guard = new LoopGuard(db);
  guard.recordMessage("a", 2, ["root-a"]);
  assert.deepEqual(guard.rootsFor([message("b", 5, "user"), message("a", 2, "contact")], "a"), ["root-a"]);
});

test("R1-F09 两个独立根各自计数互不占用", () => {
  const db = openDb(nextFile()); dbs.push(db);
  const guard = new LoopGuard(db, { maxHops: 1 });
  guard.recordMessage("a", 1, ["root-a"]);
  guard.recordMessage("b", 1, ["root-b"]);
  assert.equal(guard.admit("a", 1, "甲").allowed, true);
  assert.equal(guard.admit("b", 1, "乙").allowed, true);
});

test("R1-F10 同会话多条派生输入必须继承每一根", () => {
  const db = openDb(nextFile()); dbs.push(db);
  const guard = new LoopGuard(db);
  guard.recordMessage("a", 1, ["root-a"]);
  guard.recordMessage("a", 2, ["root-b"]);
  assert.deepEqual(guard.rootsFor([message("a", 1, "contact"), message("a", 2, "contact")], "a"), ["root-a", "root-b"]);
});

test("R1-F11 多根消息第二根已停时仍判为停止", () => {
  const db = openDb(nextFile()); dbs.push(db);
  const guard = new LoopGuard(db, { maxHops: 1 });
  guard.recordMessage("b", 1, ["root-b"]);
  guard.recordMessage("b", 2, ["root-b"]);
  assert.equal(guard.admit("b", 1, "甲").allowed, true);
  assert.equal(guard.admit("b", 2, "乙").allowed, false);
  guard.recordMessage("a", 1, ["root-a", "root-b"]);
  assert.equal(guard.isStopped("a", 1), true);
});

test("R1-F14 宿主把滚动频率上限接入真实注意循环", async () => {
  let calls = 0;
  const mind = (): ContactMind => ({ async round(input) {
    const item = input.fresh.find((f) => f.kind === "message" && f.sender.kind !== "system");
    return { actions: item && ++calls <= 12 ? [{ kind: "reply", roomId: item.roomId, text: `回话 ${calls}`, replyToSeq: null }] : [], stateNote: null };
  } });
  const host = new Host({ file: nextFile(), mind, maxDeferMs: 2, loopGuard: { maxHops: 20, maxPerMinute: 1 } }); hosts.push(host);
  const a = host.createContact({ name: "甲" }); const b = host.createContact({ name: "乙" });
  const group = host.createGroup("频率", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  host.send({ roomId: group.id, clientActionId: "start", text: "开始" });
  await settle(host);
  assert.ok(host.loopGuard.pending().some((item) => item.reason === "rate"), "应由频率而不是总次数拦住互唤");
});

test("被拦原文跨重启和无关私聊保留，续话只补交一次", async () => {
  let aId = "";
  const received: string[] = [];
  const mind = (): ContactMind => ({ async round(input) {
    const actions: MindAction[] = [];
    for (const f of input.fresh) if (f.kind === "message") {
      if (input.contact.id === aId && f.sender.kind === "contact") received.push(f.text);
      if (input.contact.id === aId && f.sender.kind === "user" && f.text === "开始") actions.push({ kind: "reply", roomId: f.roomId, text: "甲先说", replyToSeq: null });
      if (input.contact.id !== aId && f.sender.kind === "contact" && f.text === "甲先说") actions.push({ kind: "reply", roomId: f.roomId, text: "乙的待处理原文", replyToSeq: null });
    }
    return { actions, stateNote: null };
  } });
  const file = nextFile();
  const host = new Host({ file, mind, maxDeferMs: 2, loopGuard: { maxHops: 1 } }); hosts.push(host);
  const a = host.createContact({ name: "甲" }); aId = a.id;
  const b = host.createContact({ name: "乙" });
  const group = host.createGroup("重启", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  host.send({ roomId: group.id, clientActionId: "start", text: "开始", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host);
  assert.ok(host.loopGuard.pending().some((p) => p.contactId === a.id));
  await host.close();
  const resumed = new Host({ file, mind, maxDeferMs: 2, loopGuard: { maxHops: 1 } }); hosts.push(resumed);
  const dm = resumed.openDm(a.id);
  resumed.send({ roomId: dm.id, clientActionId: "other", text: "无关私聊" });
  await settle(resumed);
  assert.equal(received.filter((x) => x === "乙的待处理原文").length, 0);
  resumed.send({ roomId: group.id, clientActionId: "continue", text: "继续", mentions: [{ id: a.id, source: "manual" }] });
  await settle(resumed);
  assert.equal(received.filter((x) => x === "乙的待处理原文").length, 1);
  assert.equal(resumed.loopGuard.pending().some((p) => p.contactId === a.id), false);
  resumed.send({ roomId: group.id, clientActionId: "again", text: "再问", mentions: [{ id: a.id, source: "manual" }] });
  await settle(resumed);
  assert.equal(received.filter((x) => x === "乙的待处理原文").length, 1);
});

test("旧游标已越过被拦消息时，用户续话在第五块补回原文", async () => {
  let aId = ""; let fifth = "";
  const mind = (): ContactMind => ({ async round(input) {
    const actions: MindAction[] = [];
    for (const f of input.fresh) if (f.kind === "message") {
      if (input.contact.id === aId && f.sender.kind === "user" && f.text === "开始") actions.push({ kind: "reply", roomId: f.roomId, text: "甲先说", replyToSeq: null });
      if (input.contact.id === aId && f.sender.kind === "user" && f.text === "继续") fifth = input.request.blocks.find((block) => block.block === 5)?.text ?? "";
      if (input.contact.id !== aId && f.sender.kind === "contact" && f.text === "甲先说") actions.push({ kind: "reply", roomId: f.roomId, text: "旧待处理原文", replyToSeq: null });
    }
    return { actions, stateNote: null };
  } });
  const host = new Host({ file: nextFile(), mind, maxDeferMs: 2, loopGuard: { maxHops: 1 } }); hosts.push(host);
  const a = host.createContact({ name: "甲" }); aId = a.id; const b = host.createContact({ name: "乙" });
  const group = host.createGroup("旧数据", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  host.send({ roomId: group.id, clientActionId: "start", text: "开始", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host);
  const blocked = host.loopGuard.pending().find((p) => p.contactId === a.id);
  assert.ok(blocked);
  // 模拟旧版本已经推进游标，不能以旧消息冒充第 4 块的新消息。
  host.db.store.db.prepare("UPDATE gg_cursor SET processed_seq=? WHERE contact_id=? AND room_id=?").run(blocked.seq, a.id, group.id);
  host.send({ roomId: group.id, clientActionId: "continue", text: "继续", mentions: [{ id: a.id, source: "manual" }] });
  await settle(host);
  assert.match(fifth, /旧待处理原文/);
  assert.equal(host.loopGuard.pending().some((p) => p.contactId === a.id), false);
});

test("失败联系人代发的群级卡继承触发输入的因果根", async () => {
  const mind = (): ContactMind => ({ async round() { throw new Error("403 Insufficient user quota"); } });
  const host = new Host({ file: nextFile(), mind, maxDeferMs: 2 }); hosts.push(host);
  const a = host.createContact({ name: "甲" });
  const group = host.createGroup("失败", [{ kind: "contact", id: a.id }]);
  host.send({ roomId: group.id, clientActionId: "start", text: "开始检查" });
  await settle(host);
  const messages = host.listMessages(group.id, {}).messages;
  const source = messages.find((m) => m.text === "开始检查");
  const card = messages.find((m) => m.card?.kind === "failure");
  assert.ok(source && card, "来源和失败卡必须实际落盘");
  assert.deepEqual(host.loopGuard.rootsOf(group.id, card.seq), host.loopGuard.rootsOf(group.id, source.seq));
});

test("宿主连续退出后的恢复失败卡沿用原始批次因果根", async () => {
  let first = 0; let second = 0;
  const hang = (which: "first" | "second"): ContactMind => ({ async round(_input, signal) {
    if (which === "first") first++; else second++;
    return await new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(new Error("关闭"));
      else signal.addEventListener("abort", () => reject(new Error("关闭")), { once: true });
    });
  } });
  const wait = async (predicate: () => boolean, what: string) => {
    for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
    assert.fail(`没有等到 ${what}`);
  };
  const file = nextFile();
  const h1 = new Host({ file, mind: () => hang("first"), maxDeferMs: 2 }); hosts.push(h1);
  const a = h1.createContact({ name: "甲" }); const dm = h1.openDm(a.id);
  h1.send({ roomId: dm.id, clientActionId: "start", text: "故障前输入" });
  await wait(() => first === 1, "首次轮次");
  const h2 = new Host({ file, mind: () => hang("second"), maxDeferMs: 2 }); hosts.push(h2);
  await wait(() => second === 1, "恢复轮次");
  const h3 = new Host({ file, mind: () => hang("second"), maxDeferMs: 2 }); hosts.push(h3);
  await wait(() => h3.listMessages(dm.id, {}).messages.some((m) => m.card?.kind === "failure"), "恢复失败卡");
  const messages = h3.listMessages(dm.id, {}).messages;
  const source = messages.find((m) => m.text === "故障前输入"); const card = messages.find((m) => m.card?.kind === "failure");
  assert.ok(source && card);
  assert.deepEqual(h3.loopGuard.rootsOf(dm.id, card.seq), h3.loopGuard.rootsOf(dm.id, source.seq));
});
