// 找旧消息的纯规则(T-177 G4;需求 D06 §3「粗筛自动、精筛内置」;实施方案 §6、§8 G4-01～03;审查条件 G1-a、G4-a、G4-b):
// 消息版本与可见状态怎么从日志投影出来、预取怎么挑(过最小分、断崖前、最多 3 条)、回读邻域怎么按回读预算截与续读。
import assert from "node:assert/strict";
import { test } from "node:test";
import { append, emptyLog, type Log } from "@g-group/domain";
import { HISTORY_NEIGHBORS_MAX, type HistoryLine, historyDocs, historyLines, historyWindow, PREFETCH_MAX, pickPrefetch, renderHistoryWindow, renderPrefetch } from "./history-tools.ts";

const AT = "2026-11-11T08:00:00.000Z";
const U = { kind: "user", id: "me" };
const C = { kind: "contact", id: "c1" };
function log(steps: readonly (["m", typeof U | typeof C, string] | ["e", number, string] | ["r", number])[]): Log {
  let l = emptyLog();
  for (const s of steps) {
    if (s[0] === "m") l = append(l, s[1], { kind: "message", text: s[2] }, AT);
    else if (s[0] === "e") l = append(l, U, { kind: "edit", target: s[1], text: s[2] }, AT);
    else l = append(l, U, { kind: "retract", target: s[1] }, AT);
  }
  return l;
}
const room = (n: number, text: (i: number) => string): HistoryLine[] =>
  Array.from({ length: n }, (_, i) => ({ roomId: "g1", seq: i + 1, revision: i + 1, sender: U, at: AT, text: text(i + 1), state: "ok" as const }));

test("消息版本是作用到它的最后一个编辑或撤回事件的 seq,没有就是消息自己的 seq;撤回的、宿主判为看不见的不带正文,交给检索的文档只收可读的最新版本", () => {
  // 1 甲;2 乙;3 编辑 1;4 丙;5 编辑 1;6 撤回 2;7 丁(宿主判看不见);8 联系人发的
  const l = log([["m", U, "甲原稿"], ["m", U, "NEUTRAL_FIXTURE_NO_CREDENTIALS 乙"], ["e", 1, "甲第一次改"], ["m", U, "丙"], ["e", 1, "甲第二次改"], ["r", 2], ["m", U, "NEUTRAL_FIXTURE_NO_CREDENTIALS 丁"], ["m", C, "联系人的话"]]);
  const lines = historyLines("dm1", l.events, (seq) => seq === 7);
  assert.deepEqual(
    lines.map((x) => [x.seq, x.revision, x.state, x.text]),
    [
      [1, 5, "ok", "甲第二次改"],
      [2, 6, "retracted", ""],
      [4, 4, "ok", "丙"],
      [7, 7, "hidden", ""],
      [8, 8, "ok", "联系人的话"],
    ],
  );
  assert.deepEqual(historyDocs(lines), [
    { ref: "dm1#1", role: "user", text: "甲第二次改" },
    { ref: "dm1#4", role: "user", text: "丙" },
    { ref: "dm1#8", role: "assistant", text: "联系人的话" },
  ]);
});

test("预取挑选:每条新消息的命中先过最小分、切在断崖前,再按名次轮流合并,同一条只收一次,最多 3 条;指针只给一行预览", () => {
  const h = (ref: string, score: number) => ({ ref, score, preview: "" });
  // 第一条新消息:9、8.5、8 之后断崖到 1;第二条:两个 7 同分没有断崖,0.2 不过最小分;第三条全在最小分以下
  const per = [[h("g#1", 9), h("g#2", 8.5), h("g#3", 8), h("g#4", 1)], [h("g#2", 7), h("g#5", 7), h("g#6", 0.2)], [h("g#7", 0.4)]];
  assert.deepEqual(pickPrefetch(per, { minScore: 0.5, max: PREFETCH_MAX }).map((x) => x.ref), ["g#1", "g#2", "g#5"]);
  assert.deepEqual(pickPrefetch(per, { minScore: 0.5, max: 10 }).map((x) => x.ref), ["g#1", "g#2", "g#5", "g#3"], "去重后第 2 名轮完再轮第 3 名;断崖后的不收");
  assert.deepEqual(pickPrefetch([[h("g#8", 3), h("g#9", 3), h("g#10", 3), h("g#11", 3), h("g#12", 3)]], { minScore: 0, max: PREFETCH_MAX }).map((x) => x.ref), ["g#8", "g#9", "g#10"], "同分没有断崖:按检索次序取满 3 条");
  assert.deepEqual(pickPrefetch(per, { minScore: 10, max: PREFETCH_MAX }), [], "都不过最小分就没有");
  const long = room(1, () => `部署\n端口  ${"长".repeat(100)}`);
  assert.equal(renderPrefetch(long, () => "我"), `g1 #1 · 我 · ${AT} · 部署 端口 ${"长".repeat(74)}…`);
});

test("回读邻域:前后各自最多 20 条;正文按回读预算从近到远装,装不下的一侧停下并给续读位置;中心太长只给前一段", () => {
  const lines = room(60, (i) => `${String(i).padStart(3, "0")}${"。".repeat(9)}`);
  const wide = historyWindow(lines, 30, 1000, 1000, 1_000_000)!;
  assert.deepEqual([wide.lines[0]!.seq, wide.lines.at(-1)!.seq, wide.lines.length], [30 - HISTORY_NEIGHBORS_MAX, 30 + HISTORY_NEIGHBORS_MAX, 2 * HISTORY_NEIGHBORS_MAX + 1]);
  assert.deepEqual([wide.moreBefore, wide.moreAfter], [null, null]);
  // 每条 30 字节:预算 100 装得下中心 + 前后各 1 条(90),第 4 条就超
  const tight = historyWindow(lines, 30, 3, 2, 100)!;
  assert.deepEqual(tight.lines.map((x) => x.seq), [29, 30, 31]);
  assert.deepEqual([tight.moreBefore, tight.moreAfter], [{ seq: 28, count: 2 }, { seq: 32, count: 1 }]);
  const next = historyWindow(lines, tight.moreBefore!.seq, tight.moreBefore!.count - 1, 0, 100)!;
  assert.deepEqual(next.lines.map((x) => x.seq), [27, 28], "按续读位置接着读,正好补上更早的两条");
  const text = renderHistoryWindow(tight, (s) => (s.id === "me" ? "我" : s.id));
  assert.match(text, /^〔g1 #29〕我 · 2026-11-11T08:00:00\.000Z · 版本 29\n029。。。。。。。。。\n/);
  assert.match(text, /\n\(回读预算用完,更早的还有 2 条没给;续读位置 roomId=g1 seq=28 before=1 after=0\)\n\(回读预算用完,更晚的还有 1 条没给;续读位置 roomId=g1 seq=32 before=0 after=0\)$/);
  const long = historyWindow(room(3, (i) => (i === 2 ? "长".repeat(50) : "短")), 2, 1, 1, 30)!;
  assert.deepEqual([long.lines.map((x) => x.seq), long.lines[0]!.text, long.anchorCut], [[2], "长".repeat(10), { shown: 30, total: 150 }]);
  assert.match(renderHistoryWindow(long, () => "我"), /版本 2\(超过回读预算,只给前 30\/150 字节\)\n(长){10}\n\(回读预算用完,更早的还有 1 条没给;续读位置 roomId=g1 seq=1 before=0 after=0\)\n/);
  assert.equal(historyWindow(lines, 999, 1, 1, 100), null, "没有这条返回 null");
});
