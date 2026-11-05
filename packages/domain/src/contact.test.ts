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

test("CH-12 承诺出处必须是非负整数消息位置:NaN、Infinity、负数、小数被拒;0 与正整数照常(对照)", () => {
  const c = mk().contacts.get("c-mi")!;
  for (const sourceSeq of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    const r = commit(c, { id: "k", sourceSeq, text: "x", boundTaskIds: ["T1"], schedule: null });
    assert.equal(r.ok, false, String(sourceSeq));
    assert.match(!r.ok ? r.reason : "", /不是合法的消息位置/, String(sourceSeq));
  }
  for (const sourceSeq of [0, 200]) assert.equal(commit(c, { id: "k", sourceSeq, text: "x", boundTaskIds: ["T1"], schedule: null }).ok, true, String(sourceSeq));
});

test("CH-12 回执依据位置不是非负整数时不确认、不回收、不解锁;同一回执换成合法位置才生效(对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kB", sourceSeq: 200, text: "T1 汇报到群 B", boundTaskIds: ["T1"], schedule: null });
  const f = setFocus(a.ok ? a.contact : (null as never), { onlyCommitmentId: "kB" });
  const locked = f.ok ? f.contact : (null as never);
  const ended = settleTask(locked, "T1");
  for (const basedOnSeq of [Number.NaN, Number.POSITIVE_INFINITY, -1, 200.5]) {
    const early = confirmFinalReport(locked, rc("T1", ["kB"], basedOnSeq));
    assert.deepEqual(early.commitments, locked.commitments, String(basedOnSeq));
    const afterEnd = settleTask(early, "T1");
    assert.equal(afterEnd.commitments[0]?.status, "active", String(basedOnSeq));
    assert.deepEqual(afterEnd.focus, { onlyCommitmentId: "kB" }, String(basedOnSeq));
    assert.deepEqual(confirmFinalReport(ended, rc("T1", ["kB"], basedOnSeq)).commitments, ended.commitments, String(basedOnSeq));
  }
  assert.deepEqual(confirmFinalReport(locked, rc("T1", ["kB"], 199)).commitments, locked.commitments);
  const ok = confirmFinalReport(ended, rc("T1", ["kB"], 200));
  assert.equal(ok.commitments[0]?.status, "done");
  assert.equal(ok.focus, null);
});

test("CH-13 回执作用域为空时不确认任何承诺;点名后才确认(对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kA", sourceSeq: 100, text: "汇报", boundTaskIds: ["T"], schedule: null });
  const base = a.ok ? a.contact : (null as never);
  assert.deepEqual(confirmFinalReport(base, rc("T", [], 100)).commitments, base.commitments);
  assert.deepEqual(confirmFinalReport(settleTask(base, "T"), rc("T", [], 100)).commitments[0]?.awaitingReport, ["T"]);
  assert.deepEqual(confirmFinalReport(base, rc("T", ["kA"], 100)).commitments[0]?.reportedTaskIds, ["T"]);
});

test("CH-13 同一回执点名两条承诺时逐条比较出处:出处 100 与 200、依据 150 只确认前者;顺序颠倒结果相同", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kA", sourceSeq: 100, text: "群 A", boundTaskIds: ["T"], schedule: null });
  const b = commit(a.ok ? a.contact : (null as never), { id: "kB", sourceSeq: 200, text: "群 B", boundTaskIds: ["T"], schedule: null });
  const fwd = b.ok ? b.contact : (null as never);
  const after = confirmFinalReport(fwd, rc("T", ["kA", "kB"], 150));
  assert.deepEqual(after.commitments.map((k) => k.reportedTaskIds), [["T"], []]);
  assert.deepEqual(settleTask(after, "T").commitments.map((k) => k.status), ["done", "active"]);
  const x = commit(mk().contacts.get("c-mi")!, { id: "kB", sourceSeq: 200, text: "群 B", boundTaskIds: ["T"], schedule: null });
  const y = commit(x.ok ? x.contact : (null as never), { id: "kA", sourceSeq: 100, text: "群 A", boundTaskIds: ["T"], schedule: null });
  const rev = confirmFinalReport(y.ok ? y.contact : (null as never), rc("T", ["kB", "kA"], 150));
  assert.deepEqual(rev.commitments.map((k) => [k.id, k.reportedTaskIds]), [["kB", []], ["kA", ["T"]]]);
});

test("CH-13 交错重放:先确认 T1、再 T2、再重放 T1,不重复记录;再全部终态后回收", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kA", sourceSeq: 100, text: "两件事", boundTaskIds: ["T1", "T2"], schedule: null });
  const first = confirmFinalReport(a.ok ? a.contact : (null as never), rc("T1", ["kA"], 100));
  const second = confirmFinalReport(first, rc("T2", ["kA"], 100));
  const replay = confirmFinalReport(second, rc("T1", ["kA"], 100));
  assert.deepEqual(replay.commitments[0]?.reportedTaskIds, ["T1", "T2"]);
  assert.deepEqual(replay.commitments, second.commitments);
  const done = settleTask(settleTask(replay, "T1"), "T2");
  assert.equal(done.commitments[0]?.status, "done");
  assert.deepEqual(done.commitments[0]?.reportedTaskIds, []);
});

test("CH-13 换行、回车、非断行空格等任何空白组成的名字都不能登记为 Compute 能力资产或直接工具;夹空白的有效名照常(对照)", () => {
  const c = mk().contacts.get("c-mi")!;
  for (const name of ["\n", "\r", "\u00a0", " \n\t\u00a0", "\u3000"]) {
    assert.equal(grantComputeAsset(c, { name, kind: "script" }).ok, false, JSON.stringify(name));
    assert.equal(grantTool(c, { name, bounded: true }).ok, false, JSON.stringify(name));
  }
  const ok = grantComputeAsset(c, { name: "my script", kind: "script" });
  assert.deepEqual(ok.ok && ok.contact.computeAssets.map((x) => x.name), ["my script"]);
});

test("CH-14 同名不同类的 Compute 能力资产第二次登记明确拒绝,原资产不变;两种顺序都一样", () => {
  for (const [first, second] of [["mcp", "skill"], ["skill", "mcp"], ["mcp", "script"]] as const) {
    const a = grantComputeAsset(mk().contacts.get("c-mi")!, { name: "research", kind: first });
    assert.ok(a.ok);
    const base = a.ok ? a.contact : (null as never);
    const r = grantComputeAsset(base, { name: "research", kind: second });
    assert.equal(r.ok, false, `${first}→${second}`);
    assert.match(!r.ok ? r.reason : "", new RegExp(`^research 已登记为 ${first} 类能力资产,不能再以 ${second} 类同名登记$`));
    assert.deepEqual(base.computeAssets, [{ name: "research", kind: first }]);
  }
});

test("CH-14 同名同类的 Compute 能力资产重复登记幂等成功;不同名不同类照常并存(对照)", () => {
  const a = grantComputeAsset(mk().contacts.get("c-mi")!, { name: "research", kind: "mcp" });
  const again = grantComputeAsset(a.ok ? a.contact : (null as never), { name: "research", kind: "mcp" });
  assert.deepEqual(again.ok && again.contact.computeAssets, [{ name: "research", kind: "mcp" }]);
  const other = grantComputeAsset(again.ok ? again.contact : (null as never), { name: "summarize", kind: "skill" });
  assert.deepEqual(other.ok && other.contact.computeAssets, [{ name: "research", kind: "mcp" }, { name: "summarize", kind: "skill" }]);
});

test("CH-15 消息位置以安全整数为界:MAX_SAFE_INTEGER 合法,+1 与更大值被拒;回执依据位置同样以此为界", () => {
  const c = mk().contacts.get("c-mi")!;
  const max = commit(c, { id: "k", sourceSeq: Number.MAX_SAFE_INTEGER, text: "x", boundTaskIds: ["T"], schedule: null });
  assert.equal(max.ok && max.contact.commitments[0]?.sourceSeq, Number.MAX_SAFE_INTEGER);
  for (const sourceSeq of [Number.MAX_SAFE_INTEGER + 1, 2 ** 60]) assert.equal(commit(c, { id: "k", sourceSeq, text: "x", boundTaskIds: ["T"], schedule: null }).ok, false, String(sourceSeq));
  const k = commit(c, { id: "k", sourceSeq: 5, text: "x", boundTaskIds: ["T"], schedule: null });
  const ended = settleTask(k.ok ? k.contact : (null as never), "T");
  assert.deepEqual(confirmFinalReport(ended, rc("T", ["k"], Number.MAX_SAFE_INTEGER + 1)).commitments, ended.commitments);
  assert.equal(confirmFinalReport(ended, rc("T", ["k"], Number.MAX_SAFE_INTEGER)).commitments[0]?.status, "done");
});

test("CH-15 -0 按位置 0 处理(合法);负的最小值被拒(对照)", () => {
  const c = mk().contacts.get("c-mi")!;
  assert.equal(commit(c, { id: "k", sourceSeq: -0, text: "x", boundTaskIds: ["T"], schedule: null }).ok, true);
  assert.equal(commit(c, { id: "k", sourceSeq: Number.MIN_SAFE_INTEGER, text: "x", boundTaskIds: ["T"], schedule: null }).ok, false);
});

test("CH-15 已撤销的承诺不能重新加专职锁,已回收的也不能;有效承诺可以(对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k", sourceSeq: 1, text: "x", boundTaskIds: ["T"], schedule: null });
  const base = a.ok ? a.contact : (null as never);
  assert.equal(setFocus(base, { onlyCommitmentId: "k" }).ok, true);
  const revoked = revokeCommitment(base, "k");
  const r = setFocus(revoked.ok ? revoked.contact : (null as never), { onlyCommitmentId: "k" });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /不存在或已结束/);
});

test("CH-15 已回收(done)的承诺不能被撤销改写成 revoked;有效承诺可以撤销(对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k", sourceSeq: 1, text: "x", boundTaskIds: ["T"], schedule: null });
  const base = a.ok ? a.contact : (null as never);
  const done = confirmFinalReport(settleTask(base, "T"), rc("T", ["k"], 1));
  assert.equal(done.commitments[0]?.status, "done");
  const r = revokeCommitment(done, "k");
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /不存在或已结束/);
  assert.equal(done.commitments[0]?.status, "done");
  const ok = revokeCommitment(base, "k");
  assert.equal(ok.ok && ok.contact.commitments[0]?.status, "revoked");
});

/** 规格里 Compute 能力资产的全部类别(ComputeAsset.kind),独立列出,不取自被测实现。 */
const ASSET_KINDS = ["mcp", "skill", "script"] as const;

test("CH-16 同名资产 3×3 类别组合:同类重复登记幂等(只留一项),异类第二次登记明确拒绝且原资产不变", () => {
  for (const first of ASSET_KINDS) {
    for (const second of ASSET_KINDS) {
      const label = `${first}→${second}`;
      const a = grantComputeAsset(mk().contacts.get("c-mi")!, { name: "research", kind: first });
      assert.ok(a.ok, label);
      const base = a.ok ? a.contact : (null as never);
      const r = grantComputeAsset(base, { name: "research", kind: second });
      if (first === second) {
        assert.equal(r.ok, true, label);
        assert.deepEqual(r.ok && r.contact.computeAssets, [{ name: "research", kind: first }], label);
      } else {
        assert.equal(r.ok, false, label);
        assert.match(!r.ok ? r.reason : "", new RegExp(`^research 已登记为 ${first} 类能力资产,不能再以 ${second} 类同名登记$`), label);
      }
      assert.deepEqual(base.computeAssets, [{ name: "research", kind: first }], label);
    }
  }
});

test("CH-16 每类登记两个不同名资产都并存,且都能派给 Compute;未登记的同类名字仍被拒(对照)", () => {
  for (const kind of ASSET_KINDS) {
    const a = grantComputeAsset(mk().contacts.get("c-mi")!, { name: `${kind}-one`, kind });
    const b = grantComputeAsset(a.ok ? a.contact : (null as never), { name: `${kind}-two`, kind });
    assert.ok(b.ok, kind);
    const c = b.ok ? b.contact : (null as never);
    assert.deepEqual(c.computeAssets, [{ name: `${kind}-one`, kind }, { name: `${kind}-two`, kind }], kind);
    const brief = briefFor(c, { task: "t", rules: [], tools: [`${kind}-one`, `${kind}-two`], credentialRefs: [] });
    assert.deepEqual(brief.ok && brief.brief.tools, [`${kind}-one`, `${kind}-two`], kind);
    assert.equal(canCallDirectly(c, `${kind}-one`), false, kind);
    assert.equal(canCallDirectly(c, `${kind}-two`), false, kind);
    const extra = briefFor(c, { task: "t", rules: [], tools: [`${kind}-three`], credentialRefs: [] });
    assert.match(!extra.ok ? extra.reason : "", new RegExp(`${kind}-three 超出联系人 c-mi 的授权集合`), kind);
  }
});

test("CH-16 名字按全名精确匹配:前缀相同的不同名资产无论先后各自独立登记、各自判重", () => {
  for (const kind of ASSET_KINDS) {
    const a = grantComputeAsset(mk().contacts.get("c-mi")!, { name: "research-news", kind });
    const b = grantComputeAsset(a.ok ? a.contact : (null as never), { name: "research", kind });
    assert.deepEqual(b.ok && b.contact.computeAssets.map((x) => x.name), ["research-news", "research"], kind);
    const c = grantComputeAsset(b.ok ? b.contact : (null as never), { name: "research-news", kind });
    assert.deepEqual(c.ok && c.contact.computeAssets.map((x) => x.name), ["research-news", "research"], kind);
    const other = ASSET_KINDS.find((k) => k !== kind)!;
    const clash = grantComputeAsset(b.ok ? b.contact : (null as never), { name: "research", kind: other });
    assert.equal(clash.ok, false, `${kind}/${other}`);
    const shortFirst = grantComputeAsset(mk().contacts.get("c-mi")!, { name: "research", kind });
    const longSecond = grantComputeAsset(shortFirst.ok ? shortFirst.contact : (null as never), { name: "research-news", kind: other });
    assert.deepEqual(longSecond.ok && longSecond.contact.computeAssets, [{ name: "research", kind }, { name: "research-news", kind: other }], `短名在先 ${kind}/${other}`);
  }
});

test("CH-16 直接工具与每类资产同名双向互斥;不同名的直接工具与资产照常并存(对照)", () => {
  for (const kind of ASSET_KINDS) {
    const asset = grantComputeAsset(mk().contacts.get("c-mi")!, { name: "dual", kind });
    const toTool = grantTool(asset.ok ? asset.contact : (null as never), { name: "dual", bounded: true });
    assert.equal(toTool.ok, false, kind);
    assert.match(!toTool.ok ? toTool.reason : "", /^dual 已登记为只给 Compute 用的能力资产/, kind);
    const tool = grantTool(mk().contacts.get("c-mi")!, { name: "dual", bounded: true });
    const toAsset = grantComputeAsset(tool.ok ? tool.contact : (null as never), { name: "dual", kind });
    assert.equal(toAsset.ok, false, kind);
    assert.match(!toAsset.ok ? toAsset.reason : "", /^dual 已是直接工具/, kind);
    const both = grantComputeAsset(tool.ok ? tool.contact : (null as never), { name: "dual-asset", kind });
    assert.deepEqual(both.ok && [both.contact.tools.map((t) => t.name), both.contact.computeAssets.map((x) => x.name)], [["dual"], ["dual-asset"]], kind);
  }
});

test("CH-17 说明生成后改调用方的 rules/tools/credentialRefs 数组,说明不受影响;同时改三项也一样", () => {
  const g = grantTool(mk().contacts.get("c-mi")!, { name: "get_weather", bounded: true });
  const c = g.ok ? g.contact : (null as never);
  const fields = ["rules", "tools", "credentialRefs"] as const;
  const mutateInput: Record<(typeof fields)[number], (a: string[]) => void> = {
    rules: (a) => { a.length = 0; a.push("被调用方改掉的规则"); },
    tools: (a) => { a.push("run_command"); },
    credentialRefs: (a) => { a.push("plaintext-secret"); },
  };
  for (const which of [...fields.map((f) => [f]), fields]) {
    const input = { task: "交付", rules: ["改代码前先问", "不得泄露用户秘密"], tools: ["get_weather"], credentialRefs: ["vault://mail/1"] };
    const r = briefFor(c, input);
    assert.ok(r.ok, which.join("+"));
    for (const f of which) mutateInput[f](input[f]);
    assert.deepEqual(r.ok && r.brief, { task: "交付", rules: ["改代码前先问", "不得泄露用户秘密"], tools: ["get_weather"], credentialRefs: ["vault://mail/1"], placement: "local" }, which.join("+"));
  }
});

test("CH-17 说明里的 rules/tools/credentialRefs 不能被改写,改写尝试不影响调用方入参(反方向)", () => {
  const g = grantTool(mk().contacts.get("c-mi")!, { name: "get_weather", bounded: true });
  const input = { task: "交付", rules: ["改代码前先问"], tools: ["get_weather"], credentialRefs: ["vault://mail/1"] };
  const r = briefFor(g.ok ? g.contact : (null as never), input);
  assert.ok(r.ok);
  const brief = r.ok ? r.brief : (null as never);
  for (const f of ["rules", "tools", "credentialRefs"] as const) {
    const arr = brief[f] as string[];
    assert.notEqual(arr, input[f], f);
    assert.throws(() => { arr.push("x"); }, TypeError, f);
    assert.throws(() => { arr[0] = "y"; }, TypeError, f);
  }
  assert.deepEqual(input, { task: "交付", rules: ["改代码前先问"], tools: ["get_weather"], credentialRefs: ["vault://mail/1"] });
  assert.deepEqual(brief, { task: "交付", rules: ["改代码前先问"], tools: ["get_weather"], credentialRefs: ["vault://mail/1"], placement: "local" });
});

test("CH-17 同名异类拒绝理由写出实际的资产名和两个类别(非 research 名对照)", () => {
  const a = grantComputeAsset(mk().contacts.get("c-mi")!, { name: "inbox_digest", kind: "skill" });
  const r = grantComputeAsset(a.ok ? a.contact : (null as never), { name: "inbox_digest", kind: "script" });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "inbox_digest 已登记为 skill 类能力资产,不能再以 script 类同名登记");
});

test("CH-18 入参属性用 getter 时每个属性只读一次;getter 后续返回的越权工具和明文凭据进不了说明", () => {
  const g = grantTool(mk().contacts.get("c-mi")!, { name: "get_weather", bounded: true });
  const c = g.ok ? g.contact : (null as never);
  const reads: Record<string, number> = { task: 0, rules: 0, tools: 0, credentialRefs: 0, placement: 0 };
  const seq = <T,>(field: string, values: T[]) => () => values[Math.min(reads[field]!++, values.length - 1)]!;
  const input = Object.defineProperties({}, {
    task: { get: seq("task", ["交付", "偷换的任务"]), enumerable: true },
    rules: { get: seq("rules", [["改代码前先问"], []]), enumerable: true },
    tools: { get: seq("tools", [["get_weather"], ["get_weather"], ["run_command"]]), enumerable: true },
    credentialRefs: { get: seq("credentialRefs", [["vault://mail/1"], ["plaintext-secret"]]), enumerable: true },
    placement: { get: seq("placement", ["byom_daemon", "mars"]), enumerable: true },
  }) as { task: string; rules: string[]; tools: string[]; credentialRefs: string[]; placement: "byom_daemon" };
  const r = briefFor(c, input);
  assert.deepEqual(r, { ok: true, brief: { task: "交付", rules: ["改代码前先问"], tools: ["get_weather"], credentialRefs: ["vault://mail/1"], placement: "byom_daemon" } });
  assert.deepEqual(reads, { task: 1, rules: 1, tools: 1, credentialRefs: 1, placement: 1 });
});

test("CH-18 getter 第一次就给越权工具或明文凭据:照常拒绝;稳定数据对象照常通过(对照)", () => {
  const g = grantTool(mk().contacts.get("c-mi")!, { name: "get_weather", bounded: true });
  const c = g.ok ? g.contact : (null as never);
  const badTools = briefFor(c, { task: "t", rules: [], get tools() { return ["run_command"]; }, credentialRefs: [] });
  assert.match(!badTools.ok ? badTools.reason : "", /run_command 超出联系人 c-mi 的授权集合/);
  const badRefs = briefFor(c, { task: "t", rules: [], tools: [], get credentialRefs() { return ["plaintext-secret"]; } });
  assert.match(!badRefs.ok ? badRefs.reason : "", /^凭据只能给引用句柄/);
  assert.equal(briefFor(c, { task: "t", rules: [], tools: ["get_weather"], credentialRefs: ["vault://mail/1"] }).ok, true);
});

test("CH-18 入参类型不对时明确拒绝:数组字段不是数组、数组里混了非字符串、task 不是字符串", () => {
  const c = mk().contacts.get("c-mi")!;
  const base = { task: "t", rules: [] as string[], tools: [] as string[], credentialRefs: [] as string[] };
  for (const f of ["rules", "tools", "credentialRefs"] as const) {
    const notArray = briefFor(c, { ...base, [f]: "vault://mail/1" as never });
    assert.equal(!notArray.ok && notArray.reason, `${f} 必须是字符串数组`, f);
    const mixed = briefFor(c, { ...base, [f]: ["ok", 42] as never });
    assert.equal(!mixed.ok && mixed.reason, `${f} 里只能是字符串`, f);
  }
  const badTask = briefFor(c, { ...base, task: 7 as never });
  assert.equal(!badTask.ok && badTask.reason, "task 必须是字符串");
  assert.equal(briefFor(c, base).ok, true);
});

test("CH-19 多项凭据逐项校验:合法引用后跟明文、空路径、路径含空白都拒;多个合法引用通过(对照)", () => {
  const c = mk().contacts.get("c-mi")!;
  const req = (credentialRefs: string[]) => briefFor(c, { task: "t", rules: [], tools: [], credentialRefs });
  for (const refs of [["vault://mail/1", "plaintext-secret"], ["vault://mail/1", "vault://news/2", "sk-live-123"], ["vault://"], ["vault://a b"], ["vault://mail/1", "vault://\tx"], ["vault://ok", "vault:// "]]) {
    const r = req(refs);
    assert.equal(r.ok, false, JSON.stringify(refs));
    assert.match(!r.ok ? r.reason : "", /^凭据只能给引用句柄/, JSON.stringify(refs));
  }
  for (const refs of [["vault://mail/1", "vault://news/2"], ["op://team/item", "vault://a/b/c"]]) {
    const r = req(refs);
    assert.deepEqual(r.ok && r.brief.credentialRefs, refs, JSON.stringify(refs));
  }
});

/** getter 输入夹具:按读取次数依次返回 values(读完停在最后一个),并在 reads 里计数。 */
const getterInput = (reads: Record<string, number>, spec: Record<string, readonly unknown[]>) => {
  const o = {};
  for (const [k, values] of Object.entries(spec)) {
    reads[k] = 0;
    Object.defineProperty(o, k, { enumerable: true, get: () => values[Math.min(reads[k]!++, values.length - 1)] });
  }
  return o;
};

test("CH-20 grantTool 的 name/bounded 各只读一次:getter 后续换成禁用名也存不进;首次就是禁用名或无界照常拒绝", () => {
  const c = mk().contacts.get("c-mi")!;
  const reads: Record<string, number> = {};
  const r = grantTool(c, getterInput(reads, { name: ["weather", "weather", "run_command"], bounded: [true, false] }) as never);
  assert.deepEqual(r.ok && r.contact.tools, [{ name: "weather", bounded: true }]);
  assert.equal(r.ok && canCallDirectly(r.contact, "run_command"), false);
  assert.deepEqual(reads, { name: 1, bounded: 1 });
  const banned = grantTool(c, getterInput({}, { name: ["run_command", "weather"], bounded: [true] }) as never);
  assert.equal(!banned.ok && banned.reason, "run_command 是通用能力,只能在 Compute 里用");
  const unbounded = grantTool(c, getterInput({}, { name: ["weather"], bounded: [false, true] }) as never);
  assert.match(!unbounded.ok ? unbounded.reason : "", /^weather 不是有界工具/);
});

test("CH-20 grantComputeAsset 的 name/kind 各只读一次:getter 后续换成已有直接工具名也绕不过互斥;首次就同名照常拒绝", () => {
  const w = grantTool(mk().contacts.get("c-mi")!, { name: "weather", bounded: true });
  const c = w.ok ? w.contact : (null as never);
  const reads: Record<string, number> = {};
  const r = grantComputeAsset(c, getterInput(reads, { name: ["something_else", "something_else", "weather"], kind: ["script", "mcp"] }) as never);
  assert.deepEqual(r.ok && r.contact.computeAssets, [{ name: "something_else", kind: "script" }]);
  assert.deepEqual(r.ok && r.contact.tools, [{ name: "weather", bounded: true }]);
  assert.deepEqual(reads, { name: 1, kind: 1 });
  const clash = grantComputeAsset(c, getterInput({}, { name: ["weather", "other"], kind: ["script"] }) as never);
  assert.equal(!clash.ok && clash.reason, "weather 已是直接工具,不必再登记");
  const a = grantComputeAsset(c, { name: "research", kind: "mcp" });
  const kindSwap = grantComputeAsset(a.ok ? a.contact : (null as never), getterInput({}, { name: ["research"], kind: ["skill", "mcp"] }) as never);
  assert.equal(!kindSwap.ok && kindSwap.reason, "research 已登记为 mcp 类能力资产,不能再以 skill 类同名登记");
});

test("CH-20 入参不是对象、字段类型不对、资产类别不认识:登记入口一律明确拒绝;合法输入照常(对照)", () => {
  const c = mk().contacts.get("c-mi")!;
  for (const bad of [null, "weather", ["weather"], 42]) {
    assert.equal(!grantTool(c, bad as never).ok && (grantTool(c, bad as never) as { reason: string }).reason, "直接工具 必须是对象", String(bad));
    assert.equal((grantComputeAsset(c, bad as never) as { reason: string }).reason, "能力资产 必须是对象", String(bad));
  }
  assert.equal((grantTool(c, { name: 7, bounded: true } as never) as { reason: string }).reason, "name 必须是字符串");
  assert.equal((grantTool(c, { name: "weather", bounded: "yes" } as never) as { reason: string }).reason, "bounded 必须是布尔值");
  assert.equal((grantComputeAsset(c, { name: "x", kind: "binary" } as never) as { reason: string }).reason, "未知的能力资产类别 binary");
  assert.equal((grantComputeAsset(c, { name: "x", kind: null } as never) as { reason: string }).reason, "kind 必须是字符串");
  for (const kind of ASSET_KINDS) assert.equal(grantComputeAsset(c, { name: "x", kind }).ok, true, kind);
  assert.equal(grantTool(c, { name: "weather", bounded: true }).ok, true);
});

test("CH-21 briefFor 每个字段读到立即复制:后面字段的 getter 清空或改写前面已读的数组,说明仍是首次读到的内容", () => {
  const g = grantTool(mk().contacts.get("c-mi")!, { name: "get_weather", bounded: true });
  const a = grantComputeAsset(g.ok ? g.contact : (null as never), { name: "get_ip", kind: "mcp" });
  const c = a.ok ? a.contact : (null as never);
  const rules = ["改代码前先问", "不得泄露用户秘密"];
  const tools = ["get_weather"];
  const refs = ["vault://mail/1"];
  const reads = { task: 0, rules: 0, tools: 0, credentialRefs: 0, placement: 0 };
  const input = {
    get task() { reads.task++; return "交付"; },
    get rules() { reads.rules++; return rules; },
    get tools() { reads.tools++; rules.length = 0; return tools; },
    get credentialRefs() { reads.credentialRefs++; tools.splice(0, 1, "get_ip"); return refs; },
    get placement() { reads.placement++; refs.splice(0, 1, "vault://news/2"); rules.push("偷加的规则"); return "local" as const; },
  };
  const r = briefFor(c, input);
  assert.deepEqual(r, { ok: true, brief: { task: "交付", rules: ["改代码前先问", "不得泄露用户秘密"], tools: ["get_weather"], credentialRefs: ["vault://mail/1"], placement: "local" } });
  assert.deepEqual(reads, { task: 1, rules: 1, tools: 1, credentialRefs: 1, placement: 1 });
  const stable = briefFor(c, { task: "交付", rules: ["改代码前先问", "不得泄露用户秘密"], tools: ["get_weather"], credentialRefs: ["vault://mail/1"], placement: "local" });
  assert.deepEqual(stable, r);
});

test("CH-22 placement 只有缺省或 undefined 时默认 local;显式 null、未知字符串、数字都拒绝;三种合法值原样返回", () => {
  const c = mk().contacts.get("c-mi")!;
  const base = { task: "t", rules: [] as string[], tools: [] as string[], credentialRefs: [] as string[] };
  const missing = briefFor(c, base);
  assert.equal(missing.ok && missing.brief.placement, "local");
  const undef = briefFor(c, { ...base, placement: undefined } as never);
  assert.equal(undef.ok && undef.brief.placement, "local");
  assert.equal((briefFor(c, { ...base, placement: null } as never) as { reason: string }).reason, "placement 必须是字符串");
  assert.equal((briefFor(c, { ...base, placement: 3 } as never) as { reason: string }).reason, "placement 必须是字符串");
  assert.equal((briefFor(c, { ...base, placement: "mars" } as never) as { reason: string }).reason, "未知的运行位置 mars");
  for (const placement of ["local", "byom_daemon", "cloud_sandbox"] as const) {
    const r = briefFor(c, { ...base, placement });
    assert.equal(r.ok && r.brief.placement, placement, placement);
  }
});

test("CH-23 数组字段:首项非字符串、类数组对象一律拒绝;真字符串数组照常(对照)", () => {
  const c = mk().contacts.get("c-mi")!;
  const base = { task: "t", rules: [] as string[], tools: [] as string[], credentialRefs: [] as string[] };
  for (const f of ["rules", "tools", "credentialRefs"] as const) {
    assert.equal((briefFor(c, { ...base, [f]: [42, "生效规则"] } as never) as { reason: string }).reason, `${f} 里只能是字符串`, f);
    assert.equal((briefFor(c, { ...base, [f]: { 0: "规则", length: 1 } } as never) as { reason: string }).reason, `${f} 必须是字符串数组`, f);
  }
  const ok = briefFor(c, { ...base, rules: ["生效规则"] });
  assert.deepEqual(ok.ok && ok.brief.rules, ["生效规则"]);
});

test("CH-23 凭据引用必须整串是引用:明文前缀加合法引用后缀拒绝;纯引用照常(对照)", () => {
  const c = mk().contacts.get("c-mi")!;
  for (const ref of ["plaintext-secret vault://mail/1", "sk-live vault://a", "xvault://"]) {
    const r = briefFor(c, { task: "t", rules: [], tools: [], credentialRefs: [ref] });
    assert.match(!r.ok ? r.reason : "", /^凭据只能给引用句柄/, ref);
  }
  const ok = briefFor(c, { task: "t", rules: [], tools: [], credentialRefs: ["vault://mail/1"] });
  assert.deepEqual(ok.ok && ok.brief.credentialRefs, ["vault://mail/1"]);
});

test("CH-20 承诺与回执入口同样只读一次:sourceSeq/basedOnSeq 的 getter 后续换成非法值不影响已存与已判的值", () => {
  const reads: Record<string, number> = {};
  const k = commit(mk().contacts.get("c-mi")!, getterInput(reads, { id: ["k1", "k2"], sourceSeq: [5, Number.NaN], text: ["汇报"], boundTaskIds: [["T1"], ["T9"]], schedule: [null] }) as never);
  assert.deepEqual(k.ok && k.contact.commitments[0], { id: "k1", sourceSeq: 5, text: "汇报", boundTaskIds: ["T1"], awaitingReport: [], reportedTaskIds: [], schedule: null, status: "active" });
  assert.deepEqual(reads, { id: 1, sourceSeq: 1, text: 1, boundTaskIds: 1, schedule: 1 });
  const ended = settleTask(k.ok ? k.contact : (null as never), "T1");
  const rReads: Record<string, number> = {};
  const done = confirmFinalReport(ended, getterInput(rReads, { taskId: ["T1", "T9"], commitmentIds: [["k1"], []], basedOnSeq: [5, -1] }) as never);
  assert.equal(done.commitments[0]?.status, "done");
  assert.deepEqual(rReads, { taskId: 1, commitmentIds: 1, basedOnSeq: 1 });
  const badSeq = commit(mk().contacts.get("c-mi")!, getterInput({}, { id: ["k1"], sourceSeq: [Number.NaN, 5], text: ["汇报"], boundTaskIds: [["T1"]], schedule: [null] }) as never);
  assert.match(!badSeq.ok ? badSeq.reason : "", /不是合法的消息位置/);
  assert.deepEqual(confirmFinalReport(ended, getterInput({}, { taskId: ["T1"], commitmentIds: [["k1"]], basedOnSeq: [-1, 5] }) as never).commitments, ended.commitments);
  assert.deepEqual(confirmFinalReport(ended, { taskId: "T1", commitmentIds: "k1", basedOnSeq: 5 } as never).commitments, ended.commitments);
});

test("CH-20 入站意图形状不对一律 ignore;合法 work/control/chatter 照常(对照)", () => {
  const c = mk().contacts.get("c-mi")!;
  for (const bad of [null, "work", { kind: "bogus", text: "x" }, { kind: 1 }, { kind: "work", text: "x", commitmentId: 3 }]) {
    assert.equal(decideUnderFocus(c, bad as never), "ignore", JSON.stringify(bad));
  }
  assert.equal(decideUnderFocus(c, { kind: "work", text: "x", commitmentId: null }), "handle");
  assert.equal(decideUnderFocus(c, { kind: "control", action: "stop", commitmentId: "k" }), "handle");
  assert.equal(decideUnderFocus(c, { kind: "chatter", text: "x" }), "ignore");
});

test("CH-24 入站意图按 kind 分变体:合法 control/work/chatter 的判定;变体外额外字段丢弃、不影响判定", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k", sourceSeq: 1, text: "x", boundTaskIds: [], schedule: null });
  const f = setFocus(a.ok ? a.contact : (null as never), { onlyCommitmentId: "k" });
  const locked = f.ok ? f.contact : (null as never);
  const free = mk().contacts.get("c-mi")!;
  const cases: [string, unknown, string, string][] = [
    ["stop", { kind: "control", action: "stop", commitmentId: "k" }, "handle", "handle"],
    ["revoke", { kind: "control", action: "revoke", commitmentId: "k9" }, "handle", "handle"],
    ["reschedule", { kind: "control", action: "reschedule", commitmentId: "k" }, "handle", "handle"],
    ["control 带 text:42", { kind: "control", action: "stop", commitmentId: "k", text: 42 }, "handle", "handle"],
    ["control 带 debug", { kind: "control", action: "stop", commitmentId: "k", debug: true }, "handle", "handle"],
    ["职责内 work", { kind: "work", text: "t", commitmentId: "k" }, "handle", "handle"],
    ["职责外 work", { kind: "work", text: "t", commitmentId: null }, "decline-focused", "handle"],
    ["work 带 action:42", { kind: "work", text: "t", commitmentId: "k", action: 42 }, "handle", "handle"],
    ["chatter", { kind: "chatter", text: "hi" }, "ignore", "ignore"],
    ["chatter 带 commitmentId:5", { kind: "chatter", text: "hi", commitmentId: 5 }, "ignore", "ignore"],
  ];
  for (const [label, intent, withLock, noLock] of cases) {
    const parsed = JSON.parse(JSON.stringify(intent));
    assert.equal(decideUnderFocus(locked, parsed), withLock, `有锁 ${label}`);
    assert.equal(decideUnderFocus(free, parsed), noLock, `无锁 ${label}`);
  }
});

test("CH-24 入站意图不合变体形状一律 ignore:每个变体 × 缺字段/错类型/null/枚举外/空 id", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k", sourceSeq: 1, text: "x", boundTaskIds: [], schedule: null });
  const f = setFocus(a.ok ? a.contact : (null as never), { onlyCommitmentId: "k" });
  const locked = f.ok ? f.contact : (null as never);
  const free = mk().contacts.get("c-mi")!;
  const bad: unknown[] = [
    { kind: "control" },
    { kind: "control", action: "stop" },
    { kind: "control", commitmentId: "k" },
    { kind: "control", action: "explode", commitmentId: "k" },
    { kind: "control", action: 1, commitmentId: "k" },
    { kind: "control", action: "stop", commitmentId: null },
    { kind: "control", action: "stop", commitmentId: "" },
    { kind: "control", action: "stop", commitmentId: "  " },
    { kind: "control", action: "stop", commitmentId: 7 },
    { kind: "work", commitmentId: "k" },
    { kind: "work", text: "t" },
    { kind: "work", text: 3, commitmentId: "k" },
    { kind: "work", text: null, commitmentId: "k" },
    { kind: "work", text: "t", commitmentId: 9 },
    { kind: "chatter" },
    { kind: "chatter", text: 5 },
    { kind: "bogus", text: "t" },
    { text: "t" },
    { kind: null },
  ];
  for (const intent of bad) {
    const parsed = JSON.parse(JSON.stringify(intent));
    assert.equal(decideUnderFocus(locked, parsed), "ignore", `有锁 ${JSON.stringify(intent)}`);
    assert.equal(decideUnderFocus(free, parsed), "ignore", `无锁 ${JSON.stringify(intent)}`);
  }
});

test("CH-25 只接受普通数据对象:外层 Proxy、数组 Proxy、自定义原型对象、类实例都拒;普通对象与 Object.create(null) 通过", () => {
  const g = grantTool(mk().contacts.get("c-mi")!, { name: "get_weather", bounded: true });
  const c = g.ok ? g.contact : (null as never);
  const plain = { task: "t", rules: ["r1", "r2"], tools: ["get_weather"], credentialRefs: ["vault://mail/1"] };
  const rules = ["r1", "r2"];
  const outerProxy = new Proxy({ task: "t", rules, tools: ["get_weather"], credentialRefs: ["vault://mail/1"] }, {
    getOwnPropertyDescriptor(t, k) { if (k === "tools") rules.length = 0; return Reflect.getOwnPropertyDescriptor(t, k); },
  });
  const r1 = briefFor(c, outerProxy);
  assert.equal(!r1.ok && r1.reason, "Compute 说明请求 只接受普通数据对象");
  const r2 = briefFor(c, { ...plain, rules: new Proxy(["r1"], {}) });
  assert.equal(!r2.ok && r2.reason, "rules 只接受普通数据数组");
  class Req { task = "t"; rules = ["r1"]; tools: string[] = []; credentialRefs: string[] = []; }
  const r3 = briefFor(c, new Req());
  assert.equal(!r3.ok && r3.reason, "Compute 说明请求 只接受普通数据对象");
  const r4 = briefFor(c, Object.assign(Object.create({ inherited: 1 }), plain));
  assert.equal(!r4.ok && r4.reason, "Compute 说明请求 只接受普通数据对象");
  class MyArr extends Array<string> {}
  const r5 = briefFor(c, { ...plain, tools: MyArr.from(["get_weather"]) });
  assert.equal(!r5.ok && r5.reason, "tools 只接受普通数据数组");
  assert.deepEqual(briefFor(c, plain), { ok: true, brief: { ...plain, placement: "local" } });
  const bare = Object.assign(Object.create(null), plain);
  assert.deepEqual(briefFor(c, bare), { ok: true, brief: { ...plain, placement: "local" } });
  assert.deepEqual(briefFor(c, JSON.parse(JSON.stringify(plain))), { ok: true, brief: { ...plain, placement: "local" } });
});

test("CH-25 回执与登记入口同样拒绝外层 Proxy:回执作用域不能在读后改写;普通回执照常(对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "a", sourceSeq: 1, text: "x", boundTaskIds: ["T"], schedule: null });
  const b = commit(a.ok ? a.contact : (null as never), { id: "b", sourceSeq: 1, text: "y", boundTaskIds: ["T"], schedule: null });
  const ended = settleTask(b.ok ? b.contact : (null as never), "T");
  const ids = ["a"];
  const proxied = new Proxy({ taskId: "T", commitmentIds: ids, basedOnSeq: 5 }, {
    getOwnPropertyDescriptor(t, k) { if (k === "basedOnSeq") ids.splice(0, 1, "b"); return Reflect.getOwnPropertyDescriptor(t, k); },
  });
  assert.deepEqual(confirmFinalReport(ended, proxied).commitments, ended.commitments);
  assert.deepEqual(confirmFinalReport(ended, { taskId: "T", commitmentIds: ["a"], basedOnSeq: 5 }).commitments.map((k) => k.status), ["done", "active"]);
  const c = mk().contacts.get("c-mi")!;
  assert.equal((grantTool(c, new Proxy({ name: "weather", bounded: true }, {})) as { reason: string }).reason, "直接工具 只接受普通数据对象");
  assert.equal((grantComputeAsset(c, new Proxy({ name: "x", kind: "mcp" }, {})) as { reason: string }).reason, "能力资产 只接受普通数据对象");
  assert.equal((commit(c, new Proxy({ id: "k", sourceSeq: 1, text: "x", boundTaskIds: [], schedule: null }, {})) as { reason: string }).reason, "承诺 只接受普通数据对象");
  assert.equal(decideUnderFocus(c, new Proxy({ kind: "control", action: "stop", commitmentId: "k" }, {}) as never), "ignore");
});

test("CH-26 其余公开入口的快照:addContact/updateContact/setFocus/decideUnderFocus/commit 的嵌套 schedule 都只读一次并存首次值", () => {
  let reads = 0;
  const d = addContact(emptyDirectory(), { get id() { return ++reads === 1 ? "first" : "second"; }, name: "n", speakingModel: "m" });
  assert.equal(reads, 1);
  assert.deepEqual(d.ok && [...d.dir.contacts.keys()], ["first"]);
  reads = 0;
  const u = updateContact(mk(), "c-mi", { get memory() { return ++reads === 1 ? "original" : "changed"; } });
  assert.equal(reads, 1);
  assert.equal(u.ok && u.dir.contacts.get("c-mi")?.memory, "original");
  const k = commit(mk().contacts.get("c-mi")!, { id: "k", sourceSeq: 5, text: "x", boundTaskIds: ["T"], schedule: null });
  const base = k.ok ? k.contact : (null as never);
  reads = 0;
  const f = setFocus(base, { get onlyCommitmentId() { return ++reads <= 1 ? "k" : "other"; } });
  assert.equal(reads, 1);
  assert.deepEqual(f.ok && f.contact.focus, { onlyCommitmentId: "k" });
  reads = 0;
  const locked = f.ok ? f.contact : (null as never);
  assert.equal(decideUnderFocus(locked, { get kind() { return ++reads === 1 ? "work" : "control"; }, text: "无关", commitmentId: null } as never), "decline-focused");
  assert.equal(reads, 1);
  reads = 0;
  const s = commit(mk().contacts.get("c-mi")!, { id: "s", sourceSeq: 1, text: "t", boundTaskIds: [], schedule: { get cron() { return ++reads === 1 ? "0 8 * * *" : "not-cron"; }, tz: "UTC", toleranceSec: 0 } });
  assert.equal(reads, 1);
  assert.deepEqual(s.ok && s.contact.commitments[0]?.schedule, { cron: "0 8 * * *", tz: "UTC", toleranceSec: 0 });
  const extra = commit(mk().contacts.get("c-mi")!, { id: "x", sourceSeq: 1, text: "t", boundTaskIds: [], schedule: null, secret: "plaintext" } as never);
  assert.equal(extra.ok && "secret" in extra.contact.commitments[0]!, false);
});
