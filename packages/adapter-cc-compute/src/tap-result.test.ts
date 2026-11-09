import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assessTap, type TapRun } from "../test-support/tap-result.ts";

// 夹具里的 skip/todo 是判决器的真实反例输入,不是本测试套件的跳过项。
function fixture(body: string): TapRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tap-fixture-"));
  try {
    const file = path.join(dir, "case.test.mjs");
    fs.writeFileSync(file, `import { test } from 'node:test'; import assert from 'node:assert/strict';\n${body}\n`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], { encoding: "utf8", timeout: 10_000, env });
    assert.equal(r.error, undefined, r.stderr);
    return { out: r.stdout, code: r.status, signal: r.signal, timedOut: false };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const full = () => fixture("test('目标', () => assert.equal(1, 1)); test('对照', () => assert.equal(2, 2));");
const red = () => fixture("test('目标', () => assert.equal(1, 2)); test('对照', () => assert.equal(2, 2));");
const target = { name: "目标", code: "ERR_ASSERTION" };
const names = ["目标", "对照"];

test("R10-01/全执行:真实 TAP 的完整基线与指定断言失败分别认可,同名全绿不算发现故障", () => {
  assert.equal(assessTap(full()).valid, true);
  assert.equal(assessTap(red(), names, target).killed, true);
  assert.equal(assessTap(full(), names, target).killed, false);
});
test("R10-01/跳过:真实 TAP 跳过项使原样与故障副本均无效", () => {
  for (const expression of ["1", "2"]) {
    const run = fixture(`test('目标', () => assert.equal(1, ${expression})); test('对照', { skip: true }, () => {});`);
    assert.equal(assessTap(run, names, target).valid, false, run.out);
    assert.equal(assessTap(run, names, target).killed, false);
  }
});
test("R10-01/待办:真实 TAP 的通过和失败待办都不算执行完成", () => {
  for (const expression of ["1", "2"]) {
    const run = fixture(`test('目标', { todo: true }, () => assert.equal(1, ${expression})); test('对照', () => {});`);
    assert.equal(assessTap(run, names, target).valid, false, run.out);
  }
});
test("R10-01/取消:真实未完成 Promise 的取消结果不算具名发现", () => {
  const run = fixture("const controller = new AbortController(); setTimeout(() => controller.abort(), 10); test('目标', { signal: controller.signal }, () => new Promise(() => {})); test('对照', () => {});");
  assert.equal(assessTap(run, names, target).valid, false, run.out);
});
test("R10-01/文件失败:加载异常或提前退出不算测试代码断言失败", () => {
  for (const body of ["throw new Error('中性加载错误');", "test('目标', () => process.exit(1));"]) {
    const run = fixture(body);
    assert.equal(assessTap(run).valid, false, run.out);
  }
});
test("R10-01/计划汇总:缺失重复或错误的 TAP 计划与汇总都拒收", () => {
  const run = red();
  for (const out of [run.out.replace(/^1\.\.2$/m, "1..3"), run.out.replace(/^1\.\.2\n/m, ""), `${run.out}\n1..2\n`, run.out.replace(/^# tests 2$/m, "# tests 1"), run.out.replace(/^# fail 1$/m, "# fail 0"), run.out.replace(/^# skipped 0\n/m, ""), `${run.out}\n# pass 1\n`]) {
    assert.equal(assessTap({ ...run, out }, names, target).valid, false, out);
  }
});
test("R10-01/逐名:条数相同但名字或序号不一致以及重复名字均拒收", () => {
  const run = red();
  for (const out of [run.out.replaceAll("对照", "另一项"), run.out.replace(/^ok 2 -/m, "ok 3 -"), run.out.replaceAll("对照", "目标")]) {
    assert.equal(assessTap({ ...run, out }, names, target).valid, false, out);
  }
});
test("R10-01/进程:超时信号异常退出码和截断均不能成为有效判决", () => {
  const run = red();
  for (const changed of [{ timedOut: true }, { signal: "SIGTERM" }, { code: 0 }, { code: 2 }, { out: run.out.slice(0, run.out.indexOf("1..2")) }]) {
    assert.equal(assessTap({ ...run, ...changed }, names, target).valid, false);
  }
});
test("R10-01/原因:只有指定名字及指定错误码匹配才算发现,无关失败不能替代", () => {
  const run = red();
  assert.equal(assessTap(run, names, { name: "对照", code: "ERR_ASSERTION" }).killed, false);
  assert.equal(assessTap(run, names, { name: "目标", code: "ERR_OTHER" }).killed, false);
  assert.equal(assessTap({ ...run, out: run.out.replace("testCodeFailure", "cancelledByParent") }, names, target).valid, false);
});
test("R10-01/指令:即使汇总声称零跳过,结果行 SKIP 或 TODO 指令仍拒收", () => {
  const run = red();
  for (const directive of ["SKIP", "TODO"]) {
    const out = run.out.replace(/^ok 2 - 对照$/m, `ok 2 - 对照 # ${directive} 中性`);
    assert.equal(assessTap({ ...run, out }, names, target).valid, false);
  }
});
