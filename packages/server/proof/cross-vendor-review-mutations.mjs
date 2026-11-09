// 跨厂商审查联系人(AC-26 / AC-28)的变异校准:按验收文档 AC-26「坏实现」列逐个注入故障,
// 每个变异必须让指定的具名测试失败(断言失败;加载失败、语法错误不算杀死)。
// 用法(仓库根目录、已装依赖的克隆;就地改文件,每个变异后还原):node packages/server/proof/cross-vendor-review-mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const HOST = "packages/server/src/host.ts";
const REVIEW = "packages/server/src/review.ts";
const TEST = "packages/server/src/review.test.ts";

const T = {
  pass: "AC-26 ④ 有跨厂商审查联系人:交付后用它的 Compute 模型起只读审查 Compute,审过 → T8a 待确认,reviewGate 记 compliant",
  accept: "AC-28 审过后提出者确认 → T8_Accepted,reviewGate 仍是 compliant,承诺了结;沉默不自动通过",
  view: "AC-26 TaskView.reviews 记下审查人、实际审查模型与厂商、结论和意见",
  same: "AC-26 ② 只有同厂商的联系人 → 不起审查 Compute,交给提出者本人豁免,记 waived-by-user",
  unknown: "AC-26 ③ 审查联系人的模型认不出厂商(unknown)→ 不当审查人",
  self: "AC-26 ① 作者自己不当审查人:负责联系人的 Compute 模型跨厂商也不行,换别的合格联系人",
  stale: "AC-26 打回后、Compute 重新完成前,联系人拿旧结果再交付被拒:任务留在 T3,不重新送审(旧结果已作废)",
  rework: "AC-26 审查打回 → 回 T3,原 Compute 带审查意见续改;改完再交付重新送审,第二次审过才进 T8a",
  failed: "审查 Compute 失败 → 不当通过,交给提出者本人豁免或退回,说明审查没做成",
  garbled: "审查结论既不是 APPROVE 也不是 REJECT → 当审查没做成,不猜成通过",
  cancel: "审查中取消任务 → 审查 Compute 也被停止",
  restart: "重启时审查 Compute 已不在 → 这次审查记中断,交给提出者本人豁免或退回,任务不卡在 T5",
  pick: "pickReviewer:排除作者、unknown、与累积生产厂商任一同源(F13 半途换模 {A,B} 都不行);同会话成员优先",
  parse: "parseVerdict:结论行以 APPROVE / REJECT 开头,或在冒号后以它结尾(去掉加粗等标记,大小写不敏感);前后矛盾或认不出返回 null",
};

/** [编号 说明, 文件, 原文, 替换, 应失败的具名测试] */
const mutants = [
  ["R01 去掉审查人≠作者", REVIEW, "return c.contactId !== ownerId && v !== \"unknown\" && !producers.has(v);", "return v !== \"unknown\" && !producers.has(v);", T.pick],
  ["R02 只查联系人 ID、不查厂商", REVIEW, "return c.contactId !== ownerId && v !== \"unknown\" && !producers.has(v);", "return c.contactId !== ownerId;", T.same],
  ["R03 unknown 厂商的审查人放行", REVIEW, "return c.contactId !== ownerId && v !== \"unknown\" && !producers.has(v);", "return c.contactId !== ownerId && !producers.has(v);", T.unknown],
  ["R04 只比末次生产模型(F13)", REVIEW, "const producers = new Set(producerModels.map(vendorOf));", "const producers = new Set(producerModels.slice(-1).map(vendorOf));", T.pick],
  ["R05 生产模型里有 unknown 仍放行", REVIEW, "if (producers.size === 0 || producers.has(\"unknown\")) return null;", "if (producers.size === 0) return null;", T.pick],
  ["R06 不优先同会话成员", REVIEW, "return ok.find((c) => c.inRoom) ?? ok[0] ?? null;", "return ok[0] ?? null;", T.pick],
  ["R07 按说话模型判审查厂商", HOST, ".map((d) => ({ contactId: d.value.id, model: this.computeModelOf(d.value), inRoom:", ".map((d) => ({ contactId: d.value.id, model: d.value.speakingModel, inRoom:", T.pass],
  ["R08 审查 Compute 拿到写工具", REVIEW, "Object.freeze([\"Read\", \"Glob\", \"Grep\"])", "Object.freeze([\"Read\", \"Glob\", \"Grep\", \"Write\", \"Bash\"])", T.pass],
  ["R09 审过的交付不 @ 提出者", HOST, "          mentions: [{ id: t.requester, source: \"auto\" }],\n        });\n        posted = { roomId: doc.roomId, seq: r.seq };", "          mentions: [],\n        });\n        posted = { roomId: doc.roomId, seq: r.seq };", T.pass],
  ["R23 审过的交付挂回验收卡", HOST, "          mentions: [{ id: t.requester, source: \"auto\" }],\n        });\n        posted = { roomId: doc.roomId, seq: r.seq };", "          mentions: [{ id: t.requester, source: \"auto\" }],\n          card: { card_id: this.newId(\"card\"), kind: \"delivery\", task_id: rv.task_id, title: \"交付\", body: \"\", state: \"open\", actions: \"[]\", meta: \"{}\" },\n        });\n        posted = { roomId: doc.roomId, seq: r.seq };", T.pass],
  ["R10 审过后不进 T8a 待确认", HOST, "        this.stepTaskTx(rv.task_id, { kind: \"DeliveredCard\", taskId: rv.task_id, deliveryRound: send.deliveryRound, commit: send.commit });\n", "", T.pass],
  ["R11 认不出的结论当通过", REVIEW, "  return found;\n}", "  return found ?? { verdict: \"approve\", notes: \"\" };\n}", T.garbled],
  ["R12 结论词不要求在行首(子串匹配)", REVIEW, "const HEAD = /^(APPROVE|REJECT)\\b", "const HEAD = /(APPROVE|REJECT)\\b", T.parse],
  ["R21 前后矛盾的结论取第一条", REVIEW, "    if (found && found.verdict !== verdict) return null;\n", "", T.parse],
  ["R22 不去掉加粗等标记", REVIEW, "l.replace(/[*_`~]/g, \"\").replace(/^[\\s>#\\-•]+/, \"\").trim()", "l.trim()", T.parse],
  ["R13 审查失败不交给提出者", HOST, "      if (ev.kind === \"blocked\") void this.runEffects([{ kind: \"stop\", taskId: rv.task_id, computeId: rv.compute_id }]);\n      this.reviewFallback(rv.task_id, rv.round, why);\n", "      if (ev.kind === \"blocked\") void this.runEffects([{ kind: \"stop\", taskId: rv.task_id, computeId: rv.compute_id }]);\n", T.failed],
  ["R14 打回不续接原 Compute(当不可恢复新开)", HOST, "verdict: \"reject\", computeResumable: this.computeResumable(t.computeId)", "verdict: \"reject\", computeResumable: false", T.rework],
  ["R24 续接时不作废旧结果(联系人可拿旧结果再交付)", HOST, "          run(this.db, \"UPDATE gg_compute SET status = 'running', result = NULL, ended_at = NULL WHERE compute_id = ?\", x.computeId);\n          effects.push({ kind: \"resume\", taskId: rv.task_id", "          effects.push({ kind: \"resume\", taskId: rv.task_id", T.stale],
  ["R15 打回不把意见带给 Compute", HOST, "          effects.push({ kind: \"resume\", taskId: rv.task_id, computeId: x.computeId, text });", "          effects.push({ kind: \"resume\", taskId: rv.task_id, computeId: x.computeId, text: \"继续\" });", T.rework],
  ["R16 任务离开审查不停审查 Compute", HOST, "    this.retireReviewsTx(id, out.task);\n", "", T.cancel],
  ["R17 重启不恢复在跑的审查", HOST, "    this.recoverReviews();\n", "", T.restart],
  ["R18 审查记录不带意见", HOST, "        notes: r.notes.slice(0, 20000),", "        notes: \"\",", T.view],
  ["R19 审查人自报模型当实际模型", HOST, "        vendor: vendorOf(r.model),", "        vendor: \"anthropic\",", T.view],
  ["R20 审过就直接记验收通过(沉默通过)", HOST, "        posted = { roomId: doc.roomId, seq: r.seq };\n        this.stepTaskTx(rv.task_id, { kind: \"DeliveredCard\", taskId: rv.task_id, deliveryRound: send.deliveryRound, commit: send.commit });\n", "        posted = { roomId: doc.roomId, seq: r.seq };\n        this.stepTaskTx(rv.task_id, { kind: \"DeliveredCard\", taskId: rv.task_id, deliveryRound: send.deliveryRound, commit: send.commit });\n        this.stepTaskTx(rv.task_id, { kind: \"UserAccept\", taskId: rv.task_id, by: t.requester, deliveryRound: send.deliveryRound, commit: send.commit });\n", T.accept],
];

function runTests(file) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], { cwd: root, encoding: "utf8", timeout: 600_000, env: { ...process.env, NODE_OPTIONS: "" } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { status: r.status, out, failed: [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()), passed: [...out.matchAll(/^\s*ok \d+ - (.+)$/gm)].map((m) => m[1].trim()) };
}
let success = true;
const b = runTests(TEST);
const baseOk = b.status === 0 && b.failed.length === 0;
console.log(`${baseOk ? "PASS" : "FAIL"} 基线 ${TEST}: 通过 ${b.passed.length} 失败 ${b.failed.length}`);
if (!baseOk) success = false;
for (const [name, rel, from, to, expected] of mutants) {
  const file = path.join(root, rel);
  const original = fs.readFileSync(file, "utf8");
  if (original.split(from).length !== 2) {
    console.log(`FAIL ${name}: 注入点不是唯一一处`);
    success = false;
    continue;
  }
  fs.writeFileSync(file, original.replace(from, to));
  try {
    const r = runTests(TEST);
    const loadFail = r.failed.some((n) => n.endsWith(".test.ts")) || /SyntaxError|ERR_MODULE_NOT_FOUND|TransformError/.test(r.out);
    const killed = r.status !== 0 && r.failed.includes(expected) && !loadFail;
    console.log(`${killed ? "KILLED" : "SURVIVED"} ${name}: ${killed ? `被「${expected}」杀死;同时失败 ${r.failed.length} 条` : `exit=${r.status} 失败=${JSON.stringify(r.failed)} 加载失败=${loadFail}`}`);
    if (!killed) success = false;
  } finally {
    fs.writeFileSync(file, original);
  }
}
console.log(success ? `PASS ${mutants.length}/${mutants.length} 变异被指定测试杀死` : "FAIL 变异校准未通过");
process.exitCode = success ? 0 : 1;
