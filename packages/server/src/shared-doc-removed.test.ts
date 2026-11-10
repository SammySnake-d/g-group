// P1:共享文档撤销后,服务入口消失、新库不再初始化专用存储。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "gg-doc-removed-"));
  return { file: join(dir, "gg.db"), dataDir: dir, mind: () => scriptedMind() };
}

test("P1 docs.list 返回 unknown_method", async (t) => {
  const opts = fresh();
  const host = new Host(opts);
  t.after(async () => { await host.close(); rmSync(opts.dataDir, { recursive: true, force: true }); });
  const svc = createService(host);
  const r = await svc.handle("docs.list", {});
  assert.deepEqual(r, { ok: false, error: { code: "unknown_method", message: "没有方法 docs.list" } });
});

test("P1 docs.get 返回 unknown_method", async (t) => {
  const opts = fresh();
  const host = new Host(opts);
  t.after(async () => { await host.close(); rmSync(opts.dataDir, { recursive: true, force: true }); });
  const svc = createService(host);
  const r = await svc.handle("docs.get", { docId: "d1" });
  assert.deepEqual(r, { ok: false, error: { code: "unknown_method", message: "没有方法 docs.get" } });
});

test("P1 docs.create 返回 unknown_method", async (t) => {
  const opts = fresh();
  const host = new Host(opts);
  t.after(async () => { await host.close(); rmSync(opts.dataDir, { recursive: true, force: true }); });
  const svc = createService(host);
  const r = await svc.handle("docs.create", { clientActionId: "a1", title: "中性样例", content: "NEUTRAL_FIXTURE_NO_CREDENTIALS" });
  assert.deepEqual(r, { ok: false, error: { code: "unknown_method", message: "没有方法 docs.create" } });
});

test("P1 docs.commit 返回 unknown_method", async (t) => {
  const opts = fresh();
  const host = new Host(opts);
  t.after(async () => { await host.close(); rmSync(opts.dataDir, { recursive: true, force: true }); });
  const svc = createService(host);
  const r = await svc.handle("docs.commit", { docId: "d1", requestId: "r1", baseVersion: 1, content: "中性样例" });
  assert.deepEqual(r, { ok: false, error: { code: "unknown_method", message: "没有方法 docs.commit" } });
});

test("P1 docs.history 返回 unknown_method", async (t) => {
  const opts = fresh();
  const host = new Host(opts);
  t.after(async () => { await host.close(); rmSync(opts.dataDir, { recursive: true, force: true }); });
  const svc = createService(host);
  const r = await svc.handle("docs.history", { docId: "d1" });
  assert.deepEqual(r, { ok: false, error: { code: "unknown_method", message: "没有方法 docs.history" } });
});

test("P1 新宿主没有共享文档专用表和镜像目录", (t) => {
  const opts = fresh();
  const host = new Host(opts);
  t.after(async () => { await host.close(); rmSync(opts.dataDir, { recursive: true, force: true }); });
  const tables = host.db.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('gg_doc_versions', 'gg_doc_requests')").all();
  assert.deepEqual(tables, []);
  assert.equal(existsSync(join(opts.dataDir, "shared-docs")), false);
});
