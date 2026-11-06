// test-runner.ts 的单元测试(g-group#2538):测试步骤跑了 0 条用例不算通过。
// 也是 chore/gates 自身在 npm test 里真实执行的用例。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { countTests } from "./test-runner.ts";

const RUNNER = path.join(import.meta.dirname, "test-runner.ts");
function runIn(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-runner-"));
  try {
    for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t);
    // 外层 node --test 设的 NODE_TEST_CONTEXT 传下去会让里层 node --test 改用子进程协议
    const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
    const r = spawnSync(process.execPath, [RUNNER, "*.test.ts"], { cwd: dir, encoding: "utf8", env });
    return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("countTests 读顶层汇总行,忽略缩进的子测试汇总", () => {
  assert.equal(countTests("TAP version 13\n    # tests 9\n# tests 3\n# pass 3\n"), 3);
});

test("countTests 没有汇总行时给 undefined", () => {
  assert.equal(countTests("TAP version 13\n1..0\n"), undefined);
});

test("0 条用例判失败", () => {
  const r = runIn({});
  assert.equal(r.code, 1);
  assert.match(r.out, /跑了 0 条用例,不算通过/);
});

test("1 条通过的用例判通过", () => {
  const r = runIn({ "a.test.ts": 'import { test } from "node:test";\ntest("ok", () => {});\n' });
  assert.equal(r.code, 0);
});

test("全部 skip 判失败", () => {
  const r = runIn({ "a.test.ts": 'import { test } from "node:test";\ntest.skip("s", () => {});\n' });
  assert.equal(r.code, 1);
  assert.match(r.out, /没有实际执行/);
});

test("全部 todo 判失败", () => {
  const r = runIn({ "a.test.ts": 'import { test } from "node:test";\ntest.todo("t");\n' });
  assert.equal(r.code, 1);
  assert.match(r.out, /没有实际执行/);
});

test("通过与 skip 混合判失败", () => {
  const r = runIn({ "a.test.ts": 'import { test } from "node:test";\ntest("ok", () => {});\ntest.skip("s", () => {});\n' });
  assert.equal(r.code, 1);
  assert.match(r.out, /没有实际执行/);
});

test("有失败用例判失败", () => {
  const r = runIn({ "a.test.ts": 'import { test } from "node:test";\ntest("bad", () => { throw new Error("x"); });\n' });
  assert.notEqual(r.code, 0);
});
