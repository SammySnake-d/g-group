// AC-21 共享文档单一提交点:两人基于同一版本修改,后提交者收到版本冲突,禁止静默覆盖;改不同文档都成功。
import assert from "node:assert/strict";
import { test } from "node:test";
import { cell, commit, commitIn, type Store, type Versioned } from "./cas.ts";

test("基于当前版本提交成功,版本号加一", () => {
  const r = commit(cell("v0 主稿"), 0, "v1 主稿");
  assert.equal(r.ok && r.cell.ver, 1);
  assert.equal(r.ok && r.cell.value, "v1 主稿");
});

test("两人基于同一版本修改,后提交者收到版本冲突(阳性埋雷:去掉版本校验就会静默覆盖)", () => {
  const base = cell("主稿");
  const first = commit(base, 0, "Argon 的修改");
  assert.ok(first.ok);
  const latest: Versioned<string> = first.cell;
  const second = commit(latest, 0, "Claude 的修改");
  assert.deepEqual(second, { ok: false, reason: "version-conflict", currentVer: 1 });
});

test("冲突时当前值保持先提交者的内容", () => {
  const first = commit(cell("主稿"), 0, "Argon 的修改");
  assert.ok(first.ok);
  commit(first.cell, 0, "Claude 的修改");
  assert.equal(first.cell.value, "Argon 的修改");
});

test("多文档存储:改不同文档互不冲突(阴性对照)", () => {
  let store: Store<string> = new Map([["需求", cell("需求 v0")], ["验收", cell("验收 v0")]]);
  const a = commitIn(store, "需求", 0, "需求 v1");
  assert.ok(a.ok);
  store = a.store;
  const b = commitIn(store, "验收", 0, "验收 v1");
  assert.ok(b.ok);
  assert.deepEqual([...b.store.values()].map((c) => c.ver), [1, 1]);
});

test("多文档存储:同一文档基于旧版本提交被拒绝,不存在的文档按版本 0 新建", () => {
  const s1 = commitIn(new Map(), "清单", 0, "第一版");
  assert.ok(s1.ok);
  const stale = commitIn(s1.store, "清单", 0, "旧版本上的修改");
  assert.deepEqual(stale, { ok: false, reason: "version-conflict", currentVer: 1 });
});
