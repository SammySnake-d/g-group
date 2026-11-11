import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CRON_PRESETS,
  cronError,
  cronPresetId,
  daysInMonth,
  describeCron,
  describeTrigger,
  formatRunAt,
  messagesLeft,
  nextRuns,
  parseCron,
  parseLocalDateTime,
  toLocalDateTime,
  triggerError,
  triggerNext,
  utcOffsetLabel,
  localZoneLabel,
  type CronParse,
} from "./cron.ts";

/** 本地时间构造 / 打印,断言和机器时区无关(测试日期都避开夏令时切换日) */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);
const fmt = (d: Date) => toLocalDateTime(d).replace("T", " ");
const fmts = (ds: readonly Date[]) => ds.map(fmt);
/** 取合法结果 / 错误;不符合预期直接抛,断言里仍然直接调用被测函数 */
const ok = (p: CronParse) => {
  if (!p.ok) throw new Error(`应当合法却报错:${p.error.message}`);
  return p.spec;
};
const bad = (p: CronParse) => {
  if (p.ok) throw new Error(`应当报错却通过:${p.spec.expr}`);
  return p.error;
};

test("parseCron:* / 列表 / 范围 / 步长逐段展开成取值", () => {
  const s = ok(parseCron("0,15,30 9-11 */10 1-12/3 *"));
  assert.deepEqual(s.minutes, [0, 15, 30]);
  assert.deepEqual(s.hours, [9, 10, 11]);
  assert.deepEqual(s.days, [1, 11, 21, 31]);
  assert.deepEqual(s.months, [1, 4, 7, 10]);
  assert.deepEqual(s.weekdays, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(s.expr, "0,15,30 9-11 */10 1-12/3 *");
  // 多余空白会被规整
  assert.equal(ok(parseCron("  0   9 *  * 1-5 ")).expr, "0 9 * * 1-5");
});

test("parseCron:步长边界 */15、1-30/5、5/20、*/59、*/60", () => {
  assert.deepEqual(ok(parseCron("*/15 * * * *")).minutes, [0, 15, 30, 45]);
  assert.deepEqual(ok(parseCron("1-30/5 * * * *")).minutes, [1, 6, 11, 16, 21, 26]);
  assert.deepEqual(ok(parseCron("5/20 * * * *")).minutes, [5, 25, 45]);
  assert.deepEqual(ok(parseCron("*/59 * * * *")).minutes, [0, 59]);
  assert.deepEqual(ok(parseCron("*/60 * * * *")).minutes, [0]);
  assert.deepEqual(ok(parseCron("0 0-23/6 * * *")).hours, [0, 6, 12, 18]);
});

test("parseCron:月份和星期英文名大小写不敏感,周的 0 和 7 都是周日", () => {
  const s = ok(parseCron("0 9 * jan-Mar,DEC mon-FRI"));
  assert.deepEqual(s.months, [1, 2, 3, 12]);
  assert.deepEqual(s.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(s.expr, "0 9 * JAN-MAR,DEC MON-FRI");
  assert.deepEqual(ok(parseCron("0 0 * * 7")).weekdays, [0]);
  assert.deepEqual(ok(parseCron("0 0 * * 0,7")).weekdays, [0]);
  assert.deepEqual(ok(parseCron("0 0 * * sun")).weekdays, [0]);
  assert.deepEqual(ok(parseCron("0 0 * * 5-7")).weekdays, [0, 5, 6]);
  assert.deepEqual(ok(parseCron("0 0 * * Sat,Sun")).weekdays, [0, 6]);
});

test("parseCron:越界报中文错误并指出第几段", () => {
  assert.deepEqual(bad(parseCron("0 25 * * *")), { field: 2, message: "第 2 段（时）：25 超出 0–23" });
  assert.deepEqual(bad(parseCron("60 * * * *")), { field: 1, message: "第 1 段（分）：60 超出 0–59" });
  assert.deepEqual(bad(parseCron("0 0 0 * *")), { field: 3, message: "第 3 段（日）：0 超出 1–31" });
  assert.deepEqual(bad(parseCron("0 0 * 13 *")), { field: 4, message: "第 4 段（月）：13 超出 1–12" });
  assert.deepEqual(bad(parseCron("0 0 * * 8")), { field: 5, message: "第 5 段（周）：8 超出 0–7" });
  assert.deepEqual(bad(parseCron("0 0 1-40 * *")), { field: 3, message: "第 3 段（日）：40 超出 1–31" });
  // 对照:每段的上下界本身是合法的
  const hi = ok(parseCron("59 23 31 12 7"));
  assert.deepEqual([hi.minutes, hi.hours, hi.days, hi.months, hi.weekdays], [[59], [23], [31], [12], [0]]);
  const lo = ok(parseCron("0 0 1 1 0"));
  assert.deepEqual([lo.minutes, lo.hours, lo.days, lo.months, lo.weekdays], [[0], [0], [1], [1], [0]]);
});

test("parseCron:段数不对、空段、非法字符、反向范围、步长为 0 都报错", () => {
  assert.deepEqual(bad(parseCron("* * *")), { field: null, message: "要 5 段（分 时 日 月 周），现在是 3 段" });
  assert.deepEqual(bad(parseCron("0 0 * * * *")), { field: null, message: "要 5 段（分 时 日 月 周），现在是 6 段" });
  assert.equal(bad(parseCron("   ")).field, null);
  assert.match(bad(parseCron("")).message, /还没写表达式/);
  assert.deepEqual(bad(parseCron("0 9,,10 * * *")), { field: 2, message: "第 2 段（时）：逗号前后不能为空" });
  assert.deepEqual(bad(parseCron("0 9 * * MON?")), { field: 5, message: "第 5 段（周）：不认识「MON?」" });
  assert.deepEqual(bad(parseCron("0 9 L * *")), { field: 3, message: "第 3 段（日）：不认识「L」" });
  // 英文名只在月、周两段认
  assert.deepEqual(bad(parseCron("MON 9 * * *")), { field: 1, message: "第 1 段（分）：不认识「MON」" });
  assert.deepEqual(bad(parseCron("0 9-5 * * *")), { field: 2, message: "第 2 段（时）：范围 9-5 起点大于终点" });
  assert.deepEqual(bad(parseCron("*/0 * * * *")), { field: 1, message: "第 1 段（分）：步长不能是 0" });
  assert.deepEqual(bad(parseCron("0 0 * * 1-")), { field: 5, message: "第 5 段（周）：范围「1-」缺少终点" });
  assert.deepEqual(bad(parseCron("*/ * * * *")), { field: 1, message: "第 1 段（分）：/ 后面要写步长" });
  assert.deepEqual(bad(parseCron("1/2/3 * * * *")), { field: 1, message: "第 1 段（分）：「1/2/3」里只能有一个 /" });
  assert.equal(cronError("0 25 * * *"), "第 2 段（时）：25 超出 0–23");
  assert.equal(cronError("0 9 * * 1-5"), null);
});

test("parseCron:永远不会触发的表达式判为错误,闰日和日周「或」不算", () => {
  assert.deepEqual(bad(parseCron("0 0 30 2 *")), { field: null, message: "永远不会触发：2 月没有 30 日" });
  assert.deepEqual(bad(parseCron("0 0 31 4,6,9,11 *")), { field: null, message: "永远不会触发：选的月份里没有这些日子" });
  assert.equal(cronError("0 0 29 2 *"), null);
  // 日、周都受限 → 或:2 月 31 日不存在,但 2 月的每个周一都会跑
  assert.equal(cronError("0 0 31 2 1"), null);
  // 日段以 * 开头 → 且:*/40 只剩 1 号,1 号是周一的 2 月存在
  assert.equal(cronError("0 0 */40 2 1"), null);
});

test("nextRuns:从下一分钟起算,正好在点上也排到下一次", () => {
  assert.deepEqual(fmts(nextRuns("0 9 * * *", at(2026, 3, 10, 8, 59, 30), 3)), ["2026-03-10 09:00", "2026-03-11 09:00", "2026-03-12 09:00"]);
  assert.deepEqual(fmts(nextRuns("0 9 * * *", at(2026, 3, 10, 9, 0, 0), 2)), ["2026-03-11 09:00", "2026-03-12 09:00"]);
  assert.deepEqual(fmts(nextRuns("* * * * *", at(2026, 3, 10, 9, 0, 45), 2)), ["2026-03-10 09:01", "2026-03-10 09:02"]);
  assert.equal(nextRuns("0 9 * * *", at(2026, 3, 10), 0).length, 0);
});

test("nextRuns:步长边界与跨小时、跨天、跨年", () => {
  assert.deepEqual(fmts(nextRuns("*/15 * * * *", at(2026, 6, 1, 10, 7), 4)), ["2026-06-01 10:15", "2026-06-01 10:30", "2026-06-01 10:45", "2026-06-01 11:00"]);
  // 1-30/5 取到 26,不会出现 31
  assert.deepEqual(fmts(nextRuns("1-30/5 * * * *", at(2026, 6, 1, 10, 25, 10), 3)), ["2026-06-01 10:26", "2026-06-01 11:01", "2026-06-01 11:06"]);
  assert.deepEqual(fmts(nextRuns("*/30 * * * *", at(2026, 12, 31, 23, 45), 2)), ["2027-01-01 00:00", "2027-01-01 00:30"]);
});

test("nextRuns:跨月跳过没有 31 日的月份,跨年继续算", () => {
  assert.deepEqual(fmts(nextRuns("30 23 31 * *", at(2026, 11, 15), 4)), ["2026-12-31 23:30", "2027-01-31 23:30", "2027-03-31 23:30", "2027-05-31 23:30"]);
  assert.deepEqual(fmts(nextRuns("0 8 1 jan,jul *", at(2026, 11, 8), 2)), ["2027-01-01 08:00", "2027-07-01 08:00"]);
});

test("nextRuns:闰年 2/29,跨 2100(不是闰年)也找得到", () => {
  assert.deepEqual(fmts(nextRuns("0 0 29 2 *", at(2026, 3, 1), 2)), ["2028-02-29 00:00", "2032-02-29 00:00"]);
  assert.deepEqual(fmts(nextRuns("0 0 29 2 *", at(2097, 1, 1), 1)), ["2104-02-29 00:00"]);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2100, 2), 28);
});

test("nextRuns:日和周都受限按「或」,有一段以 * 开头按「且」(Vixie)", () => {
  // 2026-11-01 是周日;13 号或周五:11/13 两者都是,12/13 是周日只因日命中
  assert.deepEqual(fmts(nextRuns("0 12 13 * 5", at(2026, 11, 1), 7)), [
    "2026-11-06 12:00", "2026-11-13 12:00", "2026-11-20 12:00", "2026-11-27 12:00",
    "2026-12-04 12:00", "2026-12-11 12:00", "2026-12-13 12:00",
  ]);
  // */2 以 * 开头 → 单数日且周五:11/13、11/27、12/11
  assert.deepEqual(fmts(nextRuns("0 12 */2 * 5", at(2026, 11, 1), 3)), ["2026-11-13 12:00", "2026-11-27 12:00", "2026-12-11 12:00"]);
  // 只限周:工作日
  assert.deepEqual(fmts(nextRuns("0 9 * * 1-5", at(2026, 11, 6, 10), 3)), ["2026-11-09 09:00", "2026-11-10 09:00", "2026-11-11 09:00"]);
});

test("nextRuns:不合法或永远不会触发的表达式返回空,不会死循环", () => {
  // 对照:同一个起点,合法表达式照常给结果
  assert.deepEqual(fmts(nextRuns("0 9 * * *", at(2026, 1, 1), 1)), ["2026-01-01 09:00"]);
  assert.deepEqual(nextRuns("0 25 * * *", at(2026, 1, 1), 3), []);
  assert.deepEqual(nextRuns("0 0 30 2 *", at(2026, 1, 1), 3), []);
  assert.deepEqual(nextRuns("0 9 * * *", new Date(Number.NaN), 3), []);
});

test("nextRuns:夏令时跳过的时刻不存在,跳到下一天", () => {
  const tz = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    // 2026-03-08 凌晨 2 点直接跳到 3 点,02:30 不存在
    assert.deepEqual(fmts(nextRuns("30 2 * * *", at(2026, 3, 7, 3), 2)), ["2026-03-09 02:30", "2026-03-10 02:30"]);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test("describeCron:常见写法给中文人话", () => {
  assert.equal(describeCron("0 9 * * *"), "每天 09:00");
  assert.equal(describeCron("0 9 * * 1-5"), "工作日 09:00");
  assert.equal(describeCron("0 10 * * 1"), "每周一 10:00");
  assert.equal(describeCron("0 10 * * mon"), "每周一 10:00");
  assert.equal(describeCron("0 9 * * 0,6"), "周末 09:00");
  assert.equal(describeCron("30 18 * * 1,3,5"), "每周一、三、五 18:30");
  assert.equal(describeCron("0 9 * * 2-4"), "每周二至周四 09:00");
  assert.equal(describeCron("*/30 * * * *"), "每 30 分钟");
  assert.equal(describeCron("7 * * * *"), "每小时第 7 分");
  assert.equal(describeCron("0 * * * *"), "每小时整点");
  assert.equal(describeCron("0 */2 * * *"), "每 2 小时整点");
  assert.equal(describeCron("* * * * *"), "每分钟");
  assert.equal(describeCron("0 9,14 * * 1-5"), "工作日 09:00、14:00");
  assert.equal(describeCron("*/30 9-18 * * 1-5"), "工作日 9–18 点每 30 分钟");
  assert.equal(describeCron("0 8 1 * *"), "每月 1 日 08:00");
  assert.equal(describeCron("0 8 1 1 *"), "每年 1 月 1 日 08:00");
  assert.equal(describeCron("0 9 1,15 * 1"), "每月 1、15 日或每周一 09:00");
});

test("describeCron:复杂的退化成逐段说明,不合法返回空串", () => {
  assert.equal(describeCron("5 4 1-5 1,7 *"), "逐段：分 5 · 时 4 · 日 1–5 · 月 1、7 · 周 任意");
  assert.equal(describeCron("0 12 */2 * 5"), "逐段：分 0 · 时 12 · 日 1、3、5、7、9、11、13、15、17、19、21、23、25、27、29、31 · 月 任意 · 周 周五");
  assert.equal(describeCron("0 25 * * *"), "");
});

test("预设:每个预设的表达式能认回自己,说明和标签一致;其余是自定义", () => {
  assert.deepEqual(CRON_PRESETS.map((p) => cronPresetId(p.expr)), ["daily-9", "weekdays-9", "monday-9", "hourly", "every-30m"]);
  assert.deepEqual(CRON_PRESETS.slice(0, 3).map((p) => describeCron(p.expr)), CRON_PRESETS.slice(0, 3).map((p) => p.label));
  assert.equal(describeCron(CRON_PRESETS[4]!.expr), CRON_PRESETS[4]!.label);
  assert.equal(cronPresetId(" 0  9 * *  1-5"), "weekdays-9");
  assert.equal(cronPresetId("0 9 * * MON"), "custom");
  assert.equal(cronPresetId("0 25 * * *"), "custom");
});

test("本地日期时间:解析与格式互逆,不存在的日期返回 null", () => {
  const d = parseLocalDateTime("2026-11-10T09:05");
  assert.ok(d);
  assert.equal(fmt(d), "2026-11-10 09:05");
  assert.equal(toLocalDateTime(at(2027, 1, 4, 23, 59)), "2027-01-04T23:59");
  assert.equal(parseLocalDateTime("2026-02-30T09:00"), null);
  assert.equal(parseLocalDateTime("2026-11-10 09:00"), null);
  assert.equal(parseLocalDateTime("2026-11-10T24:00"), null);
});

test("triggerError:四种叫醒方式各自的保存前校验", () => {
  const now = at(2026, 11, 9, 8, 30);
  assert.equal(triggerError({ kind: "cron", expr: "0 9 * * 1-5" }, now), null);
  assert.equal(triggerError({ kind: "cron", expr: "0 25 * * *" }, now), "第 2 段（时）：25 超出 0–23");
  assert.equal(triggerError({ kind: "once", at: "2026-11-09T09:00" }, now), null);
  assert.equal(triggerError({ kind: "once", at: "2026-11-09T08:30" }, now), "这个时间已经过去了");
  assert.equal(triggerError({ kind: "once", at: "" }, now), "选一个具体的日期和时间");
  assert.equal(triggerError({ kind: "messages", n: 30, seen: 0 }, now), null);
  assert.equal(triggerError({ kind: "messages", n: 0, seen: 0 }, now), "条数要是 1 到 1000 的整数");
  assert.equal(triggerError({ kind: "messages", n: 2.5, seen: 0 }, now), "条数要是 1 到 1000 的整数");
  assert.equal(triggerError({ kind: "event", source: "p-cve", cond: "命中本项目依赖" }, now), null);
  assert.equal(triggerError({ kind: "event", source: "", cond: "命中" }, now), "选一个插件来源");
  assert.equal(triggerError({ kind: "event", source: "p-cve", cond: "  " }, now), "写清楚发生什么事才叫醒它");
});

test("triggerNext / messagesLeft:按钟点的给下次时刻,按条数的给还差几条", () => {
  const now = at(2026, 11, 9, 8, 30);
  assert.equal(fmt(triggerNext({ kind: "cron", expr: "0 9 * * 1-5" }, now)!), "2026-11-09 09:00");
  assert.equal(fmt(triggerNext({ kind: "once", at: "2026-11-12T20:00" }, now)!), "2026-11-12 20:00");
  assert.equal(triggerNext({ kind: "once", at: "2026-11-01T20:00" }, now), null);
  assert.equal(triggerNext({ kind: "messages", n: 30, seen: 18 }, now), null);
  assert.equal(triggerNext({ kind: "event", source: "p-cve", cond: "x" }, now), null);
  assert.equal(messagesLeft({ kind: "messages", n: 30, seen: 18 }), 12);
  assert.equal(messagesLeft({ kind: "messages", n: 30, seen: 31 }), 0);
  assert.equal(messagesLeft({ kind: "cron", expr: "0 9 * * *" }), 0);
});

test("describeTrigger:一句话说清怎么叫醒,不依赖现在", () => {
  assert.equal(describeTrigger({ kind: "cron", expr: "0 9 * * 1-5" }), "工作日 09:00");
  assert.equal(describeTrigger({ kind: "cron", expr: "0 25 * * *" }), "0 25 * * *");
  assert.equal(describeTrigger({ kind: "once", at: "2026-11-12T20:00" }), "只跑一次：2026-11-12 20:00");
  assert.equal(describeTrigger({ kind: "messages", n: 30, seen: 3 }), "每 30 条消息");
  assert.equal(describeTrigger({ kind: "event", source: "p-cve", cond: "出现严重级 CVE" }), "当出现严重级 CVE");
});

test("formatRunAt:相对现在写今天 / 明天 / 昨天 / 周几 / 月日 / 年月日", () => {
  const now = at(2026, 11, 9, 8, 30); // 周一
  assert.equal(formatRunAt(at(2026, 11, 9, 9, 0), now), "今天 09:00");
  assert.equal(formatRunAt(at(2026, 11, 10, 9, 0), now), "明天 09:00");
  assert.equal(formatRunAt(at(2026, 11, 8, 8, 0), now), "昨天 08:00");
  assert.equal(formatRunAt(at(2026, 11, 12, 9, 0), now), "周四 09:00");
  assert.equal(formatRunAt(at(2026, 11, 5, 10, 12), now), "周四 10:12");
  assert.equal(formatRunAt(at(2026, 11, 19, 9, 0), now), "11/19 09:00");
  assert.equal(formatRunAt(at(2027, 1, 4, 9, 0), now), "2027/1/4 09:00");
  // 跨年的明天
  assert.equal(formatRunAt(at(2027, 1, 1, 0, 0), at(2026, 12, 31, 23, 45)), "明天 00:00");
});

test("时区说明:UTC 偏移写法,本地时区名 + 当时的偏移(夏令时随日期变)", () => {
  assert.equal(utcOffsetLabel(480), "UTC+8");
  assert.equal(utcOffsetLabel(-300), "UTC-5");
  assert.equal(utcOffsetLabel(330), "UTC+5:30");
  assert.equal(utcOffsetLabel(-210), "UTC-3:30");
  assert.equal(utcOffsetLabel(0), "UTC");
  const tz = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    assert.equal(localZoneLabel(at(2026, 7, 1, 12), "America/New_York"), "America/New_York · UTC-4");
    assert.equal(localZoneLabel(at(2026, 1, 15, 12), "America/New_York"), "America/New_York · UTC-5");
    process.env.TZ = "Asia/Shanghai";
    assert.equal(localZoneLabel(at(2026, 11, 9, 8, 30), "Asia/Shanghai"), "Asia/Shanghai · UTC+8");
    assert.equal(localZoneLabel(at(2026, 11, 9, 8, 30), ""), "UTC+8");
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});
