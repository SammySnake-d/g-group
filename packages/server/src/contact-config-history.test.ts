// U07:通用配置版本快照与回滚。真 SQLite + 对外服务;不导出秘密/记忆,不做 Soul 自修改。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { ContactConfigVersion } from "@g-group/api-contract";
import { all, getDoc, putDoc, run } from "./db.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const root = mkdtempSync(path.join(tmpdir(), "gg-contact-history-"));
const hosts: Host[] = [];
let number = 0;
const make = (file = path.join(root, `${++number}.db`)) => {
  const host = new Host({ file, mind: () => ({ async round() { return { actions: [], stateNote: null }; } }) });
  hosts.push(host);
  return { host, svc: createService(host), file };
};
afterEach(async () => { for (const h of hosts.splice(0)) await h.close(); });
after(() => rmSync(root, { recursive: true, force: true }));
type History = { contactId: string; currentVersion: number; versions: ContactConfigVersion[]; hasMore: boolean };
const catalog = [
  { id: "fixture-a", label: "A", vendor: "anthropic", harnesses: ["claude-code" as const] },
  { id: "fixture-b", label: "B", vendor: "anthropic", harnesses: ["claude-code" as const] },
];

test("CFG01 创建与修改保留完整配置快照，旧版本不随当前修改变化", async () => {
  const { host } = make();
  const svc = createService(host);
  const c = host.createContact({ name: "原名字", persona: "原人设" });
  await svc.handle("contacts.update", { contactId: c.id, name: "新名字", avatar: "fixture-avatar", bio: "简介", persona: "新人设", computeSlots: 3, tools: ["read"], computeAssets: [{ name: "fixture-skill", kind: "skill" }] });
  const result = await svc.handle("contacts.history", { contactId: c.id });
  assert.ok(result.ok);
  const h = result.value as History;
  assert.deepEqual(h.versions.map((v) => [v.version, v.kind, v.config.name]), [[2, "update", "新名字"], [1, "create", "原名字"]]);
  assert.deepEqual([h.contactId, h.currentVersion, h.hasMore], [c.id, 2, false]);
  assert.deepEqual([h.versions[0]!.config.avatar, h.versions[0]!.config.persona, h.versions[0]!.config.computeSlots, h.versions[0]!.config.tools, h.versions[0]!.config.computeAssets], ["fixture-avatar", "新人设", 3, ["read"], [{ name: "fixture-skill", kind: "skill" }]]);
  assert.deepEqual([h.versions[1]!.config.persona, h.versions[1]!.config.computeSlots], ["原人设", null]);
});

test("CFG02 回滚生成递增版本且保留身份、消息、记忆、任务与游标", async () => {
  const { host } = make();
  const svc = createService(host);
  const c = host.createContact({ name: "原名字", persona: "原人设" });
  const dm = host.openDm(c.id);
  putDoc(host.db, `note:${c.id}`, 0, { text: "NEUTRAL_MEMORY", marker: "keep" });
  putDoc(host.db, "task:fixture", 0, { state: "NEUTRAL_TASK" });
  run(host.db, "INSERT OR REPLACE INTO gg_cursor (contact_id, room_id, processed_seq) VALUES (?, ?, 7)", c.id, dm.id);
  host.updateContact(c.id, { name: "改坏的名字", persona: "改坏的人设" });
  const before = [getDoc(host.db, `note:${c.id}`), getDoc(host.db, "task:fixture"), all(host.db, "SELECT * FROM gg_cursor"), all(host.db, "SELECT * FROM events")];
  const result = await svc.handle("contacts.rollback", { contactId: c.id, version: 1, expectedVersion: 2, clientActionId: "rollback-1" });
  assert.ok(result.ok);
  assert.deepEqual([host.contactDoc(c.id).ver, host.contactDoc(c.id).value.name, host.contactDoc(c.id).value.persona], [3, "原名字", "原人设"]);
  assert.deepEqual([host.contactDoc(c.id).value.id, host.contactDoc(c.id).value.createdAt], [c.id, c.createdAt]);
  assert.deepEqual([getDoc(host.db, `note:${c.id}`), getDoc(host.db, "task:fixture"), all(host.db, "SELECT * FROM gg_cursor"), all(host.db, "SELECT * FROM events")], before);
  const history = await svc.handle("contacts.history", { contactId: c.id });
  assert.ok(history.ok);
  assert.deepEqual((history.value as History).versions.map((v) => [v.version, v.kind, v.restoredFrom]), [[3, "rollback", 1], [2, "update", null], [1, "create", null]]);
});

test("CFG03 回滚按当前版本拒绝过期请求，不覆盖较新的配置", async () => {
  const { host } = make();
  const svc = createService(host);
  const c = host.createContact({ name: "原" });
  host.updateContact(c.id, { name: "新" });
  const result = await svc.handle("contacts.rollback", { contactId: c.id, version: 1, expectedVersion: 1, clientActionId: "stale" });
  assert.deepEqual(!result.ok && [result.error.code, result.error.detail], ["conflict", { currentVersion: 2 }]);
  assert.equal(host.contactDoc(c.id).value.name, "新");
  assert.equal(all(host.db, "SELECT * FROM gg_contact_config_versions").length, 2);
});

test("CFG04 修改可带 CAS 和幂等号，重复请求不追加快照或通知", async () => {
  const { host } = make();
  const svc = createService(host);
  const c = host.createContact({ name: "原" });
  const events: unknown[] = [];
  const off = host.bus.subscribe((e) => { if (e.type === "contact.updated") events.push(e); });
  const input = { contactId: c.id, name: "新", expectedVersion: 1, clientActionId: "update-once" };
  const first = await svc.handle("contacts.update", input);
  const again = await svc.handle("contacts.update", input);
  assert.deepEqual(first, again);
  assert.deepEqual([host.contactDoc(c.id).ver, events.length], [2, 1]);
  const stale = await svc.handle("contacts.update", { ...input, name: "过时", clientActionId: "different" });
  assert.deepEqual(!stale.ok && [stale.error.code, stale.error.detail], ["conflict", { currentVersion: 2 }]);
  assert.equal(all(host.db, "SELECT * FROM gg_contact_config_versions").length, 2);
  off();
});

test("CFG05 回滚幂等持久化；同一动作号换目标版本拒绝", async () => {
  const { host, file } = make();
  const svc = createService(host);
  const c = host.createContact({ name: "原" });
  host.updateContact(c.id, { name: "新" });
  const input = { contactId: c.id, version: 1, expectedVersion: 2, clientActionId: "rollback-once" };
  const first = await svc.handle("contacts.rollback", input);
  await host.close();
  const restarted = make(file);
  const again = await createService(restarted.host).handle("contacts.rollback", input);
  assert.deepEqual(again, first);
  assert.equal(restarted.host.contactDoc(c.id).ver, 3);
  const conflict = await createService(restarted.host).handle("contacts.rollback", { ...input, version: 2 });
  assert.equal(!conflict.ok && conflict.error.code, "conflict");
  assert.equal(all(restarted.host.db, "SELECT * FROM gg_contact_config_versions").length, 3);
});

test("CFG06 回滚重新执行当前模型兼容预检，失败原子不写；明确确认后保留原选择", async () => {
  const { host } = make();
  const svc = createService(host);
  host.updateSettings({ defaultHarness: "claude-code", defaultSpeakingModel: "fixture-a", defaultComputeModel: "fixture-a", models: catalog });
  const c = host.createContact({ name: "原", computeModel: { mode: "explicit", model: "fixture-a" } });
  host.updateContact(c.id, { computeModel: { mode: "explicit", model: "fixture-b" } });
  host.updateSettings({ defaultComputeModel: "fixture-b", models: [{ ...catalog[0]!, harnesses: ["codex"] }, catalog[1]!] });
  const input = { contactId: c.id, version: 1, expectedVersion: 2, clientActionId: "incompatible" };
  const rejected = await svc.handle("contacts.rollback", input);
  assert.equal(!rejected.ok && rejected.error.code, "conflict");
  assert.equal(!rejected.ok && (rejected.error.detail as { reason: string }).reason, "model-incompatible");
  assert.deepEqual([host.contactDoc(c.id).ver, host.contactDoc(c.id).value.computeModel.model], [2, "fixture-b"]);
  const accepted = await svc.handle("contacts.rollback", { ...input, confirmAffected: true });
  assert.ok(accepted.ok);
  assert.deepEqual([host.contactDoc(c.id).ver, host.contactDoc(c.id).value.computeModel.model], [3, "fixture-a"]);
});

test("CFG07 历史写入失败时配置更新与通知一起放弃", async () => {
  const { host } = make();
  const svc = createService(host);
  const c = host.createContact({ name: "原" });
  const events: unknown[] = [];
  const off = host.bus.subscribe((e) => { if (e.type === "contact.updated") events.push(e); });
  host.db.store.db.exec("CREATE TRIGGER fixture_history_failure BEFORE INSERT ON gg_contact_config_versions WHEN NEW.version = 2 BEGIN SELECT RAISE(ABORT, 'FIXTURE_HISTORY_FAILURE'); END");
  const rejected = await svc.handle("contacts.update", { contactId: c.id, name: "不得提交", clientActionId: "atomic" });
  assert.equal(!rejected.ok && rejected.error.code, "internal");
  assert.deepEqual([host.contactDoc(c.id).ver, host.contactDoc(c.id).value.name, events.length], [1, "原", 0]);
  host.db.store.db.exec("DROP TRIGGER fixture_history_failure");
  const retried = await svc.handle("contacts.update", { contactId: c.id, name: "不得提交", clientActionId: "atomic" });
  assert.ok(retried.ok);
  assert.deepEqual([host.contactDoc(c.id).ver, all(host.db, "SELECT * FROM gg_contact_config_versions").length, events.length], [2, 2, 1]);
  off();
});

test("CFG08 批量模型替换也追加快照，快照失败同时回滚全局与所有联系人", async () => {
  const { host } = make();
  const svc = createService(host);
  host.updateSettings({ defaultHarness: "claude-code", defaultSpeakingModel: "fixture-a", defaultComputeModel: "fixture-a", models: catalog });
  const c = host.createContact({ name: "甲" });
  const d = host.createContact({ name: "乙" });
  host.db.store.db.exec(`CREATE TRIGGER fixture_batch_failure BEFORE INSERT ON gg_contact_config_versions WHEN NEW.contact_id = '${d.id}' AND NEW.version = 2 BEGIN SELECT RAISE(ABORT, 'FIXTURE_BATCH_FAILURE'); END`);
  const failed = await svc.handle("models.batchReplace", { clientActionId: "batch", from: "fixture-a", to: "fixture-b", apply: true });
  assert.equal(!failed.ok && failed.error.code, "internal");
  assert.deepEqual([host.settings().defaultSpeakingModel, host.contactDoc(c.id).value.speakingModel, host.contactDoc(d.id).value.speakingModel], ["fixture-a", "fixture-a", "fixture-a"]);
  host.db.store.db.exec("DROP TRIGGER fixture_batch_failure");
  const applied = await svc.handle("models.batchReplace", { clientActionId: "batch", from: "fixture-a", to: "fixture-b", apply: true });
  assert.ok(applied.ok);
  const h = await svc.handle("contacts.history", { contactId: c.id });
  assert.ok(h.ok);
  assert.deepEqual((h.value as History).versions.map((v) => [v.kind, v.config.speakingModel]), [["batch", "fixture-b"], ["create", "fixture-a"]]);
});

test("CFG09 重启后历史按联系人分页且不会复制已有版本", async () => {
  const { host, file } = make();
  const svc = createService(host);
  const c = host.createContact({ name: "甲" });
  host.createContact({ name: "不能串进来" });
  host.updateContact(c.id, { name: "甲二" });
  host.updateContact(c.id, { name: "甲三" });
  const first = await svc.handle("contacts.history", { contactId: c.id, limit: 2 });
  assert.ok(first.ok);
  assert.deepEqual([(first.value as History).versions.map((v) => v.version), (first.value as History).hasMore], [[3, 2], true]);
  await host.close();
  const restarted = make(file);
  const second = await createService(restarted.host).handle("contacts.history", { contactId: c.id, beforeVersion: 2, limit: 2 });
  assert.ok(second.ok);
  assert.deepEqual([(second.value as History).versions.map((v) => [v.version, v.config.name]), (second.value as History).hasMore, (second.value as History).currentVersion], [[[1, "甲"]], false, 3]);
  assert.equal(all(restarted.host.db, "SELECT * FROM gg_contact_config_versions WHERE contact_id = ?", c.id).length, 3);
});

test("CFG10 升级既有联系人只登记当前配置基线，不伪造早期历史或纳入秘密记忆字段", async () => {
  const { host, file } = make();
  const existing = { id: "legacy-contact", name: "旧联系人", avatar: null, bio: "", speakingModel: "", harness: "claude-code", computeModel: { mode: "inherit" }, tools: [], computeAssets: [], persona: "旧人设", createdAt: "2026-11-01T00:00:00.000Z", memory: "NEUTRAL_PRIVATE_MEMORY", authToken: "NEUTRAL_FIXTURE_NO_CREDENTIALS" };
  putDoc(host.db, "contact:legacy-contact", 0, existing);
  putDoc(host.db, "contact:legacy-contact", 1, { ...existing, name: "旧联系人第二版" });
  await host.close();
  const restarted = make(file);
  const result = await createService(restarted.host).handle("contacts.history", { contactId: "legacy-contact" });
  assert.ok(result.ok);
  const h = result.value as History;
  assert.deepEqual(h.versions.map((v) => [v.version, v.kind, v.config.name]), [[2, "baseline", "旧联系人第二版"]]);
  assert.ok(!JSON.stringify(h).includes("NEUTRAL_PRIVATE_MEMORY") && !JSON.stringify(h).includes("NEUTRAL_FIXTURE_NO_CREDENTIALS"));
  assert.deepEqual(Object.keys(h.versions[0]!.config).sort(), ["avatar", "bio", "computeAssets", "computeModel", "computeSlots", "harness", "name", "persona", "speakingModel", "tools"]);
});

test("CFG11 历史只追加，数据库 UPDATE 或 DELETE 被拒且原值保留", () => {
  const { host } = make();
  const c = host.createContact({ name: "原" });
  assert.throws(() => run(host.db, "UPDATE gg_contact_config_versions SET config = '{}' WHERE contact_id = ?", c.id), /immutable/);
  assert.throws(() => run(host.db, "DELETE FROM gg_contact_config_versions WHERE contact_id = ?", c.id), /immutable/);
  assert.equal(all<{ config: string }>(host.db, "SELECT config FROM gg_contact_config_versions WHERE contact_id = ?", c.id).map((r) => JSON.parse(r.config).name).join(), "原");
});

test("CFG12 删除联系人不允许通过配置回滚复活；不存在的版本不写任何东西", async () => {
  const { host } = make();
  const svc = createService(host);
  const c = host.createContact({ name: "原" });
  const missing = await svc.handle("contacts.rollback", { contactId: c.id, version: 999, expectedVersion: 1, clientActionId: "missing" });
  assert.equal(!missing.ok && missing.error.code, "not_found");
  host.removeContact(c.id);
  const removed = await svc.handle("contacts.rollback", { contactId: c.id, version: 1, expectedVersion: host.contactDoc(c.id).ver, clientActionId: "removed" });
  assert.equal(!removed.ok && removed.error.code, "not_found");
  assert.equal(host.listContacts().length, 0);
  assert.equal(all(host.db, "SELECT * FROM gg_contact_config_versions").length, 1);
});
