// G5 待精筛标记的持久化:真实 SQLite;租约、失败上限、身份幂等与联系人隔离。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { DEFAULT_RETRY_POLICY } from "@g-group/kernel";
import { openDb, tx } from "./db.ts";
import { type MemoryMark, MemoryMarks } from "./memory-marks.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-memory-marks-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
let num = 0;
function fixture(Marks: typeof MemoryMarks) {
  const db = openDb(path.join(dir, `db-${++num}.sqlite`));
  after(() => db.close());
  return { db, marks: new Marks(db) };
}
const mark = (id: string, over: Partial<MemoryMark> = {}): MemoryMark => ({
  id, contactId: "c", roomId: "r", seq: 2, revision: 2, kind: "fact", evidence: `原话-${id}`, origin: { coverageId: "cov", candidateKey: id, takeover: false },
  state: "pending", attempts: 0, retryAt: 0, blocked: false, error: null, askedTarget: false, createdAt: 0, disposition: null, next: null, doneBy: null, ...over,
});

test("G5-LS4 精筛租约同一时刻只一个 过期或旧启动留下的可收回", () => {
  const s = fixture(MemoryMarks);
  assert.equal(s.marks.claimLease("c", "h1", "boot-1", 0, 100), true);
  assert.equal(s.marks.claimLease("c", "h2", "boot-1", 50, 100), false, "租约有效期内第二次认领被拒");
  assert.equal(s.marks.claimLease("other", "h2", "boot-1", 50, 100), true, "别的联系人各管各的");
  assert.equal(s.marks.claimLease("c", "h3", "boot-2", 60, 100), true, "上一次启动留下的租约可收回");
  assert.equal(s.marks.lease("c")?.holder, "h3");
  s.marks.releaseLease("c", "h1");
  assert.equal(s.marks.lease("c")?.until, 160, "不是持有人不能释放");
  s.marks.releaseLease("c", "h3");
  assert.equal(s.marks.claimLease("c", "h4", "boot-2", 61, 100), true, "释放后可再领");
});

test("G5-02L 失败到上限只挡自动重试 标记仍是欠账", () => {
  const s = fixture(MemoryMarks);
  tx(s.db, () => s.marks.addTx([mark("m1")]));
  const policy = { ...DEFAULT_RETRY_POLICY, maxAutoRetries: 1, baseDelayMs: 20, maxDelayMs: 20, jitter: 0 };
  const first = s.marks.fail("c", "m1", "upstream 503", "A1", policy, 100);
  assert.equal(first.retryAt, 120);
  assert.equal(s.marks.due("c", 119).length, 0);
  assert.equal(s.marks.due("c", 120).length, 1);
  const second = s.marks.fail("c", "m1", "upstream 503", "A1", policy, 120);
  assert.equal(second.blocked, true);
  assert.equal(s.marks.due("c", 99_999).length, 0, "到上限不再自动重试");
  assert.deepEqual(s.marks.open("c").map((m) => [m.id, m.state, m.evidence]), [["m1", "pending", "原话-m1"]], "上限不清账,原话还在");
  s.marks.dispose("c", "m1", "source-retracted-or-inaccessible", null);
  assert.deepEqual([s.marks.get("c", "m1")?.state, s.marks.get("c", "m1")?.evidence], ["disposed", null], "处置只留原因不留原文");
});

test("G5-05S 同一消息两项各自留存 同身份幂等 联系人互不覆盖", () => {
  const s = fixture(MemoryMarks);
  const added = tx(s.db, () => s.marks.addTx([mark("a"), mark("b"), mark("a")]));
  assert.equal(added, 2);
  assert.equal(tx(s.db, () => s.marks.addTx([mark("a")])), 0, "重放同一身份不新增");
  assert.equal(tx(s.db, () => s.marks.addTx([mark("a", { contactId: "d" })])), 1, "另一位联系人的同一身份是它自己的");
  assert.deepEqual(s.marks.list("c").map((m) => m.id).sort(), ["a", "b"]);
  assert.deepEqual(s.marks.list("d").map((m) => m.id), ["a"]);
  assert.equal(s.marks.generation("c"), 1);
  tx(s.db, () => s.marks.switchTx("c", 5));
  assert.equal(s.marks.generation("c"), 2);
  assert.equal(s.marks.generation("d"), 1, "代次按联系人记");
});
