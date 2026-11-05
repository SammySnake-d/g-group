// AC-01 联系人持久身份;AC-33 直接工具清单收窄、Compute 不继承记忆和性格、凭据只给引用、placement 契约;
// 概念卡第 11 张:定时是联系人自己的承诺(带时区和误差),不是插件能力;AC-35① 专职锁不挡控制指令;AC-31⑤ 承诺终态自动回收。
import assert from "node:assert/strict";
import { test } from "node:test";
import { addContact, briefFor, commit, decideUnderFocus, emptyDirectory, FORBIDDEN_DIRECT_TOOLS, grantTool, setFocus, settleTask, updateContact } from "./contact.ts";

const mk = () => {
  const r = addContact(emptyDirectory(), { id: "c-mi", name: "小秘", speakingModel: "claude-opus-5-5" });
  if (!r.ok) throw new Error(r.reason);
  return r.dir;
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

test("AC-33 shell、任意写文件、浏览器自动化等通用工具不能进联系人直接工具清单", () => {
  const c = mk().contacts.get("c-mi")!;
  assert.ok(FORBIDDEN_DIRECT_TOOLS.includes("bash"));
  for (const name of FORBIDDEN_DIRECT_TOOLS) assert.equal(grantTool(c, { name, bounded: true }).ok, false, name);
  assert.equal(grantTool(c, { name: "fetch_anything", bounded: false }).ok, false);
});

test("AC-33 具名有界工具可以授予联系人(阴性对照)", () => {
  const r = grantTool(mk().contacts.get("c-mi")!, { name: "get_weather", bounded: true });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.contact.tools.map((t) => t.name), ["get_weather"]);
});

test("AC-33 派给 Compute 的说明不带联系人的记忆和性格,只带任务、群规切片、白名单子集与凭据引用", () => {
  const base = updateContact(mk(), "c-mi", { memory: "私人记忆:老板生日 3 月" });
  assert.ok(base.ok);
  const c = base.dir.contacts.get("c-mi")!;
  const r = briefFor(c, { task: "整理周报", rules: ["改代码前先问"], tools: [], credentialRefs: ["vault://gmail/1"] });
  assert.ok(r.ok);
  const json = JSON.stringify(r.ok && r.brief);
  assert.equal(json.includes("老板生日"), false);
  assert.deepEqual(r.ok && r.brief.rules, ["改代码前先问"]);
  assert.equal(r.ok && r.brief.placement, "local");
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
  assert.deepEqual(ok.ok && ok.contact.commitments[0]?.schedule, daily8);
  assert.equal(commit(c, { id: "k2", sourceSeq: 11, text: "x", boundTaskIds: [], schedule: { cron: "0 8 * * *", tz: "", toleranceSec: 60 } }).ok, false);
  assert.equal(commit(c, { id: "k3", sourceSeq: 12, text: "x", boundTaskIds: [], schedule: { cron: "0 8 * * *", tz: "Asia/Shanghai", toleranceSec: -1 } }).ok, false);
  assert.equal(commit(c, { id: "k4", sourceSeq: 13, text: "x", boundTaskIds: [], schedule: { cron: "每天八点", tz: "Asia/Shanghai", toleranceSec: 60 } }).ok, false);
  assert.equal(commit(c, { id: "k5", sourceSeq: 14, text: "x", boundTaskIds: [], schedule: { cron: "0 8 * * *", tz: "Mars/Base", toleranceSec: 60 } }).ok, false);
});

test("承诺 id 不能重复", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "a", boundTaskIds: [], schedule: null });
  assert.ok(a.ok);
  assert.equal(a.ok && commit(a.contact, { id: "k1", sourceSeq: 2, text: "b", boundTaskIds: [], schedule: null }).ok, false);
});

test("AC-31⑤ 承诺绑定的任务全部结束后自动回收,不污染后续任务", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 200, text: "有进度就汇报", boundTaskIds: ["T_A", "T_B"], schedule: null });
  assert.ok(a.ok);
  const half = settleTask(a.ok ? a.contact : (null as never), "T_A");
  assert.equal(half.commitments[0]?.status, "active");
  const done = settleTask(half, "T_B");
  assert.equal(done.commitments[0]?.status, "done");
});

test("AC-31⑤ 定时承诺不随任务结束回收(阴性对照)", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "每天 8 点", boundTaskIds: ["T_A"], schedule: daily8 });
  assert.ok(a.ok);
  assert.equal(settleTask(a.ok ? a.contact : (null as never), "T_A").commitments[0]?.status, "active");
});

test("AC-35① 专职锁:无关闲聊忽略,越界派活婉拒,停止/撤销/改时间的控制指令照样处理", () => {
  const a = commit(mk().contacts.get("c-mi")!, { id: "k1", sourceSeq: 1, text: "每天 8 点总结", boundTaskIds: [], schedule: daily8 });
  assert.ok(a.ok);
  const f = setFocus(a.ok ? a.contact : (null as never), { onlyCommitmentId: "k1" });
  assert.ok(f.ok);
  const c = f.ok ? f.contact : (null as never);
  assert.equal(decideUnderFocus(c, { kind: "chatter", text: "今天天气不错" }), "ignore");
  assert.equal(decideUnderFocus(c, { kind: "work", text: "帮我写个前端页面" }), "decline-focused");
  for (const action of ["stop", "revoke", "reschedule"] as const) assert.equal(decideUnderFocus(c, { kind: "control", action, commitmentId: "k1" }), "handle");
});

test("AC-35① 没有专职锁时派活正常处理(阴性对照)", () => {
  assert.equal(decideUnderFocus(mk().contacts.get("c-mi")!, { kind: "work", text: "帮我写个前端页面" }), "handle");
});

test("专职锁只能指向自己身上有效的承诺", () => {
  assert.equal(setFocus(mk().contacts.get("c-mi")!, { onlyCommitmentId: "nope" }).ok, false);
});

test("联系人更新不改入参目录", () => {
  const d = mk();
  const saved = JSON.stringify([...d.contacts]);
  const r = updateContact(d, "c-mi", { memory: "新记忆" });
  assert.ok(r.ok);
  assert.equal(JSON.stringify([...d.contacts]), saved);
});
