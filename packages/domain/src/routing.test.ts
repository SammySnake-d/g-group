// AC-18 少问与少错同时成立:回放报两个数(追问次数、挂错且未纠正条数);P0 只验两个数都能测出来,阈值是参数。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type RoutePolicy, type RoutingRecord, judgeRouting, misattachedOf, routeFollowUp, routingReport } from "./routing.ts";

// 回放 #1728:同一联系人同时做「快捷键」(K)和「PR#3 审查」(R);每条补充标注了正确归属,guess 是模型凭内容的猜测
const CORPUS = [
  { msgKey: "g#1", anchorTaskId: null, liveTaskIds: ["K"], guess: "K", truth: "K" },
  { msgKey: "g#2", anchorTaskId: "R", liveTaskIds: ["K", "R"], guess: "R", truth: "R" },
  { msgKey: "g#3", anchorTaskId: null, liveTaskIds: ["K", "R"], guess: "K", truth: "R" }, // "再看一遍变异":实际是审查的补充
  { msgKey: "g#4", anchorTaskId: null, liveTaskIds: ["K", "R"], guess: "K", truth: "K" },
  { msgKey: "g#5", anchorTaskId: null, liveTaskIds: [], guess: null, truth: null },
] as const;
const replay = (policy: RoutePolicy): RoutingRecord[] =>
  CORPUS.map((c) => ({ msgKey: c.msgKey, decision: routeFollowUp(c, policy), truth: c.truth, corrected: false }));

test("AC-18 路由兜底:有引用锚点直达,只有一件在途直通,两件以上没锚点时追问", () => {
  assert.deepEqual(routeFollowUp({ anchorTaskId: "R", liveTaskIds: ["K", "R"], guess: "K" }, "ask-when-ambiguous"), { kind: "attach", taskId: "R" });
  assert.deepEqual(routeFollowUp({ anchorTaskId: null, liveTaskIds: ["K"], guess: null }, "ask-when-ambiguous"), { kind: "attach", taskId: "K" });
  assert.deepEqual(routeFollowUp({ anchorTaskId: null, liveTaskIds: ["K", "R"], guess: "R" }, "ask-when-ambiguous"), { kind: "ask", candidates: ["K", "R"] });
  assert.deepEqual(routeFollowUp({ anchorTaskId: null, liveTaskIds: ["K", "R"], guess: "R" }, "never-ask"), { kind: "attach", taskId: "R" });
  assert.deepEqual(routeFollowUp({ anchorTaskId: null, liveTaskIds: [], guess: null }, "never-ask"), { kind: "none" });
  assert.deepEqual(routeFollowUp({ anchorTaskId: "X", liveTaskIds: ["K"], guess: null }, "never-ask"), { kind: "attach", taskId: "K" });
});

test("AC-18 两个数都能测出来:追问次数、挂错且无人纠正条数", () => {
  const ask = routingReport(replay("ask-when-ambiguous"));
  assert.deepEqual({ ...ask }, { total: 5, clarifyAsks: 2, misattached: 0, misattachedUncorrected: 0 });
  const never = routingReport(replay("never-ask"));
  assert.deepEqual({ ...never }, { total: 5, clarifyAsks: 0, misattached: 1, misattachedUncorrected: 1 });
});

test("AC-18 改成「永不问」→ 未纠正挂错数上升,按阈值判红;纠正过的挂错不计入未纠正", () => {
  const thresholds = { maxMisattachedUncorrected: 0 };
  assert.equal(judgeRouting(routingReport(replay("ask-when-ambiguous")), thresholds).pass, true);
  const never = judgeRouting(routingReport(replay("never-ask")), thresholds);
  assert.equal(never.pass, false);
  assert.match(never.violations[0]!, /挂错且未纠正 1 条/);
  const corrected = replay("never-ask").map((r) => (r.msgKey === "g#3" ? { ...r, corrected: true } : r));
  const rep = routingReport(corrected);
  assert.equal(rep.misattached, 1);
  assert.equal(rep.misattachedUncorrected, 0);
});

test("AC-18 阈值待定:不给阈值只报不判;追问阈值同样可配", () => {
  const rep = routingReport(replay("ask-when-ambiguous"));
  assert.equal(rep.misattachedUncorrected, 0);
  assert.equal(judgeRouting(rep).pass, true);
  assert.equal(judgeRouting(rep, { maxMisattachedUncorrected: 0 }).pass, true);
  const strict = judgeRouting(rep, { maxClarifyAsks: 1 });
  assert.equal(strict.pass, false);
  assert.match(strict.violations[0]!, /追问 2 次/);
});

test("AC-18 单条挂错判定:挂到别的任务、该挂没挂算挂错;挂对、闲聊没挂、问过的不算", () => {
  assert.equal(misattachedOf({ kind: "attach", taskId: "K" }, "R"), true);
  assert.equal(misattachedOf({ kind: "none" }, "K"), true);
  assert.equal(misattachedOf({ kind: "attach", taskId: "R" }, "R"), false);
  assert.equal(misattachedOf({ kind: "none" }, null), false);
  assert.equal(misattachedOf({ kind: "ask", candidates: ["K", "R"] }, "R"), false);
});

test("AC-18 该挂没挂也算挂错;回放里重复的消息被拒", () => {
  const rep = routingReport([{ msgKey: "g#9", decision: { kind: "none" }, truth: "K", corrected: false }]);
  assert.equal(rep.misattachedUncorrected, 1);
  assert.throws(() => routingReport([...replay("never-ask"), replay("never-ask")[0]!]), /重复/);
});
