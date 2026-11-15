// AC-43 运行台账的纯逻辑(需求文档 D26 第 3–5 节、第 8.3/8.5/8.6 节):
//   ① 五类单元与固定状态集合,failed/interrupted 必带原因类别与原文;② 孤儿识别(宿主启动号 / 进程存活);③ 父子一致;
//   ④ 可见范围(私聊只看自己在这个私聊的、群里看本群全部、别处不返回、用户全看);⑤ 重跑规则(#2628,上限是参数);
//   ⑦ 卡死判失败(真实事件才算进展;重试公告、心跳、存活不刷新;合法等待不计时;默认 15 分钟 / 120 秒,可按联系人或上游单独设);
//   ⑨ 画板展示(人停的与失败不同)与同一上游同一原因的合并键。宿主落盘与接线在 server 包。
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFailure } from "./failure-class.ts";
import {
  DEFAULT_RERUN_LIMIT,
  DEFAULT_STALL_THRESHOLDS,
  type RunUnit,
  childrenOf,
  failFastOf,
  failureGroups,
  newRun,
  noteActivity,
  planRerun,
  reconcileOrphans,
  resolveThresholds,
  RUN_LAYERS,
  RUN_STATUSES,
  runDisplay,
  runFailure,
  setStatus,
  stallCheck,
  visibleRuns,
} from "./run-ledger.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-09T02:00:00Z");
const base = { roomId: "g1", sourceSeq: 3, contactId: "c1", bootId: "boot-1", at: T0 };
const short = resolveThresholds({ defaults: { stallMs: 10 * MIN, firstByteMs: 60_000 } }, "c1", null);

/** 应用一次状态变化,把变化写回列表(测试里模拟宿主落盘) */
function apply(units: RunUnit[], id: string, to: RunUnit["status"], at: number, extra?: Parameters<typeof setStatus>[4]) {
  const r = setStatus(units, id, to, at, extra);
  if (!r.ok) return r;
  for (const c of r.changed) units.splice(units.findIndex((u) => u.id === c.id), 1, c);
  return r;
}
const stalledFailure = () => runFailure(classifyFailure({ text: "x", stall: "stalled" }));

test("状态集合固定为七种、单元四层五类;新单元带来源、父单元、属于谁和宿主启动号", () => {
  assert.deepEqual([...RUN_STATUSES], ["queued", "running", "waiting_user", "done", "failed", "interrupted", "orphaned"]);
  assert.deepEqual([...RUN_LAYERS], ["contact-round", "compute-session", "compute-turn", "background", "subagent"]);
  assert.ok(Object.isFrozen(RUN_STATUSES) && Object.isFrozen(RUN_LAYERS));
  const u = newRun({ ...base, id: "r1", layer: "contact-round", parentId: null });
  assert.deepEqual([u.status, u.roomId, u.sourceSeq, u.contactId, u.parentId, u.bootId, u.progress.lastProgressAt, u.failure], ["running", "g1", 3, "c1", null, "boot-1", T0, null]);
  assert.throws(() => newRun({ ...base, id: "r2", layer: "nope" as never, parentId: null }), RangeError);
  assert.throws(() => newRun({ ...base, id: "", layer: "contact-round", parentId: null }), RangeError);
  assert.throws(() => newRun({ ...base, id: "r3", layer: "contact-round", parentId: null, contactId: "" }), RangeError);
});

test("failed / interrupted 必须带原因类别与原文;orphaned 必须写明原因;终态不能再改", () => {
  const units = [newRun({ ...base, id: "r1", layer: "compute-turn", parentId: null })];
  assert.deepEqual(setStatus(units, "r1", "failed", T0 + 1), { ok: false, reason: "failure-required" });
  assert.deepEqual(setStatus(units, "r1", "interrupted", T0 + 1), { ok: false, reason: "failure-required" });
  assert.deepEqual(setStatus(units, "r1", "orphaned", T0 + 1), { ok: false, reason: "note-required" });
  assert.deepEqual(setStatus(units, "nope", "done", T0 + 1), { ok: false, reason: "not-found" });
  const f = runFailure(classifyFailure({ text: "API Error: 503 upstream connect error" }));
  const r = apply(units, "r1", "failed", T0 + 5 * MIN, { failure: f });
  assert.ok(r.ok);
  assert.equal(units[0]!.status, "failed");
  assert.deepEqual([units[0]!.failure?.reasonClass, units[0]!.failure?.raw, units[0]!.failure?.retryClass], ["upstream_unavailable", "API Error: 503 upstream connect error", "Transient"]);
  assert.equal(units[0]!.endedAt, T0 + 5 * MIN);
  assert.deepEqual(setStatus(units, "r1", "running", T0 + 6 * MIN), { ok: false, reason: "terminal" });
  assert.deepEqual(setStatus(units, "r1", "done", T0 + 6 * MIN), { ok: false, reason: "terminal" });
});

test("父子一致:子单元在跑时父单元不能记 done;子单元都结束后父单元才能 done(AC-43 ③)", () => {
  const units = [
    newRun({ ...base, id: "s", layer: "compute-session", parentId: null }),
    newRun({ ...base, id: "t", layer: "compute-turn", parentId: "s" }),
    newRun({ ...base, id: "bg", layer: "background", parentId: "t" }),
  ];
  assert.deepEqual(setStatus(units, "s", "done", T0 + 1), { ok: false, reason: "children-running" });
  assert.deepEqual(setStatus(units, "t", "done", T0 + 1), { ok: false, reason: "children-running" }, "孙单元在跑也算");
  assert.ok(apply(units, "bg", "done", T0 + 2).ok);
  assert.ok(apply(units, "t", "done", T0 + 3).ok);
  assert.ok(apply(units, "s", "done", T0 + 4).ok);
  assert.deepEqual(units.map((u) => u.status), ["done", "done", "done"]);
  assert.deepEqual(childrenOf(units, "s").map((u) => u.id), ["t"]);
});

test("父单元失败或中断时,还在跑的子单元一起标 orphaned 并写明原因,不留「运行中」", () => {
  const units = [
    newRun({ ...base, id: "s", layer: "compute-session", parentId: null }),
    newRun({ ...base, id: "t", layer: "compute-turn", parentId: "s" }),
    newRun({ ...base, id: "sub", layer: "subagent", parentId: "t" }),
    newRun({ ...base, id: "done-bg", layer: "background", parentId: "t" }),
  ];
  assert.ok(apply(units, "done-bg", "done", T0 + 1).ok);
  const r = apply(units, "s", "failed", T0 + 2, { failure: stalledFailure() });
  assert.ok(r.ok);
  assert.deepEqual(units.map((u) => [u.id, u.status]), [["s", "failed"], ["t", "orphaned"], ["sub", "orphaned"], ["done-bg", "done"]]);
  assert.match(units[1]!.note ?? "", /父单元已结束/);
  assert.equal(units.filter((u) => u.status === "running").length, 0);
});

test("重放 2430 号:一个会话带 3 个后台任务,宿主进程退出后重启,一个核对周期内全部变 orphaned,原因「宿主进程退出」(AC-43 ①②)", () => {
  const units = [
    newRun({ ...base, id: "round", layer: "contact-round", parentId: null }),
    newRun({ ...base, id: "s", layer: "compute-session", parentId: "round", pid: 4242 }),
    newRun({ ...base, id: "t", layer: "compute-turn", parentId: "s", pid: 4242 }),
    newRun({ ...base, id: "b1", layer: "background", parentId: "t" }),
    newRun({ ...base, id: "b2", layer: "background", parentId: "t" }),
    newRun({ ...base, id: "b3", layer: "subagent", parentId: "t" }),
  ];
  const changed = reconcileOrphans(units, { bootId: "boot-2", at: T0 + 3 * MIN, alive: () => true });
  assert.equal(changed.length, 6);
  assert.ok(changed.every((u) => u.status === "orphaned" && u.note === "宿主进程退出" && u.endedAt === T0 + 3 * MIN));
  assert.equal(changed.filter((u) => u.status === "running").length, 0);
});

test("同一启动里进程已不在的 running 单元变 orphaned;进程活着、已结束的单元、等人回答的单元不受影响;不杀进程时无误报", () => {
  const live = newRun({ ...base, id: "live", layer: "compute-turn", parentId: null, pid: 1 });
  const dead = newRun({ ...base, id: "dead", layer: "compute-turn", parentId: null, pid: 2 });
  const fin = setStatus([newRun({ ...base, id: "fin", layer: "compute-turn", parentId: null, pid: 2 })], "fin", "done", T0 + 1);
  assert.ok(fin.ok);
  const units = [live, dead, fin.changed[0]!];
  const changed = reconcileOrphans(units, { bootId: "boot-1", at: T0 + MIN, alive: (pid) => pid === 1 });
  assert.deepEqual(changed.map((u) => [u.id, u.status, u.note]), [["dead", "orphaned", "执行进程已不在"]]);
  // 同一夹具不杀进程:全部正常结束为 done,核对不产生 orphaned
  const ok = [newRun({ ...base, id: "a", layer: "contact-round", parentId: null }), newRun({ ...base, id: "b", layer: "compute-turn", parentId: "a", pid: 7 })];
  assert.ok(apply(ok, "b", "done", T0 + 1).ok && apply(ok, "a", "done", T0 + 2).ok);
  assert.deepEqual(reconcileOrphans(ok, { bootId: "boot-2", at: T0 + MIN, alive: () => false }), []);
});

test("同一启动里执行进程已不在的会话成孤儿时,还在跑的子孙一并成孤儿,写明是父单元结束(AC-43 ①③)", () => {
  const units = [
    newRun({ ...base, id: "s", layer: "compute-session", parentId: null, pid: 9 }),
    newRun({ ...base, id: "t", layer: "compute-turn", parentId: "s" }),
    newRun({ ...base, id: "bg", layer: "background", parentId: "t" }),
    newRun({ ...base, id: "other", layer: "compute-turn", parentId: null }),
  ];
  const changed = reconcileOrphans(units, { bootId: "boot-1", at: T0 + MIN, alive: () => false });
  assert.deepEqual(
    changed.map((u) => [u.id, u.status, u.note, u.endedAt]),
    [
      ["s", "orphaned", "执行进程已不在", T0 + MIN],
      ["t", "orphaned", "父单元已结束(orphaned)", T0 + MIN],
      ["bg", "orphaned", "父单元已结束(orphaned)", T0 + MIN],
    ],
  );
});

test("默认阈值是 15 分钟 / 120 秒;按联系人、按上游单独设都生效,没设的用默认,两边都设取更宽的,并记下按哪个判(AC-43 ⑯)", () => {
  assert.deepEqual({ ...DEFAULT_STALL_THRESHOLDS }, { stallMs: 15 * MIN, firstByteMs: 120_000 });
  assert.ok(Object.isFrozen(DEFAULT_STALL_THRESHOLDS));
  const d = resolveThresholds({}, "c1", "gw/model-a");
  assert.deepEqual([d.stallMs, d.firstByteMs, d.source.stallMs, d.source.firstByteMs], [15 * MIN, 120_000, "default", "default"]);
  const cfg = { byContact: { c1: { stallMs: 30 * MIN } }, byUpstream: { "gw/model-a": { firstByteMs: 300_000 }, "gw/model-b": { stallMs: 40 * MIN } } };
  const c = resolveThresholds(cfg, "c1", "gw/model-a");
  assert.deepEqual([c.stallMs, c.source.stallMs, c.firstByteMs, c.source.firstByteMs], [30 * MIN, "contact", 300_000, "upstream"]);
  const both = resolveThresholds(cfg, "c1", "gw/model-b");
  assert.deepEqual([both.stallMs, both.source.stallMs], [40 * MIN, "upstream"]);
  const other = resolveThresholds(cfg, "c2", "gw/model-z");
  assert.deepEqual([other.stallMs, other.firstByteMs, other.source.stallMs], [15 * MIN, 120_000, "default"]);
  // 不合法的单独设置不生效,回到默认
  const bad = resolveThresholds({ byContact: { c1: { stallMs: -5, firstByteMs: Number.NaN } } }, "c1", null);
  assert.deepEqual([bad.stallMs, bad.firstByteMs], [15 * MIN, 120_000]);
  // 单独设的阈值真的用于判定:默认下 20 分钟会判失败,c1 设了 30 分钟就不判
  const u = newRun({ ...base, id: "r", layer: "compute-turn", parentId: null });
  assert.equal(stallCheck(u, T0 + 20 * MIN, d).verdict?.kind, "stalled");
  assert.equal(stallCheck(u, T0 + 20 * MIN, c).verdict, null);
});

test("卡死判失败:一轮无进展到阈值判 failed,带原因类别、原因原文、用时、最后进展时间、判定阈值与规则表版本(AC-43 ⑦)", () => {
  let u = newRun({ ...base, id: "r", layer: "compute-turn", parentId: null });
  u = noteActivity(u, { kind: "progress", what: "text" }, T0 + 2 * MIN);
  assert.equal(stallCheck(u, T0 + 11 * MIN, short).verdict, null, "离最后进展 9 分钟,未到 10 分钟阈值");
  const c = stallCheck(u, T0 + 12 * MIN, short);
  assert.ok(c.verdict);
  const v = c.verdict;
  assert.equal(v.kind, "stalled");
  assert.equal(v.failure.reasonClass, "stalled");
  assert.equal(v.failure.label, "卡住无进展");
  assert.match(v.failure.raw, /10 分钟/);
  assert.equal(v.durationMs, 12 * MIN);
  assert.equal(v.lastProgressAt, T0 + 2 * MIN);
  assert.equal(v.thresholdMs, 10 * MIN);
  assert.equal(v.thresholdSource, "default");
  assert.equal(v.judgedAt, T0 + 12 * MIN);
  assert.match(v.failure.rulesVersion, /^\d{4}-/);
  const units = [u];
  assert.ok(apply(units, "r", "failed", v.judgedAt, { failure: v.failure, verdict: v }).ok);
  assert.deepEqual([units[0]!.status, units[0]!.verdict?.thresholdMs], ["failed", 10 * MIN]);
  // 只对在跑的轮次计时:会话、后台任务本身不判卡死
  assert.equal(stallCheck(newRun({ ...base, id: "s", layer: "compute-session", parentId: null }), T0 + 60 * MIN, short).verdict, null);
});

test("重放断流重试:harness 每隔几秒报一次「正在重试」、心跳和进程存活都不刷新计时,到阈值判 stream_dropped(AC-43 ⑪)", () => {
  let u = newRun({ ...base, id: "r", layer: "compute-turn", parentId: null });
  u = noteActivity(u, { kind: "progress", what: "text" }, T0);
  u = noteActivity(u, { kind: "model_call" }, T0 + 1000);
  for (let t = T0 + 5000; t < T0 + 11 * MIN; t += 5000) {
    u = noteActivity(u, { kind: "retry", error: "API Error: 503 stream disconnected", httpStatus: 503 }, t);
    u = noteActivity(u, { kind: "heartbeat" }, t + 1);
    u = noteActivity(u, { kind: "alive" }, t + 2);
  }
  assert.equal(u.progress.lastProgressAt, T0, "重试公告、心跳、存活都不算进展");
  assert.ok(u.progress.retries > 100);
  const v = stallCheck(u, T0 + 11 * MIN, short).verdict;
  assert.equal(v?.kind, "stream_dropped");
  assert.equal(v?.failure.reasonClass, "stream_dropped");
  assert.match(v?.failure.raw ?? "", /重试/);
  assert.match(v?.failure.raw ?? "", /stream disconnected/, "最近一次重试的原文带上");
});

test("重放 2734 号上游无响应:调用发出后既不回应也不断开,超过首字节窗口判 no_response;窗口内不判(AC-43 ⑩)", () => {
  let u = newRun({ ...base, id: "r", layer: "compute-turn", parentId: null });
  u = noteActivity(u, { kind: "model_call" }, T0 + 1000);
  const inWindow = stallCheck(u, T0 + 50_000, short);
  assert.deepEqual([inWindow.verdict, inWindow.waiting], [null, "first_byte"]);
  const v = stallCheck(u, T0 + 61_000 + 1000, short).verdict;
  assert.equal(v?.kind, "no_response");
  assert.equal(v?.failure.reasonClass, "no_response");
  assert.equal(v?.thresholdMs, 60_000);
  assert.match(v?.failure.raw ?? "", /没有任何回应/);
  // 收到任何真实事件就离开首字节等待
  const replied = noteActivity(u, { kind: "progress", what: "thinking" }, T0 + 30_000);
  assert.equal(replied.progress.awaitingSince, null);
  assert.equal(stallCheck(replied, T0 + 5 * MIN, short).verdict, null);
});

test("合法等待不误判:等用户回答、工具子进程在跑、休眠唤醒宽限期内都不计时;等待结束后从结束时刻重新计时(AC-43 ⑫)", () => {
  // 等人回答超过阈值
  const units = [newRun({ ...base, id: "r", layer: "compute-turn", parentId: null })];
  assert.ok(apply(units, "r", "waiting_user", T0 + MIN).ok);
  const w = stallCheck(units[0]!, T0 + 60 * MIN, short);
  assert.deepEqual([w.verdict, w.waiting], [null, "waiting_user"]);
  assert.ok(apply(units, "r", "running", T0 + 60 * MIN).ok);
  assert.equal(stallCheck(units[0]!, T0 + 65 * MIN, short).verdict, null, "回答后从回来那一刻重新计时");
  assert.equal(stallCheck(units[0]!, T0 + 71 * MIN, short).verdict?.kind, "stalled");
  // 一个工具子进程持续运行超过阈值
  let t = newRun({ ...base, id: "tool", layer: "compute-turn", parentId: null });
  t = noteActivity(t, { kind: "tool_start", toolId: "bash-1" }, T0 + MIN);
  const tw = stallCheck(t, T0 + 90 * MIN, short);
  assert.deepEqual([tw.verdict, tw.waiting], [null, "tool_running"]);
  t = noteActivity(t, { kind: "tool_end", toolId: "bash-1" }, T0 + 90 * MIN);
  assert.equal(stallCheck(t, T0 + 95 * MIN, short).verdict, null, "工具结束是真实进展");
  assert.equal(stallCheck(t, T0 + 101 * MIN, short).verdict?.kind, "stalled");
  // 合盖休眠:唤醒后的宽限期内不判,宽限期过后从唤醒时刻起算,真停滞照常检出
  const s = newRun({ ...base, id: "sleep", layer: "contact-round", parentId: null });
  const sleep = { awakeSince: T0 + 120 * MIN, graceMs: 3 * MIN };
  const sg = stallCheck(s, T0 + 121 * MIN, short, sleep);
  assert.deepEqual([sg.verdict, sg.waiting], [null, "sleep_grace"]);
  assert.equal(stallCheck(s, T0 + 125 * MIN, short, sleep).verdict, null);
  assert.equal(stallCheck(s, T0 + 131 * MIN, short, sleep).verdict?.kind, "stalled");
});

test("真实事件才算进展:文本、思考、工具开始/输出/结束、子代理事件刷新计时并清掉重试计数;工具按调用 id 计数", () => {
  let u = newRun({ ...base, id: "r", layer: "compute-turn", parentId: null });
  u = noteActivity(u, { kind: "retry", error: "503", httpStatus: 503 }, T0 + 1000);
  assert.equal(u.progress.retries, 1);
  for (const [i, what] of (["text", "thinking", "tool_output", "subagent", "semantic"] as const).entries()) {
    u = noteActivity(u, { kind: "progress", what }, T0 + (i + 2) * 1000);
    assert.equal(u.progress.lastProgressAt, T0 + (i + 2) * 1000, what);
  }
  assert.equal(u.progress.retries, 0);
  u = noteActivity(u, { kind: "tool_start", toolId: "a" }, T0 + 10_000);
  u = noteActivity(u, { kind: "tool_start", toolId: "b" }, T0 + 11_000);
  u = noteActivity(u, { kind: "tool_end", toolId: "a" }, T0 + 12_000);
  assert.deepEqual([...u.progress.toolsRunning], ["b"]);
  assert.equal(u.progress.lastProgressAt, T0 + 12_000);
  assert.ok(Object.isFrozen(u) && Object.isFrozen(u.progress));
  // 已结束的单元不再记活动
  const done = setStatus([u], "r", "failed", T0 + 13_000, { failure: stalledFailure() });
  assert.ok(done.ok);
  assert.equal(noteActivity(done.changed[0]!, { kind: "progress", what: "text" }, T0 + 99_000).progress.lastProgressAt, T0 + 12_000);
});

test("确定不会自愈的错误不等阈值:重试公告带 401 / 上下文超长,立即给出失败;普通 503 重试不立即判", () => {
  assert.equal(failFastOf({ kind: "retry", error: "API Error: 401 invalid x-api-key", httpStatus: 401 })?.reasonClass, "auth_or_quota");
  assert.equal(failFastOf({ kind: "retry", error: "Prompt is too long", httpStatus: 400 })?.reasonClass, "context_overflow");
  assert.equal(failFastOf({ kind: "retry", error: "API Error: 503", httpStatus: 503 }), null);
  assert.equal(failFastOf({ kind: "progress", what: "text" }), null);
});

test("可见范围:私聊只返回该联系人在这个私聊里的单元;群里返回本群全部成员在本群的单元;别的群、别人私聊不返回;用户本人全看(AC-43 ④)", () => {
  const units = [
    newRun({ ...base, id: "dm-own", layer: "contact-round", parentId: null, roomId: "dm-c1", contactId: "c1" }),
    newRun({ ...base, id: "dm-other", layer: "contact-round", parentId: null, roomId: "dm-c2", contactId: "c2" }),
    newRun({ ...base, id: "g1-own", layer: "compute-session", parentId: null, roomId: "g1", contactId: "c1" }),
    newRun({ ...base, id: "g1-c2", layer: "compute-session", parentId: null, roomId: "g1", contactId: "c2" }),
    newRun({ ...base, id: "g2-own", layer: "compute-session", parentId: null, roomId: "g2", contactId: "c1" }),
  ];
  const ids = (xs: readonly RunUnit[]) => xs.map((u) => u.id);
  assert.deepEqual(ids(visibleRuns(units, { kind: "contact", contactId: "c1", roomId: "dm-c1", roomKind: "dm" })), ["dm-own"], "私聊里查不到另一个群的任务");
  assert.deepEqual(ids(visibleRuns(units, { kind: "contact", contactId: "c1", roomId: "g1", roomKind: "group" })), ["g1-own", "g1-c2"]);
  assert.deepEqual(ids(visibleRuns(units, { kind: "contact", contactId: "c2", roomId: "g1", roomKind: "group" })), ["g1-own", "g1-c2"]);
  assert.deepEqual(ids(visibleRuns(units, { kind: "contact", contactId: "c2", roomId: "dm-c1", roomKind: "dm" })), [], "别人的私聊");
  assert.deepEqual(ids(visibleRuns(units, { kind: "user" })), ids(units));
});

test("重跑只接受 failed / interrupted / orphaned;无失败时没有可重跑项", () => {
  const ok = { at: T0 + MIN, initiator: { kind: "contact" as const, id: "c1" }, trigger: "auto" as const };
  const running = newRun({ ...base, id: "r", layer: "compute-session", parentId: null });
  assert.deepEqual(planRerun({ unit: running, autoReruns: 0, lease: null, sameUpstreamFailures: 0 }, ok), { ok: false, reason: "not-rerunnable", notDone: null });
  const done = setStatus([running], "r", "done", T0 + 1);
  assert.ok(done.ok);
  assert.equal(planRerun({ unit: done.changed[0]!, autoReruns: 0, lease: null, sameUpstreamFailures: 0 }, ok).ok, false);
  for (const [to, extra] of [["failed", { failure: stalledFailure() }], ["orphaned", { note: "宿主进程退出" }], ["interrupted", { failure: runFailure(classifyFailure({ text: "进程被信号 SIGTERM 结束" })) }]] as const) {
    const r = setStatus([running], "r", to, T0 + 2, extra);
    assert.ok(r.ok);
    const plan = planRerun({ unit: r.changed[0]!, autoReruns: 0, lease: null, sameUpstreamFailures: 0 }, ok);
    assert.equal(plan.ok, true, to);
  }
});

test("人停的拒绝重跑(自动和联系人明确发起都拒),用户本人这次明确要求才执行(AC-43 坏实现 ⑥)", () => {
  const stopped = setStatus([newRun({ ...base, id: "r", layer: "compute-session", parentId: null })], "r", "interrupted", T0 + 1, { failure: runFailure(classifyFailure({ text: "", userStopped: true })) });
  assert.ok(stopped.ok);
  const unit = stopped.changed[0]!;
  const ctx = { unit, autoReruns: 0, lease: null, sameUpstreamFailures: 0 };
  assert.deepEqual(planRerun(ctx, { at: T0 + 2, initiator: { kind: "contact", id: "c1" }, trigger: "auto" }), { ok: false, reason: "user-stopped", notDone: null });
  assert.equal(planRerun(ctx, { at: T0 + 2, initiator: { kind: "contact", id: "c1" }, trigger: "explicit" }).ok, false);
  const byUser = planRerun(ctx, { at: T0 + 2, initiator: { kind: "user", id: "me" }, trigger: "explicit" });
  assert.equal(byUser.ok, true);
});

test("重放 1663 号:cyber_policy 平台拒绝的会话重跑开新会话并带原任务引用,不在原会话继续;上下文超长、会话丢失同样(AC-43 坏实现 ⑤)", () => {
  for (const text of ["cyber_policy violation", "Prompt is too long · automatic compaction failed", "No conversation found with session ID: x"]) {
    const r = setStatus([newRun({ ...base, id: "r", layer: "compute-session", parentId: null, taskId: "t-9" })], "r", "failed", T0 + 1, { failure: runFailure(classifyFailure({ text })) });
    assert.ok(r.ok);
    const plan = planRerun({ unit: r.changed[0]!, autoReruns: 0, lease: null, sameUpstreamFailures: 0 }, { at: T0 + 2, initiator: { kind: "contact", id: "c1" }, trigger: "auto" });
    assert.ok(plan.ok, text);
    assert.equal(plan.mode, "new_session", text);
    assert.deepEqual([plan.event.basis.unitId, plan.event.basis.taskId, plan.event.basis.raw], ["r", "t-9", text]);
  }
  const ordinary = setStatus([newRun({ ...base, id: "r", layer: "compute-session", parentId: null })], "r", "failed", T0 + 1, { failure: stalledFailure() });
  assert.ok(ordinary.ok);
  const p = planRerun({ unit: ordinary.changed[0]!, autoReruns: 0, lease: null, sameUpstreamFailures: 0 }, { at: T0 + 2, initiator: { kind: "contact", id: "c1" }, trigger: "auto" });
  assert.ok(p.ok);
  assert.equal(p.mode, "same_session");
});

test("同一单元并发重跑只成功一个:租约在有效期内一律拒绝,过期后可以再领(AC-43 坏实现 ⑦)", () => {
  const r = setStatus([newRun({ ...base, id: "r", layer: "compute-session", parentId: null })], "r", "failed", T0 + 1, { failure: stalledFailure() });
  assert.ok(r.ok);
  const unit = r.changed[0]!;
  const first = planRerun({ unit, autoReruns: 0, lease: null, sameUpstreamFailures: 0 }, { at: T0 + 2, initiator: { kind: "contact", id: "c1" }, trigger: "auto" });
  assert.ok(first.ok);
  assert.equal(first.lease.holder, "c1");
  assert.ok(first.lease.until > T0 + 2);
  for (const who of ["c1", "c2"]) {
    const second = planRerun({ unit, autoReruns: 0, lease: first.lease, sameUpstreamFailures: 0 }, { at: T0 + 3, initiator: { kind: "contact", id: who }, trigger: "explicit" });
    assert.deepEqual(second, { ok: false, reason: "lease-held", notDone: null }, who);
  }
  const later = planRerun({ unit, autoReruns: 0, lease: first.lease, sameUpstreamFailures: 0 }, { at: first.lease.until + 1, initiator: { kind: "contact", id: "c2" }, trigger: "explicit" });
  assert.equal(later.ok, true);
});

test("自己名下自动重跑上限默认 2 次(参数可改),到上限报「未做:原因」;每次重跑都给出事件(谁发起、依据哪条失败、第几次)(AC-43 坏实现 ⑦c)", () => {
  assert.equal(DEFAULT_RERUN_LIMIT, 2);
  const r = setStatus([newRun({ ...base, id: "r", layer: "compute-session", parentId: null })], "r", "failed", T0 + 1, { failure: runFailure(classifyFailure({ text: "进程以 1 退出" })) });
  assert.ok(r.ok);
  const unit = r.changed[0]!;
  const req = { at: T0 + 2, initiator: { kind: "contact" as const, id: "c1" }, trigger: "auto" as const };
  for (const n of [0, 1]) {
    const p = planRerun({ unit, autoReruns: n, lease: null, sameUpstreamFailures: 0 }, req);
    assert.ok(p.ok);
    assert.equal(p.countsTowardLimit, true);
    assert.deepEqual([p.event.kind, p.event.initiator.id, p.event.owner, p.event.trigger, p.event.basis.unitId, p.event.basis.reasonClass], ["rerun", "c1", "c1", "auto", "r", "harness_crashed"]);
  }
  const third = planRerun({ unit, autoReruns: 2, lease: null, sameUpstreamFailures: 0 }, req);
  assert.equal(third.ok, false);
  assert.ok(!third.ok && third.reason === "limit-reached");
  assert.match(!third.ok ? (third.notDone ?? "") : "", /^未做:.*2 次/);
  assert.equal(planRerun({ unit, autoReruns: 2, limit: 3, lease: null, sameUpstreamFailures: 0 }, req).ok, true, "上限是参数");
  // 认不出的失败按 AC-36 低上限 1 次
  const u = setStatus([newRun({ ...base, id: "u", layer: "compute-session", parentId: null })], "u", "failed", T0 + 1, { failure: runFailure(classifyFailure({ text: "frobnicator out of phase" })) });
  assert.ok(u.ok);
  assert.equal(planRerun({ unit: u.changed[0]!, autoReruns: 1, lease: null, sameUpstreamFailures: 0 }, req).ok, false);
  const once = planRerun({ unit: u.changed[0]!, autoReruns: 0, lease: null, sameUpstreamFailures: 0 }, req);
  assert.ok(once.ok);
  assert.equal(once.explainFirst, true, "不知道副作用做没做完:先在群里说明再重跑");
});

test("别人名下的失败任务不自动重跑;明确发起才执行,并要在群里留记录(发起人、任务归属、依据的失败记录)(AC-43 坏实现 ⑦b)", () => {
  const r = setStatus([newRun({ ...base, id: "r", layer: "compute-session", parentId: null, contactId: "c1", taskId: "t-1" })], "r", "failed", T0 + 1, { failure: stalledFailure() });
  assert.ok(r.ok);
  const unit = r.changed[0]!;
  assert.deepEqual(planRerun({ unit, autoReruns: 0, lease: null, sameUpstreamFailures: 0 }, { at: T0 + 2, initiator: { kind: "contact", id: "c2" }, trigger: "auto" }), { ok: false, reason: "not-owner-auto", notDone: null });
  const p = planRerun({ unit, autoReruns: 5, lease: null, sameUpstreamFailures: 0 }, { at: T0 + 2, initiator: { kind: "contact", id: "c2" }, trigger: "explicit" });
  assert.ok(p.ok);
  assert.equal(p.announce, true);
  assert.equal(p.countsTowardLimit, false);
  assert.deepEqual([p.event.initiator.id, p.event.owner, p.event.basis.unitId, p.event.basis.taskId, p.event.basis.reasonClass], ["c2", "c1", "r", "t-1", "stalled"]);
  // 自己名下的自动重跑不需要群里留记录
  const own = planRerun({ unit, autoReruns: 0, lease: null, sameUpstreamFailures: 0 }, { at: T0 + 2, initiator: { kind: "contact", id: "c1" }, trigger: "auto" });
  assert.ok(own.ok);
  assert.equal(own.announce, false);
});

test("鉴权额度、请求无效不自动重跑;上游无响应不自动重跑到同一上游;同一上游连续失败则停,换了上游可以", () => {
  const req = { at: T0 + 2, initiator: { kind: "contact" as const, id: "c1" }, trigger: "auto" as const };
  const failed = (text: string, stall?: "no_response") => {
    const r = setStatus([newRun({ ...base, id: "r", layer: "compute-session", parentId: null, upstream: "gw/a" })], "r", "failed", T0 + 1, { failure: runFailure(classifyFailure({ text, ...(stall ? { stall } : {}) })) });
    assert.ok(r.ok);
    return r.changed[0]!;
  };
  const auth = planRerun({ unit: failed("403 Insufficient user quota"), autoReruns: 0, lease: null, sameUpstreamFailures: 0 }, req);
  assert.ok(!auth.ok && auth.reason === "never-auto");
  assert.match(!auth.ok ? (auth.notDone ?? "") : "", /^未做:鉴权或额度问题/);
  assert.equal(planRerun({ unit: failed("model foo does not exist"), autoReruns: 0, lease: null, sameUpstreamFailures: 0 }, req).ok, false);
  const nr = failed("", "no_response");
  const same = planRerun({ unit: nr, autoReruns: 0, lease: null, sameUpstreamFailures: 1 }, req);
  assert.ok(!same.ok && same.reason === "same-upstream");
  assert.equal(planRerun({ unit: nr, autoReruns: 0, lease: null, sameUpstreamFailures: 1, upstreamChanged: true }, req).ok, true);
  const up = failed("API Error: 503");
  assert.equal(planRerun({ unit: up, autoReruns: 0, lease: null, sameUpstreamFailures: 1 }, req).ok, true, "第一次上游不可用可以重跑");
  const again = planRerun({ unit: up, autoReruns: 1, lease: null, sameUpstreamFailures: 2 }, req);
  assert.ok(!again.ok && again.reason === "same-upstream");
  // 明确发起不受自动重跑的这些限制
  assert.equal(planRerun({ unit: up, autoReruns: 9, lease: null, sameUpstreamFailures: 9 }, { ...req, trigger: "explicit" }).ok, true);
});

test("同一上游同一原因的多条失败合并成一条群级提示;不同上游、不同原因、不同群分开;人停的不进提示(AC-43 坏实现 ⑮)", () => {
  const units: RunUnit[] = [];
  const add = (id: string, roomId: string, upstream: string, text: string, userStopped = false) => {
    const r = setStatus([newRun({ ...base, id, roomId, layer: "compute-session", parentId: null, upstream })], id, userStopped ? "interrupted" : "failed", T0 + 1, { failure: runFailure(classifyFailure({ text, userStopped })) });
    assert.ok(r.ok);
    units.push(r.changed[0]!);
  };
  for (const id of ["a", "b", "c", "d"]) add(id, "g1", "gw/x", "API Error: 429");
  add("e", "g1", "gw/y", "API Error: 429");
  add("f", "g1", "gw/x", "API Error: 503");
  add("g", "g2", "gw/x", "API Error: 429");
  add("h", "g1", "gw/x", "", true);
  const groups = failureGroups(units);
  assert.deepEqual(
    groups.map((g) => [g.roomId, g.upstream, g.reasonClass, g.unitIds.join(","), g.label]),
    [
      ["g1", "gw/x", "rate_limited", "a,b,c,d", "被限流"],
      ["g1", "gw/x", "upstream_unavailable", "f", "上游不可用"],
      ["g1", "gw/y", "rate_limited", "e", "被限流"],
      ["g2", "gw/x", "rate_limited", "g", "被限流"],
    ],
  );
});

test("画板展示:失败显示「失败 · 原因 · 用时」,人停的显示「已停止」且色调不同;孤儿写明原因;运行中显示已跑时长(AC-43 ⑨)", () => {
  const run = newRun({ ...base, id: "r", layer: "compute-session", parentId: null });
  const live = runDisplay(run, T0 + 4 * MIN);
  assert.deepEqual([live.tone, live.text], ["running", "运行中 · 已跑 4 分"]);
  const f = setStatus([run], "r", "failed", T0 + 3 * MIN + 12_000, { failure: runFailure(classifyFailure({ text: "API Error: 529 Overloaded" })) });
  assert.ok(f.ok);
  const fd = runDisplay(f.changed[0]!, T0 + 9 * MIN);
  assert.deepEqual([fd.tone, fd.text], ["failed", "失败 · 上游不可用 · 用时 3 分 12 秒"]);
  const s = setStatus([run], "r", "interrupted", T0 + MIN, { failure: runFailure(classifyFailure({ text: "", userStopped: true })) });
  assert.ok(s.ok);
  const sd = runDisplay(s.changed[0]!, T0 + 9 * MIN);
  assert.deepEqual([sd.tone, sd.text], ["stopped", "已停止"]);
  assert.notEqual(sd.tone, fd.tone);
  const o = setStatus([run], "r", "orphaned", T0 + MIN, { note: "宿主进程退出" });
  assert.ok(o.ok);
  assert.deepEqual(runDisplay(o.changed[0]!, T0 + 9 * MIN), { tone: "orphaned", text: "没跑完 · 宿主进程退出" });
  const w = setStatus([run], "r", "waiting_user", T0 + MIN);
  assert.ok(w.ok);
  assert.equal(runDisplay(w.changed[0]!, T0 + 9 * MIN).tone, "waiting");
});
