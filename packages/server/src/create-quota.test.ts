// U08/U09 创建额度:真 service/SQLite,配置与幂等记录同事务;租约验证复用真实 Host/QuotaTable 路径。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { ContactView, RoomView } from "@g-group/api-contract";
import type { QuiesceResult } from "@g-group/adapter-cc-compute";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { all, getDoc, run } from "./db.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const root = mkdtempSync(path.join(tmpdir(), "gg-create-quota-"));
const hosts = new Set<Host>();
const computes = new Set<ReturnType<typeof scriptedCompute>>();
let number = 0;
const make = (file = path.join(root, `${++number}.db`), opts: Partial<ConstructorParameters<typeof Host>[0]> = {}) => {
  const host = new Host({ file, mind: () => ({ async round() { return { actions: [], stateNote: null }; } }), ...opts });
  hosts.add(host);
  return { host, file };
};
const close = async (host: Host) => { hosts.delete(host); await host.close(); };
afterEach(async () => { for (const compute of computes) compute.close(); computes.clear(); for (const host of hosts) await close(host); });
after(() => rmSync(root, { recursive: true, force: true }));

test("CQ01 contacts.create 在创建事务持久化指定个人额度与首版历史", async () => {
  const { host } = make();
  const svc = createService(host);
  const result = await svc.handle("contacts.create", { clientActionId: "cq-contact", name: "创建即限额", computeSlots: 2 });
  assert.ok(result.ok);
  const id = (result.value as { id: string }).id;
  assert.equal(host.contactDoc(id).value.computeSlots, 2);
  assert.deepEqual(host.contactHistory(id).versions.map((v) => [v.version, v.kind, v.config.computeSlots]), [[1, "create", 2]]);
});

test("CQ02 rooms.createGroup 原子保存群成员与指定临时额度并对外返回", async () => {
  const { host } = make();
  const svc = createService(host);
  const c = host.createContact({ name: "成员" });
  const result = await svc.handle("rooms.createGroup", { clientActionId: "cq-group", title: "创建即限额", members: [{ kind: "contact", id: c.id }], tempComputeSlots: 3 });
  assert.ok(result.ok);
  const room = result.value as RoomView;
  assert.equal(room.tempComputeSlots, 3);
  assert.deepEqual(getDoc(host.db, `room-slots:${room.id}`)?.value, { slots: 3 });
  assert.deepEqual(room.members, [{ kind: "contact", id: c.id }, { kind: "user", id: host.userId }]);
});

test("CQ03 contacts.create 与更新共用 null 或 1..64 整数范围，坏额度不残留实体", async () => {
  const { host } = make();
  const svc = createService(host);
  for (const [i, slots] of [0, -1, 65, 1.5, "1"].entries()) {
    const result = await svc.handle("contacts.create", { clientActionId: `invalid-contact-${i}`, name: "不能创建", computeSlots: slots });
    assert.equal(!result.ok && result.error.code, "invalid_params");
  }
  assert.equal(host.listContacts().length, 0);
  assert.equal(all(host.db, "SELECT * FROM gg_contact_config_versions").length, 0);
  assert.equal(all(host.db, "SELECT * FROM actions WHERE action_id LIKE 'create:%'").length, 0);
  for (const [i, slots] of [null, 1, 64].entries()) {
    const valid = await svc.handle("contacts.create", { clientActionId: `valid-contact-range-${i}`, name: "合法边界", computeSlots: slots });
    assert.ok(valid.ok);
    assert.equal(host.contactDoc((valid.value as ContactView).id).value.computeSlots, slots);
  }
});

test("CQ04 rooms.createGroup 与更新共用 0..64 整数范围，坏额度不残留群成员", async () => {
  const { host } = make();
  const svc = createService(host);
  for (const [i, slots] of [-1, 65, 0.5, null, "1"].entries()) {
    const result = await svc.handle("rooms.createGroup", { clientActionId: `invalid-group-${i}`, title: "不能创建", members: [], tempComputeSlots: slots });
    assert.equal(!result.ok && result.error.code, "invalid_params");
  }
  assert.equal(all(host.db, "SELECT * FROM gg_rooms").length, 0);
  assert.equal(all(host.db, "SELECT * FROM gg_members").length, 0);
  assert.equal(all(host.db, "SELECT * FROM docs WHERE key LIKE 'room-slots:%'").length, 0);
  for (const [i, slots] of [0, 64].entries()) {
    const valid = await svc.handle("rooms.createGroup", { clientActionId: `valid-group-range-${i}`, title: "合法边界", members: [], tempComputeSlots: slots });
    assert.ok(valid.ok);
    const room = valid.value as RoomView;
    assert.equal(room.tempComputeSlots, slots);
    assert.deepEqual(getDoc(host.db, `room-slots:${room.id}`)?.value, { slots });
  }
});

test("CQ05 个人创建缺省和 null 保留宿主默认，1 与 64 边界保存且动作可重放", async () => {
  const { host } = make();
  const svc = createService(host);
  for (const [i, slots] of [undefined, null, 1, 64].entries()) {
    const input = { clientActionId: `contact-boundary-${i}`, name: `边界${i}`, computeSlots: slots };
    const result = await svc.handle("contacts.create", input);
    assert.ok(result.ok);
    const c = result.value as ContactView;
    assert.equal(host.contactDoc(c.id).value.computeSlots, slots ?? null);
    assert.equal(host.contactHistory(c.id).versions[0]!.config.computeSlots, slots ?? null);
    const replay = await svc.handle("contacts.create", input);
    assert.deepEqual(replay, result);
  }
  assert.equal(host.listContacts().length, 4);
});

test("CQ06 群创建缺省零与显式 0 和 64 都持久化同一额度文档", async () => {
  const { host } = make();
  const svc = createService(host);
  for (const [i, slots] of [undefined, 0, 64].entries()) {
    const result = await svc.handle("rooms.createGroup", { clientActionId: `group-boundary-${i}`, title: `群边界${i}`, members: [], tempComputeSlots: slots });
    assert.ok(result.ok);
    const room = result.value as RoomView;
    assert.equal(room.tempComputeSlots, slots ?? 0);
    assert.deepEqual(getDoc(host.db, `room-slots:${room.id}`)?.value, { slots: slots ?? 0 });
  }
});

test("CQ07 联系人创建动作跨重启返回原响应，修改参数冲突且不覆当前配置历史", async () => {
  const first = make();
  const svc = createService(first.host);
  const input = { clientActionId: "contact-restart", name: "创建时名字", computeSlots: 2 };
  const created = await svc.handle("contacts.create", input);
  assert.ok(created.ok);
  const id = (created.value as ContactView).id;
  first.host.updateContact(id, { name: "后来改名", computeSlots: 1 });
  await close(first.host);
  const { host } = make(first.file);
  const restarted = createService(host);
  let notifications = 0;
  const off = restarted.subscribe((e) => { if (e.type === "contact.updated") notifications++; });
  const replay = await restarted.handle("contacts.create", input);
  assert.deepEqual(replay, created);
  const conflict = await restarted.handle("contacts.create", { ...input, computeSlots: 3 });
  assert.equal(!conflict.ok && conflict.error.code, "conflict");
  const renamed = await restarted.handle("contacts.create", { ...input, name: "另一请求" });
  assert.equal(!renamed.ok && renamed.error.code, "conflict");
  assert.deepEqual([host.listContacts().length, host.contactDoc(id).value.name, host.contactDoc(id).value.computeSlots], [1, "后来改名", 1]);
  assert.deepEqual(host.contactHistory(id).versions.map((v) => v.version), [2, 1]);
  assert.equal(notifications, 0);
  off();
});

test("CQ08 建群动作跨重启返回原响应，额度或成员变更冲突且不覆当前群", async () => {
  const first = make();
  const svc = createService(first.host);
  const input = { clientActionId: "group-restart", title: "创建时群名", members: [], tempComputeSlots: 2 };
  const created = await svc.handle("rooms.createGroup", input);
  assert.ok(created.ok);
  const id = (created.value as RoomView).id;
  first.host.updateRoom(id, { title: "后来改群名", tempComputeSlots: 0 });
  await close(first.host);
  const { host } = make(first.file);
  const restarted = createService(host);
  let notifications = 0;
  const off = restarted.subscribe((e) => { if (e.type === "room.updated") notifications++; });
  const replay = await restarted.handle("rooms.createGroup", input);
  assert.deepEqual(replay, created);
  const conflict = await restarted.handle("rooms.createGroup", { ...input, tempComputeSlots: 3 });
  assert.equal(!conflict.ok && conflict.error.code, "conflict");
  const membersConflict = await restarted.handle("rooms.createGroup", { ...input, members: [{ kind: "user", id: "another-user" }] });
  assert.equal(!membersConflict.ok && membersConflict.error.code, "conflict");
  assert.deepEqual([all(host.db, "SELECT * FROM gg_rooms").length, host.roomView(id).title, host.roomView(id).tempComputeSlots], [1, "后来改群名", 0]);
  assert.equal(all(host.db, "SELECT * FROM gg_members").length, 1);
  assert.equal(notifications, 0);
  off();
});

test("CQ09 动作号按创建种类隔离，JSON字段顺序不产生伪冲突或重复实体", async () => {
  const { host } = make();
  const svc = createService(host);
  const c = await svc.handle("contacts.create", { clientActionId: "shared", name: "独立联系人", computeSlots: 2 });
  const g = await svc.handle("rooms.createGroup", { clientActionId: "shared", title: "独立群", members: [], tempComputeSlots: 2 });
  assert.ok(c.ok && g.ok);
  const cAgain = await svc.handle("contacts.create", { computeSlots: 2, name: "独立联系人", clientActionId: "shared" });
  const gAgain = await svc.handle("rooms.createGroup", { members: [], tempComputeSlots: 2, title: "独立群", clientActionId: "shared" });
  assert.deepEqual([cAgain, gAgain], [c, g]);
  assert.deepEqual([host.listContacts().length, all(host.db, "SELECT * FROM gg_rooms").length], [1, 1]);
});

test("CQ10 创建动作记账失败回滚联系人、额度与历史，修复后同号可重试", async () => {
  const { host } = make();
  const svc = createService(host);
  run(host.db, "CREATE TRIGGER cq_contact_abort BEFORE INSERT ON actions WHEN NEW.action_id LIKE 'create:contact:%' BEGIN SELECT RAISE(ABORT, 'fixture contact failure'); END");
  const input = { clientActionId: "contact-failure", name: "原子联系人", computeSlots: 2 };
  const failed = await svc.handle("contacts.create", input);
  assert.equal(!failed.ok && failed.error.code, "internal");
  assert.deepEqual([host.listContacts().length, all(host.db, "SELECT * FROM gg_contact_config_versions").length, all(host.db, "SELECT * FROM actions WHERE action_id LIKE 'create:%'").length], [0, 0, 0]);
  run(host.db, "DROP TRIGGER cq_contact_abort");
  const retried = await svc.handle("contacts.create", input);
  assert.ok(retried.ok);
  const id = (retried.value as ContactView).id;
  assert.equal(host.contactDoc(id).value.computeSlots, 2);
  assert.equal(host.contactHistory(id).versions.length, 1);
});

test("CQ11 群额度落盘失败回滚群、成员与动作，修复后同号可重试", async () => {
  const { host } = make();
  const svc = createService(host);
  run(host.db, "CREATE TRIGGER cq_group_abort BEFORE INSERT ON docs WHEN NEW.key LIKE 'room-slots:%' BEGIN SELECT RAISE(ABORT, 'fixture group failure'); END");
  const input = { clientActionId: "group-failure", title: "原子群", members: [], tempComputeSlots: 2 };
  const failed = await svc.handle("rooms.createGroup", input);
  assert.equal(!failed.ok && failed.error.code, "internal");
  assert.deepEqual([all(host.db, "SELECT * FROM gg_rooms").length, all(host.db, "SELECT * FROM gg_members").length, all(host.db, "SELECT * FROM actions WHERE action_id LIKE 'create:%'").length], [0, 0, 0]);
  run(host.db, "DROP TRIGGER cq_group_abort");
  const retried = await svc.handle("rooms.createGroup", input);
  assert.ok(retried.ok);
  assert.equal((retried.value as RoomView).tempComputeSlots, 2);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(condition: () => boolean, message: string) {
  const end = Date.now() + 5000;
  while (!condition() && Date.now() < end) await tick();
  assert.ok(condition(), message);
}
function controlledCompute() {
  const gates = new Map<string, (result: QuiesceResult) => void>();
  const asked: string[] = [];
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "cq-scripted", resumed: false }], quiesce: (id) => { asked.push(id); return new Promise((resolve) => gates.set(id, resolve)); } });
  computes.add(compute);
  return { compute, asked, finish: (id: string) => gates.get(id)?.({ ok: true, killed: 1 }) };
}

test("CQ12 创建额度进入既有租约原语，群不串借，下调不抢在途且停止确认才归还", async () => {
  const lr = controlledCompute();
  const { host } = make(undefined, { mind: () => scriptedMind(), compute: () => lr.compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const c = await svc.handle("contacts.create", { clientActionId: "lease-contact", name: "额度成员", computeSlots: 1 });
  assert.ok(c.ok);
  const id = (c.value as ContactView).id;
  const ga = await svc.handle("rooms.createGroup", { clientActionId: "lease-ga", title: "A群", members: [{ kind: "contact", id }], tempComputeSlots: 1 });
  const gb = await svc.handle("rooms.createGroup", { clientActionId: "lease-gb", title: "B群", members: [{ kind: "contact", id }], tempComputeSlots: 0 });
  assert.ok(ga.ok && gb.ok);
  const a = (ga.value as RoomView).id;
  const b = (gb.value as RoomView).id;
  host.send({ roomId: a, clientActionId: "lease-a1", text: "帮我跑第一个慢脚本", mentions: [{ id, source: "manual" }] });
  await until(() => lr.compute.spawned.length === 1, "CQ12 第一个实际起跑");
  host.send({ roomId: a, clientActionId: "lease-a2", text: "帮我跑第二个慢脚本", mentions: [{ id, source: "manual" }] });
  await until(() => lr.compute.spawned.length === 2, "CQ12 第二个借本群额度");
  assert.deepEqual(host.quota.view().leases.map((l) => l.scope).sort(), [`personal:${id}`, `group:${a}`].sort());
  host.send({ roomId: b, clientActionId: "lease-b1", text: "帮我跑B群慢脚本", mentions: [{ id, source: "manual" }] });
  await until(() => host.listTasks({ roomId: b }).length === 1, "CQ12 B群任务进入既有排队路径");
  const before = host.quota.view().leases;
  const lowered = await svc.handle("rooms.update", { roomId: a, tempComputeSlots: 0 });
  assert.ok(lowered.ok);
  assert.deepEqual(host.quota.view().leases, before);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(lr.compute.spawned.length, 2);
  const borrowed = before.find((l) => l.scope === `group:${a}`)!;
  host.taskDecision(borrowed.taskId, "cancel", "lease-stop-group");
  await until(() => lr.asked.length === 1, "CQ12 请求适配器确认停止");
  assert.equal(host.quota.leaseOf(borrowed.taskId)?.stopping, true);
  assert.equal(host.taskDoc(borrowed.taskId).value.task.state, "T9_StopRequested");
  assert.equal(lr.compute.spawned.length, 2);
  lr.finish(lr.asked[0]!);
  await until(() => host.quota.leaseOf(borrowed.taskId) === undefined, "CQ12 停止确认后归还群租约");
  assert.equal(host.taskDoc(borrowed.taskId).value.task.state, "T10_Cancelled");
  assert.equal(lr.compute.spawned.length, 2);
  assert.equal(host.quota.view().waiting.length, 1);
});

test("CQ13 个人额度下调保留旧租约，未停止不抢占，低于新上限后才让排队起跑", async () => {
  const lr = controlledCompute();
  const { host } = make(undefined, { mind: () => scriptedMind(), compute: () => lr.compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const c = await svc.handle("contacts.create", { clientActionId: "down-contact", name: "个人下调", computeSlots: 2 });
  assert.ok(c.ok);
  const id = (c.value as ContactView).id;
  assert.equal(host.contactDoc(id).value.computeSlots, 2);
  const dm = host.openDm(id);
  host.send({ roomId: dm.id, clientActionId: "down-1", text: "帮我跑第一个慢脚本" });
  await until(() => lr.compute.spawned.length === 1, "CQ13 第一个起跑");
  host.send({ roomId: dm.id, clientActionId: "down-2", text: "帮我跑第二个慢脚本" });
  await until(() => lr.compute.spawned.length === 2, "CQ13 第二个起跑");
  const before = host.quota.view().leases;
  const lowered = await svc.handle("contacts.update", { contactId: id, computeSlots: 1 });
  assert.ok(lowered.ok);
  assert.deepEqual(host.quota.view().leases, before);
  host.send({ roomId: dm.id, clientActionId: "down-3", text: "帮我跑第三个慢脚本" });
  await until(() => host.listTasks({ roomId: dm.id }).length === 3, "CQ13 第三个任务建好");
  const [first, second] = before;
  host.taskDecision(first!.taskId, "cancel", "down-stop-1");
  await until(() => lr.asked.length === 1, "CQ13 第一次停止确认待决");
  assert.ok(host.quota.leaseOf(first!.taskId));
  assert.equal(lr.compute.spawned.length, 2);
  lr.finish(lr.asked[0]!);
  await until(() => host.quota.leaseOf(first!.taskId) === undefined, "CQ13 第一份停止已确认");
  assert.equal(lr.compute.spawned.length, 2);
  assert.equal(host.quota.view().waiting.length, 1);
  host.taskDecision(second!.taskId, "cancel", "down-stop-2");
  await until(() => lr.asked.length === 2, "CQ13 第二次停止确认待决");
  assert.ok(host.quota.leaseOf(second!.taskId));
  assert.equal(lr.compute.spawned.length, 2);
  lr.finish(lr.asked[1]!);
  await until(() => lr.compute.spawned.length === 3, "CQ13 确认停止且低于新上限后第三个才起跑");
  assert.equal(host.quota.view().leases.length, 1);
  assert.equal(host.quota.view().waiting.length, 0);
});
