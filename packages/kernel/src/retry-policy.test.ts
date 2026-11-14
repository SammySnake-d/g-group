// AC-36 失败轮次 A×B 双维容错的纯策略:F1/F2/F3/F7/F8/F9(重试裁决)、F10(共享上游熔断)、F11(休眠唤醒宽限门)、
// F12(防毒丸崩溃循环)、A27-05(可恢复失败卡 CAS 领取与跳过范围)。时钟、随机数都由测试注入。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BREAKER_CLOSED,
  CRASH_CLEAN,
  DEFAULT_BREAKER_POLICY,
  DEFAULT_RETRY_POLICY,
  DEFAULT_WAKE_POLICY,
  HEAL_CLASSES,
  WAKE_INITIAL,
  backoffDelay,
  breakerAdmit,
  breakerFailure,
  breakerSuccess,
  checkRetryPolicy,
  claimFailureCard,
  crashCommitted,
  crashRecover,
  decideRetry,
  effectOf,
  healOf,
  judgeRunner,
  mayJudgeStale,
  skipTarget,
  wakeTick,
} from "./retry-policy.ts";

const zero = () => 0;

// ---------------- 重试裁决 ----------------
test("F1 首次 502:A1×B0 静默退避重试第 1 次,不出卡", () => {
  assert.deepEqual(decideRetry({ heal: "A1", effect: "B0", attempts: 0 }, undefined, zero), { kind: "retry", attempt: 1, limit: 3, delayMs: 1000 });
});

test("F1 A1×B1 同样静默退避(接收端按 action_id 去重)", () => {
  assert.deepEqual(decideRetry({ heal: "A1", effect: "B1", attempts: 1 }, undefined, zero), { kind: "retry", attempt: 2, limit: 3, delayMs: 2000 });
});

test("F1 指数退避:延迟按 2 的幂增长、到封顶为止,抖动只往下收", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((k) => backoffDelay(k, DEFAULT_RETRY_POLICY, zero)), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(backoffDelay(0, DEFAULT_RETRY_POLICY, () => 0.5), 900);
  assert.equal(backoffDelay(2, DEFAULT_RETRY_POLICY, () => 0.99), 3208);
  assert.equal(backoffDelay(1, DEFAULT_RETRY_POLICY, () => Number.NaN), 2000, "随机数不合法按 0");
  assert.equal(backoffDelay(1, DEFAULT_RETRY_POLICY, () => { throw new Error("坏随机数"); }), 2000, "随机数抛错按 0");
});

test("F1 耗尽自动重试上限:只出 1 张卡,原因 exhausted", () => {
  assert.deepEqual(decideRetry({ heal: "A1", effect: "B0", attempts: 3 }, undefined, zero), { kind: "card", cause: "exhausted", deliveryUnknown: false, attempts: 3 });
});

test("F3 统一重试权:harness 已重试的次数计入同一预算,不叠加", () => {
  assert.deepEqual(decideRetry({ heal: "A1", effect: "B0", attempts: 0, harnessAttempts: 2 }, undefined, zero), { kind: "retry", attempt: 1, limit: 1, delayMs: 1000 });
  assert.deepEqual(decideRetry({ heal: "A1", effect: "B0", attempts: 1, harnessAttempts: 2 }, undefined, zero), { kind: "card", cause: "exhausted", deliveryUnknown: false, attempts: 1 });
  assert.deepEqual(decideRetry({ heal: "A1", effect: "B0", attempts: 0, harnessAttempts: 5 }, undefined, zero), { kind: "card", cause: "exhausted", deliveryUnknown: false, attempts: 0 });
});

test("F8 unknown×(B0|B1) 最多有界重试 1 次即出卡", () => {
  assert.deepEqual(decideRetry({ heal: "unknown", effect: "B0", attempts: 0 }, undefined, zero), { kind: "retry", attempt: 1, limit: 1, delayMs: 1000 });
  assert.deepEqual(decideRetry({ heal: "unknown", effect: "B1", attempts: 1 }, undefined, zero), { kind: "card", cause: "exhausted", deliveryUnknown: false, attempts: 1 });
  assert.deepEqual(decideRetry({ heal: "unknown", effect: "B0", attempts: 0 }, { maxAutoRetries: 9 }, zero), { kind: "retry", attempt: 1, limit: 1, delayMs: 1000 }, "A1 上限调大不影响 unknown 的 1 次");
});

test("F8 unknown×B2 0 次自动重发,置 DeliveryUnknown", () => {
  assert.deepEqual(decideRetry({ heal: "unknown", effect: "B2", attempts: 0 }, undefined, zero), { kind: "card", cause: "delivery-unknown", deliveryUnknown: true, attempts: 0 });
});

test("F9 A1×B2 外部结果未知:0 次自动重发,置 DeliveryUnknown", () => {
  assert.deepEqual(decideRetry({ heal: "A1", effect: "B2", attempts: 0 }, undefined, zero), { kind: "card", cause: "delivery-unknown", deliveryUnknown: true, attempts: 0 });
});

test("F2 A2 配额耗尽(403 Insufficient user quota):任意 B 都 0 次自动重试,立即出卡", () => {
  for (const effect of ["B0", "B1", "B2"] as const) {
    const d = decideRetry({ heal: "A2", effect, attempts: 0 }, undefined, zero);
    assert.deepEqual(d, { kind: "card", cause: "permanent", deliveryUnknown: effect === "B2", attempts: 0 });
  }
});

test("F2 A3 永久拒绝:0 次自动重试,立即出卡", () => {
  assert.deepEqual(decideRetry({ heal: "A3", effect: "B0", attempts: 0 }, { maxAutoRetries: 10 }, zero), { kind: "card", cause: "permanent", deliveryUnknown: false, attempts: 0 });
});

test("F7 用户主动中断不是失败:0 重试 0 出卡,清掉本轮残留的瞬态错误", () => {
  for (const heal of HEAL_CLASSES) {
    assert.deepEqual(decideRetry({ heal, effect: "B0", attempts: 0, userAborted: true }, undefined, zero), { kind: "aborted", clearTransient: true });
  }
});

test("D26 整轮已由宿主判卡死:不再静默重试同一轮,直接出卡", () => {
  assert.deepEqual(decideRetry({ heal: "A1", effect: "B0", attempts: 0, stallJudged: true }, undefined, zero), { kind: "card", cause: "stall", deliveryUnknown: false, attempts: 0 });
});

test("参数可配:上限、基数、封顶、抖动按传入值;unknown 上限只能 0 或 1,非法参数拒收", () => {
  const p = { maxAutoRetries: 5, unknownMaxRetries: 0, baseDelayMs: 200, maxDelayMs: 500, jitter: 0 };
  assert.deepEqual(decideRetry({ heal: "A1", effect: "B0", attempts: 4 }, p, zero), { kind: "retry", attempt: 5, limit: 5, delayMs: 500 });
  assert.deepEqual(decideRetry({ heal: "unknown", effect: "B0", attempts: 0 }, p, zero), { kind: "card", cause: "exhausted", deliveryUnknown: false, attempts: 0 });
  assert.deepEqual(decideRetry({ heal: "A1", effect: "B0", attempts: 0 }, { maxAutoRetries: 0 }, zero), { kind: "card", cause: "exhausted", deliveryUnknown: false, attempts: 0 });
  assert.equal(checkRetryPolicy({ unknownMaxRetries: 2 }).ok, false);
  assert.equal(checkRetryPolicy({ maxAutoRetries: -1 }).ok, false);
  assert.equal(checkRetryPolicy({ baseDelayMs: Number.NaN }).ok, false);
  assert.equal(checkRetryPolicy({ baseDelayMs: 100, maxDelayMs: 50 }).ok, false);
  assert.equal(checkRetryPolicy({ jitter: 1.5 }).ok, false);
  assert.equal(checkRetryPolicy(null).ok, false);
  assert.deepEqual(checkRetryPolicy(undefined), { ok: true, policy: DEFAULT_RETRY_POLICY });
  assert.equal(decideRetry({ heal: "A1", effect: "B0", attempts: 0 }, { unknownMaxRetries: 3 }).kind, "invalid");
});

test("输入合同:null、缺字段、未知分类一律拒收不抛错;访问器与 Proxy 拒收且不调用", () => {
  let calls = 0;
  const getter = { effect: "B0", attempts: 0 } as Record<string, unknown>;
  Object.defineProperty(getter, "heal", { enumerable: true, get: () => { calls++; return "A1"; } });
  const proxy = new Proxy({ heal: "A1", effect: "B0", attempts: 0 }, { get: (t, k) => { calls++; return Reflect.get(t, k); } });
  for (const [i, x] of [null, undefined, 1, "A1", [], {}, { heal: "A9", effect: "B0", attempts: 0 }, { heal: "A1", effect: "B3", attempts: 0 }, { heal: "A1", effect: "B0", attempts: -1 }, { heal: "A1", effect: "B0", attempts: 0, userAborted: "yes" }, getter, proxy].entries()) {
    assert.equal(decideRetry(x).kind, "invalid", `第 ${i} 个输入应拒收`);
  }
  assert.equal(calls, 0, "访问器与 Proxy 陷阱一次都没被调用");
  assert.equal(breakerFailure(null, null).ok, false);
  assert.equal(breakerAdmit(BREAKER_CLOSED, null).ok, false);
  assert.equal(breakerSuccess(null).ok, false);
  assert.equal(crashRecover(null, null).ok, false);
  assert.equal(claimFailureCard(null, null).ok, false);
  assert.equal(skipTarget(null, null).ok, false);
  assert.match((judgeRunner(null, WAKE_INITIAL) as { invalid: string }).invalid, /必须是对象/);
  assert.equal(mayJudgeStale(null, 0), false, "状态不合法保守地不判停滞");
  assert.deepEqual(wakeTick(null, 0), WAKE_INITIAL);
});

test("导出的默认参数、分类表与初始状态冻结,调用方改不动", () => {
  for (const o of [DEFAULT_RETRY_POLICY, DEFAULT_BREAKER_POLICY, DEFAULT_WAKE_POLICY, BREAKER_CLOSED, BREAKER_CLOSED.members, CRASH_CLEAN, WAKE_INITIAL, HEAL_CLASSES]) assert.equal(Object.isFrozen(o), true);
  assert.throws(() => { (DEFAULT_RETRY_POLICY as { maxAutoRetries: number }).maxAutoRetries = 99; }, TypeError);
  assert.equal(decideRetry({ heal: "A1", effect: "B0", attempts: 3 }, undefined, zero).kind, "card", "默认上限仍是 3");
});

test("失败原因类别映射到 A 维:瞬态 A1、配置/配额 A2、平台拒绝 A3、认不出 unknown、人停不是失败", () => {
  const cases: [string, string][] = [
    ["upstream_unavailable", "A1"], ["rate_limited", "A1"], ["no_response", "A1"], ["stream_dropped", "A1"], ["stalled", "A1"], ["harness_crashed", "A1"],
    ["auth_or_quota", "A2"], ["invalid_request", "A2"], ["context_overflow", "A2"], ["session_lost", "A2"],
    ["platform_refused", "A3"], ["user_stopped", "user_stopped"], ["unknown", "unknown"], ["新出现的类别", "unknown"], ["toString", "unknown"], ["__proto__", "unknown"],
  ];
  for (const [r, h] of cases) assert.equal(healOf(r), h, r);
  assert.equal(healOf(null), "unknown");
});

test("副作用维度:分类器判不知道副作用做没做完(UnknownEffect)一律按 B2;其余按宿主给的 hint", () => {
  assert.equal(effectOf("B0", "UnknownEffect"), "B2");
  assert.equal(effectOf("B1", "Transient"), "B1");
  assert.equal(effectOf("B0"), "B0");
  assert.equal(effectOf("B9"), "B2", "认不出的 hint 保守按 B2");
});

// ---------------- 共享上游熔断(F10) ----------------
const fail = (s: unknown, member: string, nowMs: number, heal = "A1", policy?: unknown) => {
  const r = breakerFailure(s, { nowMs, heal, member, reason: heal === "A2" ? "403 Insufficient user quota" : "502 EOF" }, policy);
  assert.ok(r.ok, JSON.stringify(r));
  return r;
};
const ONE = { memberThreshold: 1, cooldownMs: 5000 };

test("F10 同一上游 3 个联系人连续 502:到阈值打开熔断,只在打开那一刻出 1 张群级卡", () => {
  const a = fail(BREAKER_CLOSED, "contact:a", 0);
  const b = fail(a.state, "contact:b", 10);
  const c = fail(b.state, "contact:c", 20);
  const again = fail(c.state, "contact:a", 30);
  assert.deepEqual([a.opened, b.opened, c.opened, again.opened], [false, true, false, false], "合并只出 1 张");
  assert.equal(b.state.status, "open");
  assert.deepEqual(again.state.members, ["contact:a", "contact:b", "contact:c"]);
  assert.deepEqual([again.state.reason, again.state.failures, again.state.manualOnly], ["502 EOF", 4, false]);
});

test("同一个联系人自己反复失败不触发共享熔断,由它自己的重试上限出卡", () => {
  let s = BREAKER_CLOSED;
  for (let i = 0; i < 5; i++) {
    const r = fail(s, "contact:a", i);
    assert.equal(r.opened, false);
    s = r.state;
  }
  assert.deepEqual([s.status, s.failures, s.members], ["closed", 5, ["contact:a"]]);
});

test("F10 熔断打开期间暂停后台重试,冷却到期才放 1 个半开探测", () => {
  const opened = fail(BREAKER_CLOSED, "contact:a", 1000, "A1", ONE).state;
  const early = breakerAdmit(opened, { nowMs: 3000, priority: "background" }, ONE);
  assert.ok(early.ok);
  assert.deepEqual([early.admit, early.probe, early.waitMs, early.needsUser], [false, false, 3000, false]);
  const due = breakerAdmit(opened, { nowMs: 6000 }, ONE);
  assert.ok(due.ok);
  assert.deepEqual([due.admit, due.probe, due.state.status, due.state.probeInFlight], [true, true, "half-open", true]);
  const second = breakerAdmit(due.state, { nowMs: 6001 }, ONE);
  assert.ok(second.ok);
  assert.deepEqual([second.admit, second.probe], [false, false], "半开期间只放 1 个探测");
  const manual = breakerAdmit(due.state, { nowMs: 6002, manual: true }, ONE);
  assert.ok(manual.ok);
  assert.equal(manual.admit, false, "探测在途时用户再点也不并发第二个");
});

test("F10 半开探测成功:回到关闭并交回被暂停的成员续跑", () => {
  let s = fail(BREAKER_CLOSED, "contact:a", 0).state;
  s = fail(s, "contact:b", 1).state;
  s = fail(s, "task:t1", 2).state;
  const probe = breakerAdmit(s, { nowMs: 1 + DEFAULT_BREAKER_POLICY.cooldownMs });
  assert.ok(probe.ok && probe.probe);
  const ok = breakerSuccess(probe.state);
  assert.ok(ok.ok);
  assert.deepEqual([ok.recovered, ok.resume, ok.state.status, ok.state.failures], [true, ["contact:a", "contact:b", "task:t1"], "closed", 0]);
  const plain = breakerSuccess(BREAKER_CLOSED);
  assert.ok(plain.ok);
  assert.deepEqual([plain.recovered, plain.resume], [false, []]);
});

test("F10 半开探测失败:重新打开、重新计冷却,不再出第二张卡", () => {
  const P = { memberThreshold: 1, cooldownMs: 100 };
  const s = fail(BREAKER_CLOSED, "contact:a", 0, "A1", P).state;
  const probe = breakerAdmit(s, { nowMs: 100 }, P);
  assert.ok(probe.ok && probe.probe);
  const again = fail(probe.state, "contact:a", 150, "A1", P);
  assert.deepEqual([again.opened, again.state.status, again.state.openedAt, again.state.probeInFlight], [false, "open", 150, false]);
  const wait = breakerAdmit(again.state, { nowMs: 200 }, P);
  assert.ok(wait.ok);
  assert.deepEqual([wait.admit, wait.waitMs], [false, 50]);
});

test("F2 同一 Key 403 配额耗尽:第一次就打开熔断,N 个联系人合并只出 1 张群级卡", () => {
  const a = fail(BREAKER_CLOSED, "contact:a", 0, "A2");
  const b = fail(a.state, "contact:b", 1, "A2");
  const c = fail(b.state, "contact:c", 2, "A2");
  assert.deepEqual([a.opened, b.opened, c.opened], [true, false, false]);
  assert.deepEqual([a.state.reason, a.state.manualOnly, c.state.members.length], ["403 Insufficient user quota", true, 3]);
});

test("F2 403 打开的熔断不自动半开探测:冷却到期也暂停,等用户在群级卡上点重试", () => {
  const s = fail(BREAKER_CLOSED, "contact:a", 0, "A2", ONE).state;
  const late = breakerAdmit(s, { nowMs: 10 * ONE.cooldownMs }, ONE);
  assert.ok(late.ok);
  assert.deepEqual([late.admit, late.probe, late.needsUser], [false, false, true]);
  const viaOpen = fail(fail(BREAKER_CLOSED, "contact:a", 0, "A1", ONE).state, "contact:b", 1, "A2", ONE).state;
  assert.equal(viaOpen.manualOnly, true, "已打开后又遇到 403,同样只能由用户发起");
  const later = breakerAdmit(viaOpen, { nowMs: 10 * ONE.cooldownMs }, ONE);
  assert.ok(later.ok);
  assert.equal(later.admit, false);
});

test("用户在群级卡上点[重试]:不等冷却立即放 1 个半开探测", () => {
  for (const heal of ["A1", "A2"]) {
    const s = fail(BREAKER_CLOSED, "contact:a", 0, heal, ONE).state;
    const now = breakerAdmit(s, { nowMs: 1, manual: true }, ONE);
    assert.ok(now.ok);
    assert.deepEqual([now.admit, now.probe, now.state.status], [true, true, "half-open"], heal);
  }
  assert.equal(breakerAdmit(BREAKER_CLOSED, { nowMs: 0, manual: "yes" }).ok, false);
});

test("A3 内容拒绝只关乎这次请求,不计入上游熔断", () => {
  const r = fail(BREAKER_CLOSED, "contact:a", 0, "A3", ONE);
  assert.deepEqual([r.opened, r.state.status, r.state.failures, r.state.members], [false, "closed", 0, []]);
});

test("熔断计数在成功后清零:成功之前失败过的成员不再算进下一次", () => {
  const s = fail(BREAKER_CLOSED, "contact:a", 0).state;
  const ok = breakerSuccess(s);
  assert.ok(ok.ok);
  const r = fail(ok.state, "contact:b", 2);
  assert.deepEqual([r.opened, r.state.failures, r.state.members], [false, 1, ["contact:b"]]);
});

test("熔断参数可配;交互关键路径优先级只做接口(被校验、被记录)", () => {
  const P = { memberThreshold: 1, cooldownMs: 0 };
  const r = fail(BREAKER_CLOSED, "contact:a", 0, "A1", P);
  assert.equal(r.opened, true);
  const adm = breakerAdmit(r.state, { nowMs: 0, priority: "interactive" }, P);
  assert.ok(adm.ok);
  assert.deepEqual([adm.admit, adm.probe, adm.priority], [true, true, "interactive"]);
  assert.equal(breakerAdmit(BREAKER_CLOSED, { nowMs: 0, priority: "urgent" }).ok, false);
  assert.equal(breakerFailure(BREAKER_CLOSED, { nowMs: 0, heal: "A1", member: "m", reason: "x" }, { memberThreshold: 0 }).ok, false);
  const closed = breakerAdmit(BREAKER_CLOSED, { nowMs: 0, priority: "background" });
  assert.ok(closed.ok);
  assert.deepEqual([closed.admit, closed.probe, closed.priority], [true, false, "background"]);
});

// ---------------- 防毒丸崩溃循环(F12) ----------------
test("F12 同一失败输入:第 1 次崩溃恢复允许自动续跑,第 2 次熔断 CrashLoopBlocked", () => {
  const first = crashRecover(CRASH_CLEAN, { key: "c1@room:3", effect: "B0" });
  assert.ok(first.ok);
  assert.deepEqual([first.decision, first.why, first.state.count], ["resume", "first-recovery", 1]);
  const second = crashRecover(first.state, { key: "c1@room:3", effect: "B0" });
  assert.ok(second.ok);
  assert.deepEqual([second.decision, second.why, second.state.count], ["blocked", "crash-loop", 2]);
});

test("F12 新成功轮次清零:之后同一输入再崩溃仍算第 1 次", () => {
  const first = crashRecover(CRASH_CLEAN, { key: "k", effect: "B1" });
  assert.ok(first.ok);
  const clean = crashCommitted();
  assert.deepEqual(clean, { key: null, count: 0 });
  const again = crashRecover(clean, { key: "k", effect: "B1" });
  assert.ok(again.ok);
  assert.deepEqual([again.decision, again.state.count], ["resume", 1]);
});

test("F12 换了失败输入(游标已前进)按新输入从 1 计", () => {
  const r = crashRecover({ key: "old", count: 1 }, { key: "new", effect: "B0" });
  assert.ok(r.ok);
  assert.deepEqual([r.decision, r.state], ["resume", { key: "new", count: 1 }]);
});

test("F12 在途的是 B2 外部不幂等动作:不自动续跑", () => {
  const r = crashRecover(CRASH_CLEAN, { key: "k", effect: "B2" });
  assert.ok(r.ok);
  assert.deepEqual([r.decision, r.why], ["blocked", "delivery-unknown"]);
});

test("F12 回收上限是参数,默认 1", () => {
  const two = crashRecover({ key: "k", count: 1 }, { key: "k" }, 2);
  assert.ok(two.ok);
  assert.equal(two.decision, "resume");
  const dflt = crashRecover({ key: "k", count: 1 }, { key: "k" });
  assert.ok(dflt.ok);
  assert.equal(dflt.decision, "blocked");
  assert.equal(crashRecover(CRASH_CLEAN, { key: "k" }, -1).ok, false);
});

// ---------------- 休眠唤醒宽限门(F11) ----------------
const MIN = 60000;
test("F11 时钟跳变 +10 分钟:awakeSince 宽限期内不判 stopped-beating", () => {
  let w = wakeTick(WAKE_INITIAL, 0);
  w = wakeTick(w, 5000);
  w = wakeTick(w, 5000 + 10 * MIN);
  assert.equal(w.awakeSince, 5000 + 10 * MIN);
  const now = 5000 + 10 * MIN + 1000;
  assert.equal(mayJudgeStale(w, now), false);
  assert.equal(judgeRunner({ pidAlive: true, bootMatches: true, lastBeatMs: 5000, nowMs: now, staleAfterMs: 2 * MIN }, w), "live");
});

test("F11 宽限期过后真停滞照常检出 stopped-beating", () => {
  let w = wakeTick(WAKE_INITIAL, 0);
  w = wakeTick(w, 10 * MIN);
  const after = 10 * MIN + DEFAULT_WAKE_POLICY.graceMs;
  assert.equal(mayJudgeStale(w, after), true);
  assert.equal(judgeRunner({ pidAlive: true, bootMatches: true, lastBeatMs: 0, nowMs: after, staleAfterMs: 2 * MIN }, w), "stopped-beating");
});

test("F11 没有休眠时心跳超时即 stopped-beating:宽限门不是总开关", () => {
  let w = wakeTick(WAKE_INITIAL, 0);
  for (let t = 5000; t <= 3 * MIN; t += 5000) w = wakeTick(w, t);
  assert.equal(w.awakeSince, null);
  assert.equal(mayJudgeStale(w, 3 * MIN), true);
  assert.equal(judgeRunner({ pidAlive: true, bootMatches: true, lastBeatMs: 0, nowMs: 3 * MIN, staleAfterMs: 2 * MIN }, w), "stopped-beating");
  assert.equal(judgeRunner({ pidAlive: true, bootMatches: true, lastBeatMs: 2 * MIN, nowMs: 3 * MIN, staleAfterMs: 2 * MIN }, w), "live");
});

test("F11 时钟回拨也按跳变处理;宽限参数可配", () => {
  const w = wakeTick(wakeTick(WAKE_INITIAL, 100 * MIN), 50 * MIN);
  assert.equal(w.awakeSince, 50 * MIN);
  assert.equal(mayJudgeStale(w, 50 * MIN + 1000, { jumpMs: 1000, graceMs: 500 }), true);
  assert.equal(mayJudgeStale(w, 50 * MIN + 400, { jumpMs: 1000, graceMs: 500 }), false);
  assert.equal(mayJudgeStale(w, 50 * MIN + 400, { jumpMs: 0, graceMs: 500 }), false, "非法参数保守地不判");
});

test("存活判定:进程没了是 pid-dead,启动编号对不上是 pid-reused(与宽限门无关)", () => {
  const w = wakeTick(wakeTick(WAKE_INITIAL, 0), 10 * MIN);
  assert.equal(judgeRunner({ pidAlive: false, bootMatches: true, lastBeatMs: 0, nowMs: 10 * MIN, staleAfterMs: MIN }, w), "pid-dead");
  assert.equal(judgeRunner({ pidAlive: true, bootMatches: false, lastBeatMs: 0, nowMs: 10 * MIN, staleAfterMs: MIN }, w), "pid-reused");
});

// ---------------- 可恢复失败卡(A27-05) ----------------
const CARD = { status: "open", ownerUserId: "me", contactId: "c1", attemptSeq: 2, allowedModels: ["gpt-5", "gemini-3"] } as const;
const me = { kind: "user", id: "me" } as const;

test("A27-05 CAS 领取:连点[重试]第二次被拒(卡片已领走)", () => {
  const first = claimFailureCard(CARD, { by: me, attemptSeq: 2, action: "retry" });
  assert.ok(first.ok);
  assert.equal(first.card.status, "claimed");
  assert.equal(first.targetModel, null);
  const second = claimFailureCard(first.card, { by: me, attemptSeq: 2, action: "retry" });
  assert.deepEqual(second.ok ? null : second.reason, "not-open");
});

test("A27-05 手点[重试]与后台自动恢复竞争:只成功一次", () => {
  const auto = claimFailureCard(CARD, { by: { kind: "auto", id: "host" }, attemptSeq: 2, action: "retry" });
  assert.ok(auto.ok);
  const click = claimFailureCard(auto.card, { by: me, attemptSeq: 2, action: "retry" });
  assert.equal(click.ok ? "ok" : click.reason, "not-open");
});

test("A27-05 过期 attempt_seq 的迟到点击一律丢弃", () => {
  const r = claimFailureCard(CARD, { by: me, attemptSeq: 1, action: "retry" });
  assert.equal(r.ok ? "ok" : r.reason, "stale-attempt");
});

test("A27-05 未授权点击拒绝", () => {
  const r = claimFailureCard(CARD, { by: { kind: "user", id: "someone-else" }, attemptSeq: 2, action: "skip" });
  assert.equal(r.ok ? "ok" : r.reason, "forbidden");
});

test("严禁静默换模:只有显式[换模型重试]能带目标模型且须在可选清单里;自动恢复不能换模也不能跳过", () => {
  const sw = claimFailureCard(CARD, { by: me, attemptSeq: 2, action: "switch-model", targetModel: "gemini-3" });
  assert.ok(sw.ok);
  assert.equal(sw.targetModel, "gemini-3");
  const reasons = [
    claimFailureCard(CARD, { by: me, attemptSeq: 2, action: "switch-model" }),
    claimFailureCard(CARD, { by: me, attemptSeq: 2, action: "switch-model", targetModel: "不在清单里" }),
    claimFailureCard(CARD, { by: me, attemptSeq: 2, action: "retry", targetModel: "gpt-5" }),
    claimFailureCard(CARD, { by: { kind: "auto", id: "host" }, attemptSeq: 2, action: "switch-model", targetModel: "gpt-5" }),
    claimFailureCard(CARD, { by: { kind: "auto", id: "host" }, attemptSeq: 2, action: "skip" }),
    claimFailureCard(CARD, { by: me, attemptSeq: 2, action: "delete-everything" }),
  ].map((r) => (r.ok ? "ok" : r.reason));
  assert.deepEqual(reasons, ["model-required", "model-not-allowed", "model-not-explicit", "auto-not-allowed", "auto-not-allowed", "invalid"]);
  for (const action of ["skip", "give-up"] as const) {
    const r = claimFailureCard(CARD, { by: me, attemptSeq: 2, action });
    assert.ok(r.ok, action);
    assert.equal(r.targetModel, null);
  }
});

test("A27-05 [跳过本轮]只把游标推到 failed_batch_end_seq,失败期间新到的 m_new 不被吞掉", () => {
  // 失败批次是 #3–#5;失败期间用户又发了 #6(m_new),最新是 #6
  const r = skipTarget({ "room-1": 2 }, { "room-1": 5 });
  assert.ok(r.ok);
  assert.deepEqual({ ...r.cursors }, { "room-1": 5 });
  assert.notEqual(r.cursors["room-1"], 6);
});

test("跳过不回退已经更靠后的处理位置,各会话分开算", () => {
  const r = skipTarget({ a: 9, b: 1 }, { a: 4, b: 7 });
  assert.ok(r.ok);
  assert.deepEqual({ ...r.cursors }, { a: 9, b: 7 });
  assert.equal(skipTarget({ a: 1 }, { a: -1 }).ok, false);
});
