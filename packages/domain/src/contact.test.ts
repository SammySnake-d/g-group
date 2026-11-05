// AC-01 联系人持久身份;AC-33 直接工具清单收窄、Compute 不继承记忆和性格、凭据只给引用、placement 契约;
// 概念卡第 11 张:定时是联系人自己的承诺(带时区和误差),不是插件能力;AC-35① 专职锁不挡控制指令;AC-31⑤ 承诺终态自动回收。
import assert from "node:assert/strict";
import { test } from "node:test";
import { addContact, briefFor, canCallDirectly, commit, confirmFinalReport, decideUnderFocus, emptyDirectory, grantComputeAsset, grantTool, revokeCommitment, setFocus, settleTask, updateContact } from "./contact.ts";

/** 按需求文档 75-78 行独立列出的通用能力样本,不取自被测实现的清单。 */
const SPEC_GENERAL_TOOLS = ["bash", "shell", "exec", "run_command", "write_file", "edit_file", "apply_patch", "browser", "computer_use", "run_script"];

const mk = () => {
  const r = addContact(emptyDirectory(), { id: "c-mi", name: "小秘", speakingModel: "claude-opus-5-5" });
  if (!r.ok) throw new Error(r.reason);
  return r.dir;
};
/** 末次汇报回执夹具:默认履行 k1,依据位置足够新。 */
const rc = (taskId: string, commitmentIds: readonly string[] = ["k1"], basedOnSeq = 10_000) => ({ taskId, commitmentIds, basedOnSeq });
const daily8 = { cron: "0 8 * * *", tz: "Asia/Shanghai", toleranceSec: 120 };

test("AC-01 同 id 重复新建被拒,不会覆盖原联系人的记忆", () => {
  const d = addContact(emptyDirectory(), { id: "c-mi", name: "小秘", speakingModel: "claude-opus-5-5" });
  assert.ok(d.ok);
  const withMem = updateContact(d.dir, "c-mi", { memory: "用户偏好中文" });
  assert.ok(withMem.ok);
  const dup = addContact(withMem.dir, { id: "c-mi", name: "小秘", speakingModel: "gpt-6" });
  assert.equal(dup.ok, false);
  assert.equal(withMem.dir.contacts.get("c-mi")?.memory, "用户偏好中文");
});

test("AC-01 换说话模型或改名,id 与记忆不变(阴性对照)", () => {
  const withMem = updateContact(mk(), "c-mi", { memory: "记住:周报周五发" });
  assert.ok(withMem.ok);
  const r = updateContact(withMem.dir, "c-mi", { speakingModel: "gemini-4", name: "秘书" });
  assert.ok(r.ok);
  const c = r.dir.contacts.get("c-mi");
  assert.equal(c?.id, "c-mi");
  assert.equal(c?.memory, "记住:周报周五发");
  assert.equal(c?.speakingModel, "gemini-4");
  assert.equal(c?.name, "秘书");
});

test("AC-01 更新不存在的联系人被拒", () => {
  assert.equal(updateContact(emptyDirectory(), "nobody", { name: "x" }).ok, false);
});

test("AC-33 shell、任意写文件、浏览器自动化等通用工具不能进联系人直接工具清单,拒绝理由指向 Compute", () => {
  const c = mk().contacts.get("c-mi")!;
  for (const name of SPEC_GENERAL_TOOLS) {
    const r = grantTool(c, { name, bounded: true });
    assert.equal(r.ok, false, name);
    assert.match(!r.ok ? r.reason : "", new RegExp(`^${name} 是通用能力,只能在 Compute 里用$`), name);
  }
  const unbounded = grantTool(c, { name: "fetch_anything", bounded: false });
  assert.equal(unbounded.ok, false);
  assert.match(!unbounded.ok ? unbounded.reason : "", /fetch_anything 不是有界工具/);
});

test("AC-33 具名有界工具可以授予联系人(阴性对照)", () => {
  const r = grantTool(mk().contacts.get("c-mi")!, { name: "get_weather", bounded: true });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.contact.tools.map((t) => t.name), ["get_weather"]);
});

test("AC-33 派给 Compute 的说明不带联系人的记忆和性格,只带任务、群规切片、白名单子集与凭据引用", () => {
  const base = updateContact(mk(), "c-mi", { memory: "私人记忆:老板生日 3 月", soul: "性格:爱用颜文字" });
  assert.ok(base.ok);
  const g = grantTool(base.dir.contacts.get("c-mi")!, { name: "get_weather", bounded: true });
  assert.ok(g.ok);
  const r = briefFor(g.ok ? g.contact : (null as never), { task: "整理周报", rules: ["改代码前先问"], tools: ["get_weather"], credentialRefs: ["vault://gmail/1"], placement: "byom_daemon" });
  assert.deepEqual(r, { ok: true, brief: { task: "整理周报", rules: ["改代码前先问"], tools: ["get_weather"], credentialRefs: ["vault://gmail/1"], placement: "byom_daemon" } });
});

test("AC-33 同一联系人只切记忆和性格开关,说明内容完全一样(阴性对照)", () => {
  const req = { task: "整理周报", rules: ["改代码前先问"], tools: [], credentialRefs: [] };
  const bare = briefFor(mk().contacts.get("c-mi")!, req);
  const full = updateContact(mk(), "c-mi", { memory: "私人记忆", soul: "性格" });
  assert.ok(full.ok);
  assert.deepEqual(briefFor(full.dir.contacts.get("c-mi")!, req), bare);
  assert.equal(bare.ok && bare.brief.placement, "local");
});

test("AC-33 只给 Compute 的能力资产可以派给 Compute,联系人本体仍调不到;没登记的照样被拒", () => {
  const c = mk().contacts.get("c-mi")!;
  const req = { task: "跑脚本", rules: [], tools: ["run_command"], credentialRefs: [] };
  assert.match((() => { const r = briefFor(c, req); return r.ok ? "" : r.reason; })(), /run_command 超出联系人 c-mi 的授权集合/);
  const a = grantComputeAsset(c, { name: "run_command", kind: "mcp" });
  assert.ok(a.ok);
  const granted = a.ok ? a.contact : (null as never);
  assert.deepEqual(briefFor(granted, req), { ok: true, brief: { task: "跑脚本", rules: [], tools: ["run_command"], credentialRefs: [], placement: "local" } });
  assert.equal(canCallDirectly(granted, "run_command"), false);
  assert.deepEqual(granted.tools, []);
  const w = grantTool(c, { name: "get_weather", bounded: true });
  assert.equal(canCallDirectly(w.ok ? w.contact : (null as never), "get_weather"), true);
});

test("AC-33 派给 Compute 的工具超出联系人白名单被拒", () => {
  const g = grantTool(mk().contacts.get("c-mi")!, { name: "get_weather", bounded: true });
  assert.ok(g.ok);
  const r = briefFor(g.ok ? g.contact : (null as never), { task: "t", rules: [], tools: ["get_weather", "send_email"], credentialRefs: [] });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /send_email/);
});

test("AC-33 凭据只给引用句柄,明文密钥被拒", () => {
  const r = briefFor(mk().contacts.get("c-mi")!, { task: "t", rules: [], tools: [], credentialRefs: ["sk-live-123456"] });
  assert.equal(r.ok, false);
});

test("AC-33 placement 只能是 local / byom_daemon / cloud_sandbox", () => {
  const c = mk().contacts.get("c-mi")!;
  assert.equal(briefFor(c, { task: "t", rules: [], tools: [], credentialRefs: [], placement: "cloud_sandbox" }).ok, true);
  assert.equal(briefFor(c, { task: "t", rules: [], tools: [], credentialRefs: [], placement: "mars" as never }).ok, false);
});

test("定时是联系人的承诺:必须带时区和允许误差", () => {
  const c = mk().contacts.get("c-mi")!;
  const ok = commit(c, { id: "k1", sourceSeq: 10, text: "每天 8 点总结 Telegram 群", boundTaskIds: [], schedule: daily8 });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.contact.commitments[0], { id: "k1", sourceSeq: 10, text: "每天 8 点总结 Telegram 群", boundTaskIds: [], awaitingReport: [], reportedTaskIds: [], schedule: daily8, status: "active" });
  assert.equal(commit(c, { id: "k2", sourceSeq: 11, text: "x", boundTaskIds: [], schedule: { cron: "0 8 * * *", tz: "", toleranceSec: 60 } }).ok, false);
  assert.equal(commit(c, { id: "k3", sourceSeq: 12, text: "x", boundTaskIds: [], schedule: { cron: "0 8 * * *", tz: "Asia/Shanghai", toleranceSec: -1 } }).ok, false);
  for (const toleranceSec of [Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(commit(c, { id: "k6", sourceSeq: 15, text: "x", boundTaskIds: [], schedule: { cron: "0 8 * * *", tz: "Asia/Shanghai", toleranceSec } }).ok, false, String(toleranceSec));
  assert.equal(commit(c, { id: "k4", sourceSeq: 13, text: "x", boundTaskIds: [], schedule: { cron: "每天八点", tz: "Asia/Shanghai", toleranceSec: 60 } }).ok, false);
  assert.equal(commit(c, { id: "k5", sourceSeq: 14, text: "x", boundTaskIds: [], schedule: { cron: "0 8 * * *", tz: "Mars/Base", toleranceSec: 60 } }).ok, false);
});

test("承诺 id 不能重复", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "a", boundTaskIds: [], schedule: null });
  assert.ok(a.ok);
  assert.equal(a.ok && commit(a.contact, { id: "k1", sourceSeq: 2, text: "b", boundTaskIds: [], schedule: null }).ok, false);
});

test("AC-31⑤ 绑定任务全部终态但末次汇报还没发出,承诺仍有效;同一状态只补上发送确认就回收", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 200, text: "有进度就汇报", boundTaskIds: ["T_A", "T_B"], schedule: null });
  assert.ok(a.ok);
  const half = settleTask(a.ok ? a.contact : (null as never), "T_A");
  const ended = settleTask(half, "T_B");
  assert.deepEqual(ended.commitments[0], { id: "k1", sourceSeq: 200, text: "有进度就汇报", boundTaskIds: [], awaitingReport: ["T_A", "T_B"], reportedTaskIds: [], schedule: null, status: "active" });
  const oneReported = confirmFinalReport(ended, rc("T_A"));
  assert.equal(oneReported.commitments[0]?.status, "active");
  assert.equal(confirmFinalReport(oneReported, rc("T_X")).commitments[0]?.status, "active");
  const done = confirmFinalReport(oneReported, rc("T_B"));
  assert.equal(done.commitments[0]?.status, "done");
  assert.deepEqual(done.commitments[0]?.awaitingReport, []);
});

test("AC-31⑤ 承诺回收后不污染后续任务:旧专职锁解除,新派的活正常接,旧承诺不能再被锁定", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 200, text: "只盯 T_A", boundTaskIds: ["T_A"], schedule: null });
  assert.ok(a.ok);
  const f = setFocus(a.ok ? a.contact : (null as never), { onlyCommitmentId: "k1" });
  assert.ok(f.ok);
  const locked = f.ok ? f.contact : (null as never);
  const newWork = { kind: "work", text: "T_A2 写周报", commitmentId: null } as const;
  assert.equal(decideUnderFocus(locked, newWork), "decline-focused");
  const after = confirmFinalReport(settleTask(locked, "T_A"), rc("T_A"));
  assert.equal(after.focus, null);
  assert.equal(decideUnderFocus(after, newWork), "handle");
  assert.equal(setFocus(after, { onlyCommitmentId: "k1" }).ok, false);
  const k2 = commit(after, { id: "k2", sourceSeq: 300, text: "T_A2", boundTaskIds: ["T_A2"], schedule: null });
  assert.equal(k2.ok && k2.contact.commitments.find((k) => k.id === "k2")?.status, "active");
});

test("AC-31⑤ 定时承诺不随任务结束回收(阴性对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "每天 8 点", boundTaskIds: ["T_A"], schedule: daily8 });
  assert.ok(a.ok);
  const after = confirmFinalReport(settleTask(a.ok ? a.contact : (null as never), "T_A"), rc("T_A"));
  assert.deepEqual(after.commitments[0], { id: "k1", sourceSeq: 1, text: "每天 8 点", boundTaskIds: ["T_A"], awaitingReport: [], reportedTaskIds: [], schedule: daily8, status: "active" });
});

test("AC-31⑤ 别的任务的汇报确认不回收无关承诺(阴性对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "常驻承诺", boundTaskIds: [], schedule: null });
  assert.ok(a.ok);
  assert.equal(confirmFinalReport(a.ok ? a.contact : (null as never), rc("T_X")).commitments[0]?.status, "active");
});

test("AC-35① 专职锁:职责内的活照接,越界派活婉拒,无关闲聊忽略,停止/撤销/改时间照样处理", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "每天 8 点总结 Telegram G1", boundTaskIds: [], schedule: daily8 });
  assert.ok(a.ok);
  const f = setFocus(a.ok ? a.contact : (null as never), { onlyCommitmentId: "k1" });
  assert.ok(f.ok);
  const c = f.ok ? f.contact : (null as never);
  assert.equal(decideUnderFocus(c, { kind: "chatter", text: "今天天气不错" }), "ignore");
  assert.equal(decideUnderFocus(c, { kind: "work", text: "总结 Telegram G1", commitmentId: "k1" }), "handle");
  assert.equal(decideUnderFocus(c, { kind: "work", text: "总结 Telegram G1", commitmentId: null }), "decline-focused");
  assert.equal(decideUnderFocus(c, { kind: "work", text: "帮我写个前端页面", commitmentId: "k9" }), "decline-focused");
  for (const action of ["stop", "revoke", "reschedule"] as const) {
    assert.equal(decideUnderFocus(c, { kind: "control", action, commitmentId: "k1" }), "handle");
    assert.equal(decideUnderFocus(c, { kind: "control", action, commitmentId: "k9" }), "handle");
  }
});

test("AC-35① 没有专职锁时派活正常处理(阴性对照)", () => {
  assert.equal(decideUnderFocus(mk().contacts.get("c-mi")!, { kind: "work", text: "帮我写个前端页面", commitmentId: null }), "handle");
});

test("AC-35① 撤销被锁定的承诺,专职锁随之解除", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "每天 8 点", boundTaskIds: [], schedule: daily8 });
  const f = setFocus(a.ok ? a.contact : (null as never), { onlyCommitmentId: "k1" });
  const r = revokeCommitment(f.ok ? f.contact : (null as never), "k1");
  assert.ok(r.ok);
  assert.equal(r.ok && r.contact.commitments[0]?.status, "revoked");
  assert.equal(r.ok && r.contact.focus, null);
  assert.equal(r.ok && revokeCommitment(r.contact, "k1").ok, false);
});

test("专职锁只能指向自己身上有效的承诺,已回收的也不行", () => {
  assert.equal(setFocus(mk().contacts.get("c-mi")!, { onlyCommitmentId: "nope" }).ok, false);
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "x", boundTaskIds: ["T1"], schedule: null });
  const gone = confirmFinalReport(settleTask(a.ok ? a.contact : (null as never), "T1"), rc("T1"));
  assert.equal(setFocus(gone, { onlyCommitmentId: "k1" }).ok, false);
  assert.equal(setFocus(a.ok ? a.contact : (null as never), { onlyCommitmentId: "k1" }).ok, true);
});

test("联系人更新不改入参目录", () => {
  const d = mk();
  const saved = JSON.stringify([...d.contacts]);
  const r = updateContact(d, "c-mi", { memory: "新记忆" });
  assert.ok(r.ok);
  assert.equal(JSON.stringify([...d.contacts]), saved);
});

test("CH-05 末次汇报确认先于终态到达:不被吞掉,任务终态后立即回收并解除旧锁;重复确认与重复终态幂等", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "进度汇报", boundTaskIds: ["T1"], schedule: null });
  const f = setFocus(a.ok ? a.contact : (null as never), { onlyCommitmentId: "k1" });
  assert.ok(f.ok);
  const reported = confirmFinalReport(f.ok ? f.contact : (null as never), rc("T1"));
  assert.deepEqual(reported.commitments[0], { id: "k1", sourceSeq: 1, text: "进度汇报", boundTaskIds: ["T1"], awaitingReport: [], reportedTaskIds: ["T1"], schedule: null, status: "active" });
  assert.deepEqual(reported.focus, { onlyCommitmentId: "k1" });
  const replayed = confirmFinalReport(reported, rc("T1"));
  assert.deepEqual(replayed.commitments[0]?.reportedTaskIds, ["T1"]);
  const ended = settleTask(replayed, "T1");
  assert.deepEqual(ended.commitments[0], { id: "k1", sourceSeq: 1, text: "进度汇报", boundTaskIds: [], awaitingReport: [], reportedTaskIds: [], schedule: null, status: "done" });
  assert.equal(ended.focus, null);
  assert.equal(decideUnderFocus(ended, { kind: "work", text: "新活", commitmentId: null }), "handle");
  assert.deepEqual(confirmFinalReport(settleTask(ended, "T1"), rc("T1")).commitments[0], ended.commitments[0]);
});

test("CH-05 先终态后确认的顺序照旧回收(对照),确认重放不改结果", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "进度汇报", boundTaskIds: ["T1"], schedule: null });
  const f = setFocus(a.ok ? a.contact : (null as never), { onlyCommitmentId: "k1" });
  const ended = settleTask(f.ok ? f.contact : (null as never), "T1");
  assert.deepEqual(ended.commitments[0]?.awaitingReport, ["T1"]);
  assert.equal(ended.commitments[0]?.status, "active");
  assert.deepEqual(ended.focus, { onlyCommitmentId: "k1" });
  const done = confirmFinalReport(ended, rc("T1"));
  assert.equal(done.commitments[0]?.status, "done");
  assert.equal(done.focus, null);
  assert.deepEqual(confirmFinalReport(done, rc("T1")).commitments[0], done.commitments[0]);
});

test("CH-05 跨任务负对照:先确认的任务不替别的任务放行,无关任务的确认不被记下", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "两件事都汇报", boundTaskIds: ["T1", "T2"], schedule: null });
  const b = commit(a.ok ? a.contact : (null as never), { id: "k2", sourceSeq: 2, text: "另一件", boundTaskIds: ["T9"], schedule: null });
  const f = setFocus(b.ok ? b.contact : (null as never), { onlyCommitmentId: "k1" });
  const early = confirmFinalReport(confirmFinalReport(f.ok ? f.contact : (null as never), rc("T1")), rc("T_X"));
  assert.deepEqual(early.commitments.map((k) => k.reportedTaskIds), [["T1"], []]);
  const t2 = settleTask(early, "T2");
  assert.deepEqual(t2.commitments[0], { id: "k1", sourceSeq: 1, text: "两件事都汇报", boundTaskIds: ["T1"], awaitingReport: ["T2"], reportedTaskIds: ["T1"], schedule: null, status: "active" });
  const t1 = settleTask(t2, "T1");
  assert.equal(t1.commitments[0]?.status, "active");
  assert.deepEqual(t1.commitments[0]?.awaitingReport, ["T2"]);
  assert.deepEqual(t1.focus, { onlyCommitmentId: "k1" });
  const done = confirmFinalReport(t1, rc("T2"));
  assert.equal(done.commitments[0]?.status, "done");
  assert.equal(done.commitments[1]?.status, "active");
  assert.deepEqual(done.commitments[1]?.boundTaskIds, ["T9"]);
});

test("CH-05 定时承诺的绑定任务先确认汇报也不回收、不记录(阴性对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "每天 8 点", boundTaskIds: ["T_A"], schedule: daily8 });
  const after = settleTask(confirmFinalReport(a.ok ? a.contact : (null as never), rc("T_A")), "T_A");
  assert.deepEqual(after.commitments[0], { id: "k1", sourceSeq: 1, text: "每天 8 点", boundTaskIds: ["T_A"], awaitingReport: [], reportedTaskIds: [], schedule: daily8, status: "active" });
});

test("CH-06 已登记为 Compute 专用的脚本不能再以同名登记成直接工具;别的有界工具照常可授(阴性对照)", () => {
  const a = grantComputeAsset(mk().contacts.get("c-mi")!, { name: "workspace_script", kind: "script" });
  assert.ok(a.ok);
  const asset = a.ok ? a.contact : (null as never);
  const r = grantTool(asset, { name: "workspace_script", bounded: true });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /^workspace_script 已登记为只给 Compute 用的能力资产/);
  assert.equal(canCallDirectly(asset, "workspace_script"), false);
  const w = grantTool(asset, { name: "get_weather", bounded: true });
  assert.deepEqual(w.ok && w.contact.tools.map((t) => t.name), ["get_weather"]);
  assert.deepEqual(w.ok && w.contact.computeAssets.map((x) => x.name), ["workspace_script"]);
});

test("CH-07 空名或仅空白的工具不能授为直接工具,也不能写进 Compute 说明;有效名照常(阴性对照)", () => {
  const c = mk().contacts.get("c-mi")!;
  for (const name of ["", "   ", "\t"]) {
    const r = grantTool(c, { name, bounded: true });
    assert.equal(r.ok, false, JSON.stringify(name));
    assert.match(!r.ok ? r.reason : "", /^工具名不能为空$/);
    const b = briefFor(c, { task: "t", rules: [], tools: [name], credentialRefs: [] });
    assert.match(!b.ok ? b.reason : "", /^派给 Compute 的工具名不能为空$/, JSON.stringify(name));
  }
  const ok = grantTool(c, { name: "get_weather", bounded: true });
  assert.equal(ok.ok && canCallDirectly(ok.contact, "get_weather"), true);
  assert.equal(ok.ok && briefFor(ok.contact, { task: "t", rules: [], tools: ["get_weather"], credentialRefs: [] }).ok, true);
});

test("CH-08 一个任务终态且已汇报、另一个仍在跑:承诺不回收,专职锁不解", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 45, text: "两件事", boundTaskIds: ["T_A", "T_B"], schedule: null });
  const f = setFocus(a.ok ? a.contact : (null as never), { onlyCommitmentId: "k1" });
  const half = confirmFinalReport(settleTask(f.ok ? f.contact : (null as never), "T_A"), rc("T_A"));
  assert.equal(half.commitments[0]?.status, "active");
  assert.deepEqual(half.commitments[0]?.boundTaskIds, ["T_B"]);
  assert.deepEqual(half.focus, { onlyCommitmentId: "k1" });
  const done = confirmFinalReport(settleTask(half, "T_B"), rc("T_B"));
  assert.equal(done.commitments[0]?.status, "done");
  assert.equal(done.focus, null);
});

test("CH-08 Compute 说明原样保留多条群规和多项凭据引用", () => {
  const rules = ["必须先问", "不得泄露用户秘密", "周末不打扰"];
  const credentialRefs = ["vault://mail/1", "vault://news/2"];
  const r = briefFor(mk().contacts.get("c-mi")!, { task: "交付", rules, tools: [], credentialRefs });
  assert.deepEqual(r.ok && r.brief.rules, rules);
  assert.deepEqual(r.ok && r.brief.credentialRefs, credentialRefs);
});

test("CH-08 定时允许误差 0 秒合法(非负含 0),负数仍被拒(对照)", () => {
  const c = mk().contacts.get("c-mi")!;
  const zero = commit(c, { id: "z", sourceSeq: 7, text: "零容差", boundTaskIds: [], schedule: { cron: "0 8 * * *", tz: "Asia/Shanghai", toleranceSec: 0 } });
  assert.equal(zero.ok && zero.contact.commitments[0]?.schedule?.toleranceSec, 0);
  assert.equal(commit(c, { id: "n", sourceSeq: 8, text: "负", boundTaskIds: [], schedule: { cron: "0 8 * * *", tz: "Asia/Shanghai", toleranceSec: -0.5 } }).ok, false);
});

test("CH-08 撤销或回收别的承诺不解除当前承诺的专职锁", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "other", sourceSeq: 1, text: "别的", boundTaskIds: ["T_X"], schedule: null });
  const b = commit(a.ok ? a.contact : (null as never), { id: "target", sourceSeq: 2, text: "专职", boundTaskIds: ["T_Y"], schedule: null });
  const f = setFocus(b.ok ? b.contact : (null as never), { onlyCommitmentId: "target" });
  const locked = f.ok ? f.contact : (null as never);
  const revoked = revokeCommitment(locked, "other");
  assert.equal(revoked.ok && revoked.contact.commitments[0]?.status, "revoked");
  assert.deepEqual(revoked.ok && revoked.contact.focus, { onlyCommitmentId: "target" });
  const retired = confirmFinalReport(settleTask(locked, "T_X"), rc("T_X", ["other"]));
  assert.equal(retired.commitments[0]?.status, "done");
  assert.deepEqual(retired.focus, { onlyCommitmentId: "target" });
});

test("CH-09 同一任务两条承诺:只履行旧承诺的迟到回执不替新承诺放行,新承诺的锁不解", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kA", sourceSeq: 100, text: "T1 汇报到群 A", boundTaskIds: ["T1"], schedule: null });
  const b = commit(a.ok ? a.contact : (null as never), { id: "kB", sourceSeq: 200, text: "T1 汇报到群 B", boundTaskIds: ["T1"], schedule: null });
  const f = setFocus(b.ok ? b.contact : (null as never), { onlyCommitmentId: "kB" });
  const lateOld = confirmFinalReport(f.ok ? f.contact : (null as never), rc("T1", ["kA"], 150));
  assert.deepEqual(lateOld.commitments.map((k) => k.reportedTaskIds), [["T1"], []]);
  const ended = settleTask(lateOld, "T1");
  assert.deepEqual(ended.commitments.map((k) => k.status), ["done", "active"]);
  assert.deepEqual(ended.commitments[1]?.awaitingReport, ["T1"]);
  assert.deepEqual(ended.focus, { onlyCommitmentId: "kB" });
  assert.equal(decideUnderFocus(ended, { kind: "work", text: "职责外新活", commitmentId: null }), "decline-focused");
  const done = confirmFinalReport(ended, rc("T1", ["kB"], 250));
  assert.deepEqual(done.commitments.map((k) => k.status), ["done", "done"]);
  assert.equal(done.focus, null);
});

test("CH-09 回执依据位置早于承诺出处时,即使点名这条承诺也不算数;依据位置不早于出处才算(对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kB", sourceSeq: 200, text: "T1 汇报到群 B", boundTaskIds: ["T1"], schedule: null });
  const ended = settleTask(a.ok ? a.contact : (null as never), "T1");
  const stale = confirmFinalReport(ended, rc("T1", ["kB"], 199));
  assert.deepEqual(stale.commitments[0], ended.commitments[0]);
  const fresh = confirmFinalReport(ended, rc("T1", ["kB"], 200));
  assert.equal(fresh.commitments[0]?.status, "done");
});

test("CH-09 一条汇报经宿主明确判定覆盖两条承诺:两条都生效;先确认后终态与先终态后确认结果一致,重放不变", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kA", sourceSeq: 100, text: "群 A", boundTaskIds: ["T1"], schedule: null });
  const b = commit(a.ok ? a.contact : (null as never), { id: "kB", sourceSeq: 200, text: "群 B", boundTaskIds: ["T1"], schedule: null });
  const base = b.ok ? b.contact : (null as never);
  const both = rc("T1", ["kA", "kB"], 300);
  const early = settleTask(confirmFinalReport(base, both), "T1");
  const late = confirmFinalReport(settleTask(base, "T1"), both);
  assert.deepEqual(early.commitments.map((k) => k.status), ["done", "done"]);
  assert.deepEqual(late.commitments, early.commitments);
  assert.deepEqual(confirmFinalReport(late, both).commitments, late.commitments);
});

test("CH-10 空名或仅空白的 Compute 能力资产不能登记;合法具名资产照常登记并可派出(阴性对照)", () => {
  const c = mk().contacts.get("c-mi")!;
  for (const name of ["", "   ", "\t"]) {
    const r = grantComputeAsset(c, { name, kind: "script" });
    assert.equal(r.ok, false, JSON.stringify(name));
    assert.match(!r.ok ? r.reason : "", /^能力资产名不能为空$/);
  }
  const ok = grantComputeAsset(c, { name: "valid-script", kind: "script" });
  assert.deepEqual(ok.ok && ok.contact.computeAssets, [{ name: "valid-script", kind: "script" }]);
  assert.equal(ok.ok && briefFor(ok.contact, { task: "t", rules: [], tools: ["valid-script"], credentialRefs: [] }).ok, true);
});

test("CH-11 已撤销承诺:迟到的汇报确认不再记录,迟到的终态不把 revoked 改成 done", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "汇报", boundTaskIds: ["T1"], schedule: null });
  const revoked = revokeCommitment(a.ok ? a.contact : (null as never), "k1");
  assert.ok(revoked.ok);
  const lateReceipt = confirmFinalReport(revoked.ok ? revoked.contact : (null as never), rc("T1"));
  assert.deepEqual(lateReceipt.commitments[0], { id: "k1", sourceSeq: 1, text: "汇报", boundTaskIds: ["T1"], awaitingReport: [], reportedTaskIds: [], schedule: null, status: "revoked" });
  const early = confirmFinalReport(a.ok ? a.contact : (null as never), rc("T1"));
  const r2 = revokeCommitment(early, "k1");
  const lateEnd = settleTask(r2.ok ? r2.contact : (null as never), "T1");
  assert.deepEqual(lateEnd.commitments[0], { id: "k1", sourceSeq: 1, text: "汇报", boundTaskIds: ["T1"], awaitingReport: [], reportedTaskIds: ["T1"], schedule: null, status: "revoked" });
});

test("CH-11 Compute 说明保留全部已授权工具", () => {
  const a = grantTool(mk().contacts.get("c-mi")!, { name: "get_weather", bounded: true });
  const b = grantComputeAsset(a.ok ? a.contact : (null as never), { name: "get_ip", kind: "mcp" });
  const r = briefFor(b.ok ? b.contact : (null as never), { task: "两项查询", rules: [], tools: ["get_weather", "get_ip"], credentialRefs: [] });
  assert.deepEqual(r.ok && r.brief.tools, ["get_weather", "get_ip"]);
});

test("CH-11 双任务乱序:先终态 A、B 再先确认 B 只移除 B;先确认 A、B 再先终态 B 只消耗 B 的确认", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "两件事", boundTaskIds: ["A", "B"], schedule: null });
  const base = a.ok ? a.contact : (null as never);
  const endedFirst = confirmFinalReport(settleTask(settleTask(base, "A"), "B"), rc("B"));
  assert.deepEqual(endedFirst.commitments[0]?.awaitingReport, ["A"]);
  assert.equal(endedFirst.commitments[0]?.status, "active");
  assert.equal(confirmFinalReport(endedFirst, rc("A")).commitments[0]?.status, "done");
  const reportedFirst = settleTask(confirmFinalReport(confirmFinalReport(base, rc("A")), rc("B")), "B");
  assert.deepEqual(reportedFirst.commitments[0]?.reportedTaskIds, ["A"]);
  assert.deepEqual(reportedFirst.commitments[0]?.boundTaskIds, ["A"]);
  const done = settleTask(reportedFirst, "A");
  assert.equal(done.commitments[0]?.status, "done");
  assert.deepEqual(done.commitments[0]?.reportedTaskIds, []);
});

test("CH-09 两条承诺出处都早于汇报依据位置,回执只点名 kA:只有 kA 生效,kB 仍等自己的回执", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kA", sourceSeq: 100, text: "群 A", boundTaskIds: ["T1"], schedule: null });
  const b = commit(a.ok ? a.contact : (null as never), { id: "kB", sourceSeq: 200, text: "群 B", boundTaskIds: ["T1"], schedule: null });
  const ended = settleTask(b.ok ? b.contact : (null as never), "T1");
  const onlyA = confirmFinalReport(ended, rc("T1", ["kA"], 300));
  assert.deepEqual(onlyA.commitments.map((k) => k.status), ["done", "active"]);
  assert.deepEqual(onlyA.commitments[1]?.awaitingReport, ["T1"]);
  const early = confirmFinalReport(b.ok ? b.contact : (null as never), rc("T1", ["kA"], 300));
  assert.deepEqual(early.commitments.map((k) => k.reportedTaskIds), [["T1"], []]);
});
