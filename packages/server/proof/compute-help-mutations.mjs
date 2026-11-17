// T4b 求助闭环(AC-44 / tasks.answer)的变异校准:按验收文档 AC-44「坏实现」列逐个注入故障,
// 每个变异必须让指定的具名测试失败(断言失败;加载失败、语法错误不算杀死)。
// 用法(在仓库根目录、已装依赖的克隆里跑;会就地改文件,每个变异后还原):
//   node packages/server/proof/compute-help-mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const HOST = "packages/server/src/host.ts";
const ADAPTER = "packages/adapter-cc-compute/src/adapter.ts";
const SCHEMA = "packages/adapter-cc-compute/src/report-schema.ts";
const HELP_TEST = "packages/server/src/help.test.ts";
const HOST_TEST = "packages/server/src/host.test.ts";
const ADAPTER_TEST = "packages/adapter-cc-compute/src/attachments.test.ts";

const T = {
  blocked: "AC-44 ① Compute 报受阻 → 任务进 T4b(q_id),宿主不重试、不重派、不自己续接",
  card: "AC-44 ② 联系人在会话里 @提出者并附截图发提问卡;Compute 不直接发言",
  answer: "AC-44 ③ tasks.answer 校验 (task_id, q_id, constraint_ver) 后回 T3,回答续接给同一个 Compute",
  reject: "AC-44 ④ 用户在提问卡上选「不做了」→ 任务取消,Compute 被停止并释放",
  late: "AC-44 ⑤ 任务取消后的迟到回答幂等忽略:不送进 Compute,提问卡标「已过期·未执行」",
  staleQ: "AC-44 ⑤ 换了新问题后,旧问题上的回答幂等忽略,只有当前 q_id 生效",
  notFound: "tasks.answer:不存在的问题号 not_found;回答为空被合同拒绝",
  relay: "AC-44 ③ 用户在聊天里直接回答,联系人 forward 转达 → 同样回 T3 并续接,提问卡标为已处理",
  fabricate: "AC-44 ① 联系人没等用户回答、自己编了答案 forward → 宿主拒收,任务仍停在 T4b,不送进 Compute",
  dupForward: "AC-44 ③ 用户在提问卡上回答后,联系人又把那条回答 forward → 宿主拒收,回答只送进 Compute 一次",
  rule: "AC-44 ① 派给 Compute 的说明带人工验证规则:不反复尝试、不猜、不用打码服务,截图后报 blocked 停下",
  shots: "受阻截图只收工作目录里的图片:目录外路径与非图片被丢弃,提问卡照发",
  adapterPass: "AC-44 ②:blocked 汇报可带 attachments(工作目录内文件的相对路径),原样透传到 blocked 事件",
  adapterSchema: "AC-44 ②:attachments 不是字符串数组的汇报被拒收;没带 attachments 的 blocked 事件里没有这个字段",
};

/** [编号 说明, 文件, 原文, 替换, 应失败的具名测试, 跑哪个测试文件] */
const mutants = [
  ["M01 受阻后任务停在 T3 空转", HOST, 'if (t.state === "T3_Running" && t.computeId === ev.computeId) {\n          const qId', 'if (false) {\n          const qId', T.blocked, HELP_TEST],
  ["M02 宿主收到受阻就自己续接(反复提交)", HOST, "asked = { roomId: doc.roomId, seq: r.seq, contactId: row.contact_id, qId };", 'asked = { roomId: doc.roomId, seq: r.seq, contactId: row.contact_id, qId }; void this.adapterForCompute(ev.computeId)?.resume(ev.computeId, "再试一次");', T.blocked, HELP_TEST],
  ["M03 提问卡不由联系人发(Compute 直接发言)", HOST, 'this.appendMessageTx(doc.roomId, { kind: "contact", id: row.contact_id }, {\n            text: `@', 'this.appendMessageTx(doc.roomId, { kind: "helper", id: ev.computeId }, {\n            text: `@', T.card, HELP_TEST],
  ["M04 提问卡没 @提出者", HOST, 'mentions: [{ id: t.requester, source: "auto" }],\n            attachments: shots,', "mentions: [],\n            attachments: shots,", T.card, HELP_TEST],
  ["M05 提问卡不附截图", HOST, "attachments: shots,", "attachments: [],", T.card, HELP_TEST],
  ["M06 工作目录外的文件也收", HOST, 'if (!real.startsWith(base + sep)) throw new Error("不在工作目录里");', "", T.shots, HELP_TEST],
  ["M07 非图片也收", HOST, 'if (!QUESTION_IMAGE_EXT.has(extname(real).toLowerCase())) throw new Error("不是图片");', "", T.shots, HELP_TEST],
  ["M08 过期卡上的点击不幂等返回", HOST, 'if (card.kind === "question" && card.state === "expired") {', "if (false) {", T.late, HELP_TEST],
  ["M10 tasks.answer 不认 q_id,总答当前问题", HOST, "    const card = this.questionCard(taskId, qId);\n    if (!card) throw", "    const card = this.questionCard(taskId, this.taskDoc(taskId).value.task.pendingQ?.qId ?? qId);\n    if (!card) throw", T.staleQ, HELP_TEST],
  ["M11 任务离开 T4b 不过期旧卡", HOST, "    this.expireQuestionsTx(id, out.task);\n", "", T.late, HELP_TEST],
  ["M12 过期卡不标「已过期·未执行」", HOST, 'const EXPIRED_NOTE = "\\n(已过期·未执行)";', 'const EXPIRED_NOTE = "";', T.late, HELP_TEST],
  ["M13 「不做了」不停 Compute", HOST, '      for (const e of eff) if (e.kind === "stop-compute") effects.push({ kind: "stop", taskId, computeId: e.computeId });\n      return effects;\n    }\n    if (card.kind !== "delivery"', '      return effects;\n    }\n    if (card.kind !== "delivery"', T.reject, HELP_TEST],
  ["M14 「不做了」也当回答", HOST, 'answer: actionId === "answer" ? "approve" : "reject"', 'answer: "approve"', T.reject, HELP_TEST],
  ["M15 forward 不核对提出者的回答", HOST, '              if (!answered) { reject("任务在等用户回答,只能转达提出者本轮在会话里的回答"); break; }\n', "", T.fabricate, HELP_TEST],
  ["M16 forward 在 T4b 不推进状态机", HOST, '              this.stepTaskTx(a.taskId, { kind: "HumanReply", qId: q.qId, constraintVer: q.constraintVer, answer: "approve" });\n', "", T.relay, HELP_TEST],
  ["M17 Compute 说明不带人工验证规则", HOST, "rules: [HUMAN_VERIFICATION_RULE]", "rules: []", T.rule, HELP_TEST],
  ["M18 规则里允许打码服务", HOST, "不要调用打码服务或任何代解服务", "可以调用识别服务", T.rule, HELP_TEST],
  ["M19 未知问题号当成功", HOST, 'if (!card) throw new HostError("not_found", `任务 ${taskId} 没有问题 ${qId}`);', "if (!card) return this.taskView(this.taskDoc(taskId).value);", T.notFound, HELP_TEST],
  ["M20 回答不续接给 Compute", HOST, 'if (actionId === "answer" && t.computeId) effects.push(', 'if (false && t.computeId) effects.push(', T.answer, HELP_TEST],
  ["M21 服务层 tasks.answer 仍回 conflict", "packages/server/src/service.ts", '"tasks.answer": (p: { taskId: string; qId: string; clientActionId: string; answer: string }) => host.answerTask(p.taskId, p.qId, p.clientActionId, p.answer),', '"tasks.answer": () => { throw new HostError("conflict", "任务没有待回答的问题"); },', T.answer, HELP_TEST],
  ["M25 卡片已回答的那条再 forward 照样续接(验证码送两次)", HOST, '            if (fromRequester.length > 0 && fromRequester.every(cardAnswer)) { reject("这条回答已经通过提问卡转给 Compute,不再重复转发"); break; }\n', "", T.dupForward, HELP_TEST],
  ["M22 适配器丢掉 attachments", ADAPTER, ", ...(r.attachments !== undefined ? { attachments: Object.freeze([...r.attachments]) } : {})", "", T.adapterPass, ADAPTER_TEST],
  ["M23 schema 不校验 attachments 类型", SCHEMA, '  if (a.attachments !== undefined && !strArr(a.attachments)) errs.push("attachments 须为字符串数组");\n', "", T.adapterSchema, ADAPTER_TEST],
  ["M24 schema 不认 attachments 字段", SCHEMA, '"doneSideEffects", "attachments"]', '"doneSideEffects"]', T.adapterPass, ADAPTER_TEST],
];

function runTests(file, pattern) {
  const args = ["--test", "--test-reporter=tap", ...(pattern ? ["--test-name-pattern", pattern] : []), file];
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 600_000, env: { ...process.env, NODE_OPTIONS: "" } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  const passed = [...out.matchAll(/^\s*ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  return { status: r.status, out, failed, passed };
}

let success = true;
const lines = [];
const log = (s) => {
  lines.push(s);
  console.log(s);
};
// 基线:原样代码下这些测试全过
for (const [file, pattern] of [[HELP_TEST, null], [HOST_TEST, null], [ADAPTER_TEST, null]]) {
  const b = runTests(file, pattern);
  const ok = b.status === 0 && b.failed.length === 0;
  log(`${ok ? "PASS" : "FAIL"} 基线 ${file}${pattern ? ` (${pattern})` : ""}: 通过 ${b.passed.length} 失败 ${b.failed.length}`);
  if (!ok) success = false;
}
for (const [name, rel, from, to, expected, testFile] of mutants) {
  const file = path.join(root, rel);
  const original = fs.readFileSync(file, "utf8");
  if (original.split(from).length !== 2) {
    log(`FAIL ${name}: 注入点不是唯一一处`);
    success = false;
    continue;
  }
  fs.writeFileSync(file, original.replace(from, to));
  try {
    const r = runTests(testFile, null);
    // 文件级失败(加载/语法错误)时 tap 里失败名是文件路径,不算杀死
    const loadFail = r.failed.some((n) => n.endsWith(".test.ts")) || /SyntaxError|ERR_MODULE_NOT_FOUND|TransformError/.test(r.out);
    const killed = r.status !== 0 && r.failed.includes(expected) && !loadFail;
    log(`${killed ? "KILLED" : "SURVIVED"} ${name}: ${killed ? `被「${expected}」杀死;同时失败 ${r.failed.length} 条` : `exit=${r.status} 失败=${JSON.stringify(r.failed)} 加载失败=${loadFail}`}`);
    if (!killed) success = false;
  } finally {
    fs.writeFileSync(file, original);
  }
}
log(success ? `PASS ${mutants.length}/${mutants.length} 变异被指定测试杀死` : "FAIL 变异校准未通过");
process.exitCode = success ? 0 : 1;
