// 定时(用户 #719:定时要能用 cron 表达式;U74 常驻承诺「每天 8 点」显式绑定时区、DST 校验,AC-35 ①)。
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCron, isValidTimeZone, nextRuns, parseCron } from "./cron.ts";

const spec = (e: string) => {
  const r = parseCron(e);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
};
const iso = (ms: number[]) => ms.map((m) => new Date(m).toISOString());

test("每天 8 点(上海):按时区算,不按 UTC", () => {
  const after = Date.parse("2026-11-08T23:30:00+08:00");
  assert.deepEqual(iso(nextRuns(spec("0 8 * * *"), "Asia/Shanghai", after, 2)), ["2026-11-09T00:00:00.000Z", "2026-11-10T00:00:00.000Z"]);
});

test("严格在 after 之后:正好在触发点上不重复返回", () => {
  const at = Date.parse("2026-11-09T08:00:00+08:00");
  assert.deepEqual(iso(nextRuns(spec("0 8 * * *"), "Asia/Shanghai", at, 1)), ["2026-11-10T00:00:00.000Z"]);
});

test("工作日 9:30、每 15 分钟、月末与名字写法", () => {
  const after = Date.parse("2026-11-06T10:00:00+08:00"); // 周五
  assert.deepEqual(iso(nextRuns(spec("30 9 * * MON-FRI"), "Asia/Shanghai", after, 2)), ["2026-11-09T01:30:00.000Z", "2026-11-10T01:30:00.000Z"]);
  assert.deepEqual(iso(nextRuns(spec("*/15 * * * *"), "UTC", Date.parse("2026-11-08T10:07:00Z"), 3)), ["2026-11-08T10:15:00.000Z", "2026-11-08T10:30:00.000Z", "2026-11-08T10:45:00.000Z"]);
  assert.deepEqual(iso(nextRuns(spec("0 0 31 * *"), "UTC", Date.parse("2026-11-08T00:00:00Z"), 2)), ["2026-12-31T00:00:00.000Z", "2027-01-31T00:00:00.000Z"]);
  assert.deepEqual(iso(nextRuns(spec("0 12 1 JAN,jul *"), "UTC", Date.parse("2026-11-08T00:00:00Z"), 2)), ["2027-01-01T12:00:00.000Z", "2027-07-01T12:00:00.000Z"]);
});

test("日与周都受限时取「或」;周日写 0 或 7 都行", () => {
  const after = Date.parse("2026-11-08T12:00:00Z"); // 周日
  assert.deepEqual(iso(nextRuns(spec("0 9 13 * 1"), "UTC", after, 2)), ["2026-11-09T09:00:00.000Z", "2026-11-13T09:00:00.000Z"]);
  assert.deepEqual(nextRuns(spec("0 9 * * 7"), "UTC", after, 1), nextRuns(spec("0 9 * * 0"), "UTC", after, 1));
});

test("夏令时:纽约春季拨快时 2:30 不存在就跳过,秋季拨慢 1:30 只触发一次", () => {
  const spring = nextRuns(spec("30 2 * * *"), "America/New_York", Date.parse("2027-03-13T12:00:00Z"), 2);
  assert.deepEqual(iso(spring), ["2027-03-15T06:30:00.000Z", "2027-03-16T06:30:00.000Z"], "3 月 14 日 2:30 不存在");
  const fall = nextRuns(spec("30 1 * * *"), "America/New_York", Date.parse("2026-11-01T00:00:00Z"), 2);
  assert.deepEqual(iso(fall), ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"], "11 月 1 日 1:30 只取第一次(EDT)");
});

test("非法表达式与时区给出人话原因", () => {
  assert.deepEqual(parseCron("0 8 * *"), { ok: false, error: "cron 要 5 段(分 时 日 月 周),这里有 4 段" });
  assert.deepEqual(parseCron("61 8 * * *"), { ok: false, error: "分字段「61」超出范围 0–59" });
  assert.deepEqual(parseCron("0 8 * * FUN"), { ok: false, error: "周字段「FUN」有不认识的值" });
  assert.deepEqual(parseCron("*/0 * * * *"), { ok: false, error: "分字段步长必须 ≥ 1" });
  assert.equal(isValidTimeZone("Asia/Shanghai"), true);
  assert.equal(isValidTimeZone("Mars/Base"), false);
  assert.throws(() => nextRuns(spec("0 8 * * *"), "Mars/Base", 0), /不认识的时区/);
});

test("描述给表单预览用", () => {
  assert.equal(describeCron(spec("0 8 * * *"), "Asia/Shanghai"), "每天 08:00(Asia/Shanghai)");
  assert.equal(describeCron(spec("30 9 * * 1-5"), "UTC"), "每周一、二、三、四、五 09:30(UTC)");
  assert.equal(describeCron(spec("0 8,20 1 * *"), "UTC"), "每月 1 日 08:00、20:00(UTC)");
});
