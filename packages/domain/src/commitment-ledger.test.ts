import assert from "node:assert/strict";
import { test } from "node:test";
import { applyLedger, emptyLedger as createLedger, reconcileRound, type Actor, type Command, type Ledger, type Result } from "./commitment-ledger.ts";

const user = { kind: "user", id: "u" } as const;
const contact = { kind: "contact", id: "c" } as const;
const compute = { kind: "compute", id: "worker" } as const;
const message = (id: string, seq: number, taskId: string | null = "task-a", sender = user) =>
  ({ id, seq, sender, text: `原文 ${id}`, taskId, replyToSeq: null });
const receive = (id = "m1", seq = 1, taskId: string | null = "task-a"): Command =>
  ({ type: "receive", actionId: `receive-${id}`, message: message(id, seq, taskId) });
const process = (seq = 1, taskId = "task-a"): Command => ({
  type: "process", actionId: `process-${seq}`, seq, accepted: true,
  commitments: [{ id: `k${seq}`, taskId, text: `原文 m${seq}` }],
});
const progress = (id = "k1", taskId = "task-a", roundId = "r1", actor: Actor = contact): Command =>
  ({ type: "progress", actionId: `progress-${id}-${roundId}`, commitmentId: id, taskId, actor, roundId, text: "进展" });
const bindCompute = (actionId: string, computeId: string | null, actor: Actor = contact): Command =>
  ({ type: "bind-compute", actionId, commitmentId: "k1", taskId: "task-a", actor, computeId });
const close = (outcome: "done" | "revoked" | "superseded" | "blocked", artifact: string | null = null, actor: typeof contact | typeof user = contact): Command =>
  ({ type: "close", actionId: `close-${outcome}`, commitmentId: "k1", taskId: "task-a", actor, roundId: "r1", outcome, artifact, detail: outcome === "done" ? null : "明确原因" });
function unwrap(result: Result): Ledger {
  if (!result.ok) throw new Error(result.reason);
  return result.ledger;
}
function emptyLedger(owner: string): Ledger {
  const result = createLedger(owner);
  if ("ok" in result) throw new Error("invalid owner");
  return result;
}
function received(): Ledger {
  return unwrap(applyLedger(emptyLedger("c"), 0, receive()));
}
function registered(): Ledger {
  const r = received();
  return unwrap(applyLedger(r, r.version, process()));
}

test("收到消息时先记录原文、序号和未处理状态", () => {
  const result = applyLedger(emptyLedger("c"), 0, receive());
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.ledger.messages.map((m) => [m.seq, m.id, m.text, m.handled]), [[1, "m1", "原文 m1", false]]);
});

test("未收到的消息不能处理或生成承诺", () => {
  const result = applyLedger(emptyLedger("c"), 0, process());
  assert.deepEqual(result, { ok: false, reason: "message-not-found" });
});

test("同一投递动作重试按稳定 id 去重,旧版本重试也不重复", () => {
  const first = received();
  const result = applyLedger(first, 0, receive());
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.duplicate, true); assert.deepEqual(result.ledger, first); }
});

test("复用动作 id 改载荷会被拒绝", () => {
  const first = received();
  const result = applyLedger(first, first.version, { type: "receive", actionId: "receive-m1", message: message("m2", 2) });
  assert.deepEqual(result, { ok: false, reason: "action-id-conflict" });
});

test("同一消息 id 重投不重复,但内容冲突不得覆盖", () => {
  const first = received();
  const retry = applyLedger(first, first.version, { type: "receive", actionId: "retry", message: message("m1", 1) });
  const changed = applyLedger(first, first.version, { type: "receive", actionId: "other", message: { ...message("m1", 1), text: "另一正文" } });
  assert.equal(retry.ok && retry.duplicate, true);
  assert.deepEqual(changed, { ok: false, reason: "message-id-conflict" });
  if (retry.ok) {
    const reuse = applyLedger(retry.ledger, retry.ledger.version, { type: "receive", actionId: "retry", message: message("m3", 3) });
    assert.deepEqual(reuse, { ok: false, reason: "action-id-conflict" });
  }
});

test("新动作使用旧版本被拒绝且不改原状态", () => {
  const first = received();
  const saved = JSON.stringify(first);
  const result = applyLedger(first, 0, receive("m2", 2));
  assert.deepEqual(result, { ok: false, reason: "version-conflict" });
  assert.equal(JSON.stringify(first), saved);
});

test("用户交办并接下的多个承诺同时登记并保留来源", () => {
  const r = unwrap(applyLedger(emptyLedger("c"), 0, { type: "receive", actionId: "r", message: { ...message("m1", 1), text: "请做 A，再做 B" } }));
  const result = applyLedger(r, r.version, { type: "process", actionId: "p", seq: 1, accepted: true, commitments: [
    { id: "a", taskId: "task-a", text: "做 A" }, { id: "b", taskId: "task-a", text: "做 B" },
  ] });
  assert.equal(result.ok, true);
  if (result.ok) { assert.deepEqual(result.ledger.commitments.map((c) => [c.id, c.sourceSeq, c.text]), [["a", 1, "做 A"], ["b", 1, "做 B"]]); assert.equal(result.ledger.messages[0]?.handled, true); }
  const forged = applyLedger(r, r.version, { type: "process", actionId: "forged", seq: 1, accepted: true, commitments: [{ id: "x", taskId: "task-a", text: "未出现的承诺" }] });
  assert.deepEqual(forged, { ok: false, reason: "commitment-text-not-source" });
});

test("用户未接下的要求不能伪造承诺", () => {
  const r = received();
  const result = applyLedger(r, r.version, { type: "process", actionId: "p", seq: 1, accepted: false, commitments: [{ id: "a", taskId: "task-a", text: "做 A" }] });
  assert.deepEqual(result, { ok: false, reason: "not-accepted" });
});

test("联系人自己说出的承诺进自己的账本", () => {
  const msg = { ...message("m2", 2), sender: contact, text: "我会做" };
  const r = unwrap(applyLedger(emptyLedger("c"), 0, { type: "receive", actionId: "r", message: msg }));
  const result = applyLedger(r, r.version, { type: "process", actionId: "p", seq: 2, accepted: false, commitments: [{ id: "self", taskId: "task-a", text: "我会做" }] });
  assert.equal(result.ok && result.ledger.commitments[0]?.text, "我会做");
});

test("同 id 承诺不可覆盖,失败不得部分处理消息", () => {
  const first = registered();
  const next = unwrap(applyLedger(first, first.version, receive("m2", 2)));
  const result = applyLedger(next, next.version, { type: "process", actionId: "p2", seq: 2, accepted: true, commitments: [{ id: "k1", taskId: "task-a", text: "覆盖" }] });
  assert.deepEqual(result, { ok: false, reason: "commitment-id-conflict" });
  assert.equal(next.messages[1]?.handled, false);
});

test("后台等待的承诺不因后续消息或时间样式字段自动消失", () => {
  const first = registered();
  const next = applyLedger(first, first.version, receive("m2", 2, null));
  assert.equal(next.ok && next.ledger.commitments[0]?.status, "active");
  if (next.ok) assert.deepEqual(next.ledger.commitments, first.commitments);
});

test("done 没有存在的产物不得落账", () => {
  const first = registered();
  const absent = applyLedger(first, first.version, close("done", "missing"), () => false);
  const unspecified = applyLedger(first, first.version, close("done"), () => true);
  assert.deepEqual(absent, { ok: false, reason: "artifact-not-found" });
  assert.deepEqual(unspecified, { ok: false, reason: "artifact-not-found" });
  assert.equal(first.commitments[0]?.status, "active");
});

test("可信产物解析器确认存在后才可完成,并保留指针", () => {
  const first = registered();
  const result = applyLedger(first, first.version, close("done", "artifact-1"), (id) => id === "artifact-1");
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.ledger.commitments[0]?.resolution, { artifact: "artifact-1", detail: null });
});

test("撤销、替代和阻塞必须明确记录而不是删除", () => {
  const first = registered();
  const revoked = applyLedger(first, first.version, close("revoked", null, user));
  const replaced = applyLedger(first, first.version, close("superseded"));
  const blocked = applyLedger(first, first.version, close("blocked"));
  assert.deepEqual([revoked, replaced, blocked].map((r) => r.ok && [r.ledger.commitments[0]?.status, r.ledger.commitments[0]?.resolution?.detail]), [["revoked", "明确原因"], ["superseded", "明确原因"], ["blocked", "明确原因"]]);
});

test("已了结承诺不能再次改成其他状态", () => {
  const first = registered();
  const done = unwrap(applyLedger(first, first.version, close("done", "a"), () => true));
  const result = applyLedger(done, done.version, close("blocked"));
  assert.deepEqual(result, { ok: false, reason: "commitment-closed" });
});

test("Compute 不得直接作为群消息发送者", () => {
  const result = applyLedger(emptyLedger("c"), 0, { type: "receive", actionId: "r", message: { ...message("m1", 1), sender: compute } });
  assert.deepEqual(result, { ok: false, reason: "sender-not-allowed" });
});

test("未绑定的 Compute 不可记进展,对账仍待处理", () => {
  const first = registered();
  const attempt = applyLedger(first, first.version, progress("k1", "task-a", "r1", compute));
  assert.deepEqual(attempt, { ok: false, reason: "actor-not-allowed" });
  assert.deepEqual(reconcileRound(first, "r1", ["k1"]), { ok: true, ready: false, pending: ["k1"] });
});

test("主人可绑定、替换和撤销 Compute,仅当前绑定可记进展", () => {
  const first = registered();
  const bound = unwrap(applyLedger(first, first.version, bindCompute("bind-1", "worker")));
  assert.deepEqual(reconcileRound(bound, "r1", ["k1"]), { ok: true, ready: false, pending: ["k1"] });
  assert.equal(applyLedger(bound, bound.version, progress("k1", "task-a", "r1", compute)).ok, true);
  const replaced = unwrap(applyLedger(bound, bound.version, bindCompute("bind-2", "worker-2")));
  assert.deepEqual(applyLedger(replaced, replaced.version, progress("k1", "task-a", "r2", compute)), { ok: false, reason: "actor-not-allowed" });
  assert.equal(applyLedger(replaced, replaced.version, progress("k1", "task-a", "r2", { kind: "compute", id: "worker-2" })).ok, true);
  const revoked = unwrap(applyLedger(replaced, replaced.version, bindCompute("bind-3", null)));
  assert.deepEqual(applyLedger(revoked, revoked.version, progress("k1", "task-a", "r3", { kind: "compute", id: "worker-2" })), { ok: false, reason: "actor-not-allowed" });
});

test("只有账本主人可绑定 Compute,绑定遵循版本和动作幂等", () => {
  const first = registered();
  for (const actor of [user, compute, { kind: "contact", id: "other" } as const]) {
    assert.deepEqual(applyLedger(first, first.version, bindCompute("bad", "worker", actor)), { ok: false, reason: "actor-not-allowed" });
  }
  assert.deepEqual(applyLedger(first, first.version + 1, bindCompute("future", "worker")), { ok: false, reason: "version-conflict" });
  const command = bindCompute("bind", "worker");
  const bound = unwrap(applyLedger(first, first.version, command));
  const retry = applyLedger(bound, first.version, command);
  assert.equal(retry.ok && retry.duplicate, true);
  assert.deepEqual(applyLedger(bound, bound.version, bindCompute("bind", "worker-2")), { ok: false, reason: "action-id-conflict" });
});

test("Compute 只可报告绑定任务的承诺进展,不能了结承诺", () => {
  const initial = registered();
  const first = unwrap(applyLedger(initial, initial.version, bindCompute("bind-worker", "worker")));
  const good = applyLedger(first, first.version, progress("k1", "task-a", "r1", compute));
  const wrong = applyLedger(first, first.version, progress("k1", "task-b", "r1", compute));
  const closed = applyLedger(first, first.version, { ...close("blocked"), actor: compute } as Command);
  assert.equal(good.ok, true);
  assert.deepEqual(wrong, { ok: false, reason: "task-mismatch" });
  assert.deepEqual(closed, { ok: false, reason: "actor-not-allowed" });
});

test("引用审查汇报的补充不能绑到快捷键任务", () => {
  const first = unwrap(applyLedger(emptyLedger("c"), 0, { type: "receive", actionId: "r1", message: { ...message("report", 1, "review"), sender: contact } }));
  const result = applyLedger(first, first.version, { type: "receive", actionId: "r2", message: { ...message("followup", 2, "shortcut"), replyToSeq: 1 } });
  assert.deepEqual(result, { ok: false, reason: "task-mismatch" });
});

test("轮末只对本轮绑定承诺对账,后台任务不阻塞闲聊", () => {
  const first = registered();
  const chat = reconcileRound(first, "chat", []);
  const work = reconcileRound(first, "r1", ["k1"]);
  assert.deepEqual(chat, { ok: true, ready: true, pending: [] });
  assert.deepEqual(work, { ok: true, ready: false, pending: ["k1"] });
});

test("本轮有动作后对账通过,别轮动作不冒充本轮动作", () => {
  const first = registered();
  const changed = unwrap(applyLedger(first, first.version, progress()));
  const same = reconcileRound(changed, "r1", ["k1"]);
  const other = reconcileRound(changed, "r2", ["k1"]);
  assert.deepEqual(same, { ok: true, ready: true, pending: [] });
  assert.deepEqual(other, { ok: true, ready: false, pending: ["k1"] });
});

test("拒绝 getter、setter 和 Proxy,不触发其代码", () => {
  let invoked = 0;
  const command = Object.defineProperty({ ...receive() }, "actionId", { enumerable: true, get() { invoked++; return "x"; } });
  const proxy = new Proxy(receive(), { get() { invoked++; throw new Error("不应调用"); }, ownKeys() { invoked++; throw new Error("不应调用"); } });
  const a = applyLedger(emptyLedger("c"), 0, command as Command);
  const b = applyLedger(emptyLedger("c"), 0, proxy);
  assert.deepEqual(a, { ok: false, reason: "invalid-input" });
  assert.deepEqual(b, { ok: false, reason: "invalid-input" });
  assert.equal(invoked, 0);
});

test("合法 JSON 的 null 输入被拒绝但不抛异常", () => {
  const result = applyLedger(emptyLedger("c"), 0, null as unknown as Command);
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.deepEqual(createLedger(null), { ok: false, reason: "invalid-input" });
  assert.deepEqual(createLedger(""), { ok: false, reason: "invalid-input" });
});

test("非主人联系人不得记进展", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, progress("k1", "task-a", "r1", { kind: "contact", id: "other" })), { ok: false, reason: "actor-not-allowed" });
});

test("非主人联系人不得了结承诺", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, { ...close("blocked"), actor: { kind: "contact", id: "other" } } as Command), { ok: false, reason: "actor-not-allowed" });
});

test("用户不得直接完成、替代或阻塞承诺", () => {
  const state = registered();
  for (const outcome of ["done", "superseded", "blocked"] as const) {
    assert.deepEqual(applyLedger(state, state.version, close(outcome, outcome === "done" ? "artifact" : null, user), () => true), { ok: false, reason: "actor-not-allowed" });
  }
});

test("用户不得记承诺进展", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, progress("k1", "task-a", "r1", user)), { ok: false, reason: "actor-not-allowed" });
});

test("其他联系人的消息不能登记到主人账本", () => {
  const state = unwrap(applyLedger(emptyLedger("c"), 0, { type: "receive", actionId: "r", message: { ...message("m1", 1), sender: { kind: "contact", id: "other" } } }));
  assert.deepEqual(applyLedger(state, state.version, process()), { ok: false, reason: "actor-not-allowed" });
});

test("承诺不得绑定到来源消息以外的任务", () => {
  const state = received();
  assert.deepEqual(applyLedger(state, state.version, process(1, "task-b")), { ok: false, reason: "task-mismatch" });
});

test("撤销后的承诺不得再记进展", () => {
  const state = registered();
  const revoked = unwrap(applyLedger(state, state.version, close("revoked", null, user)));
  assert.deepEqual(applyLedger(revoked, revoked.version, progress()), { ok: false, reason: "commitment-closed" });
});

test("产物解析器返回非布尔真值不算存在", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, close("done", "artifact"), () => "yes" as unknown as boolean), { ok: false, reason: "artifact-not-found" });
});

test("产物解析器抛错按不存在处理", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, close("done", "artifact"), () => { throw new Error("unavailable"); }), { ok: false, reason: "artifact-not-found" });
});

test("别轮已完成的承诺不再挂起", () => {
  const state = registered();
  const done = unwrap(applyLedger(state, state.version, close("done", "artifact"), () => true));
  assert.deepEqual(reconcileRound(done, "r2", ["k1"]), { ok: true, ready: true, pending: [] });
});

test("篡改承诺来源的外部账本被拒绝", () => {
  const state = registered();
  const forged = { ...state, commitments: [{ ...state.commitments[0]!, text: "不在来源中" }] };
  assert.deepEqual(applyLedger(forged, forged.version, receive("m2", 2)), { ok: false, reason: "invalid-input" });
});

test("完成却缺少产物的外部账本被拒绝", () => {
  const state = registered();
  const forged: Ledger = { ...state, commitments: [{ ...state.commitments[0]!, status: "done", resolution: { detail: null, artifact: null } }] };
  assert.deepEqual(applyLedger(forged, forged.version, receive("m2", 2)), { ok: false, reason: "invalid-input" });
});

test("相同动作载荷键序不同仍幂等", () => {
  const state = received();
  const reordered: Command = { actionId: "receive-m1", message: { text: "原文 m1", sender: { id: "u", kind: "user" }, seq: 1, id: "m1", replyToSeq: null, taskId: "task-a" }, type: "receive" };
  const result = applyLedger(state, 0, reordered);
  assert.equal(result.ok && result.duplicate, true);
  if (result.ok) assert.deepEqual(result.ledger, state);
});

test("外部类实例命令被拒绝", () => {
  class Input {}
  const command = Object.assign(new Input(), receive());
  assert.deepEqual(applyLedger(emptyLedger("c"), 0, command as Command), { ok: false, reason: "invalid-input" });
});

test("未来版本号不得提交", () => {
  const state = received();
  assert.deepEqual(applyLedger(state, state.version + 1, receive("m2", 2)), { ok: false, reason: "version-conflict" });
});

test("撤销、替代和阻塞缺原因或带产物均被拒绝", () => {
  const state = registered();
  for (const outcome of ["revoked", "superseded", "blocked"] as const) {
    assert.deepEqual(applyLedger(state, state.version, { ...close(outcome), detail: null } as Command), { ok: false, reason: "resolution-required" });
    assert.deepEqual(applyLedger(state, state.version, close(outcome, "artifact")), { ok: false, reason: "resolution-required" });
  }
});

test("引用不存在的消息被拒绝", () => {
  const state = emptyLedger("c");
  assert.deepEqual(applyLedger(state, state.version, { type: "receive", actionId: "r", message: { ...message("m1", 1), replyToSeq: 99 } }), { ok: false, reason: "reply-not-found" });
});

test("已处理消息不得使用新动作号重复处理", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, { ...process(), actionId: "again" } as Command), { ok: false, reason: "already-processed" });
});

test("对账拒绝不存在的承诺", () => {
  const state = registered();
  assert.deepEqual(reconcileRound(state, "r1", ["missing"]), { ok: false, reason: "commitment-not-found" });
});

test("不同消息不能复用序号", () => {
  const state = received();
  assert.deepEqual(applyLedger(state, state.version, receive("m2", 1)), { ok: false, reason: "seq-conflict" });
});

test("嵌套访问器与 Proxy 在三个入口均不执行", () => {
  let invoked = 0;
  const trap = () => { invoked++; throw new Error("must not execute"); };
  const nestedGetter = Object.defineProperty(message("m1", 1), "text", { enumerable: true, get: trap });
  const setter = Object.defineProperty({ ...receive() }, "actionId", { enumerable: true, set: trap });
  const nestedProxy = new Proxy(message("m1", 1), { get: trap, ownKeys: trap });
  const entries = Object.defineProperty([{}], "0", { enumerable: true, get: trap });
  const stateProxy = new Proxy(registered(), { get: trap, ownKeys: trap });
  const idsProxy = new Proxy(["k1"], { get: trap, ownKeys: trap });
  const resolverProxy = new Proxy(() => true, { apply: trap });
  const empty = emptyLedger("c");
  const state = registered();
  for (const command of [
    { type: "receive", actionId: "r", message: nestedGetter }, setter,
    { type: "receive", actionId: "r", message: nestedProxy },
    { type: "process", actionId: "p", seq: 1, accepted: true, commitments: entries },
    { ...bindCompute("bind", "worker"), actor: new Proxy(contact, { get: trap, ownKeys: trap }) },
  ]) assert.deepEqual(applyLedger(empty, empty.version, command as Command), { ok: false, reason: "invalid-input" });
  assert.deepEqual(applyLedger(stateProxy, state.version, receive("m2", 2)), { ok: false, reason: "invalid-input" });
  assert.deepEqual(reconcileRound(stateProxy, "r1", ["k1"]), { ok: false, reason: "invalid-input" });
  assert.deepEqual(reconcileRound(state, "r1", idsProxy), { ok: false, reason: "invalid-input" });
  assert.deepEqual(applyLedger(state, state.version, close("done", "artifact"), resolverProxy), { ok: false, reason: "artifact-not-found" });
  assert.equal(invoked, 0);
});

test("各入口的 null 输入不抛错,合法 null 字段可接受", () => {
  const state = registered();
  assert.deepEqual(applyLedger(null as unknown as Ledger, 0, receive()), { ok: false, reason: "invalid-input" });
  assert.deepEqual(applyLedger(state, null as unknown as number, receive("m2", 2)), { ok: false, reason: "invalid-input" });
  assert.deepEqual(reconcileRound(null as unknown as Ledger, "r1", []), { ok: false, reason: "invalid-input" });
  assert.deepEqual(reconcileRound(state, null as unknown as string, []), { ok: false, reason: "invalid-input" });
  assert.deepEqual(reconcileRound(state, "r1", null as unknown as string[]), { ok: false, reason: "invalid-input" });
  const empty = emptyLedger("c");
  assert.equal(applyLedger(empty, empty.version, receive("free", 1, null)).ok, true);
});

test("返回账本深冻结且不冻结调用方输入", () => {
  const input = receive();
  const result = applyLedger(emptyLedger("c"), 0, input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(result.ledger), true);
  assert.equal(Object.isFrozen(result.ledger.messages), true);
  assert.equal(Object.isFrozen(result.ledger.messages[0]), true);
  assert.equal(Object.isFrozen(result.ledger.messages[0]?.sender), true);
  assert.equal(Object.isFrozen(result.ledger.actions[0]), true);
});

test("绑定范围限于对应承诺且拒绝无效或终态输入", () => {
  const first = registered();
  const next = unwrap(applyLedger(first, first.version, receive("m2", 2)));
  const two = unwrap(applyLedger(next, next.version, process(2)));
  const bound = unwrap(applyLedger(two, two.version, bindCompute("bind", "worker")));
  assert.deepEqual(applyLedger(bound, bound.version, progress("k2", "task-a", "r1", compute)), { ok: false, reason: "actor-not-allowed" });
  assert.deepEqual(applyLedger(bound, bound.version, { ...bindCompute("missing", "worker"), commitmentId: "missing" } as Command), { ok: false, reason: "commitment-not-found" });
  assert.deepEqual(applyLedger(bound, bound.version, { ...bindCompute("wrong", "worker"), taskId: "task-b" } as Command), { ok: false, reason: "task-mismatch" });
  assert.deepEqual(applyLedger(bound, bound.version, bindCompute("empty", "")), { ok: false, reason: "invalid-input" });
  const done = unwrap(applyLedger(bound, bound.version, close("done", "artifact"), () => true));
  assert.deepEqual(applyLedger(done, done.version, bindCompute("closed", "worker")), { ok: false, reason: "commitment-closed" });
});

// The broader scenarios above remain as regression tests; these isolate their criteria.
test("独立判据：接收保留消息编号", () => {
  const result = applyLedger(emptyLedger("c"), 0, receive());
  assert.deepEqual(result.ok && result.ledger.messages.map((m) => m.id), ["m1"]);
});

test("独立判据：接收保留消息序号", () => {
  const result = applyLedger(emptyLedger("c"), 0, receive());
  assert.deepEqual(result.ok && result.ledger.messages.map((m) => m.seq), [1]);
});

test("独立判据：接收保留消息原文", () => {
  const result = applyLedger(emptyLedger("c"), 0, receive());
  assert.deepEqual(result.ok && result.ledger.messages.map((m) => m.text), ["原文 m1"]);
});

test("独立判据：接收不提前标记已处理", () => {
  const result = applyLedger(emptyLedger("c"), 0, receive());
  assert.deepEqual(result.ok && result.ledger.messages.map((m) => m.handled), [false]);
});

test("独立判据：同消息新动作重投标记重复", () => {
  const state = received();
  const result = applyLedger(state, state.version, { type: "receive", actionId: "retry", message: message("m1", 1) });
  assert.equal(result.ok && result.duplicate, true);
});

test("独立判据：同消息新动作重投保留新动作身份", () => {
  const state = received();
  const retry = unwrap(applyLedger(state, state.version, { type: "receive", actionId: "retry", message: message("m1", 1) }));
  assert.deepEqual(applyLedger(retry, retry.version, { type: "receive", actionId: "retry", message: message("m3", 3) }), { ok: false, reason: "action-id-conflict" });
});

test("独立判据：同消息号的正文冲突被拒绝", () => {
  const state = received();
  assert.deepEqual(applyLedger(state, state.version, { type: "receive", actionId: "other", message: { ...message("m1", 1), text: "另一正文" } }), { ok: false, reason: "message-id-conflict" });
});

test("独立判据：登记后消息标记已处理", () => {
  const state = received();
  const result = applyLedger(state, state.version, process());
  assert.equal(result.ok && result.ledger.messages[0]?.handled, true);
});

test("独立判据：登记承诺保留来源序号", () => {
  const state = received();
  const result = applyLedger(state, state.version, process());
  assert.equal(result.ok && result.ledger.commitments[0]?.sourceSeq, 1);
});

test("独立判据：登记承诺保留来源文字", () => {
  const state = received();
  const result = applyLedger(state, state.version, process());
  assert.equal(result.ok && result.ledger.commitments[0]?.text, "原文 m1");
});

test("独立判据：登记拒绝来源未出现的文字", () => {
  const state = received();
  assert.deepEqual(applyLedger(state, state.version, { type: "process", actionId: "p", seq: 1, accepted: true, commitments: [{ id: "x", taskId: "task-a", text: "未出现" }] }), { ok: false, reason: "commitment-text-not-source" });
});

test("独立判据：解析器否认存在时不能完成", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, close("done", "missing"), () => false), { ok: false, reason: "artifact-not-found" });
});

test("独立判据：未指定产物时不能完成", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, close("done"), () => true), { ok: false, reason: "artifact-not-found" });
});

test("独立判据：存在产物的承诺进入完成状态", () => {
  const state = registered();
  const result = applyLedger(state, state.version, close("done", "artifact"), () => true);
  assert.equal(result.ok && result.ledger.commitments[0]?.status, "done");
});

test("独立判据：完成时保留产物指针", () => {
  const state = registered();
  const result = applyLedger(state, state.version, close("done", "artifact"), () => true);
  assert.equal(result.ok && result.ledger.commitments[0]?.resolution?.artifact, "artifact");
});

test("独立判据：用户撤销保留状态和原因", () => {
  const state = registered();
  const result = applyLedger(state, state.version, close("revoked", null, user));
  assert.deepEqual(result.ok && [result.ledger.commitments[0]?.status, result.ledger.commitments[0]?.resolution?.detail], ["revoked", "明确原因"]);
});

test("独立判据：替代保留状态和原因", () => {
  const state = registered();
  const result = applyLedger(state, state.version, close("superseded"));
  assert.deepEqual(result.ok && [result.ledger.commitments[0]?.status, result.ledger.commitments[0]?.resolution?.detail], ["superseded", "明确原因"]);
});

test("独立判据：阻塞保留状态和原因", () => {
  const state = registered();
  const result = applyLedger(state, state.version, close("blocked"));
  assert.deepEqual(result.ok && [result.ledger.commitments[0]?.status, result.ledger.commitments[0]?.resolution?.detail], ["blocked", "明确原因"]);
});

test("独立判据：未绑定 Compute 不得记进展", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, progress("k1", "task-a", "r1", compute)), { ok: false, reason: "actor-not-allowed" });
});

test("独立判据：绑定动作不冒充本轮进展", () => {
  const state = registered();
  const bound = unwrap(applyLedger(state, state.version, bindCompute("bind", "worker")));
  assert.deepEqual(reconcileRound(bound, "r1", ["k1"]), { ok: true, ready: false, pending: ["k1"] });
});

test("独立判据：当前绑定 Compute 可记进展", () => {
  const state = registered();
  const bound = unwrap(applyLedger(state, state.version, bindCompute("bind", "worker")));
  assert.equal(applyLedger(bound, bound.version, progress("k1", "task-a", "r1", compute)).ok, true);
});

test("独立判据：替换后原 Compute 不得记进展", () => {
  const state = registered();
  const bound = unwrap(applyLedger(state, state.version, bindCompute("bind-1", "worker")));
  const replaced = unwrap(applyLedger(bound, bound.version, bindCompute("bind-2", "worker-2")));
  assert.deepEqual(applyLedger(replaced, replaced.version, progress("k1", "task-a", "r1", compute)), { ok: false, reason: "actor-not-allowed" });
});

test("独立判据：替换后新 Compute 可记进展", () => {
  const state = registered();
  const bound = unwrap(applyLedger(state, state.version, bindCompute("bind-1", "worker")));
  const replaced = unwrap(applyLedger(bound, bound.version, bindCompute("bind-2", "worker-2")));
  assert.equal(applyLedger(replaced, replaced.version, progress("k1", "task-a", "r1", { kind: "compute", id: "worker-2" })).ok, true);
});

test("独立判据：撤销绑定后 Compute 不得记进展", () => {
  const state = registered();
  const bound = unwrap(applyLedger(state, state.version, bindCompute("bind-1", "worker")));
  const revoked = unwrap(applyLedger(bound, bound.version, bindCompute("bind-2", null)));
  assert.deepEqual(applyLedger(revoked, revoked.version, progress("k1", "task-a", "r1", compute)), { ok: false, reason: "actor-not-allowed" });
});

test("独立判据：用户不能绑定 Compute", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, bindCompute("bind", "worker", user)), { ok: false, reason: "actor-not-allowed" });
});

test("独立判据：Compute 不能绑定 Compute", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, bindCompute("bind", "worker", compute)), { ok: false, reason: "actor-not-allowed" });
});

test("独立判据：非主人联系人不能绑定 Compute", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, bindCompute("bind", "worker", { kind: "contact", id: "other" })), { ok: false, reason: "actor-not-allowed" });
});

test("独立判据：绑定检查版本", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version + 1, bindCompute("bind", "worker")), { ok: false, reason: "version-conflict" });
});

test("独立判据：绑定动作重复提交保持幂等", () => {
  const state = registered();
  const command = bindCompute("bind", "worker");
  const bound = unwrap(applyLedger(state, state.version, command));
  const result = applyLedger(bound, state.version, command);
  assert.equal(result.ok && result.duplicate, true);
});

test("独立判据：绑定动作号不能用于另一载荷", () => {
  const state = registered();
  const bound = unwrap(applyLedger(state, state.version, bindCompute("bind", "worker")));
  assert.deepEqual(applyLedger(bound, bound.version, bindCompute("bind", "worker-2")), { ok: false, reason: "action-id-conflict" });
});

test("独立判据：Compute 不得报告其他任务的进展", () => {
  const state = registered();
  const bound = unwrap(applyLedger(state, state.version, bindCompute("bind", "worker")));
  assert.deepEqual(applyLedger(bound, bound.version, progress("k1", "task-b", "r1", compute)), { ok: false, reason: "task-mismatch" });
});

test("独立判据：Compute 不得了结已绑定承诺", () => {
  const state = registered();
  const bound = unwrap(applyLedger(state, state.version, bindCompute("bind", "worker")));
  assert.deepEqual(applyLedger(bound, bound.version, { ...close("blocked"), actor: compute } as Command), { ok: false, reason: "actor-not-allowed" });
});

test("独立判据：闲聊不等待未绑定到本轮的承诺", () => {
  const state = registered();
  assert.deepEqual(reconcileRound(state, "chat", []), { ok: true, ready: true, pending: [] });
});

test("独立判据：本轮未处理的绑定承诺保持待处理", () => {
  const state = registered();
  assert.deepEqual(reconcileRound(state, "r1", ["k1"]), { ok: true, ready: false, pending: ["k1"] });
});

test("独立判据：本轮已有进展则对账通过", () => {
  const state = registered();
  const progressed = unwrap(applyLedger(state, state.version, progress()));
  assert.deepEqual(reconcileRound(progressed, "r1", ["k1"]), { ok: true, ready: true, pending: [] });
});

test("独立判据：别轮进展不能冒充本轮进展", () => {
  const state = registered();
  const progressed = unwrap(applyLedger(state, state.version, progress()));
  assert.deepEqual(reconcileRound(progressed, "r2", ["k1"]), { ok: true, ready: false, pending: ["k1"] });
});

test("独立判据：用户不得直接完成承诺", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, close("done", "artifact", user), () => true), { ok: false, reason: "actor-not-allowed" });
});

test("独立判据：用户不得直接替代承诺", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, close("superseded", null, user)), { ok: false, reason: "actor-not-allowed" });
});

test("独立判据：用户不得直接阻塞承诺", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, close("blocked", null, user)), { ok: false, reason: "actor-not-allowed" });
});

test("独立判据：撤销必须有原因", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, { ...close("revoked"), detail: null } as Command), { ok: false, reason: "resolution-required" });
});

test("独立判据：替代必须有原因", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, { ...close("superseded"), detail: null } as Command), { ok: false, reason: "resolution-required" });
});

test("独立判据：阻塞必须有原因", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, { ...close("blocked"), detail: null } as Command), { ok: false, reason: "resolution-required" });
});

test("独立判据：撤销不能携带产物", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, close("revoked", "artifact")), { ok: false, reason: "resolution-required" });
});

test("独立判据：替代不能携带产物", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, close("superseded", "artifact")), { ok: false, reason: "resolution-required" });
});

test("独立判据：阻塞不能携带产物", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, close("blocked", "artifact")), { ok: false, reason: "resolution-required" });
});

test("独立判据：绑定不会影响其他承诺", () => {
  const state = registered();
  const next = unwrap(applyLedger(state, state.version, receive("m2", 2)));
  const two = unwrap(applyLedger(next, next.version, process(2)));
  const bound = unwrap(applyLedger(two, two.version, bindCompute("bind", "worker")));
  assert.deepEqual(applyLedger(bound, bound.version, progress("k2", "task-a", "r1", compute)), { ok: false, reason: "actor-not-allowed" });
});

test("独立判据：绑定拒绝不存在的承诺", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, { ...bindCompute("bind", "worker"), commitmentId: "missing" } as Command), { ok: false, reason: "commitment-not-found" });
});

test("独立判据：绑定拒绝错误任务", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, { ...bindCompute("bind", "worker"), taskId: "task-b" } as Command), { ok: false, reason: "task-mismatch" });
});

test("独立判据：绑定拒绝空 Compute 身份", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, state.version, bindCompute("bind", "")), { ok: false, reason: "invalid-input" });
});

test("独立判据：绑定拒绝已完成承诺", () => {
  const state = registered();
  const done = unwrap(applyLedger(state, state.version, close("done", "artifact"), () => true));
  assert.deepEqual(applyLedger(done, done.version, bindCompute("bind", "worker")), { ok: false, reason: "commitment-closed" });
});

test("独立判据：顶层 getter 被拒绝且不调用", () => {
  let invoked = 0;
  const command = Object.defineProperty({ ...receive() }, "actionId", { enumerable: true, get() { invoked++; return "r"; } });
  const result = applyLedger(emptyLedger("c"), 0, command as Command);
  assert.deepEqual([result, invoked], [{ ok: false, reason: "invalid-input" }, 0]);
});

test("独立判据：顶层 setter 被拒绝且不调用", () => {
  let invoked = 0;
  const command = Object.defineProperty({ ...receive() }, "actionId", { enumerable: true, set(_value: string) { invoked++; } });
  const result = applyLedger(emptyLedger("c"), 0, command as Command);
  assert.deepEqual([result, invoked], [{ ok: false, reason: "invalid-input" }, 0]);
});

test("独立判据：顶层 Proxy 被拒绝且不调用", () => {
  let invoked = 0;
  const command = new Proxy(receive(), { ownKeys(target) { invoked++; return Reflect.ownKeys(target); } });
  const result = applyLedger(emptyLedger("c"), 0, command);
  assert.deepEqual([result, invoked], [{ ok: false, reason: "invalid-input" }, 0]);
});

test("独立判据：嵌套消息 getter 被拒绝且不调用", () => {
  let invoked = 0;
  const nested = Object.defineProperty(message("m1", 1), "text", { enumerable: true, get() { invoked++; return "原文 m1"; } });
  const result = applyLedger(emptyLedger("c"), 0, { type: "receive", actionId: "r", message: nested });
  assert.deepEqual([result, invoked], [{ ok: false, reason: "invalid-input" }, 0]);
});

test("独立判据：嵌套消息 Proxy 被拒绝且不调用", () => {
  let invoked = 0;
  const nested = new Proxy(message("m1", 1), { ownKeys(target) { invoked++; return Reflect.ownKeys(target); } });
  const result = applyLedger(emptyLedger("c"), 0, { type: "receive", actionId: "r", message: nested });
  assert.deepEqual([result, invoked], [{ ok: false, reason: "invalid-input" }, 0]);
});

test("独立判据：数组访问器被拒绝且不调用", () => {
  let invoked = 0;
  const entries = Object.defineProperty([{}], "0", { enumerable: true, get() { invoked++; return {}; } });
  const result = applyLedger(emptyLedger("c"), 0, { type: "process", actionId: "p", seq: 1, accepted: true, commitments: entries } as unknown as Command);
  assert.deepEqual([result, invoked], [{ ok: false, reason: "invalid-input" }, 0]);
});

test("独立判据：更新入口拒绝账本 Proxy 且不调用", () => {
  let invoked = 0;
  const state = registered();
  const proxy = new Proxy(state, { ownKeys(target) { invoked++; return Reflect.ownKeys(target); } });
  const result = applyLedger(proxy, state.version, receive("m2", 2));
  assert.deepEqual([result, invoked], [{ ok: false, reason: "invalid-input" }, 0]);
});

test("独立判据：对账入口拒绝账本 Proxy 且不调用", () => {
  let invoked = 0;
  const state = registered();
  const proxy = new Proxy(state, { ownKeys(target) { invoked++; return Reflect.ownKeys(target); } });
  const result = reconcileRound(proxy, "r1", ["k1"]);
  assert.deepEqual([result, invoked], [{ ok: false, reason: "invalid-input" }, 0]);
});

test("独立判据：对账入口拒绝编号数组 Proxy 且不调用", () => {
  let invoked = 0;
  const state = registered();
  const proxy = new Proxy(["k1"], { ownKeys(target) { invoked++; return Reflect.ownKeys(target); } });
  const result = reconcileRound(state, "r1", proxy);
  assert.deepEqual([result, invoked], [{ ok: false, reason: "invalid-input" }, 0]);
});

test("独立判据：产物解析器 Proxy 不执行", () => {
  let invoked = 0;
  const state = registered();
  const proxy = new Proxy(() => true, { apply() { invoked++; return true; } });
  const result = applyLedger(state, state.version, close("done", "artifact"), proxy);
  assert.deepEqual([result, invoked], [{ ok: false, reason: "artifact-not-found" }, 0]);
});

test("独立判据：空任务字段是合法输入", () => {
  const state = emptyLedger("c");
  assert.equal(applyLedger(state, state.version, receive("free", 1, null)).ok, true);
});

test("独立判据：返回账本外壳冻结", () => {
  const result = applyLedger(emptyLedger("c"), 0, receive());
  assert.equal(result.ok && Object.isFrozen(result.ledger), true);
});

test("独立判据：返回消息数组冻结", () => {
  const result = applyLedger(emptyLedger("c"), 0, receive());
  assert.equal(result.ok && Object.isFrozen(result.ledger.messages), true);
});

test("独立判据：返回消息冻结", () => {
  const result = applyLedger(emptyLedger("c"), 0, receive());
  assert.equal(result.ok && Object.isFrozen(result.ledger.messages[0]), true);
});

test("独立判据：返回消息发送者冻结", () => {
  const result = applyLedger(emptyLedger("c"), 0, receive());
  assert.equal(result.ok && Object.isFrozen(result.ledger.messages[0]?.sender), true);
});

test("独立判据：返回动作记录冻结", () => {
  const result = applyLedger(emptyLedger("c"), 0, receive());
  assert.equal(result.ok && Object.isFrozen(result.ledger.actions[0]), true);
});

test("独立判据：不冻结调用方命令", () => {
  const input = receive();
  const result = applyLedger(emptyLedger("c"), 0, input);
  assert.deepEqual([result.ok, Object.isFrozen(input)], [true, false]);
});

test("独立判据：相同动作重试标记重复", () => {
  const state = received();
  const result = applyLedger(state, 0, receive());
  assert.equal(result.ok && result.duplicate, true);
});

test("独立判据：相同动作重试不改账本", () => {
  const state = received();
  const result = applyLedger(state, 0, receive());
  assert.deepEqual(result.ok && result.ledger, state);
});

test("独立判据：一条消息可登记多个承诺", () => {
  const state = unwrap(applyLedger(emptyLedger("c"), 0, { type: "receive", actionId: "r", message: { ...message("m1", 1), text: "请做 A，再做 B" } }));
  const result = applyLedger(state, state.version, { type: "process", actionId: "p", seq: 1, accepted: true, commitments: [{ id: "a", taskId: "task-a", text: "做 A" }, { id: "b", taskId: "task-a", text: "做 B" }] });
  assert.deepEqual(result.ok && result.ledger.commitments.map((c) => c.id), ["a", "b"]);
});

test("独立判据：新消息保留原有承诺", () => {
  const state = registered();
  const result = applyLedger(state, state.version, receive("m2", 2, null));
  assert.deepEqual(result.ok && result.ledger.commitments, state.commitments);
});

test("独立判据：更新入口拒绝空命令", () => {
  assert.deepEqual(applyLedger(emptyLedger("c"), 0, null as unknown as Command), { ok: false, reason: "invalid-input" });
});

test("独立判据：更新入口拒绝空账本", () => {
  assert.deepEqual(applyLedger(null as unknown as Ledger, 0, receive()), { ok: false, reason: "invalid-input" });
});

test("独立判据：更新入口拒绝空版本", () => {
  const state = registered();
  assert.deepEqual(applyLedger(state, null as unknown as number, receive("m2", 2)), { ok: false, reason: "invalid-input" });
});

test("独立判据：对账入口拒绝空账本", () => {
  assert.deepEqual(reconcileRound(null as unknown as Ledger, "r1", []), { ok: false, reason: "invalid-input" });
});

test("独立判据：对账入口拒绝空轮次", () => {
  const state = registered();
  assert.deepEqual(reconcileRound(state, null as unknown as string, []), { ok: false, reason: "invalid-input" });
});

test("独立判据：对账入口拒绝空绑定列表", () => {
  const state = registered();
  assert.deepEqual(reconcileRound(state, "r1", null as unknown as string[]), { ok: false, reason: "invalid-input" });
});

test("独立判据：创建账本拒绝空所有者", () => {
  assert.deepEqual(createLedger(null), { ok: false, reason: "invalid-input" });
});

test("独立判据：创建账本拒绝空字符串所有者", () => {
  assert.deepEqual(createLedger(""), { ok: false, reason: "invalid-input" });
});

test("独立判据：绑定参与者 Proxy 被拒绝且不调用", () => {
  let invoked = 0;
  const state = registered();
  const actor = new Proxy(contact, { ownKeys(target) { invoked++; return Reflect.ownKeys(target); } });
  const result = applyLedger(state, state.version, bindCompute("bind", "worker", actor));
  assert.deepEqual([result, invoked], [{ ok: false, reason: "invalid-input" }, 0]);
});

test("独立判据：旧版本被拒绝时不改调用方账本", () => {
  const state = structuredClone(received());
  const before = structuredClone(state);
  const result = applyLedger(state, 0, receive("m2", 2));
  assert.deepEqual([result, state], [{ ok: false, reason: "version-conflict" }, before]);
});

test("独立判据：重复承诺被拒绝时不改消息状态", () => {
  const first = registered();
  const state = structuredClone(unwrap(applyLedger(first, first.version, receive("m2", 2))));
  const before = structuredClone(state);
  const result = applyLedger(state, state.version, { type: "process", actionId: "p2", seq: 2, accepted: true, commitments: [{ id: "k1", taskId: "task-a", text: "覆盖" }] });
  assert.deepEqual([result, state], [{ ok: false, reason: "commitment-id-conflict" }, before]);
});

test("独立判据：产物不存在时不改调用方承诺", () => {
  const state = structuredClone(registered());
  const before = structuredClone(state);
  const result = applyLedger(state, state.version, close("done", "missing"), () => false);
  assert.deepEqual([result, state], [{ ok: false, reason: "artifact-not-found" }, before]);
});

test("独立判据：未授权进展不改变本轮待处理状态", () => {
  const state = structuredClone(registered());
  const result = applyLedger(state, state.version, progress("k1", "task-a", "r1", compute));
  assert.deepEqual([result, reconcileRound(state, "r1", ["k1"])], [{ ok: false, reason: "actor-not-allowed" }, { ok: true, ready: false, pending: ["k1"] }]);
});

test("独立判据：多个承诺均保留来源序号", () => {
  const state = unwrap(applyLedger(emptyLedger("c"), 0, { type: "receive", actionId: "r", message: { ...message("m1", 1), text: "请做 A，再做 B" } }));
  const result = applyLedger(state, state.version, { type: "process", actionId: "p", seq: 1, accepted: true, commitments: [{ id: "a", taskId: "task-a", text: "做 A" }, { id: "b", taskId: "task-a", text: "做 B" }] });
  assert.deepEqual(result.ok && result.ledger.commitments.map((c) => c.sourceSeq), [1, 1]);
});

test("独立判据：多个承诺均保留来源文字", () => {
  const state = unwrap(applyLedger(emptyLedger("c"), 0, { type: "receive", actionId: "r", message: { ...message("m1", 1), text: "请做 A，再做 B" } }));
  const result = applyLedger(state, state.version, { type: "process", actionId: "p", seq: 1, accepted: true, commitments: [{ id: "a", taskId: "task-a", text: "做 A" }, { id: "b", taskId: "task-a", text: "做 B" }] });
  assert.deepEqual(result.ok && result.ledger.commitments.map((c) => c.text), ["做 A", "做 B"]);
});

test("独立判据：撤销状态准确", () => {
  const state = registered();
  const result = applyLedger(state, state.version, close("revoked", null, user));
  assert.equal(result.ok && result.ledger.commitments[0]?.status, "revoked");
});

test("独立判据：撤销原因保留", () => {
  const state = registered();
  const result = applyLedger(state, state.version, close("revoked", null, user));
  assert.equal(result.ok && result.ledger.commitments[0]?.resolution?.detail, "明确原因");
});

test("独立判据：替代状态准确", () => {
  const state = registered();
  const result = applyLedger(state, state.version, close("superseded"));
  assert.equal(result.ok && result.ledger.commitments[0]?.status, "superseded");
});

test("独立判据：替代原因保留", () => {
  const state = registered();
  const result = applyLedger(state, state.version, close("superseded"));
  assert.equal(result.ok && result.ledger.commitments[0]?.resolution?.detail, "明确原因");
});

test("独立判据：阻塞状态准确", () => {
  const state = registered();
  const result = applyLedger(state, state.version, close("blocked"));
  assert.equal(result.ok && result.ledger.commitments[0]?.status, "blocked");
});

test("独立判据：阻塞原因保留", () => {
  const state = registered();
  const result = applyLedger(state, state.version, close("blocked"));
  assert.equal(result.ok && result.ledger.commitments[0]?.resolution?.detail, "明确原因");
});

// Round 2 reviewer cases: each assertion isolates one accepted behavior.
test("独立判据：同动作处理承诺元素内容冲突", () => {
  const state = registered();
  const command: Command = { type: "process", actionId: "process-1", seq: 1, accepted: true,
    commitments: [{ id: "changed", taskId: "task-a", text: "原文 m1" }] };
  assert.deepEqual(applyLedger(state, state.version, command), { ok: false, reason: "action-id-conflict" });
});

test("独立判据：同动作处理承诺元素个数冲突", () => {
  const state = registered();
  const command: Command = { type: "process", actionId: "process-1", seq: 1, accepted: true,
    commitments: [{ id: "k1", taskId: "task-a", text: "原文 m1" }, { id: "k2", taskId: "task-a", text: "原文 m1" }] };
  assert.deepEqual(applyLedger(state, state.version, command), { ok: false, reason: "action-id-conflict" });
});

test("独立判据：承诺原文不能取自另一条消息", () => {
  const first = received();
  const state = unwrap(applyLedger(first, first.version, receive("m2", 2)));
  const command: Command = { type: "process", actionId: "other-source", seq: 2, accepted: true,
    commitments: [{ id: "other", taskId: "task-a", text: "原文 m1" }] };
  assert.deepEqual(applyLedger(state, state.version, command), { ok: false, reason: "commitment-text-not-source" });
});


test("独立判据：done 终态拒绝 progress", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("done", "artifact"), () => true));
  assert.deepEqual(applyLedger(state, state.version, progress("k1", "task-a", "r2"), () => true), { ok: false, reason: "commitment-closed" });
});


test("独立判据：done 终态拒绝 close", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("done", "artifact"), () => true));
  assert.deepEqual(applyLedger(state, state.version, { ...close("done", "artifact"), actionId: "after-close" } as Command, () => true), { ok: false, reason: "commitment-closed" });
});


test("独立判据：done 终态拒绝 bind-compute", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("done", "artifact"), () => true));
  assert.deepEqual(applyLedger(state, state.version, bindCompute("after-bind", "worker"), () => true), { ok: false, reason: "commitment-closed" });
});


test("独立判据：revoked 终态拒绝 progress", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("revoked"), () => true));
  assert.deepEqual(applyLedger(state, state.version, progress("k1", "task-a", "r2"), () => true), { ok: false, reason: "commitment-closed" });
});


test("独立判据：revoked 终态拒绝 close", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("revoked"), () => true));
  assert.deepEqual(applyLedger(state, state.version, { ...close("done", "artifact"), actionId: "after-close" } as Command, () => true), { ok: false, reason: "commitment-closed" });
});


test("独立判据：revoked 终态拒绝 bind-compute", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("revoked"), () => true));
  assert.deepEqual(applyLedger(state, state.version, bindCompute("after-bind", "worker"), () => true), { ok: false, reason: "commitment-closed" });
});


test("独立判据：superseded 终态拒绝 progress", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("superseded"), () => true));
  assert.deepEqual(applyLedger(state, state.version, progress("k1", "task-a", "r2"), () => true), { ok: false, reason: "commitment-closed" });
});


test("独立判据：superseded 终态拒绝 close", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("superseded"), () => true));
  assert.deepEqual(applyLedger(state, state.version, { ...close("done", "artifact"), actionId: "after-close" } as Command, () => true), { ok: false, reason: "commitment-closed" });
});


test("独立判据：superseded 终态拒绝 bind-compute", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("superseded"), () => true));
  assert.deepEqual(applyLedger(state, state.version, bindCompute("after-bind", "worker"), () => true), { ok: false, reason: "commitment-closed" });
});


test("独立判据：blocked 终态拒绝 progress", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("blocked"), () => true));
  assert.deepEqual(applyLedger(state, state.version, progress("k1", "task-a", "r2"), () => true), { ok: false, reason: "commitment-closed" });
});


test("独立判据：blocked 终态拒绝 close", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("blocked"), () => true));
  assert.deepEqual(applyLedger(state, state.version, { ...close("done", "artifact"), actionId: "after-close" } as Command, () => true), { ok: false, reason: "commitment-closed" });
});


test("独立判据：blocked 终态拒绝 bind-compute", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("blocked"), () => true));
  assert.deepEqual(applyLedger(state, state.version, bindCompute("after-bind", "worker"), () => true), { ok: false, reason: "commitment-closed" });
});


test("独立判据：revoked 承诺在别轮对账已就绪", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("revoked")));
  assert.deepEqual(reconcileRound(state, "r2", ["k1"]), { ok: true, ready: true, pending: [] });
});


test("独立判据：superseded 承诺在别轮对账已就绪", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("superseded")));
  assert.deepEqual(reconcileRound(state, "r2", ["k1"]), { ok: true, ready: true, pending: [] });
});


test("独立判据：blocked 承诺在别轮对账已就绪", () => {
  const before = registered();
  const state = unwrap(applyLedger(before, before.version, close("blocked")));
  assert.deepEqual(reconcileRound(state, "r2", ["k1"]), { ok: true, ready: true, pending: [] });
});


test("独立判据：快照拒绝不同消息复用序号", () => {
  const state = registered();
  const forged = { ...state, messages: [...state.messages, { ...state.messages[0]!, id: "m2" }] };
  let calls = 0;
  const result = applyLedger(forged, forged.version, close("done", "artifact"), () => { calls++; return true; });
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.equal(calls, 0);
});


test("独立判据：快照拒绝活动承诺携带了结信息", () => {
  const state = registered();
  const forged = { ...state, commitments: [{ ...state.commitments[0]!, resolution: { detail: "原因", artifact: null } }] };
  let calls = 0;
  const result = applyLedger(forged, forged.version, close("done", "artifact"), () => { calls++; return true; });
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.equal(calls, 0);
});


test("独立判据：快照拒绝活动指向不存在承诺", () => {
  const state = registered();
  const forged = { ...state, activity: [{ roundId: "r1", commitmentId: "missing", taskId: "task-a", actor: contact, kind: "progress" as const, text: "进展" }] };
  let calls = 0;
  const result = applyLedger(forged, forged.version, close("done", "artifact"), () => { calls++; return true; });
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.equal(calls, 0);
});


test("独立判据：快照拒绝活动指向不同任务的承诺", () => {
  const state = registered();
  const forged = { ...state, activity: [{ roundId: "r1", commitmentId: "k1", taskId: "task-b", actor: contact, kind: "progress" as const, text: "进展" }] };
  let calls = 0;
  const result = applyLedger(forged, forged.version, close("done", "artifact"), () => { calls++; return true; });
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.equal(calls, 0);
});


test("独立判据：快照拒绝承诺来源消息尚未处理", () => {
  const state = registered();
  const forged = { ...state, messages: [{ ...state.messages[0]!, handled: false }] };
  let calls = 0;
  const result = applyLedger(forged, forged.version, close("done", "artifact"), () => { calls++; return true; });
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.equal(calls, 0);
});


test("独立判据：快照拒绝多余字段", () => {
  const state = registered();
  const forged = { ...state, extra: "unexpected" };
  let calls = 0;
  const result = applyLedger(forged, forged.version, close("done", "artifact"), () => { calls++; return true; });
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.equal(calls, 0);
});


test("独立判据：命令拒绝多余字段", () => {
  const state = registered();
  const command = { ...close("done", "artifact"), extra: "unexpected" } as unknown as Command;
  let calls = 0;
  const result = applyLedger(state, state.version, command, () => { calls++; return true; });
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.equal(calls, 0);
});

test("独立判据：快照拒绝重复消息编号", () => {
  const state = registered();
  const forged = { ...state, messages: [...state.messages, { ...state.messages[0]!, seq: 2 }] };
  let calls = 0;
  const result = applyLedger(forged, forged.version, close("done", "artifact"), () => { calls++; return true; });
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.equal(calls, 0);
});

test("独立判据：快照拒绝重复承诺编号", () => {
  const state = registered();
  const forged = { ...state, commitments: [...state.commitments, { ...state.commitments[0]! }] };
  let calls = 0;
  const result = applyLedger(forged, forged.version, close("done", "artifact"), () => { calls++; return true; });
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.equal(calls, 0);
});

test("独立判据：快照拒绝重复动作编号", () => {
  const state = registered();
  const forged = { ...state, actions: [...state.actions, { ...state.actions[0]! }] };
  let calls = 0;
  const result = applyLedger(forged, forged.version, close("done", "artifact"), () => { calls++; return true; });
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.equal(calls, 0);
});

test("独立判据：快照拒绝终态缺少了结信息", () => {
  const state = registered();
  const forged = { ...state, commitments: [{ ...state.commitments[0]!, status: "done" as const, resolution: null }] };
  let calls = 0;
  const result = applyLedger(forged, forged.version, close("done", "artifact"), () => { calls++; return true; });
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.equal(calls, 0);
});

test("独立判据：快照拒绝 revoked 缺少原因", () => {
  const state = registered();
  const forged = { ...state, commitments: [{ ...state.commitments[0]!, status: "revoked" as const, resolution: { detail: null, artifact: null } }] };
  let calls = 0;
  const result = applyLedger(forged, forged.version, close("done", "artifact"), () => { calls++; return true; });
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.equal(calls, 0);
});

test("独立判据：快照拒绝 superseded 缺少原因", () => {
  const state = registered();
  const forged = { ...state, commitments: [{ ...state.commitments[0]!, status: "superseded" as const, resolution: { detail: null, artifact: null } }] };
  let calls = 0;
  const result = applyLedger(forged, forged.version, close("done", "artifact"), () => { calls++; return true; });
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.equal(calls, 0);
});

test("独立判据：快照拒绝 blocked 缺少原因", () => {
  const state = registered();
  const forged = { ...state, commitments: [{ ...state.commitments[0]!, status: "blocked" as const, resolution: { detail: null, artifact: null } }] };
  let calls = 0;
  const result = applyLedger(forged, forged.version, close("done", "artifact"), () => { calls++; return true; });
  assert.deepEqual(result, { ok: false, reason: "invalid-input" });
  assert.equal(calls, 0);
});

test("独立判据：单次处理拒绝重复承诺编号", () => {
  const state = received();
  const command: Command = { type: "process", actionId: "duplicate-proposals", seq: 1, accepted: true,
    commitments: [{ id: "k1", taskId: "task-a", text: "原文 m1" }, { id: "k1", taskId: "task-a", text: "原文 m1" }] };
  assert.deepEqual(applyLedger(state, state.version, command), { ok: false, reason: "commitment-id-conflict" });
});

test("独立判据：对账拒绝重复绑定编号", () => {
  const state = registered();
  assert.deepEqual(reconcileRound(state, "r1", ["k1", "k1"]), { ok: false, reason: "invalid-input" });
});

test("独立判据：无任务来源可登记指定任务承诺", () => {
  const state = unwrap(applyLedger(emptyLedger("c"), 0, receive("m1", 1, null)));
  const result = applyLedger(state, state.version, process(1, "task-b"));
  assert.equal(result.ok && result.ledger.commitments[0]?.taskId, "task-b");
});
