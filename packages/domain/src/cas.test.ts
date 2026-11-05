// AC-21 共享文档单一提交点:两人基于同一版本修改,后提交者收到版本冲突,禁止静默覆盖;改不同文档都成功。
// 本文件只覆盖纯函数层的比较逻辑;同一事务内读版本、写入的原子性由存储适配器负责。
import assert from "node:assert/strict";
import { test } from "node:test";
import { cell, commit, commitIn, type Store } from "./cas.ts";

const snapStore = (s: Store<string>) => JSON.stringify([...s.entries()]);

test("基于当前版本提交成功,版本号加一且写入新内容", () => {
  const r = commit(cell("v0 主稿"), 0, "v1 主稿");
  assert.deepEqual(r, { ok: true, cell: { value: "v1 主稿", ver: 1 } });
});

test("两人基于同一版本修改,后提交者收到版本冲突(阳性埋雷:去掉版本校验就会静默覆盖)", () => {
  const first = commit(cell("主稿"), 0, "Argon 的修改");
  assert.ok(first.ok);
  const second = commit(first.cell, 0, "Claude 的修改");
  assert.deepEqual(second, { ok: false, reason: "version-conflict", currentVer: 1 });
  assert.equal(first.cell.value, "Argon 的修改");
});

test("提交不改入参单元", () => {
  const base = cell("主稿");
  const saved = JSON.stringify(base);
  commit(base, 0, "新");
  commit(base, 5, "冲突");
  assert.equal(JSON.stringify(base), saved);
});

test("多文档存储:同一版本、同一提案只切文档键,改不同文档互不冲突且内容都写入(阴性对照)", () => {
  const store: Store<string> = new Map([["需求", cell("需求 v0")], ["验收", cell("验收 v0")]]);
  const a = commitIn(store, "需求", 0, "第一版修改");
  assert.ok(a.ok);
  assert.equal(a.store.get("需求")?.value, "第一版修改");
  assert.equal(a.store.get("验收")?.value, "验收 v0");
  const b = commitIn(a.store, "验收", 0, "第一版修改");
  assert.ok(b.ok);
  assert.deepEqual(b.store.get("需求"), { value: "第一版修改", ver: 1 });
  assert.deepEqual(b.store.get("验收"), { value: "第一版修改", ver: 1 });
  assert.equal(a.store.get("验收")?.value, "验收 v0");
});

test("多文档存储:成功和冲突两条路径都不改输入 Store", () => {
  const store: Store<string> = new Map([["需求", cell("需求 v0")]]);
  const saved = snapStore(store);
  const ok = commitIn(store, "需求", 0, "改");
  assert.ok(ok.ok);
  assert.equal(snapStore(store), saved);
  const conflict = commitIn(ok.store, "需求", 0, "旧版本上的修改");
  assert.equal(conflict.ok, false);
  assert.equal(ok.store.get("需求")?.value, "改");
  assert.equal(snapStore(store), saved);
});

test("多文档存储:同一文档基于旧版本提交被拒绝,不存在的文档按版本 0 新建并写入内容", () => {
  const s1 = commitIn(new Map(), "清单", 0, "第一版");
  assert.ok(s1.ok);
  assert.deepEqual(s1.store.get("清单"), { value: "第一版", ver: 1 });
  const stale = commitIn(s1.store, "清单", 0, "旧版本上的修改");
  assert.deepEqual(stale, { ok: false, reason: "version-conflict", currentVer: 1 });
  assert.equal(s1.store.get("清单")?.value, "第一版");
});
