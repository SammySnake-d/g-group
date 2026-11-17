// 共享文档单一提交点(AC-21,D20.1(3) 路径 A、4B R-Doc、C-US11):两人基于同一版本改主稿,后提交者收到版本冲突、不静默覆盖;
// 同一 requestId 重试幂等;改不同文档都成功;权威在数据库,.md 镜像只是派生,读取与启动时按权威修复。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { type ServerEvent, checkEvent } from "@g-group/api-contract";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-docs-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = path.join(dir, `h${++n}`);
  return { file: path.join(d, "gg.db"), dataDir: d };
};
/** 宿主选项:数据目录先建好(SQLite 打不开不存在目录里的库) */
const opts = (where: { file: string; dataDir: string }) => {
  mkdirSync(where.dataDir, { recursive: true });
  return { file: where.file, dataDir: where.dataDir, mind: () => scriptedMind(), maxDeferMs: 5 };
};

test("两人基于同一版本改主稿:先提交者成为第 2 版,后提交者收到版本冲突(currentVer=2),正文是先提交者的,不静默覆盖", async () => {
  const host = new Host(opts(fresh()));
  const svc = createService(host);
  const g = host.createGroup("大阪", []);
  const made = await svc.handle("docs.create", { clientActionId: "mk", title: "大阪行程单", content: "# 行程\n", roomId: g.id });
  assert.ok(made.ok);
  const doc = made.value as { id: string; version: number };
  assert.equal(doc.version, 1);
  const a = await svc.handle("docs.commit", { docId: doc.id, requestId: "r-lv", baseVersion: 1, content: "# 行程\n- 晚餐:一兰拉面\n" });
  assert.ok(a.ok, a.ok ? "" : a.error.message);
  assert.deepEqual([(a.value as { committedVersion: number }).committedVersion, (a.value as { replayed: boolean }).replayed], [2, false]);
  const b = await svc.handle("docs.commit", { docId: doc.id, requestId: "r-qian", baseVersion: 1, content: "# 行程\n- 交通:关西机场快线\n" });
  assert.equal(b.ok, false);
  assert.equal(b.ok ? "" : b.error.code, "conflict");
  assert.deepEqual(b.ok ? null : b.error.detail, { currentVer: 2 });
  const now = host.docs.get(doc.id);
  assert.equal(now.version, 2);
  assert.equal(now.content, "# 行程\n- 晚餐:一兰拉面\n");
  assert.deepEqual(host.docs.history(doc.id).map((v) => v.version), [2, 1], "冲突的提交不进版本链");
  await host.close();
});

test("后提交者读到第 2 版、合并后基于第 2 版重交成为第 3 版:版本链 1→2→3,两人的改动都在", async () => {
  const host = new Host(opts(fresh()));
  const doc = host.docs.create({ clientActionId: "mk", title: "大阪行程单", content: "# 行程\n" }, { kind: "user", id: "me" });
  host.docs.commit({ docId: doc.id, requestId: "r1", baseVersion: 1, content: "# 行程\n- 晚餐\n" }, { kind: "contact", id: "c-lv" });
  assert.throws(() => host.docs.commit({ docId: doc.id, requestId: "r2", baseVersion: 1, content: "# 行程\n- 交通\n" }, { kind: "contact", id: "c-qian" }), (e: Error & { code?: string; detail?: unknown }) => e.code === "conflict" && JSON.stringify(e.detail) === '{"currentVer":2}');
  const latest = host.docs.get(doc.id);
  const merged = host.docs.commit({ docId: doc.id, requestId: "r3", baseVersion: latest.version, content: `${latest.content}- 交通\n` }, { kind: "contact", id: "c-qian" });
  assert.equal(merged.committedVersion, 3);
  assert.equal(merged.doc.content, "# 行程\n- 晚餐\n- 交通\n");
  assert.deepEqual(merged.doc.updatedBy, { kind: "contact", id: "c-qian" });
  assert.deepEqual(host.docs.history(doc.id).map((v) => [v.version, v.updatedBy.id, v.requestId]), [[3, "c-qian", "r3"], [2, "c-lv", "r1"], [1, "me", "create:mk"]]);
  assert.equal(host.docs.get(doc.id, 2).content, "# 行程\n- 晚餐\n", "版本链里的旧版原样可读");
  await host.close();
});

test("同一 requestId 重试(回执丢了):返回当初生效的版本,不重复写;别人之后又提交了也不当成冲突、不覆盖", async () => {
  const host = new Host(opts(fresh()));
  const events: ServerEvent[] = [];
  host.bus.subscribe((e) => events.push(e));
  const doc = host.docs.create({ clientActionId: "mk", title: "纪要", content: "" }, { kind: "user", id: "me" });
  const first = host.docs.commit({ docId: doc.id, requestId: "r-a", baseVersion: 1, content: "A 的一段\n" }, { kind: "contact", id: "c-a" });
  host.docs.commit({ docId: doc.id, requestId: "r-b", baseVersion: 2, content: "A 的一段\nB 的一段\n" }, { kind: "contact", id: "c-b" });
  const again = host.docs.commit({ docId: doc.id, requestId: "r-a", baseVersion: 1, content: "A 的一段\n" }, { kind: "contact", id: "c-a" });
  assert.deepEqual([first.committedVersion, again.committedVersion, again.replayed], [2, 2, true]);
  assert.equal(again.doc.version, 3);
  assert.equal(again.doc.content, "A 的一段\nB 的一段\n", "重放不把正文退回 A 的版本");
  assert.deepEqual(host.docs.history(doc.id).map((v) => v.version), [3, 2, 1]);
  assert.equal(events.filter((e) => e.type === "doc.updated").length, 3, "新建 + 两次生效提交各一条,重放不发");
  await host.close();
});

test("同一 requestId 换了内容或换了文档:拒绝(conflict),不写入", async () => {
  const host = new Host(opts(fresh()));
  const me = { kind: "user" as const, id: "me" };
  const d1 = host.docs.create({ clientActionId: "a", title: "一", content: "" }, me);
  const d2 = host.docs.create({ clientActionId: "b", title: "二", content: "" }, me);
  const first = host.docs.commit({ docId: d1.id, requestId: "r", baseVersion: 1, content: "x" }, me);
  assert.deepEqual([first.committedVersion, first.doc.version, first.replayed], [2, 2, false]);
  assert.throws(() => host.docs.commit({ docId: d1.id, requestId: "r", baseVersion: 1, content: "y" }, me), /已用于另一次提交/);
  assert.throws(() => host.docs.commit({ docId: d2.id, requestId: "r", baseVersion: 1, content: "x" }, me), /已用于另一次提交/);
  assert.deepEqual([host.docs.get(d1.id).content, host.docs.get(d1.id).version, host.docs.get(d2.id).version], ["x", 2, 1]);
  await host.close();
});

test("同一 clientActionId 重发新建:返回同一份文档,不多建", async () => {
  const host = new Host(opts(fresh()));
  const me = { kind: "user" as const, id: "me" };
  const a = host.docs.create({ clientActionId: "dup", title: "清单", content: "牛奶" }, me);
  const b = host.docs.create({ clientActionId: "dup", title: "清单", content: "牛奶" }, me);
  assert.equal(a.id, b.id);
  assert.deepEqual([a.version, b.version], [1, 1]);
  assert.equal(host.docs.list({}).length, 1);
  assert.throws(() => host.docs.create({ clientActionId: "dup", title: "清单", content: "鸡蛋" }, me), /已用于另一次新建/);
  await host.close();
});

test("改不同文档都成功(阴性对照):两份文档各自基于第 1 版提交,互不影响", async () => {
  const host = new Host(opts(fresh()));
  const me = { kind: "user" as const, id: "me" };
  const g = host.createGroup("项目", []);
  const x = host.docs.create({ clientActionId: "x", title: "前端", content: "", roomId: g.id }, me);
  const y = host.docs.create({ clientActionId: "y", title: "后端", content: "" }, me);
  const rx = host.docs.commit({ docId: x.id, requestId: "rx", baseVersion: 1, content: "按钮" }, { kind: "contact", id: "c-qian" });
  const ry = host.docs.commit({ docId: y.id, requestId: "ry", baseVersion: 1, content: "接口" }, { kind: "contact", id: "c-hou" });
  assert.deepEqual([rx.committedVersion, ry.committedVersion], [2, 2]);
  assert.deepEqual([host.docs.get(x.id).content, host.docs.get(y.id).content], ["按钮", "接口"]);
  assert.deepEqual(host.docs.list({ roomId: g.id }).map((d) => d.id), [x.id]);
  await host.close();
});

test("两个宿主实例(两个连接)都读到第 1 版:先交的成第 2 版,后交的收到冲突——提交点在数据库,不在进程内存", async () => {
  const where = fresh();
  const h1 = new Host(opts(where));
  const doc = h1.docs.create({ clientActionId: "mk", title: "主稿", content: "v1" }, { kind: "user", id: "me" });
  const h2 = new Host(opts(where));
  assert.equal(h1.docs.get(doc.id).version, 1);
  assert.equal(h2.docs.get(doc.id).version, 1);
  const won = h1.docs.commit({ docId: doc.id, requestId: "p1", baseVersion: 1, content: "甲改" }, { kind: "contact", id: "c-jia" });
  assert.deepEqual([doc.version, won.committedVersion], [1, 2]);
  assert.throws(() => h2.docs.commit({ docId: doc.id, requestId: "p2", baseVersion: 1, content: "乙改" }, { kind: "contact", id: "c-yi" }), (e: Error & { code?: string }) => e.code === "conflict");
  assert.equal(h2.docs.get(doc.id).content, "甲改");
  assert.equal(h2.docs.get(doc.id).version, 2);
  await h2.close();
  await h1.close();
});

test("提交中途失败整体回滚:版本、正文、幂等键都不落;排除故障后同一 requestId 当作新提交生效", async () => {
  const host = new Host(opts(fresh()));
  const me = { kind: "user" as const, id: "me" };
  const doc = host.docs.create({ clientActionId: "mk", title: "主稿", content: "v1" }, me);
  // 版本链里预先占住第 2 版(模拟上次非原子写入留下的残行):这次提交在写版本链时失败
  host.db.store.db.prepare("INSERT INTO gg_doc_versions (doc_id, ver, title, content, by_kind, by_id, at, request_id) VALUES (?, 2, '主稿', '残行', 'user', 'me', '2026-11-09T00:00:00Z', 'stale')").run(doc.id);
  assert.throws(() => host.docs.commit({ docId: doc.id, requestId: "r", baseVersion: 1, content: "v2" }, me));
  assert.deepEqual([host.docs.get(doc.id).version, host.docs.get(doc.id).content], [1, "v1"], "版本与正文都没推进");
  host.db.store.db.prepare("DELETE FROM gg_doc_versions WHERE request_id = 'stale'").run();
  const r = host.docs.commit({ docId: doc.id, requestId: "r", baseVersion: 1, content: "v2" }, me);
  assert.deepEqual([r.committedVersion, r.replayed], [2, false], "失败的那次没记幂等键");
  await host.close();
});

test("提交后 .md 镜像与权威一致;镜像被迟到的旧内容覆盖,读取时按权威版本修复", async () => {
  const host = new Host(opts(fresh()));
  const me = { kind: "user" as const, id: "me" };
  const doc = host.docs.create({ clientActionId: "mk", title: "行程", content: "v1" }, me);
  const f = host.docs.mirrorPath(doc.id);
  assert.equal(readFileSync(f, "utf8"), "v1");
  host.docs.commit({ docId: doc.id, requestId: "r", baseVersion: 1, content: "v2" }, me);
  assert.equal(readFileSync(f, "utf8"), "v2");
  writeFileSync(f, "v1");
  assert.equal(host.docs.get(doc.id).content, "v2");
  assert.equal(readFileSync(f, "utf8"), "v2", "读取按权威版本重写镜像");
  await host.close();
});

test("镜像缺失或被改坏后重启宿主:启动时按权威版本修复全部镜像,权威版本号不变", async () => {
  const where = fresh();
  const me = { kind: "user" as const, id: "me" };
  const h1 = new Host(opts(where));
  const a = h1.docs.create({ clientActionId: "a", title: "甲", content: "甲 v1" }, me);
  const b = h1.docs.create({ clientActionId: "b", title: "乙", content: "乙 v1" }, me);
  h1.docs.commit({ docId: b.id, requestId: "rb", baseVersion: 1, content: "乙 v2" }, me);
  const fa = h1.docs.mirrorPath(a.id);
  const fb = h1.docs.mirrorPath(b.id);
  await h1.close();
  unlinkSync(fa);
  writeFileSync(fb, "乙 v1");
  const h2 = new Host(opts(where));
  assert.deepEqual([readFileSync(fa, "utf8"), readFileSync(fb, "utf8")], ["甲 v1", "乙 v2"]);
  assert.deepEqual([h2.docs.get(a.id).version, h2.docs.get(b.id).version], [1, 2]);
  await h2.close();
});

test("不存在的文档、没有的版本、不存在的会话:not_found,什么都不写", async () => {
  const host = new Host(opts(fresh()));
  const svc = createService(host);
  const r = await svc.handle("docs.commit", { docId: "d-none", requestId: "r", baseVersion: 1, content: "x" });
  assert.equal(r.ok ? "" : r.error.code, "not_found");
  const c = await svc.handle("docs.create", { clientActionId: "k", title: "t", content: "", roomId: "g-none" });
  assert.equal(c.ok ? "" : c.error.code, "not_found");
  assert.equal(host.docs.list({}).length, 0);
  const doc = host.docs.create({ clientActionId: "k2", title: "t", content: "" }, { kind: "user", id: "me" });
  const v = await svc.handle("docs.get", { docId: doc.id, version: 9 });
  assert.equal(v.ok ? "" : v.error.code, "not_found");
  const h = await svc.handle("docs.history", { docId: doc.id });
  assert.ok(h.ok);
  assert.deepEqual((h.value as { versions: { version: number }[] }).versions.map((x) => x.version), [1]);
  await host.close();
});

test("合同:docs.commit 缺 requestId、baseVersion 为 0 被服务层拒为 invalid_params;doc.updated 事件按合同校验通过", async () => {
  const host = new Host(opts(fresh()));
  const svc = createService(host);
  const events: ServerEvent[] = [];
  host.bus.subscribe((e) => events.push(e));
  const bad = await svc.handle("docs.commit", { docId: "d1", baseVersion: 0, content: "x" });
  assert.equal(bad.ok ? "" : bad.error.code, "invalid_params");
  assert.equal(bad.ok ? "" : bad.error.message, "requestId: 缺少必填字段; baseVersion: 应 ≥ 1");
  const made = await svc.handle("docs.create", { clientActionId: "k", title: "行程", content: "v1" });
  assert.ok(made.ok);
  const doc = made.value as { id: string; version: number; roomId: string | null; updatedBy: { kind: string; id: string } };
  assert.deepEqual([doc.version, doc.roomId, doc.updatedBy], [1, null, { kind: "user", id: "me" }]);
  const ev = events.find((e) => e.type === "doc.updated");
  assert.ok(ev, "新建发了 doc.updated");
  const checked = checkEvent(ev);
  assert.ok(checked.ok);
  assert.equal(checked.ok ? (checked.value as { doc: { id: string } }).doc.id : "", doc.id);
  await host.close();
});
