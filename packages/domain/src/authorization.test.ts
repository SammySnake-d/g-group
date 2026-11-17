// 授权:AC-17(归入任务 ≠ 获授权,本人明确同意即可,不要求点卡)、AC-19(答复绑定对象与有效版本)、AC-20(授权只来自用户本人)。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AuthRequest,
  type ConsentMessage,
  WRITE_TOOLS,
  askBeforeWriteRule,
  consentIntent,
  expireStale,
  gateTools,
  hasGrant,
  openRequest,
  resolveConsent,
  settleRequest,
} from "./authorization.ts";

const req = (over: Partial<Parameters<typeof openRequest>[0]> = {}): AuthRequest =>
  openRequest({ qId: "q1", taskId: "A", constraintVer: 2, action: "改 src/app.ts", principal: "u1", roomId: "g", askedSeq: 10, ...over });
const msg = (text: string, over: Partial<ConsentMessage> = {}): ConsentMessage =>
  ({ roomId: "g", seq: 11, sender: { kind: "user", id: "u1" }, text, replyToSeq: null, quotedSeqs: [], forwarded: false, external: false, ...over });
const T4B = { taskId: "A", state: "T4b_BlockedOnHuman", constraintVer: 2, pendingQId: "q1" } as const;

test("AC-17 群规「改代码前先问我」识别出来:各种说法按行命中,普通群规不命中", () => {
  assert.equal(askBeforeWriteRule("周报每周五发\n改代码前先问我\n别刷屏"), "改代码前先问我");
  assert.equal(askBeforeWriteRule("提交之前必须问我一声"), "提交之前必须问我一声");
  assert.equal(askBeforeWriteRule("先问我再改"), "先问我再改");
  assert.equal(askBeforeWriteRule("没有我同意不要改仓库"), "没有我同意不要改仓库");
  assert.equal(askBeforeWriteRule("Please ask me before editing files"), "Please ask me before editing files");
  assert.equal(askBeforeWriteRule("周报每周五发\n回复要简短"), null);
  assert.equal(askBeforeWriteRule(""), null);
});

test("AC-17 先问生效且没授权:执行器拿不到任何写工具;拿到授权后原样放行", () => {
  const all = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];
  const gated = gateTools(all, true, false);
  assert.deepEqual([...gated], ["Read", "Glob", "Grep"]);
  for (const w of WRITE_TOOLS) assert.ok(!gated.includes(w), `${w} 不该留下`);
  assert.deepEqual([...gateTools(all, true, true)], all);
  assert.deepEqual([...gateTools(all, false, false)], all);
  assert.ok(Object.isFrozen(WRITE_TOOLS));
});

test("AC-17 本人自然语言同意可授权:同意/可以/好的,改吧/OK 都算同意;拒绝的说法算拒绝", () => {
  for (const t of ["同意", "可以", "好的，改吧", "行", "OK", "我同意你改代码", "嗯嗯 👍", "批准"]) assert.equal(consentIntent(t), "approve", t);
  for (const t of ["不同意", "不行", "先别改", "算了", "拒绝", "no", "不要同意", "我没同意", "别批准", "拒绝授权"]) assert.equal(consentIntent(t), "reject", t);
  assert.equal(consentIntent("没问题"), "approve");
});

test("AC-19 含义不清不放行:带条件、反问、混合、只说别的,一律 unclear", () => {
  for (const t of ["同意吗？", "可以，但只改 README", "同意，先把测试写了", "等等，我想想", "你先进行检查", "好像不对", "看这条", "同意。不过别动配置", "如果测试过了就同意"]) {
    assert.equal(consentIntent(t), "unclear", t);
  }
  // 对照:同一批说法去掉条件后是干脆的同意
  assert.equal(consentIntent("好的"), "approve");
});

test("AC-20 引用块、引号里的旧同意不是本人此刻的表态", () => {
  assert.equal(consentIntent("> 同意\n看下这条"), "unclear");
  assert.equal(consentIntent("他之前说「同意」"), "unclear");
  assert.equal(consentIntent("“同意”"), "unclear");
  assert.equal(consentIntent("```\n同意\n```"), "unclear");
  assert.equal(consentIntent("> 不同意\n好的"), "approve");
});

test("AC-17 本人直接说「同意」:绑定到唯一待授权的 (task, q, 版本, 动作, 授权人)", () => {
  const r = resolveConsent([req()], msg("好的"));
  assert.equal(r.kind, "decision");
  assert.ok(r.kind === "decision");
  assert.equal(r.decision, "approve");
  assert.deepEqual({ ...r.binding }, { taskId: "A", qId: "q1", constraintVer: 2, action: "改 src/app.ts", authorizer: "u1", roomId: "g", seq: 11 });
});

test("AC-20 授权只来自用户本人:联系人、Helper、别的用户、转发、外部材料里的「同意」都不产生授权", () => {
  assert.equal(resolveConsent([req()], msg("同意", { sender: { kind: "contact", id: "argon" } })).kind, "none");
  assert.equal(resolveConsent([req()], msg("同意", { sender: { kind: "helper", id: "h" } })).kind, "none");
  // 联系人与用户 id 恰好同名也不行:先看发话人种类
  assert.match((resolveConsent([req()], msg("同意", { sender: { kind: "contact", id: "u1" } })) as { reason: string }).reason, /只有用户本人/);
  assert.equal(resolveConsent([req()], msg("同意", { sender: { kind: "system", id: "u1" } })).kind, "none");
  const other = resolveConsent([req()], msg("同意", { sender: { kind: "user", id: "u2" } }));
  assert.equal(other.kind, "none");
  assert.match((other as { reason: string }).reason, /授权人本人/);
  assert.match((resolveConsent([req()], msg("同意", { forwarded: true })) as { reason: string }).reason, /转发/);
  assert.match((resolveConsent([req()], msg("同意", { external: true })) as { reason: string }).reason, /外部材料/);
  // 对照:同一请求由本人直接说,才产生决定
  assert.equal(resolveConsent([req()], msg("好的")).kind, "decision");
});

test("AC-20 引用旧同意不算当前授权:回复一条旧的「同意」消息、正文只说别的,不放行", () => {
  const r = resolveConsent([req()], msg("按这条来", { replyToSeq: 5, quotedSeqs: [5] }));
  assert.equal(r.kind, "none");
  // 对照:同样引用着旧消息,但本人这句话自己表态了,就算数
  assert.equal(resolveConsent([req()], msg("好的", { replyToSeq: 5, quotedSeqs: [5] })).kind, "decision");
});

test("AC-20 多个待授权动作又没指明是哪个:不擅自选,返回追问候选", () => {
  const two = [req(), req({ qId: "q2", taskId: "B", askedSeq: 9 })];
  const r = resolveConsent(two, msg("好的"));
  assert.equal(r.kind, "ambiguous");
  assert.ok(r.kind === "ambiguous");
  assert.deepEqual([...r.candidates], ["q1", "q2"]);
  // 回复了其中一次提问就是那一次
  const anchored = resolveConsent(two, msg("同意", { replyToSeq: 9 }));
  assert.ok(anchored.kind === "decision");
  assert.equal(anchored.binding.qId, "q2");
});

test("AC-19 答复早于提问、所答的提问已过期都不放行", () => {
  assert.equal(resolveConsent([req({ askedSeq: 20 })], msg("同意")).kind, "none");
  const expired = expireStale([req()], { ...T4B, constraintVer: 3 });
  const r = resolveConsent(expired, msg("同意", { replyToSeq: 10 }));
  assert.equal(r.kind, "none");
  assert.match((r as { reason: string }).reason, /过期/);
  assert.equal(resolveConsent(expired, msg("同意")).kind, "none");
  // 对照:提问在答复之前且仍有效时,同一句话照常绑定
  assert.equal(resolveConsent([req()], msg("好的")).kind, "decision");
});

test("AC-19 了结前再核一次任务:错任务、旧版本、取消后、卡已换的迟到同意记为过期·未执行", () => {
  const r = req();
  const b = { taskId: "A", qId: "q1", constraintVer: 2, action: "改 src/app.ts", authorizer: "u1", roomId: "g", seq: 11 };
  const ok = settleRequest(r, b, "approve", T4B);
  assert.ok(ok.ok && ok.effective);
  assert.equal(ok.request.state, "granted");
  assert.deepEqual({ ...ok.request.decidedBy }, { roomId: "g", seq: 11 });
  for (const [task, why] of [
    [{ ...T4B, state: "T10_Cancelled" }, /前提失效/],
    [{ ...T4B, constraintVer: 3 }, /v3/],
    [{ ...T4B, pendingQId: "q9" }, /不是这张卡/],
  ] as const) {
    const late = settleRequest(r, b, "approve", task);
    assert.ok(late.ok && !late.effective);
    assert.equal(late.request.state, "expired");
    assert.match(late.request.reason!, why);
  }
  const oldVer = settleRequest(r, { ...b, constraintVer: 1 }, "approve", T4B);
  assert.ok(oldVer.ok && oldVer.request.state === "expired");
  assert.equal(settleRequest(r, { ...b, taskId: "B" }, "approve", T4B).ok, false);
  assert.equal(settleRequest(r, { ...b, authorizer: "u2" }, "approve", T4B).ok, false);
});

test("AC-19 同一有效请求只放行一次:同一条答复重放幂等,另一条答复不改结论;授权只对当前版本有效", () => {
  const r = req();
  const b = { taskId: "A", qId: "q1", constraintVer: 2, action: "改 src/app.ts", authorizer: "u1", roomId: "g", seq: 11 };
  const first = settleRequest(r, b, "approve", T4B);
  assert.ok(first.ok && first.effective);
  const replay = settleRequest(first.request, b, "approve", T4B);
  assert.ok(replay.ok && !replay.effective);
  assert.equal(settleRequest(first.request, { ...b, seq: 12 }, "reject", T4B).ok, false);
  assert.equal(hasGrant([first.request], "A", 2), true);
  assert.equal(hasGrant([first.request], "A", 3), false);
  assert.equal(hasGrant([r], "A", 2), false);
  const denied = settleRequest(r, b, "reject", T4B);
  assert.ok(denied.ok && denied.request.state === "denied");
  assert.equal(hasGrant([denied.request], "A", 2), false);
});

test("AC-19 前提变了的待授权批量过期:只动本任务里不再对应当前卡的那些", () => {
  const list = [req(), req({ qId: "q2", taskId: "B" })];
  const after = expireStale(list, { ...T4B, state: "T3_Running", pendingQId: null });
  assert.equal(after[0]!.state, "expired");
  assert.equal(after[1]!.state, "pending");
  assert.equal(expireStale(list, T4B)[0]!.state, "pending");
});

test("AC-20 不合格的答复消息不产生授权:字段缺失或是 Proxy 时返回 none", () => {
  assert.equal(resolveConsent([req()], { ...msg("同意"), seq: -1 }).kind, "none");
  assert.equal(resolveConsent([req()], new Proxy(msg("同意"), {})).kind, "none");
  assert.throws(() => openRequest({ qId: "", taskId: "A", constraintVer: 0, action: "x", principal: "u1", roomId: "g", askedSeq: 1 }));
});
