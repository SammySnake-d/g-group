// AC-01 联系人持久身份;AC-33 直接工具清单收窄、Compute 不继承记忆和性格、凭据只给引用、placement 契约;
// 概念卡第 11 张:定时是联系人自己的承诺(带时区和误差),不是插件能力;AC-31⑤ 承诺终态自动回收。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as contactModule from "./contact.ts";
import * as domain from "./index.ts";
import { addContact, briefFor, type Contact, type ContactResult, canCallDirectly, commit, confirmFinalReport, emptyDirectory, FORBIDDEN_DIRECT_TOOLS, grantComputeAsset, grantTool, revokeCommitment, settleTask, updateContact } from "./contact.ts";
import { normalize } from "./plain.ts";

/** 按需求文档 75-78 行独立列出的通用能力样本,不取自被测实现的清单。 */
const SPEC_GENERAL_TOOLS = ["bash", "shell", "exec", "run_command", "write_file", "edit_file", "apply_patch", "browser", "computer_use", "run_script"];

const mk = () => {
  const r = addContact(emptyDirectory(), { id: "c-mi", name: "小秘", speakingModel: "claude-opus-5-5" });
  if (!r.ok) throw new Error(r.reason);
  return r.dir;
};
/** 末次汇报回执夹具:默认履行 k1,依据位置足够新。 */
const rc = (taskId: string, commitmentIds: readonly string[] = ["k1"], basedOnSeq = 10_000) => ({ taskId, commitmentIds, basedOnSeq });
/** settleTask/confirmFinalReport 返回带失败分支的结果(CH-37);正常路径取出联系人,失败就让所在测试按名字失败。 */
const unwrap = (r: ContactResult): Contact => {
  if (!r.ok) throw new Error(r.reason);
  return r.contact;
};
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
  const half = unwrap(settleTask(a.ok ? a.contact : (null as never), "T_A"));
  const ended = unwrap(settleTask(half, "T_B"));
  assert.deepEqual(ended.commitments[0], { id: "k1", sourceSeq: 200, text: "有进度就汇报", boundTaskIds: [], awaitingReport: ["T_A", "T_B"], reportedTaskIds: [], schedule: null, status: "active" });
  const oneReported = unwrap(confirmFinalReport(ended, rc("T_A")));
  assert.equal(oneReported.commitments[0]?.status, "active");
  assert.equal(unwrap(confirmFinalReport(oneReported, rc("T_X"))).commitments[0]?.status, "active");
  const done = unwrap(confirmFinalReport(oneReported, rc("T_B")));
  assert.equal(done.commitments[0]?.status, "done");
  assert.deepEqual(done.commitments[0]?.awaitingReport, []);
});

test("AC-31⑤ 承诺回收后不影响新承诺:旧承诺 done 后不能再撤销,新承诺照常立", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 200, text: "只盯 T_A", boundTaskIds: ["T_A"], schedule: null });
  assert.ok(a.ok);
  const base = a.ok ? a.contact : (null as never);
  const after = unwrap(confirmFinalReport(unwrap(settleTask(base, "T_A")), rc("T_A")));
  assert.equal(after.commitments[0]?.status, "done");
  assert.equal(revokeCommitment(after, "k1").ok, false);
  const k2 = commit(after, { id: "k2", sourceSeq: 300, text: "T_A2", boundTaskIds: ["T_A2"], schedule: null });
  assert.equal(k2.ok && k2.contact.commitments.find((k) => k.id === "k2")?.status, "active");
});

test("AC-31⑤ 定时承诺不随任务结束回收(阴性对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "每天 8 点", boundTaskIds: ["T_A"], schedule: daily8 });
  assert.ok(a.ok);
  const after = unwrap(confirmFinalReport(unwrap(settleTask(a.ok ? a.contact : (null as never), "T_A")), rc("T_A")));
  assert.deepEqual(after.commitments[0], { id: "k1", sourceSeq: 1, text: "每天 8 点", boundTaskIds: ["T_A"], awaitingReport: [], reportedTaskIds: [], schedule: daily8, status: "active" });
});

test("AC-31⑤ 别的任务的汇报确认不回收无关承诺(阴性对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "常驻承诺", boundTaskIds: [], schedule: null });
  assert.ok(a.ok);
  assert.equal(unwrap(confirmFinalReport(a.ok ? a.contact : (null as never), rc("T_X"))).commitments[0]?.status, "active");
});

test("撤销承诺置为 revoked,不能重复撤销", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "每天 8 点", boundTaskIds: [], schedule: daily8 });
  const r = revokeCommitment(a.ok ? a.contact : (null as never), "k1");
  assert.ok(r.ok);
  assert.equal(r.ok && r.contact.commitments[0]?.status, "revoked");
  assert.equal(r.ok && revokeCommitment(r.contact, "k1").ok, false);
});

test("联系人更新不改入参目录", () => {
  const d = mk();
  const saved = JSON.stringify([...d.contacts]);
  const r = updateContact(d, "c-mi", { memory: "新记忆" });
  assert.ok(r.ok);
  assert.equal(JSON.stringify([...d.contacts]), saved);
});

test("CH-05 末次汇报确认先于终态到达:不被吞掉,任务终态后立即回收;重复确认与重复终态幂等", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "进度汇报", boundTaskIds: ["T1"], schedule: null });
  const reported = unwrap(confirmFinalReport(a.ok ? a.contact : (null as never), rc("T1")));
  assert.deepEqual(reported.commitments[0], { id: "k1", sourceSeq: 1, text: "进度汇报", boundTaskIds: ["T1"], awaitingReport: [], reportedTaskIds: ["T1"], schedule: null, status: "active" });
  const replayed = unwrap(confirmFinalReport(reported, rc("T1")));
  assert.deepEqual(replayed.commitments[0]?.reportedTaskIds, ["T1"]);
  const ended = unwrap(settleTask(replayed, "T1"));
  assert.deepEqual(ended.commitments[0], { id: "k1", sourceSeq: 1, text: "进度汇报", boundTaskIds: [], awaitingReport: [], reportedTaskIds: [], schedule: null, status: "done" });
  assert.deepEqual(unwrap(confirmFinalReport(unwrap(settleTask(ended, "T1")), rc("T1"))).commitments[0], ended.commitments[0]);
});

test("CH-05 先终态后确认的顺序照旧回收(对照),确认重放不改结果", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "进度汇报", boundTaskIds: ["T1"], schedule: null });
  const ended = unwrap(settleTask(a.ok ? a.contact : (null as never), "T1"));
  assert.deepEqual(ended.commitments[0]?.awaitingReport, ["T1"]);
  assert.equal(ended.commitments[0]?.status, "active");
  const done = unwrap(confirmFinalReport(ended, rc("T1")));
  assert.equal(done.commitments[0]?.status, "done");
  assert.deepEqual(unwrap(confirmFinalReport(done, rc("T1"))).commitments[0], done.commitments[0]);
});

test("CH-05 跨任务负对照:先确认的任务不替别的任务放行,无关任务的确认不被记下", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "两件事都汇报", boundTaskIds: ["T1", "T2"], schedule: null });
  const b = commit(a.ok ? a.contact : (null as never), { id: "k2", sourceSeq: 2, text: "另一件", boundTaskIds: ["T9"], schedule: null });
  const early = unwrap(confirmFinalReport(unwrap(confirmFinalReport(b.ok ? b.contact : (null as never), rc("T1"))), rc("T_X")));
  assert.deepEqual(early.commitments.map((k) => k.reportedTaskIds), [["T1"], []]);
  const t2 = unwrap(settleTask(early, "T2"));
  assert.deepEqual(t2.commitments[0], { id: "k1", sourceSeq: 1, text: "两件事都汇报", boundTaskIds: ["T1"], awaitingReport: ["T2"], reportedTaskIds: ["T1"], schedule: null, status: "active" });
  const t1 = unwrap(settleTask(t2, "T1"));
  assert.equal(t1.commitments[0]?.status, "active");
  assert.deepEqual(t1.commitments[0]?.awaitingReport, ["T2"]);
  const done = unwrap(confirmFinalReport(t1, rc("T2")));
  assert.equal(done.commitments[0]?.status, "done");
  assert.equal(done.commitments[1]?.status, "active");
  assert.deepEqual(done.commitments[1]?.boundTaskIds, ["T9"]);
});

test("CH-05 定时承诺的绑定任务先确认汇报也不回收、不记录(阴性对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "每天 8 点", boundTaskIds: ["T_A"], schedule: daily8 });
  const after = unwrap(settleTask(unwrap(confirmFinalReport(a.ok ? a.contact : (null as never), rc("T_A"))), "T_A"));
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

test("CH-08 一个任务终态且已汇报、另一个仍在跑:承诺不回收", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 45, text: "两件事", boundTaskIds: ["T_A", "T_B"], schedule: null });
  const half = unwrap(confirmFinalReport(unwrap(settleTask(a.ok ? a.contact : (null as never), "T_A")), rc("T_A")));
  assert.equal(half.commitments[0]?.status, "active");
  assert.deepEqual(half.commitments[0]?.boundTaskIds, ["T_B"]);
  const done = unwrap(confirmFinalReport(unwrap(settleTask(half, "T_B")), rc("T_B")));
  assert.equal(done.commitments[0]?.status, "done");
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

test("CH-09 同一任务两条承诺:只履行旧承诺的迟到回执不替新承诺放行,新承诺仍等自己的回执", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kA", sourceSeq: 100, text: "T1 汇报到群 A", boundTaskIds: ["T1"], schedule: null });
  const b = commit(a.ok ? a.contact : (null as never), { id: "kB", sourceSeq: 200, text: "T1 汇报到群 B", boundTaskIds: ["T1"], schedule: null });
  const lateOld = unwrap(confirmFinalReport(b.ok ? b.contact : (null as never), rc("T1", ["kA"], 150)));
  assert.deepEqual(lateOld.commitments.map((k) => k.reportedTaskIds), [["T1"], []]);
  const ended = unwrap(settleTask(lateOld, "T1"));
  assert.deepEqual(ended.commitments.map((k) => k.status), ["done", "active"]);
  assert.deepEqual(ended.commitments[1]?.awaitingReport, ["T1"]);
  const done = unwrap(confirmFinalReport(ended, rc("T1", ["kB"], 250)));
  assert.deepEqual(done.commitments.map((k) => k.status), ["done", "done"]);
});

test("CH-09 回执依据位置早于承诺出处时,即使点名这条承诺也不算数;依据位置不早于出处才算(对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kB", sourceSeq: 200, text: "T1 汇报到群 B", boundTaskIds: ["T1"], schedule: null });
  const ended = unwrap(settleTask(a.ok ? a.contact : (null as never), "T1"));
  const stale = unwrap(confirmFinalReport(ended, rc("T1", ["kB"], 199)));
  assert.deepEqual(stale.commitments[0], ended.commitments[0]);
  const fresh = unwrap(confirmFinalReport(ended, rc("T1", ["kB"], 200)));
  assert.equal(fresh.commitments[0]?.status, "done");
});

test("CH-09 一条汇报经宿主明确判定覆盖两条承诺:两条都生效;先确认后终态与先终态后确认结果一致,重放不变", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kA", sourceSeq: 100, text: "群 A", boundTaskIds: ["T1"], schedule: null });
  const b = commit(a.ok ? a.contact : (null as never), { id: "kB", sourceSeq: 200, text: "群 B", boundTaskIds: ["T1"], schedule: null });
  const base = b.ok ? b.contact : (null as never);
  const both = rc("T1", ["kA", "kB"], 300);
  const early = unwrap(settleTask(unwrap(confirmFinalReport(base, both)), "T1"));
  const late = unwrap(confirmFinalReport(unwrap(settleTask(base, "T1")), both));
  assert.deepEqual(early.commitments.map((k) => k.status), ["done", "done"]);
  assert.deepEqual(late.commitments, early.commitments);
  assert.deepEqual(unwrap(confirmFinalReport(late, both)).commitments, late.commitments);
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
  const lateReceipt = unwrap(confirmFinalReport(revoked.ok ? revoked.contact : (null as never), rc("T1")));
  assert.deepEqual(lateReceipt.commitments[0], { id: "k1", sourceSeq: 1, text: "汇报", boundTaskIds: ["T1"], awaitingReport: [], reportedTaskIds: [], schedule: null, status: "revoked" });
  const early = unwrap(confirmFinalReport(a.ok ? a.contact : (null as never), rc("T1")));
  const r2 = revokeCommitment(early, "k1");
  const lateEnd = unwrap(settleTask(r2.ok ? r2.contact : (null as never), "T1"));
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
  const endedFirst = unwrap(confirmFinalReport(unwrap(settleTask(unwrap(settleTask(base, "A")), "B")), rc("B")));
  assert.deepEqual(endedFirst.commitments[0]?.awaitingReport, ["A"]);
  assert.equal(endedFirst.commitments[0]?.status, "active");
  assert.equal(unwrap(confirmFinalReport(endedFirst, rc("A"))).commitments[0]?.status, "done");
  const reportedFirst = unwrap(settleTask(unwrap(confirmFinalReport(unwrap(confirmFinalReport(base, rc("A"))), rc("B"))), "B"));
  assert.deepEqual(reportedFirst.commitments[0]?.reportedTaskIds, ["A"]);
  assert.deepEqual(reportedFirst.commitments[0]?.boundTaskIds, ["A"]);
  const done = unwrap(settleTask(reportedFirst, "A"));
  assert.equal(done.commitments[0]?.status, "done");
  assert.deepEqual(done.commitments[0]?.reportedTaskIds, []);
});

test("CH-09 两条承诺出处都早于汇报依据位置,回执只点名 kA:只有 kA 生效,kB 仍等自己的回执", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kA", sourceSeq: 100, text: "群 A", boundTaskIds: ["T1"], schedule: null });
  const b = commit(a.ok ? a.contact : (null as never), { id: "kB", sourceSeq: 200, text: "群 B", boundTaskIds: ["T1"], schedule: null });
  const ended = unwrap(settleTask(b.ok ? b.contact : (null as never), "T1"));
  const onlyA = unwrap(confirmFinalReport(ended, rc("T1", ["kA"], 300)));
  assert.deepEqual(onlyA.commitments.map((k) => k.status), ["done", "active"]);
  assert.deepEqual(onlyA.commitments[1]?.awaitingReport, ["T1"]);
  const early = unwrap(confirmFinalReport(b.ok ? b.contact : (null as never), rc("T1", ["kA"], 300)));
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

test("CH-12 回执依据位置不是非负整数时不确认、不回收;同一回执换成合法位置才生效(对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kB", sourceSeq: 200, text: "T1 汇报到群 B", boundTaskIds: ["T1"], schedule: null });
  const base = a.ok ? a.contact : (null as never);
  const ended = unwrap(settleTask(base, "T1"));
  for (const basedOnSeq of [Number.NaN, Number.POSITIVE_INFINITY, -1, 200.5]) {
    const early = unwrap(confirmFinalReport(base, rc("T1", ["kB"], basedOnSeq)));
    assert.deepEqual(early.commitments, base.commitments, String(basedOnSeq));
    const afterEnd = unwrap(settleTask(early, "T1"));
    assert.equal(afterEnd.commitments[0]?.status, "active", String(basedOnSeq));
    assert.deepEqual(unwrap(confirmFinalReport(ended, rc("T1", ["kB"], basedOnSeq))).commitments, ended.commitments, String(basedOnSeq));
  }
  assert.deepEqual(unwrap(confirmFinalReport(base, rc("T1", ["kB"], 199))).commitments, base.commitments);
  const ok = unwrap(confirmFinalReport(ended, rc("T1", ["kB"], 200)));
  assert.equal(ok.commitments[0]?.status, "done");
});

test("CH-13 回执作用域为空时不确认任何承诺;点名后才确认(对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kA", sourceSeq: 100, text: "汇报", boundTaskIds: ["T"], schedule: null });
  const base = a.ok ? a.contact : (null as never);
  assert.deepEqual(unwrap(confirmFinalReport(base, rc("T", [], 100))).commitments, base.commitments);
  assert.deepEqual(unwrap(confirmFinalReport(unwrap(settleTask(base, "T")), rc("T", [], 100))).commitments[0]?.awaitingReport, ["T"]);
  assert.deepEqual(unwrap(confirmFinalReport(base, rc("T", ["kA"], 100))).commitments[0]?.reportedTaskIds, ["T"]);
});

test("CH-13 同一回执点名两条承诺时逐条比较出处:出处 100 与 200、依据 150 只确认前者;顺序颠倒结果相同", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kA", sourceSeq: 100, text: "群 A", boundTaskIds: ["T"], schedule: null });
  const b = commit(a.ok ? a.contact : (null as never), { id: "kB", sourceSeq: 200, text: "群 B", boundTaskIds: ["T"], schedule: null });
  const fwd = b.ok ? b.contact : (null as never);
  const after = unwrap(confirmFinalReport(fwd, rc("T", ["kA", "kB"], 150)));
  assert.deepEqual(after.commitments.map((k) => k.reportedTaskIds), [["T"], []]);
  assert.deepEqual(unwrap(settleTask(after, "T")).commitments.map((k) => k.status), ["done", "active"]);
  const x = commit(mk().contacts.get("c-mi")!, { id: "kB", sourceSeq: 200, text: "群 B", boundTaskIds: ["T"], schedule: null });
  const y = commit(x.ok ? x.contact : (null as never), { id: "kA", sourceSeq: 100, text: "群 A", boundTaskIds: ["T"], schedule: null });
  const rev = unwrap(confirmFinalReport(y.ok ? y.contact : (null as never), rc("T", ["kB", "kA"], 150)));
  assert.deepEqual(rev.commitments.map((k) => [k.id, k.reportedTaskIds]), [["kB", []], ["kA", ["T"]]]);
});

test("CH-13 交错重放:先确认 T1、再 T2、再重放 T1,不重复记录;再全部终态后回收", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "kA", sourceSeq: 100, text: "两件事", boundTaskIds: ["T1", "T2"], schedule: null });
  const first = unwrap(confirmFinalReport(a.ok ? a.contact : (null as never), rc("T1", ["kA"], 100)));
  const second = unwrap(confirmFinalReport(first, rc("T2", ["kA"], 100)));
  const replay = unwrap(confirmFinalReport(second, rc("T1", ["kA"], 100)));
  assert.deepEqual(replay.commitments[0]?.reportedTaskIds, ["T1", "T2"]);
  assert.deepEqual(replay.commitments, second.commitments);
  const done = unwrap(settleTask(unwrap(settleTask(replay, "T1")), "T2"));
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
  const ended = unwrap(settleTask(k.ok ? k.contact : (null as never), "T"));
  assert.deepEqual(unwrap(confirmFinalReport(ended, rc("T", ["k"], Number.MAX_SAFE_INTEGER + 1))).commitments, ended.commitments);
  assert.equal(unwrap(confirmFinalReport(ended, rc("T", ["k"], Number.MAX_SAFE_INTEGER))).commitments[0]?.status, "done");
});

test("CH-15 -0 按位置 0 处理(合法);负的最小值被拒(对照)", () => {
  const c = mk().contacts.get("c-mi")!;
  assert.equal(commit(c, { id: "k", sourceSeq: -0, text: "x", boundTaskIds: ["T"], schedule: null }).ok, true);
  assert.equal(commit(c, { id: "k", sourceSeq: Number.MIN_SAFE_INTEGER, text: "x", boundTaskIds: ["T"], schedule: null }).ok, false);
});

test("CH-15 已回收(done)的承诺不能被撤销改写成 revoked;有效承诺可以撤销(对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k", sourceSeq: 1, text: "x", boundTaskIds: ["T"], schedule: null });
  const base = a.ok ? a.contact : (null as never);
  const done = unwrap(confirmFinalReport(unwrap(settleTask(base, "T")), rc("T", ["k"], 1)));
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

/** 访问器夹具:在普通对象上把 key 定义成 getter(或 setter),返回对象和调用计数;getter 被调用就计数。 */
const withAccessor = (base: Record<string, unknown>, key: string, kind: "get" | "set" = "get") => {
  const calls = { n: 0 };
  const o: Record<string, unknown> = { ...base };
  delete o[key];
  Object.defineProperty(o, key, kind === "get" ? { enumerable: true, get: () => { calls.n++; return base[key]; } } : { enumerable: true, set: () => { calls.n++; } });
  return { o, calls };
};

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
  const ended = unwrap(settleTask(b.ok ? b.contact : (null as never), "T"));
  const ids = ["a"];
  const proxied = new Proxy({ taskId: "T", commitmentIds: ids, basedOnSeq: 5 }, {
    getOwnPropertyDescriptor(t, k) { if (k === "basedOnSeq") ids.splice(0, 1, "b"); return Reflect.getOwnPropertyDescriptor(t, k); },
  });
  assert.deepEqual(unwrap(confirmFinalReport(ended, proxied)).commitments, ended.commitments);
  assert.deepEqual(unwrap(confirmFinalReport(ended, { taskId: "T", commitmentIds: ["a"], basedOnSeq: 5 })).commitments.map((k) => k.status), ["done", "active"]);
  const c = mk().contacts.get("c-mi")!;
  assert.equal((grantTool(c, new Proxy({ name: "weather", bounded: true }, {})) as { reason: string }).reason, "直接工具 只接受普通数据对象");
  assert.equal((grantComputeAsset(c, new Proxy({ name: "x", kind: "mcp" }, {})) as { reason: string }).reason, "能力资产 只接受普通数据对象");
  assert.equal((commit(c, new Proxy({ id: "k", sourceSeq: 1, text: "x", boundTaskIds: [], schedule: null }, {})) as { reason: string }).reason, "承诺 只接受普通数据对象");
});

test("普通数据合同:联系人每个公开入口的每个对象字段做成 getter 或 setter 都直接拒绝,getter 调用 0 次;同样内容的数据属性通过(对照)", () => {
  const dir = mk();
  const c = dir.contacts.get("c-mi")!;
  const k = commit(c, { id: "k", sourceSeq: 5, text: "x", boundTaskIds: ["T"], schedule: null });
  const withK = k.ok ? k.contact : (null as never);
  const ended = unwrap(settleTask(withK, "T"));
  const cases: [string, Record<string, unknown>, string, (x: never) => unknown, (r: unknown) => boolean][] = [
    ["addContact", { id: "n1", name: "n", speakingModel: "m" }, "联系人", (x) => addContact(emptyDirectory(), x), (r) => (r as { ok: boolean }).ok],
    ["updateContact", { memory: "m", soul: "s" }, "联系人修改", (x) => updateContact(dir, "c-mi", x), (r) => (r as { ok: boolean }).ok],
    ["grantTool", { name: "weather", bounded: true }, "直接工具", (x) => grantTool(c, x), (r) => (r as { ok: boolean }).ok],
    ["grantComputeAsset", { name: "research", kind: "mcp" }, "能力资产", (x) => grantComputeAsset(c, x), (r) => (r as { ok: boolean }).ok],
    ["commit", { id: "k2", sourceSeq: 1, text: "t", boundTaskIds: ["T"], schedule: null }, "承诺", (x) => commit(c, x), (r) => (r as { ok: boolean }).ok],
    ["briefFor", { task: "t", rules: ["r"], tools: [], credentialRefs: ["vault://a"], placement: "local" }, "Compute 说明请求", (x) => briefFor(c, x), (r) => (r as { ok: boolean }).ok],
    ["confirmFinalReport", { taskId: "T", commitmentIds: ["k"], basedOnSeq: 5 }, "回执", (x) => unwrap(confirmFinalReport(ended, x)), (r) => (r as typeof ended).commitments[0]?.status === "done"],
  ];
  for (let ci = 0; ci < cases.length; ci++) {
    const [label, base, what, call, accepted] = cases[ci]!;
    assert.equal(accepted(call(base as never)), true, `${label} 数据属性`);
    for (const key of Object.keys(base)) {
      for (const kind of ["get", "set"] as const) {
        const { o, calls } = withAccessor(base, key, kind);
        const r = call(o as never);
        assert.equal(accepted(r), false, `${label}.${key} ${kind}`);
        if (typeof r === "object" && r !== null && "reason" in r) assert.equal((r as { reason: string }).reason, `${what} 只接受普通数据对象(${key} 是访问器属性)`, `${label}.${key} ${kind}`);
        assert.equal(calls.n, 0, `${label}.${key} ${kind} getter 调用次数`);
      }
    }
  }
});

test("普通数据合同:嵌套 schedule 对象与数组字段里的访问器同样拒绝、getter 调用 0 次", () => {
  const c = mk().contacts.get("c-mi")!;
  const sched = withAccessor({ cron: "0 8 * * *", tz: "UTC", toleranceSec: 0 }, "cron");
  const r1 = commit(c, { id: "s", sourceSeq: 1, text: "t", boundTaskIds: [], schedule: sched.o as never });
  assert.equal(!r1.ok && r1.reason, "schedule 只接受普通数据对象(cron 是访问器属性)");
  assert.equal(sched.calls.n, 0);
  let n = 0;
  const rules: string[] = ["r1"];
  Object.defineProperty(rules, 1, { enumerable: true, get: () => { n++; return "r2"; } });
  const r2 = briefFor(c, { task: "t", rules, tools: [], credentialRefs: [] });
  assert.equal(!r2.ok && r2.reason, "rules 只接受普通数据数组(1 是访问器属性)");
  assert.equal(n, 0);
  const sparse: string[] = ["a"];
  sparse.length = 2;
  assert.equal((briefFor(c, { task: "t", rules: sparse, tools: [], credentialRefs: [] }) as { reason: string }).reason, "rules 里只能是字符串");
  const fake = (xs: string[], forged: string) => { const a = [...xs]; Object.defineProperty(a, Symbol.iterator, { value: function* () { yield forged; } }); return a; };
  const g = grantTool(c, { name: "get_weather", bounded: true });
  const cg = g.ok ? g.contact : (null as never);
  const r3 = briefFor(cg, { task: "t", rules: fake(["r1", "r2"], "伪造"), tools: fake(["get_weather"], "run_command"), credentialRefs: fake(["vault://a"], "plaintext") });
  assert.deepEqual(r3.ok && [r3.brief.rules, r3.brief.tools, r3.brief.credentialRefs], [["r1", "r2"], ["get_weather"], ["vault://a"]]);
  assert.equal(commit(c, { id: "s", sourceSeq: 1, text: "t", boundTaskIds: [], schedule: { cron: "0 8 * * *", tz: "UTC", toleranceSec: 0 } }).ok, true);
});

test("普通数据合同:逐个入口拒绝外层 Proxy 与数组 Proxy,普通对象通过(对照)", () => {
  const dir = mk();
  const c = dir.contacts.get("c-mi")!;
  const k = commit(c, { id: "k", sourceSeq: 1, text: "x", boundTaskIds: ["T"], schedule: null });
  const withK = k.ok ? k.contact : (null as never);
  const ended = unwrap(settleTask(withK, "T"));
  const P = <T extends object>(o: T): T => new Proxy(o, {});
  assert.equal((addContact(emptyDirectory(), P({ id: "n", name: "n", speakingModel: "m" })) as { reason: string }).reason, "联系人 只接受普通数据对象");
  assert.equal((updateContact(dir, "c-mi", P({ memory: "x" })) as { reason: string }).reason, "联系人修改 只接受普通数据对象");
  assert.equal((commit(c, { id: "s", sourceSeq: 1, text: "t", boundTaskIds: [], schedule: P({ cron: "0 8 * * *", tz: "UTC", toleranceSec: 0 }) }) as { reason: string }).reason, "schedule 只接受普通数据对象");
  assert.equal((commit(c, { id: "s", sourceSeq: 1, text: "t", boundTaskIds: P(["T"]), schedule: null }) as { reason: string }).reason, "boundTaskIds 只接受普通数据数组");
  const base = { task: "t", rules: [] as string[], tools: [] as string[], credentialRefs: [] as string[] };
  for (const f of ["rules", "tools", "credentialRefs"] as const) assert.equal((briefFor(c, { ...base, [f]: P([]) }) as { reason: string }).reason, `${f} 只接受普通数据数组`, f);
  assert.deepEqual(unwrap(confirmFinalReport(ended, { taskId: "T", commitmentIds: P(["k"]), basedOnSeq: 1 })).commitments, ended.commitments);
  assert.equal(unwrap(confirmFinalReport(ended, { taskId: "T", commitmentIds: ["k"], basedOnSeq: 1 })).commitments[0]?.status, "done");
  assert.equal(addContact(emptyDirectory(), { id: "n", name: "n", speakingModel: "m" }).ok, true);
  assert.equal(updateContact(dir, "c-mi", { memory: "x" }).ok, true);
});

test("快照合同:入口返回后改调用方对象或数组,已存状态与输出都不变(addContact/updateContact/commit/回执)", () => {
  const req = { id: "first", name: "n", speakingModel: "m" };
  const d = addContact(emptyDirectory(), req);
  req.id = "second";
  assert.deepEqual(d.ok && [...d.dir.contacts.keys()], ["first"]);
  const patch = { memory: "original" };
  const u = updateContact(mk(), "c-mi", patch);
  patch.memory = "changed";
  assert.equal(u.ok && u.dir.contacts.get("c-mi")?.memory, "original");
  const sched = { cron: "0 8 * * *", tz: "UTC", toleranceSec: 0 };
  const bound = ["T"];
  const k = commit(mk().contacts.get("c-mi")!, { id: "k", sourceSeq: 5, text: "x", boundTaskIds: bound, schedule: sched });
  sched.cron = "not-cron";
  bound.push("T9");
  assert.deepEqual(k.ok && [k.contact.commitments[0]?.schedule, k.contact.commitments[0]?.boundTaskIds], [{ cron: "0 8 * * *", tz: "UTC", toleranceSec: 0 }, ["T"]]);
  const extra = commit(mk().contacts.get("c-mi")!, { id: "x", sourceSeq: 1, text: "t", boundTaskIds: [], schedule: null, secret: "plaintext" } as never);
  assert.equal(extra.ok && "secret" in extra.contact.commitments[0]!, false);
});

test("普通数据合同:快照是冻结的空原型对象,schema 外字段丢弃", () => {
  const n = commit(mk().contacts.get("c-mi")!, { id: "k", sourceSeq: 1, text: "t", boundTaskIds: ["T"], schedule: { cron: "0 8 * * *", tz: "UTC", toleranceSec: 0 }, extra: 1 } as never);
  const k = n.ok ? n.contact.commitments[0]! : (null as never);
  assert.equal("extra" in k, false);
  const r = briefFor(mk().contacts.get("c-mi")!, { task: "t", rules: ["r"], tools: [], credentialRefs: [], extra: 1 } as never);
  assert.equal(r.ok && "extra" in r.brief, false);
  assert.ok(r.ok && Object.isFrozen(r.brief) && Object.isFrozen(r.brief.rules));
  const snap = normalize<{ id: string; boundTaskIds: readonly string[] }>({ id: "x", boundTaskIds: ["T"], extra: 1 }, { id: { kind: "string" }, boundTaskIds: { kind: "strings" } }, "测试");
  assert.ok(snap.ok);
  const v = snap.ok ? snap.value : (null as never);
  assert.equal(Object.getPrototypeOf(v), null);
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.boundTaskIds));
  assert.deepEqual(Object.keys(v), ["id", "boundTaskIds"]);
});

test("普通数据合同:Object.prototype 上有同名可写数据属性、setter、不可写属性时,快照字段照常写入、setter 调用 0 次;无污染时同样(对照)", () => {
  const keys = ["id", "name", "sourceSeq", "boundTaskIds", "cron", "task", "rules", "taskId", "commitmentIds", "basedOnSeq", "onlyCommitmentId", "memory", "placement", "0", "1"];
  const run = () => {
    const c = mk().contacts.get("c-mi")!;
    const k = commit(c, { id: "k", sourceSeq: 5, text: "t", boundTaskIds: ["T", "U"], schedule: { cron: "0 8 * * *", tz: "UTC", toleranceSec: 0 } });
    assert.ok(k.ok, JSON.stringify(k));
    const got = k.ok ? k.contact.commitments[0]! : (null as never);
    assert.equal(got.id, "k");
    assert.equal(got.sourceSeq, 5);
    assert.deepEqual([...got.boundTaskIds], ["T", "U"]);
    assert.equal(got.schedule?.cron, "0 8 * * *");
    const b = briefFor(c, { task: "交付", rules: ["r1", "r2"], tools: [], credentialRefs: [] });
    assert.equal(b.ok && b.brief.task, "交付");
    assert.deepEqual(b.ok && [...b.brief.rules], ["r1", "r2"]);
    const done = unwrap(confirmFinalReport(unwrap(settleTask(k.ok ? k.contact : (null as never), "T")), { taskId: "T", commitmentIds: ["k"], basedOnSeq: 5 }));
    assert.deepEqual([...done.commitments[0]!.awaitingReport], []);
    const u = updateContact(mk(), "c-mi", { name: "改名" });
    assert.equal(u.ok && u.dir.contacts.get("c-mi")?.memory, "");
    assert.equal(b.ok && b.brief.placement, "local");
  };
  const pollute = (mode: "none" | "writable" | "setter" | "readonly", f: () => void) => {
    const saved = new Map<string, PropertyDescriptor | undefined>();
    const savedArr = new Map<string, PropertyDescriptor | undefined>();
    let setterCalls = 0;
    const desc = (): PropertyDescriptor => mode === "writable" ? { value: "污染", writable: true, configurable: true }
      : mode === "setter" ? { set() { setterCalls++; }, get() { return "污染"; }, configurable: true }
      : { value: "污染", writable: false, configurable: true };
    try {
      if (mode !== "none") for (const key of keys) {
        saved.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
        Object.defineProperty(Object.prototype, key, desc());
        if (/^\d$/.test(key)) { savedArr.set(key, Object.getOwnPropertyDescriptor(Array.prototype, key)); Object.defineProperty(Array.prototype, key, desc()); }
      }
      f();
    } finally {
      for (const [key, d] of saved) { if (d) Object.defineProperty(Object.prototype, key, d); else delete (Object.prototype as Record<string, unknown>)[key]; }
      for (const [key, d] of savedArr) { if (d) Object.defineProperty(Array.prototype, key, d); else delete (Array.prototype as unknown as Record<string, unknown>)[key]; }
    }
    return setterCalls;
  };
  for (const mode of ["none", "writable", "setter", "readonly"] as const) {
    const calls = pollute(mode, run);
    assert.equal(calls, 0, `${mode} setter 调用次数`);
  }
});

test("g-group 第 2273 号讨论撤销专职开关:联系人没有 focus 字段,模块不导出 setFocus/decideUnderFocus,有承诺时也没有按「专职」婉拒的路径", () => {
  const c = mk().contacts.get("c-mi")!;
  assert.equal("focus" in c, false);
  const k = commit(c, { id: "k", sourceSeq: 1, text: "只做 T1", boundTaskIds: ["T1"], schedule: null });
  assert.ok(k.ok);
  const withK = k.ok ? k.contact : (null as never);
  const ended = unwrap(settleTask(withK, "T1"));
  const done = unwrap(confirmFinalReport(ended, rc("T1", ["k"], 1)));
  assert.deepEqual([withK, ended, done].map((x) => "focus" in x), [false, false, false]);
  const r = revokeCommitment(withK, "k");
  assert.equal(r.ok && "focus" in r.contact, false);
  const exported = Object.keys(contactModule);
  for (const name of ["setFocus", "decideUnderFocus", "focus", "FocusPolicy", "FocusDecision"]) assert.equal(exported.includes(name), false, name);
  const sources = Object.entries(contactModule).filter(([, v]) => typeof v === "function").map(([n, v]) => [n, String(v)] as const);
  assert.deepEqual(sources.filter(([, src]) => /decline-focused|onlyCommitmentId/.test(src)).map(([n]) => n), []);
});

/** 在 Object.prototype(及 Array.prototype)上临时放同名属性,跑完 f 立即恢复;返回同名 setter 被调用的次数。 */
const withPollution = (keys: readonly string[], mode: "none" | "writable" | "setter" | "readonly" | "readonlyTrue", f: () => void): number => {
  const saved: [object, string, PropertyDescriptor | undefined][] = [];
  let calls = 0;
  // 描述符一律空原型:污染 get/set 时,测试自己的 defineProperty 也不能读到原型上的同名属性
  const np = (d: PropertyDescriptor): PropertyDescriptor => Object.assign(Object.create(null) as PropertyDescriptor, d);
  const desc = (): PropertyDescriptor => np(mode === "writable" ? { value: "污染", writable: true, configurable: true }
    : mode === "setter" ? { set() { calls++; }, configurable: true }
    : mode === "readonlyTrue" ? { value: true, writable: false, configurable: true }
    : { value: "污染", writable: false, configurable: true });
  try {
    if (mode !== "none") for (const key of keys) {
      for (const proto of /^\d+$/.test(key) ? [Object.prototype, Array.prototype] : [Object.prototype]) {
        saved.push([proto, key, Object.getOwnPropertyDescriptor(proto, key)]);
        Object.defineProperty(proto, key, desc());
      }
    }
    f();
  } finally {
    for (const [proto, key, d] of saved.reverse()) { if (d) Object.defineProperty(proto, key, np(d)); else delete (proto as Record<string, unknown>)[key]; }
  }
  return calls;
};

/** 每个公开入口的一份合法调用:返回是否被接受。用于访问器、Symbol、不可枚举、原型污染的逐入口对照。 */
const entryCases = () => {
  const dir = mk();
  const c = dir.contacts.get("c-mi")!;
  const k = commit(c, { id: "k", sourceSeq: 5, text: "x", boundTaskIds: ["T"], schedule: null });
  const withK = k.ok ? k.contact : (null as never);
  const ended = unwrap(settleTask(withK, "T"));
  const ok = (r: unknown) => (r as { ok: boolean }).ok;
  return [
    ["addContact", "联系人", { id: "n1", name: "n", speakingModel: "m" }, (x: never) => addContact(emptyDirectory(), x), ok],
    ["updateContact", "联系人修改", { memory: "m", soul: "s" }, (x: never) => updateContact(dir, "c-mi", x), ok],
    ["grantTool", "直接工具", { name: "weather", bounded: true }, (x: never) => grantTool(c, x), ok],
    ["grantComputeAsset", "能力资产", { name: "research", kind: "mcp" }, (x: never) => grantComputeAsset(c, x), ok],
    ["commit", "承诺", { id: "k2", sourceSeq: 1, text: "t", boundTaskIds: ["T"], schedule: null }, (x: never) => commit(c, x), ok],
    ["briefFor", "Compute 说明请求", { task: "t", rules: ["r"], tools: [], credentialRefs: ["vault://a"], placement: "local" }, (x: never) => briefFor(c, x), ok],
    ["confirmFinalReport", "回执", { taskId: "T", commitmentIds: ["k"], basedOnSeq: 5 }, (x: never) => unwrap(confirmFinalReport(ended, x)), (r: unknown) => (r as typeof ended).commitments[0]?.status === "done"],
  ] as const;
};

test("CH-35 每个入口:不可枚举访问器与 Symbol 键访问器都拒绝、getter 调用 0 次;不可枚举或 Symbol 键的数据属性照常接受(对照)", () => {
  for (const [label, what, base, call, accepted] of entryCases()) {
    const sym = Symbol("x");
    const variants: [string, (o: object, n: { n: number }) => void, string | null][] = [
      ["不可枚举访问器", (o, n) => Object.defineProperty(o, "debug", { enumerable: false, get: () => { n.n++; return 1; } }), "debug"],
      ["Symbol 访问器", (o, n) => Object.defineProperty(o, sym, { enumerable: true, get: () => { n.n++; return 1; } }), "Symbol(x)"],
      ["不可枚举 Symbol setter", (o, n) => Object.defineProperty(o, sym, { enumerable: false, set: () => { n.n++; } }), "Symbol(x)"],
      ["不可枚举数据属性", (o) => Object.defineProperty(o, "debug", { enumerable: false, value: 1 }), null],
      ["Symbol 数据属性", (o) => Object.defineProperty(o, sym, { enumerable: true, value: 1 }), null],
    ];
    for (const [vlabel, add, key] of variants) {
      const o = { ...base } as object;
      const n = { n: 0 };
      add(o, n);
      const r = call(o as never);
      assert.equal(accepted(r), key === null, `${label} ${vlabel}`);
      if (key !== null && typeof r === "object" && r !== null && "reason" in r) assert.equal((r as { reason: string }).reason, `${what} 只接受普通数据对象(${key} 是访问器属性)`, `${label} ${vlabel}`);
      assert.equal(n.n, 0, `${label} ${vlabel} getter 调用次数`);
    }
  }
  let hit = 0;
  const hidden = Object.defineProperty({ name: "weather", bounded: true }, Symbol("direct"), { enumerable: false, get: () => { hit++; return 1; } });
  assert.deepEqual(grantTool(mk().contacts.get("c-mi")!, hidden as never), { ok: false, reason: "直接工具 只接受普通数据对象(Symbol(direct) 是访问器属性)" });
  assert.equal(hit, 0);
});

test("CH-29 Object.prototype.value 被放成只读或可写数据属性时,含访问器的输入照样拒绝、getter 调用 0 次;无污染时同样(对照)", () => {
  for (const mode of ["none", "readonly", "writable"] as const) {
    const results: [string, boolean, number][] = [];
    const cases = entryCases();
    const prepared = cases.map(([label, , base, call, accepted]) => {
      const key = Object.keys(base)[0]!;
      const { o, calls } = withAccessor(base as Record<string, unknown>, key);
      return [label, o, calls, call, accepted] as const;
    });
    let hit = 0;
    const acc = Object.defineProperty({ bounded: true }, "name", Object.assign(Object.create(null) as PropertyDescriptor, { enumerable: true, get: () => { hit++; return "weather"; } }));
    let direct: unknown;
    withPollution(["value"], mode, () => {
      for (const [label, o, calls, call, accepted] of prepared) results.push([label, accepted(call(o as never)), calls.n]);
      direct = grantTool(mk().contacts.get("c-mi")!, acc as never);
    });
    assert.deepEqual(direct, { ok: false, reason: "直接工具 只接受普通数据对象(name 是访问器属性)" }, mode);
    assert.equal(hit, 0, mode);
    for (const [label, acc, n] of results) {
      assert.equal(acc, false, `${mode} ${label}`);
      assert.equal(n, 0, `${mode} ${label} getter 调用次数`);
    }
  }
});

test("CH-30 Object.prototype.get/set 被放成 setter 或只读属性时,带同名普通字段的合法输入照常接受、不抛、setter 调用 0 次;无污染时同样(对照)", () => {
  for (const mode of ["none", "setter", "readonly"] as const) {
    const results: [string, boolean | string][] = [];
    const cases = entryCases();
    const prepared = cases.map(([label, , base, call, accepted]) => [label, { ...base, get: "legitimate-extra", set: "legitimate-extra" }, call, accepted] as const);
    const calls = withPollution(["get", "set"], mode, () => {
      for (const [label, o, call, accepted] of prepared) {
        try { results.push([label, accepted(call(o as never))]); } catch (e) { results.push([label, `抛出 ${(e as Error).message}`]); }
      }
      const arr = briefFor(mk().contacts.get("c-mi")!, { task: "t", rules: ["r1", "r2"], tools: [], credentialRefs: [] });
      results.push(["briefFor 数组写入", arr.ok && arr.brief.rules.length === 2]);
    });
    for (const [label, acc] of results) assert.equal(acc, true, `${mode} ${label}`);
    assert.equal(calls, 0, `${mode} setter 调用次数`);
  }
});

test("CH-31 每个入口的每个必填字段:缺失或类型不对都拒绝、正常值接受;Object.prototype.optional 被放成只读 true 时结果相同", () => {
  const wrong: Record<string, unknown> = { id: 1, name: 1, speakingModel: 1, bounded: "yes", kind: 1, sourceSeq: "1", text: 1, boundTaskIds: "T", schedule: "0 8 * * *", task: 1, rules: "r", tools: "t", credentialRefs: "c", taskId: 1, commitmentIds: "k", basedOnSeq: "5" };
  for (const mode of ["none", "readonlyTrue"] as const) {
    const results: [string, boolean, boolean][] = [];
    const cases = entryCases().filter(([label]) => label !== "updateContact");
    const prepared: [string, object, (x: never) => unknown, (r: unknown) => boolean, boolean][] = [];
    for (const [label, , base, call, accepted] of cases) {
      for (const key of Object.keys(base).filter((k) => k !== "placement")) {
        const missing = { ...base } as Record<string, unknown>;
        delete missing[key];
        prepared.push([`${label}.${key} 缺失`, missing, call, accepted, false]);
        prepared.push([`${label}.${key} 类型不对`, { ...base, [key]: wrong[key] }, call, accepted, false]);
      }
      prepared.push([`${label} 正常`, { ...base }, call, accepted, true]);
    }
    let direct: unknown;
    withPollution(["optional"], mode, () => {
      for (const [label, o, call, accepted, want] of prepared) results.push([label, accepted(call(o as never)), want]);
      direct = commit(mk().contacts.get("c-mi")!, { id: "k9", sourceSeq: 1, text: "t", boundTaskIds: [] } as never);
    });
    assert.deepEqual(direct, { ok: false, reason: "schedule 必须是对象" }, mode);
    for (const [label, got, want] of results) assert.equal(got, want, `${mode} ${label}`);
  }
});

test("CH-32 状态参数同样走普通数据合同:联系人状态是 Proxy、自定义原型或含访问器时,各入口拒绝且 getter 调用 0 次;普通状态照常(对照)", () => {
  const c0 = mk().contacts.get("c-mi")!;
  const k = commit(c0, { id: "k", sourceSeq: 1, text: "x", boundTaskIds: ["T"], schedule: null });
  const c = k.ok ? k.contact : (null as never);
  const calls = { n: 0 };
  const accessorState = { ...c } as Record<string, unknown>;
  delete accessorState.memory;
  Object.defineProperty(accessorState, "memory", { enumerable: true, get: () => { calls.n++; return "偷换"; } });
  const states: [string, unknown, string][] = [
    ["memory 是访问器", accessorState, "联系人状态 只接受普通数据对象(memory 是访问器属性)"],
    ["Proxy", new Proxy({ ...c }, {}), "联系人状态 只接受普通数据对象"],
    ["自定义原型", Object.assign(Object.create({ x: 1 }), c), "联系人状态 只接受普通数据对象"],
    ["工具项是 Proxy", { ...c, tools: [new Proxy({ name: "w", bounded: true }, {})] }, "tools[0] 只接受普通数据对象"],
    ["承诺数组是 Proxy", { ...c, commitments: new Proxy([...c.commitments], {}) }, "commitments 只接受普通数据数组"],
  ];
  for (const [label, s, reason] of states) {
    const st = s as never;
    for (const [entry, r] of [["grantTool", grantTool(st, { name: "weather", bounded: true })], ["grantComputeAsset", grantComputeAsset(st, { name: "x", kind: "mcp" })], ["commit", commit(st, { id: "k2", sourceSeq: 1, text: "t", boundTaskIds: [], schedule: null })], ["revokeCommitment", revokeCommitment(st, "k")], ["briefFor", briefFor(st, { task: "t", rules: [], tools: [], credentialRefs: [] })]] as const) {
      assert.deepEqual(r, { ok: false, reason }, `${label} ${entry}`);
    }
    assert.deepEqual(settleTask(st, "T"), { ok: false, reason }, `${label} settleTask`);
    assert.deepEqual(confirmFinalReport(st, rc("T", ["k"], 1)), { ok: false, reason }, `${label} confirmFinalReport`);
    assert.equal(canCallDirectly(st, "weather"), false, `${label} canCallDirectly`);
  }
  assert.equal(calls.n, 0);
  assert.equal(grantTool(c, { name: "weather", bounded: true }).ok, true);
  assert.equal(revokeCommitment(c, "k").ok, true);
  assert.equal(unwrap(settleTask(c, "T")).commitments[0]?.awaitingReport[0], "T");
});

test("CH-32 目录状态同样走普通数据合同:外层 Proxy、contacts 访问器、contacts 是 Map Proxy 或不是 Map、里面的联系人含访问器时 addContact/updateContact 拒绝;普通目录照常(对照)", () => {
  const d = mk();
  const c = d.contacts.get("c-mi")!;
  let n = 0;
  const accessorDir = {};
  Object.defineProperty(accessorDir, "contacts", { enumerable: true, get: () => { n++; return d.contacts; } });
  const badContact = { ...c } as Record<string, unknown>;
  delete badContact.name;
  Object.defineProperty(badContact, "name", { enumerable: true, get: () => { n++; return "x"; } });
  const dirs: [string, unknown, string][] = [
    ["外层 Proxy", new Proxy({ contacts: d.contacts }, {}), "目录 只接受普通数据对象"],
    ["contacts 访问器", accessorDir, "目录 只接受普通数据对象(contacts 是访问器属性)"],
    ["contacts 是 Map Proxy", { contacts: new Proxy(new Map(d.contacts), {}) }, "目录.contacts 必须是普通 Map"],
    ["contacts 不是 Map", { contacts: { "c-mi": c } }, "目录.contacts 必须是普通 Map"],
    ["联系人含访问器", { contacts: new Map([["c-mi", badContact]]) }, "联系人状态 只接受普通数据对象(name 是访问器属性)"],
  ];
  for (const [label, dir, reason] of dirs) {
    assert.deepEqual(addContact(dir as never, { id: "n2", name: "n", speakingModel: "m" }), { ok: false, reason }, `${label} addContact`);
    assert.deepEqual(updateContact(dir as never, "c-mi", { memory: "m" }), { ok: false, reason }, `${label} updateContact`);
  }
  assert.equal(n, 0);
  assert.equal(addContact(d, { id: "n2", name: "n", speakingModel: "m" }).ok, true);
  assert.equal(updateContact(d, "c-mi", { memory: "m" }).ok, true);
});

test("CH-33 旧版本形状(带 focus 字段)的联系人经 commit/settleTask/confirmFinalReport/revokeCommitment/updateContact/grantTool 后,输出不再有 focus", () => {
  const c = mk().contacts.get("c-mi")!;
  const k = commit(c, { id: "k", sourceSeq: 1, text: "只盯 T", boundTaskIds: ["T"], schedule: null });
  const legacy = Object.freeze({ ...(k.ok ? k.contact : (null as never)), focus: Object.freeze({ onlyCommitmentId: "k" }) });
  assert.equal("focus" in legacy, true);
  const outs: [string, object][] = [];
  const committed = commit(legacy, { id: "k2", sourceSeq: 2, text: "t", boundTaskIds: [], schedule: null });
  outs.push(["commit", committed.ok ? committed.contact : {}]);
  const settled = unwrap(settleTask(legacy, "T"));
  outs.push(["settleTask", settled]);
  outs.push(["confirmFinalReport", unwrap(confirmFinalReport(settled, rc("T", ["k"], 1)))]);
  const revoked = revokeCommitment(legacy, "k");
  outs.push(["revokeCommitment", revoked.ok ? revoked.contact : {}]);
  const updated = updateContact({ contacts: new Map([["c-mi", legacy]]) }, "c-mi", { memory: "新" });
  outs.push(["updateContact", updated.ok ? updated.dir.contacts.get("c-mi")! : {}]);
  const granted = grantTool(legacy, { name: "weather", bounded: true });
  outs.push(["grantTool", granted.ok ? granted.contact : {}]);
  for (const [label, out] of outs) {
    assert.equal("id" in out, true, label);
    assert.equal("focus" in out, false, label);
  }
  assert.equal(settled.commitments[0]?.status, "active");
  assert.equal(unwrap(confirmFinalReport(settled, rc("T", ["k"], 1))).commitments[0]?.status, "done");
  assert.equal(revoked.ok && revoked.contact.commitments[0]?.status, "revoked");
});

test("CH-34 briefFor 输出的 tools/credentialRefs 来自按下标复制的快照:入参数组自带的 Symbol.iterator 数据属性改写不了输出;无改写时同样(对照)", () => {
  const g = grantTool(mk().contacts.get("c-mi")!, { name: "weather", bounded: true });
  const c = g.ok ? g.contact : (null as never);
  for (const rewire of [false, true]) {
    const tools = ["weather"];
    const refs = ["vault://a"];
    if (rewire) {
      Object.defineProperty(tools, Symbol.iterator, { value: function* () { yield "run_command"; } });
      Object.defineProperty(refs, Symbol.iterator, { value: function* () { yield "plaintext-secret"; } });
    }
    const r = briefFor(c, { task: "t", rules: [], tools, credentialRefs: refs });
    assert.equal(r.ok, true, `rewire=${rewire}`);
    assert.deepEqual(r.ok && [...r.brief.tools], ["weather"], `rewire=${rewire} tools`);
    assert.deepEqual(r.ok && [...r.brief.credentialRefs], ["vault://a"], `rewire=${rewire} credentialRefs`);
  }
});

test("CH-34 Object.prototype.placement 被放成只读非法值时,不带 placement 的 briefFor 仍默认 local;Object.prototype.memory 被污染时,空修改不改记忆;无污染时同样(对照)", () => {
  for (const mode of ["none", "readonly"] as const) {
    let brief: unknown;
    let mem: unknown;
    withPollution(["placement", "memory"], mode, () => {
      const r = briefFor(mk().contacts.get("c-mi")!, { task: "t", rules: [], tools: [], credentialRefs: [] });
      brief = r.ok ? r.brief.placement : r.reason;
      const u = updateContact(mk(), "c-mi", {});
      mem = u.ok ? u.dir.contacts.get("c-mi")!.memory : u.reason;
    });
    assert.equal(brief, "local", mode);
    assert.equal(mem, mk().contacts.get("c-mi")!.memory, mode);
  }
});

test("CH-34 commit 存下的是按下标复制的快照:boundTaskIds 自带的 Symbol.iterator 数据属性改写不了存下的绑定任务,多余字段不进承诺;无改写时同样(对照)", () => {
  for (const rewire of [false, true]) {
    const ids = ["T"];
    if (rewire) Object.defineProperty(ids, Symbol.iterator, { value: function* () { yield "偷换"; } });
    const r = commit(mk().contacts.get("c-mi")!, { id: "k", sourceSeq: 1, text: "t", boundTaskIds: ids, schedule: null, extra: "多余" } as never);
    assert.equal(r.ok, true, `rewire=${rewire}`);
    const k = r.ok ? r.contact.commitments[0]! : (null as never);
    assert.deepEqual([...k.boundTaskIds], ["T"], `rewire=${rewire}`);
    assert.equal("extra" in k, false, `rewire=${rewire}`);
  }
});

// ---------------------------------------------------------------- 第十三轮(CH-36–CH-38、公开快照只读、AD01–AD04、CY06)

/** 计数 Proxy:handler 本身也是 Proxy,对目标的任何操作(get、ownKeys、getOwnPropertyDescriptor、getPrototypeOf……)都要先查一次 trap,查一次记一次。 */
const counted = <T extends object>(target: T, n: { v: number }): T =>
  new Proxy(target, new Proxy({}, { get: (_h, trap) => { n.v++; return Reflect.get(Reflect, trap); } }) as ProxyHandler<T>);
/** 普通 JSON 数据:模拟宿主从存储读回来的状态。 */
const js = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
/** 带一项直接工具、一项 Compute 能力资产、一条绑定任务 T 的承诺 k 的联系人(全经登记入口产生)。 */
const fullContact = (): Contact => {
  const g = grantTool(mk().contacts.get("c-mi")!, { name: "get_weather", bounded: true });
  const a = grantComputeAsset(g.ok ? g.contact : (null as never), { name: "ws_script", kind: "script" });
  const k = commit(a.ok ? a.contact : (null as never), { id: "k", sourceSeq: 1, text: "汇报", boundTaskIds: ["T"], schedule: null });
  return k.ok ? k.contact : (null as never);
};
/** 接受联系人状态的每个入口(canCallDirectly 另查)对同一状态的结果。 */
const stateEntryResults = (st: never) => [
  ["grantTool", grantTool(st, { name: "weather", bounded: true })],
  ["grantComputeAsset", grantComputeAsset(st, { name: "x", kind: "mcp" })],
  ["commit", commit(st, { id: "k9", sourceSeq: 1, text: "t", boundTaskIds: [], schedule: null })],
  ["revokeCommitment", revokeCommitment(st, "k")],
  ["briefFor", briefFor(st, { task: "t", rules: [], tools: ["get_weather"], credentialRefs: [] })],
  ["settleTask", settleTask(st, "T")],
  ["confirmFinalReport", confirmFinalReport(st, rc("T", ["k"], 1))],
] as const;

test("CH-36 updateContact/revokeCommitment/settleTask/canCallDirectly 的 id 参数:Proxy、自带 Symbol.toPrimitive/toString getter 的对象、数字、null 被拒且不插值,trap 与 getter 调用 0 次;正常字符串照常(对照)", () => {
  const dir = mk();
  const c = fullContact();
  const n = { v: 0 };
  const toPrim = {
    get [Symbol.toPrimitive]() { n.v++; return () => "k"; },
    get toString() { n.v++; return () => "k"; },
    get valueOf() { n.v++; return () => "k"; },
  };
  const ids: [string, unknown][] = [["Proxy", counted({}, n)], ["Proxy 包字符串对象", counted(Object("k") as object, n)], ["toPrimitive getter", toPrim], ["数字", 42], ["null", null], ["undefined", undefined]];
  for (const [label, raw] of ids) {
    const id = raw as never;
    assert.deepEqual(updateContact(dir, id, { memory: "m" }), { ok: false, reason: "联系人 id 必须是字符串" }, `${label} updateContact`);
    assert.deepEqual(revokeCommitment(c, id), { ok: false, reason: "承诺 id 必须是字符串" }, `${label} revokeCommitment`);
    assert.deepEqual(settleTask(c, id), { ok: false, reason: "任务 id 必须是字符串" }, `${label} settleTask`);
    assert.equal(canCallDirectly(c, id), false, `${label} canCallDirectly`);
  }
  assert.equal(n.v, 0);
  const u = updateContact(dir, "c-mi", { memory: "m" });
  assert.equal(u.ok && u.dir.contacts.get("c-mi")?.memory, "m");
  const r = revokeCommitment(c, "k");
  assert.equal(r.ok && r.contact.commitments[0]?.status, "revoked");
  assert.deepEqual(unwrap(settleTask(c, "T")).commitments[0]?.awaitingReport, ["T"]);
  assert.equal(canCallDirectly(c, "get_weather"), true);
  assert.deepEqual(updateContact(dir, "nobody", { memory: "m" }), { ok: false, reason: "联系人 nobody 不存在" });
  assert.deepEqual(revokeCommitment(c, "nope"), { ok: false, reason: "承诺 nope 不存在或已结束" });
});

test("CH-36 normalize 是内部模块的工具,不是公开入口:contact 模块与包入口都不导出它,包 exports 只有 \".\";联系人入口照常规范化(对照)", () => {
  assert.equal(Object.hasOwn(contactModule, "normalize"), false);
  assert.equal(Object.hasOwn(domain.contact, "normalize"), false);
  assert.equal(Object.hasOwn(domain, "normalize"), false);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.exports), ["."]);
  assert.equal(pkg.exports["."], "./src/index.ts");
  const d = domain.contact.addContact(domain.contact.emptyDirectory(), { id: "x", name: "n", speakingModel: "m", extra: 1 } as never);
  assert.equal(d.ok && d.dir.contacts.get("x")?.name, "n");
  assert.equal(d.ok && "extra" in (d.dir.contacts.get("x") as object), false);
});

test("CH-37 settleTask 与 confirmFinalReport 收到 JSON null、数字、字符串、数组或缺省状态时返回 { ok:false } 不抛;同一合法状态 JSON 往返后照常(对照)", () => {
  const c = fullContact();
  const states: [string, unknown, string][] = [
    ["JSON null", JSON.parse("null"), "联系人状态 必须是对象"],
    ["数字", JSON.parse("1"), "联系人状态 必须是对象"],
    ["字符串", JSON.parse('"c-mi"'), "联系人状态 必须是对象"],
    ["数组", JSON.parse("[]"), "联系人状态 必须是对象"],
    ["缺省", undefined, "联系人状态 必须是对象"],
    ["空对象", JSON.parse("{}"), "id 必须是字符串"],
  ];
  for (const [label, raw, reason] of states) {
    const st = raw as never;
    assert.deepEqual(settleTask(st, "T"), { ok: false, reason }, `${label} settleTask`);
    assert.deepEqual(confirmFinalReport(st, rc("T", ["k"], 1)), { ok: false, reason }, `${label} confirmFinalReport`);
    assert.deepEqual(confirmFinalReport(st, JSON.parse("null")), { ok: false, reason }, `${label} confirmFinalReport(null 回执)`);
  }
  const settled = unwrap(settleTask(js(c), "T"));
  assert.deepEqual(settled.commitments[0]?.awaitingReport, ["T"]);
  assert.equal(unwrap(confirmFinalReport(js(settled), rc("T", ["k"], 1))).commitments[0]?.status, "done");
  assert.deepEqual(confirmFinalReport(js(settled), JSON.parse("null")), { ok: true, contact: settled });
});

test("CH-38 联系人状态的业务不变量:无界或禁项直接工具、空名工具、与能力资产同名的工具、非法资产类别、空名资产、非法承诺状态、非法出处、非法定时都拒绝,不能当授权依据;登记入口产生的状态照常(对照)", () => {
  const base = js(fullContact()) as unknown as Record<string, unknown> & { commitments: Record<string, unknown>[] };
  const k0 = base.commitments[0] as Record<string, unknown>;
  const at = "联系人状态";
  const cases: [string, Record<string, unknown>, string][] = [
    ["无界的 run_command", { tools: [{ name: "run_command", bounded: false }] }, `${at}.tools[0] 不是有界工具,不能当直接工具`],
    ["禁项 run_command 标成有界", { tools: [{ name: "run_command", bounded: true }] }, `${at}.tools[0] run_command 是通用能力,不能在直接工具清单里`],
    ["空白工具名", { tools: [{ name: " \n", bounded: true }] }, `${at}.tools[0] 工具名为空`],
    ["工具与能力资产同名", { computeAssets: [{ name: "get_weather", kind: "mcp" }] }, `${at}.tools[0] get_weather 同时登记为 Compute 能力资产`],
    ["非法资产类别", { computeAssets: [{ name: "strange", kind: "invalid-kind" }] }, `${at}.computeAssets[0] 的类别 invalid-kind 不认识`],
    ["空白资产名", { computeAssets: [{ name: "\t", kind: "mcp" }] }, `${at}.computeAssets[0] 能力资产名为空`],
    ["非法承诺状态", { commitments: [{ ...k0, status: "paused" }] }, `${at}.commitments[0] 的状态 paused 不认识`],
    ["负数出处", { commitments: [{ ...k0, sourceSeq: -1 }] }, `${at}.commitments[0] 的出处 -1 不是合法的消息位置`],
    ["小数出处", { commitments: [{ ...k0, sourceSeq: 1.5 }] }, `${at}.commitments[0] 的出处 1.5 不是合法的消息位置`],
    ["非法定时", { commitments: [{ ...k0, schedule: { cron: "bad", tz: "Asia/Shanghai", toleranceSec: 1 } }] }, `${at}.commitments[0] 定时表达式 "bad" 不是 5 段 cron`],
  ];
  for (const [label, patch, reason] of cases) {
    const st = JSON.parse(JSON.stringify({ ...base, ...patch })) as never;
    for (const [entry, r] of stateEntryResults(st)) assert.deepEqual(r, { ok: false, reason }, `${label} ${entry}`);
    for (const name of ["run_command", "get_weather", " \n", "strange"]) assert.equal(canCallDirectly(st, name), false, `${label} canCallDirectly ${name}`);
    assert.deepEqual(briefFor(st, { task: "t", rules: [], tools: ["run_command"], credentialRefs: [] }), { ok: false, reason }, `${label} briefFor run_command`);
    assert.deepEqual(updateContact({ contacts: new Map([["c-mi", st]]) }, "c-mi", { memory: "m" }), { ok: false, reason }, `${label} updateContact`);
    assert.deepEqual(addContact({ contacts: new Map([["c-mi", st]]) }, { id: "n2", name: "n", speakingModel: "m" }), { ok: false, reason }, `${label} addContact`);
  }
  const ok = JSON.parse(JSON.stringify(base)) as never;
  for (const [entry, r] of stateEntryResults(ok)) assert.equal(r.ok, true, `对照 ${entry}`);
  assert.equal(canCallDirectly(ok, "get_weather"), true);
  assert.equal(canCallDirectly(ok, "ws_script"), false);
  const g = grantTool(ok, { name: "weather", bounded: true });
  assert.deepEqual(g.ok && g.contact.tools, [{ name: "get_weather", bounded: true }, { name: "weather", bounded: true }]);
});

test("CH-38 目录状态的键必须等于联系人自己的 id:键为 alias、id 为 x 时 updateContact/addContact 拒绝,不会产生两条指向同一 id 的记录;键与 id 一致照常(对照)", () => {
  const x = js({ ...fullContact(), id: "x" });
  const bad = { contacts: new Map([["alias", x]]) };
  const reason = "目录.contacts 的键 alias 与联系人 id x 不一致";
  assert.deepEqual(updateContact(bad, "alias", { memory: "m" }), { ok: false, reason });
  assert.deepEqual(updateContact(bad, "x", { memory: "m" }), { ok: false, reason });
  assert.deepEqual(addContact(bad, { id: "y", name: "n", speakingModel: "m" }), { ok: false, reason });
  const good = updateContact({ contacts: new Map([["x", x]]) }, "x", { memory: "m" });
  assert.deepEqual(good.ok && [...good.dir.contacts.keys()], ["x"]);
  assert.equal(good.ok && good.dir.contacts.get("x")?.memory, "m");
});

test("公开快照运行时只读:Directory.contacts 没有 set/delete/clear,借 Map.prototype 方法改不动,实例、原型与类都冻结;读方法照常,输出的目录能原样传回入口(对照)", () => {
  const d = mk();
  const t = d.contacts as unknown as Record<string, unknown>;
  for (const m of ["set", "delete", "clear"]) assert.equal(typeof t[m], "undefined", m);
  assert.throws(() => Map.prototype.delete.call(d.contacts, "c-mi"), TypeError);
  assert.throws(() => Map.prototype.set.call(d.contacts, "c-mi", null), TypeError);
  assert.throws(() => Map.prototype.clear.call(d.contacts), TypeError);
  assert.throws(() => { t.delete = () => true; }, TypeError);
  const proto = Object.getPrototypeOf(d.contacts) as Record<string, unknown>;
  assert.throws(() => { proto.get = () => undefined; }, TypeError);
  assert.equal(Object.isFrozen(d), true);
  assert.equal(Object.isFrozen(d.contacts), true);
  assert.equal(Object.isFrozen(proto), true);
  assert.equal(Object.isFrozen(d.contacts.constructor), true);
  assert.equal(d.contacts.size, 1);
  assert.equal(d.contacts.has("c-mi"), true);
  assert.equal(d.contacts.get("c-mi")?.name, "小秘");
  assert.deepEqual([...d.contacts.keys()], ["c-mi"]);
  assert.deepEqual([...d.contacts.values()].map((c) => c.id), ["c-mi"]);
  assert.deepEqual([...d.contacts.entries()].map(([k]) => k), ["c-mi"]);
  assert.deepEqual([...d.contacts].map(([k]) => k), ["c-mi"]);
  const seen: string[] = [];
  d.contacts.forEach((c, k, map) => { seen.push(`${k}:${c.id}:${map === d.contacts}`); });
  assert.deepEqual(seen, ["c-mi:c-mi:true"]);
  const u = updateContact(d, "c-mi", { memory: "m" });
  assert.equal(u.ok && u.dir.contacts.get("c-mi")?.memory, "m");
  assert.equal(d.contacts.get("c-mi")?.memory, "");
  assert.equal(emptyDirectory().contacts.size, 0);
  assert.equal(typeof (emptyDirectory().contacts as unknown as Record<string, unknown>).delete, "undefined");
});

test("公开快照运行时只读:拿到联系人表的构造函数自造表也绕不过状态校验(内部 Map 是 Proxy 或内容非法都拒绝、不抛)", () => {
  const d = mk();
  const c = d.contacts.get("c-mi")!;
  const Forged = d.contacts.constructor as new (m: unknown) => object;
  const evil = new Forged(new Map([["c-mi", { ...c, tools: [{ name: "bash", bounded: true }] }]]));
  assert.deepEqual(updateContact({ contacts: evil } as never, "c-mi", { memory: "m" }), { ok: false, reason: "联系人状态.tools[0] bash 是通用能力,不能在直接工具清单里" });
  const n = { v: 0 };
  const proxied = new Forged(counted(new Map([["c-mi", c]]), n));
  assert.deepEqual(updateContact({ contacts: proxied } as never, "c-mi", { memory: "m" }), { ok: false, reason: "目录.contacts 必须是普通 Map" });
  assert.deepEqual(addContact({ contacts: new Forged({ "c-mi": c }) } as never, { id: "y", name: "n", speakingModel: "m" }), { ok: false, reason: "目录.contacts 必须是普通 Map" });
  assert.equal(n.v, 0);
  const fine = updateContact({ contacts: new Forged(new Map([["c-mi", c]])) } as never, "c-mi", { memory: "m" });
  assert.equal(fine.ok && fine.dir.contacts.get("c-mi")?.memory, "m");
});

test("AD01–AD03 状态对象数组及元素的 Proxy 表驱动:computeAssets[0]、commitments[0]、tools[0]、schedule、computeAssets/tools/commitments 数组、承诺里的三张任务表是 Proxy 时各入口拒绝,trap 0 次;同样内容的普通值通过(对照)", () => {
  const sch = js({ ...fullContact() }) as unknown as Record<string, unknown> & { tools: object[]; computeAssets: object[]; commitments: Record<string, unknown>[] };
  const k0 = sch.commitments[0] as Record<string, unknown>;
  const scheduled = { ...k0, boundTaskIds: [], schedule: { ...daily8 } };
  const n = { v: 0 };
  const cases: [string, (wrap: <T extends object>(x: T) => T) => Record<string, unknown>, string][] = [
    ["computeAssets[0]", (w) => ({ computeAssets: [w({ ...sch.computeAssets[0] })] }), "computeAssets[0] 只接受普通数据对象"],
    ["commitments[0]", (w) => ({ commitments: [w({ ...k0 })] }), "commitments[0] 只接受普通数据对象"],
    ["tools[0]", (w) => ({ tools: [w({ ...sch.tools[0] })] }), "tools[0] 只接受普通数据对象"],
    ["schedule", (w) => ({ commitments: [{ ...scheduled, schedule: w({ ...daily8 }) }] }), "schedule 只接受普通数据对象"],
    ["computeAssets 数组", (w) => ({ computeAssets: w([...sch.computeAssets]) }), "computeAssets 只接受普通数据数组"],
    ["tools 数组", (w) => ({ tools: w([...sch.tools]) }), "tools 只接受普通数据数组"],
    ["commitments 数组", (w) => ({ commitments: w([...sch.commitments]) }), "commitments 只接受普通数据数组"],
    ["boundTaskIds", (w) => ({ commitments: [{ ...k0, boundTaskIds: w(["T"]) }] }), "boundTaskIds 只接受普通数据数组"],
    ["awaitingReport", (w) => ({ commitments: [{ ...k0, awaitingReport: w([]) }] }), "awaitingReport 只接受普通数据数组"],
    ["reportedTaskIds", (w) => ({ commitments: [{ ...k0, reportedTaskIds: w([]) }] }), "reportedTaskIds 只接受普通数据数组"],
  ];
  for (const [label, make, reason] of cases) {
    const st = { ...sch, ...make((x) => counted(x, n)) } as never;
    for (const [entry, r] of stateEntryResults(st)) assert.deepEqual(r, { ok: false, reason }, `${label} ${entry}`);
    assert.equal(canCallDirectly(st, "get_weather"), false, `${label} canCallDirectly`);
    assert.deepEqual(updateContact({ contacts: new Map([["c-mi", st]]) }, "c-mi", { memory: "m" }), { ok: false, reason }, `${label} updateContact`);
    const plain = { ...sch, ...make((x) => x) } as never;
    assert.equal(canCallDirectly(plain, "get_weather"), true, `${label} 对照 canCallDirectly`);
    for (const [entry, r] of stateEntryResults(plain)) assert.equal(r.ok, true, `${label} 对照 ${entry}`);
  }
  assert.equal(n.v, 0);
});

test("AD04 导出策略不可改写:FORBIDDEN_DIRECT_TOOLS 冻结,push、改写、删除、截断都抛 TypeError,内容不变;尝试之后 grantTool 仍拒绝全部通用能力", () => {
  const list = FORBIDDEN_DIRECT_TOOLS as string[];
  assert.equal(Object.isFrozen(FORBIDDEN_DIRECT_TOOLS), true);
  assert.equal(domain.contact.FORBIDDEN_DIRECT_TOOLS, FORBIDDEN_DIRECT_TOOLS);
  assert.throws(() => { list.push("x"); }, TypeError);
  assert.throws(() => { list[0] = "safe_tool"; }, TypeError);
  assert.throws(() => { list.length = 0; }, TypeError);
  assert.throws(() => { list.splice(0, 1); }, TypeError);
  assert.throws(() => { delete list[3]; }, TypeError);
  assert.deepEqual([...FORBIDDEN_DIRECT_TOOLS], SPEC_GENERAL_TOOLS);
  const c = mk().contacts.get("c-mi")!;
  for (const name of SPEC_GENERAL_TOOLS) assert.equal(grantTool(c, { name, bounded: true }).ok, false, name);
  assert.equal(grantTool(c, { name: "get_weather", bounded: true }).ok, true);
});

test("CY06 回执 commitmentIds 自带 includes 数据属性函数时,确认只按下标复制的快照生效:点名 a 只确认 a、不确认 b;普通数组同样(对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "a", sourceSeq: 1, text: "x", boundTaskIds: ["T"], schedule: null });
  const b = commit(a.ok ? a.contact : (null as never), { id: "b", sourceSeq: 1, text: "y", boundTaskIds: ["T"], schedule: null });
  const ended = unwrap(settleTask(b.ok ? b.contact : (null as never), "T"));
  const ids = ["a"];
  Object.defineProperty(ids, "includes", { value: (x: string) => x === "b", writable: true, enumerable: false, configurable: true });
  assert.equal(Object.getPrototypeOf(ids), Array.prototype);
  const tricky = unwrap(confirmFinalReport(ended, { taskId: "T", commitmentIds: ids, basedOnSeq: 5 }));
  assert.deepEqual(tricky.commitments.map((k) => [k.id, k.status]), [["a", "done"], ["b", "active"]]);
  const plain = unwrap(confirmFinalReport(ended, { taskId: "T", commitmentIds: ["a"], basedOnSeq: 5 }));
  assert.deepEqual(plain.commitments.map((k) => [k.id, k.status]), [["a", "done"], ["b", "active"]]);
});

// ---------------------------------------------------------------- 第十四轮(reviews/feat-contact-helper.md CH-39 / CH-40)
// 合法状态一律经登记入口产生再 JSON 往返(模拟宿主从存储读回),反例只把其中的标识改成空或重复。
/** 经登记入口产生:直接工具 get_weather、t_a、t_b;能力资产 ws_script/script、a_mcp/mcp、a_skill/skill;承诺 k(绑定 T)、k2(绑定 T2)、k3(定时)。 */
const threeOfEach = (): Contact => {
  let c = fullContact();
  for (const name of ["t_a", "t_b"]) c = unwrap(grantTool(c, { name, bounded: true }));
  c = unwrap(grantComputeAsset(c, { name: "a_mcp", kind: "mcp" }));
  c = unwrap(grantComputeAsset(c, { name: "a_skill", kind: "skill" }));
  c = unwrap(commit(c, { id: "k2", sourceSeq: 2, text: "第二条", boundTaskIds: ["T2"], schedule: null }));
  c = unwrap(commit(c, { id: "k3", sourceSeq: 3, text: "每天八点", boundTaskIds: [], schedule: daily8 }));
  return js(c);
};
type Raw = Record<string, unknown> & { tools: Record<string, unknown>[]; computeAssets: Record<string, unknown>[]; commitments: Record<string, unknown>[] };
const raw = (c: Contact): Raw => js(c) as unknown as Raw;
/** 同一份状态在全部状态入口上都按同一理由拒绝:七个联系人入口、canCallDirectly、briefFor 授出、目录的 updateContact/addContact。 */
const assertStateRejected = (st: Raw, reason: string, label: string, tool: string) => {
  const s = st as never;
  for (const [entry, r] of stateEntryResults(s)) assert.deepEqual(r, { ok: false, reason }, `${label} ${entry}`);
  assert.equal(canCallDirectly(s, tool), false, `${label} canCallDirectly ${tool}`);
  assert.deepEqual(briefFor(s, { task: "t", rules: [], tools: [tool], credentialRefs: [] }), { ok: false, reason }, `${label} briefFor ${tool}`);
  assert.deepEqual(updateContact({ contacts: new Map([[st.id as string, s]]) }, st.id as string, { memory: "m" }), { ok: false, reason }, `${label} updateContact`);
  assert.deepEqual(addContact({ contacts: new Map([[st.id as string, s]]) }, { id: "n2", name: "n", speakingModel: "m" }), { ok: false, reason }, `${label} addContact`);
};
const PAIRS: readonly (readonly [number, number])[] = [[0, 1], [0, 2], [1, 2]];

test("CH-39 联系人 id 不能为空:addContact 拒空 id;恢复目录里键与 id 都为空的完整联系人,updateContact 改记忆、addContact 与各状态入口同样拒绝;非空 id 照常(对照)", () => {
  assert.deepEqual(addContact(emptyDirectory(), { id: "", name: "n", speakingModel: "m" }), { ok: false, reason: "联系人 id 不能为空" });
  const reason = "联系人状态.id 为空";
  const empty = { ...raw(fullContact()), id: "" };
  assert.deepEqual(updateContact({ contacts: new Map([["", empty as never]]) }, "", { memory: "changed" }), { ok: false, reason });
  assertStateRejected(empty, reason, "空 id", "get_weather");
  const good = raw(fullContact());
  const u = updateContact({ contacts: new Map([["c-mi", good as never]]) }, "c-mi", { memory: "changed" });
  assert.deepEqual(u.ok && [...u.dir.contacts.keys()], ["c-mi"]);
  assert.equal(u.ok && u.dir.contacts.get("c-mi")?.memory, "changed");
  for (const [entry, r] of stateEntryResults(good as never)) assert.equal(r.ok, true, `对照 ${entry}`);
  assert.equal(canCallDirectly(good as never, "get_weather"), true);
});

test("CH-39 同一能力资产名只能登记一次:same/mcp 与 same/skill 的类别冲突、同类重复放在恢复状态首/中/尾任一对位置,grantComputeAsset、briefFor 等各入口都拒绝,不静默取第一项;登记产生的不同名状态照常(对照)", () => {
  const legit = threeOfEach();
  assert.deepEqual(grantComputeAsset(legit, { name: "a_mcp", kind: "skill" }), { ok: false, reason: "a_mcp 已登记为 mcp 类能力资产,不能再以 skill 类同名登记" });
  for (const [i, j] of PAIRS) {
    for (const sameKind of [false, true]) {
      const st = raw(legit);
      const first = st.computeAssets[i] as { name: string; kind: string };
      st.computeAssets[j] = sameKind ? { ...first } : { ...st.computeAssets[j], name: first.name };
      assert.equal(st.computeAssets.length, 3);
      const reason = `联系人状态.computeAssets[${j}] 能力资产名 ${first.name} 已在 computeAssets[${i}] 登记,同一名字只能登记一次、只能一种类别`;
      const label = `资产 ${i}/${j} ${sameKind ? "同类" : "异类"}`;
      assertStateRejected(st, reason, label, first.name);
      assert.deepEqual(grantComputeAsset(st as never, { name: first.name, kind: first.kind as "mcp" }), { ok: false, reason }, `${label} grantComputeAsset`);
    }
  }
  const again = grantComputeAsset(legit, { name: "a_mcp", kind: "mcp" });
  assert.deepEqual(again.ok && again.contact.computeAssets.map((a) => `${a.name}/${a.kind}`), ["ws_script/script", "a_mcp/mcp", "a_skill/skill"]);
  const b = briefFor(legit, { task: "t", rules: [], tools: ["ws_script", "a_mcp", "a_skill"], credentialRefs: [] });
  assert.deepEqual(b.ok && b.brief.tools, ["ws_script", "a_mcp", "a_skill"]);
});

test("CH-39 承诺 id 必须唯一:两条出处、正文不同而 id 相同的承诺放在恢复状态首/中/尾任一对位置,revokeCommitment 不会一次撤销两条,settleTask/confirmFinalReport 等各入口都拒绝;登记产生的唯一 id 状态只撤销点名那一条(对照)", () => {
  const legit = threeOfEach();
  assert.deepEqual(commit(legit, { id: "k2", sourceSeq: 9, text: "另一条", boundTaskIds: [], schedule: null }), { ok: false, reason: "承诺 k2 已存在" });
  for (const [i, j] of PAIRS) {
    const st = raw(legit);
    const id = st.commitments[i]?.id as string;
    st.commitments[j] = { ...st.commitments[j], id };
    const reason = `联系人状态.commitments[${j}] 承诺 id ${id} 已在 commitments[${i}] 使用,承诺 id 必须唯一`;
    const label = `承诺 ${i}/${j}`;
    assertStateRejected(st, reason, label, "get_weather");
    assert.deepEqual(revokeCommitment(st as never, id), { ok: false, reason }, `${label} revokeCommitment ${id}`);
  }
  const r = revokeCommitment(legit, "k2");
  assert.deepEqual(r.ok && r.contact.commitments.map((k) => [k.id, k.status]), [["k", "active"], ["k2", "revoked"], ["k3", "active"]]);
});

test("CH-39 直接工具名唯一:同名工具在恢复状态首/中/尾任一对位置重复时各入口拒绝;grantTool 重复授予幂等只留一项(对照)", () => {
  const legit = threeOfEach();
  for (const [i, j] of PAIRS) {
    const st = raw(legit);
    const name = st.tools[i]?.name as string;
    st.tools[j] = { name, bounded: true };
    assertStateRejected(st, `联系人状态.tools[${j}] 工具名 ${name} 已在 tools[${i}] 登记,同一工具只能登记一次`, `工具 ${i}/${j}`, name);
  }
  const again = grantTool(legit, { name: "t_a", bounded: true });
  assert.deepEqual(again.ok && again.contact.tools.map((t) => t.name), ["get_weather", "t_a", "t_b"]);
});

test("CH-40 状态里的每一项直接工具都校验:禁项、无界、空名、与能力资产同名的坏项分别放在第 0/1/2 项都拒绝;三项都合法时照常(对照)", () => {
  const legit = threeOfEach();
  const bads: [Record<string, unknown>, (p: number) => string][] = [
    [{ name: "shell", bounded: true }, (p) => `联系人状态.tools[${p}] shell 是通用能力,不能在直接工具清单里`],
    [{ name: "loose", bounded: false }, (p) => `联系人状态.tools[${p}] 不是有界工具,不能当直接工具`],
    [{ name: " \t", bounded: true }, (p) => `联系人状态.tools[${p}] 工具名为空`],
    [{ name: "a_skill", bounded: true }, (p) => `联系人状态.tools[${p}] a_skill 同时登记为 Compute 能力资产`],
  ];
  for (const [bad, reason] of bads) {
    for (const p of [0, 1, 2]) {
      const st = raw(legit);
      st.tools[p] = { ...bad };
      assertStateRejected(st, reason(p), `tools[${p}]=${String(bad.name)}`, String(bad.name));
    }
  }
  for (const name of ["get_weather", "t_a", "t_b"]) assert.equal(canCallDirectly(legit, name), true, `对照 ${name}`);
  for (const [entry, r] of stateEntryResults(legit as never)) assert.equal(r.ok, true, `对照 ${entry}`);
});

test("CH-40 状态里的每一项能力资产都校验:非法类别、空名的坏项分别放在第 0/1/2 项都拒绝;三项都合法时照常(对照)", () => {
  const legit = threeOfEach();
  const bads: [Record<string, unknown>, (p: number) => string][] = [
    [{ name: "odd", kind: "plugin" }, (p) => `联系人状态.computeAssets[${p}] 的类别 plugin 不认识`],
    [{ name: "\n", kind: "mcp" }, (p) => `联系人状态.computeAssets[${p}] 能力资产名为空`],
  ];
  for (const [bad, reason] of bads) {
    for (const p of [0, 1, 2]) {
      const st = raw(legit);
      st.computeAssets[p] = { ...bad };
      assertStateRejected(st, reason(p), `computeAssets[${p}]=${String(bad.kind)}`, String(bad.name));
    }
  }
  for (const [entry, r] of stateEntryResults(legit as never)) assert.equal(r.ok, true, `对照 ${entry}`);
  const all = briefFor(legit, { task: "t", rules: [], tools: ["ws_script", "a_mcp", "a_skill"], credentialRefs: [] });
  assert.deepEqual(all.ok && all.brief.tools, ["ws_script", "a_mcp", "a_skill"]);
  assert.equal(canCallDirectly(legit, "a_mcp"), false);
});

test("CH-40 状态里的每一条承诺都校验:非法状态、非法出处、非法定时的坏项分别放在第 0/1/2 条都拒绝;三条都合法时照常(对照)", () => {
  const legit = threeOfEach();
  const bads: [(k: Record<string, unknown>) => Record<string, unknown>, (p: number) => string][] = [
    [(k) => ({ ...k, status: "unknown" }), (p) => `联系人状态.commitments[${p}] 的状态 unknown 不认识`],
    [(k) => ({ ...k, sourceSeq: -1 }), (p) => `联系人状态.commitments[${p}] 的出处 -1 不是合法的消息位置`],
    [(k) => ({ ...k, schedule: { cron: "bad", tz: "Asia/Shanghai", toleranceSec: 1 } }), (p) => `联系人状态.commitments[${p}] 定时表达式 "bad" 不是 5 段 cron`],
  ];
  for (const [mutate, reason] of bads) {
    for (const p of [0, 1, 2]) {
      const st = raw(legit);
      st.commitments[p] = mutate(st.commitments[p] as Record<string, unknown>);
      assertStateRejected(st, reason(p), `commitments[${p}] ${reason(p)}`, "get_weather");
    }
  }
  for (const [entry, r] of stateEntryResults(legit as never)) assert.equal(r.ok, true, `对照 ${entry}`);
  const r = revokeCommitment(legit, "k3");
  assert.deepEqual(r.ok && r.contact.commitments.map((k) => k.status), ["active", "active", "revoked"]);
});

test("CH-40 目录键必须与联系人 id 精确相等:键与 id 互为前缀或后缀(person/person-2、son/person)都拒绝,坏项在目录第 1/2/3 项一样;键与 id 精确相等照常(对照)", () => {
  const as = (id: string) => ({ ...raw(fullContact()), id }) as never;
  for (const [key, id] of [["person", "person-2"], ["person-2", "person"], ["son", "person"], ["person", "son"]] as const) {
    const reason = `目录.contacts 的键 ${key} 与联系人 id ${id} 不一致`;
    for (const p of [0, 1, 2]) {
      const entries: [string, never][] = [["a", as("a")], ["b", as("b")]];
      entries.splice(p, 0, [key, as(id)]);
      const dir = { contacts: new Map(entries) };
      assert.deepEqual(updateContact(dir, key, { memory: "m" }), { ok: false, reason }, `${key}/${id} 第 ${p} 项 updateContact`);
      assert.deepEqual(updateContact(dir, "a", { memory: "m" }), { ok: false, reason }, `${key}/${id} 第 ${p} 项 updateContact a`);
      assert.deepEqual(addContact(dir, { id: "n2", name: "n", speakingModel: "m" }), { ok: false, reason }, `${key}/${id} 第 ${p} 项 addContact`);
    }
  }
  const good = updateContact({ contacts: new Map([["a", as("a")], ["person", as("person")], ["person-2", as("person-2")]]) }, "person", { memory: "m" });
  assert.deepEqual(good.ok && [...good.dir.contacts.keys()], ["a", "person", "person-2"]);
  assert.deepEqual(good.ok && [...good.dir.contacts.values()].map((c) => [c.id, c.memory]), [["a", ""], ["person", "m"], ["person-2", ""]]);
});

test("CH-40 回执 commitmentIds 按承诺 id 精确点名:回执只点名 promise 不确认 promise-long(前缀、后缀、子串都不算),先终态后确认、先确认后终态都仍等回执,撤销也不按前缀;精确点名时两种顺序都回收(对照)", () => {
  const base = mk().contacts.get("c-mi")!;
  const cases = [["promise-long", "promise"], ["promise", "promise-long"], ["promise-long", "long"], ["long", "promise-long"], ["promise-long", "romise-lon"]] as const;
  for (const [real, named] of cases) {
    const c = unwrap(commit(base, { id: real, sourceSeq: 1, text: "汇报", boundTaskIds: ["T"], schedule: null }));
    const label = `承诺 ${real} / 回执 ${named}`;
    const late = unwrap(confirmFinalReport(unwrap(settleTask(c, "T")), rc("T", [named], 10)));
    assert.deepEqual(late.commitments.map((k) => [k.id, k.status, k.awaitingReport]), [[real, "active", ["T"]]], `${label} 先终态`);
    const early = unwrap(confirmFinalReport(c, rc("T", [named], 10)));
    assert.deepEqual(early.commitments.map((k) => k.reportedTaskIds), [[]], `${label} 先确认`);
    assert.deepEqual(unwrap(settleTask(early, "T")).commitments.map((k) => [k.id, k.status, k.awaitingReport]), [[real, "active", ["T"]]], `${label} 先确认再终态`);
    assert.deepEqual(revokeCommitment(c, named), { ok: false, reason: `承诺 ${named} 不存在或已结束` }, `${label} 撤销`);
    const exactLate = unwrap(confirmFinalReport(unwrap(settleTask(c, "T")), rc("T", [real], 10)));
    assert.deepEqual(exactLate.commitments.map((k) => k.status), ["done"], `${label} 精确点名 先终态`);
    const exactEarly = unwrap(settleTask(unwrap(confirmFinalReport(c, rc("T", [real], 10))), "T"));
    assert.deepEqual(exactEarly.commitments.map((k) => k.status), ["done"], `${label} 精确点名 先确认`);
  }
  const two = unwrap(commit(unwrap(commit(base, { id: "promise", sourceSeq: 1, text: "a", boundTaskIds: ["T"], schedule: null })), { id: "promise-long", sourceSeq: 1, text: "b", boundTaskIds: ["T"], schedule: null }));
  const one = unwrap(confirmFinalReport(unwrap(settleTask(two, "T")), rc("T", ["promise"], 10)));
  assert.deepEqual(one.commitments.map((k) => [k.id, k.status]), [["promise", "done"], ["promise-long", "active"]]);
});
