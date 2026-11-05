// 行为变异校准(R-05 阳性埋雷):对 domain 包的实现逐个注入单一故障,在隔离副本里跑本包测试,
// 每个变异都必须让至少一条具名测试失败。M01–M09 对应 Astra 审查 reviews/feat-domain-core.md 的变体清单,
// M10–M12 是那次修复新增的不可变性埋雷;M13–M29 是任务生命周期作者埋雷;
// A01–A14 对应 Astra 审查 reviews/feat-task-lifecycle.md 第 3 节独立变异;N01–N14 是 CORR-01..04 修复的新增埋雷;
// B01–B10(B09 与 N09 同一注入,不重复)对应第二轮审查独立变异;R01–R11 是 R2-CORR-01..04 修复的新增埋雷。原样副本必须全绿(阴性对照)。
// 用法: node packages/domain/proof/mutations.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG, "../..");

const M = [
  ["M01 verify 删除前驱关联检查", "log.ts", "if (e.prev !== prev || hashOf(rest) !== hash)", "if (hashOf(rest) !== hash)"],
  ["M02 放行 compute 发言", "log.ts", 'if (!SENDERS.has(s.kind)) throw new DomainError("sender-not-allowed", s.kind);', ""],
  ["M03 commit 删除版本检查", "cas.ts", 'if (cur.ver !== expectedVer) return { ok: false, reason: "version-conflict", currentVer: cur.ver };', ""],
  ["M04 commitIn 删除版本检查", "cas.ts", 'if (curVer !== expectedVer) return { ok: false, reason: "version-conflict", currentVer: curVer };', ""],
  ["M05 编辑时原地改写旧消息", "log.ts", "  if (body.kind !== \"message\") checkTarget(log, sender, body.target);", "  if (body.kind !== \"message\") checkTarget(log, sender, body.target);\n  if (body.kind === \"edit\") { const i = log.events.findIndex((e) => e.seq === body.target); if (i >= 0) (log.events as LogEvent[])[i] = { ...log.events[i]!, body: { kind: \"message\", text: body.text } }; }"],
  ["M06 commitIn 已有文档保留旧内容", "cas.ts", "out.set(key, { value: next, ver: curVer + 1 });", "out.set(key, { value: cur ? cur.value : next, ver: curVer + 1 });"],
  ["M07 commitIn 原地改输入 Store", "cas.ts", "const out = new Map(store);", "const out = store as Map<string, Versioned<T>>;"],
  ["M08 verify 删除正文 hash 校验", "log.ts", "if (e.prev !== prev || hashOf(rest) !== hash)", "if (e.prev !== prev)"],
  ["M09 prev 一律为创世值", "log.ts", "prev: last?.hash ?? GENESIS,", "prev: GENESIS,"],
  ["M10 body 不做快照直接引用", "log.ts", "body: snapshotBody(body),", "body,"],
  ["M11 sender 不做快照直接引用", "log.ts", "sender: Object.freeze({ kind: sender.kind, id: String(sender.id) }),", "sender: sender as Sender,"],
  ["M12a 事件对象不冻结", "log.ts", "const event: LogEvent = Object.freeze({ ...draft, hash: hashOf(draft) });", "const event: LogEvent = { ...draft, hash: hashOf(draft) };"],
  ["M12b sender 不冻结", "log.ts", "sender: Object.freeze({ kind: sender.kind, id: String(sender.id) }),", "sender: { kind: sender.kind, id: String(sender.id) },"],
  ["M12c message body 不冻结", "log.ts", 'case "message": return Object.freeze({ kind: "message", text: String(b.text) });', 'case "message": return { kind: "message", text: String(b.text) };'],
  ["M12d 事件数组不冻结", "log.ts", "return Object.freeze({ events: Object.freeze([...log.events, event]) });", "return Object.freeze({ events: [...log.events, event] });"],
  ["M12e 日志外壳不冻结", "log.ts", "return Object.freeze({ events: Object.freeze([...log.events, event]) });", "return { events: Object.freeze([...log.events, event]) };"],
  ["M07b 冲突时偷偷推进输入版本", "cas.ts", 'if (curVer !== expectedVer) return { ok: false, reason: "version-conflict", currentVer: curVer };', 'if (curVer !== expectedVer) { if (cur) (store as Map<string, Versioned<T>>).set(key, { value: cur.value, ver: curVer + 1 }); return { ok: false, reason: "version-conflict", currentVer: curVer }; }'],
  ["M13 去掉作者自审守卫", "task.ts", "if (ev.reviewerId === t.owner) return no(`审查人 ${ev.reviewerId} 就是作者,不能自审`);", ""],
  ["M14 只比末次生产模型", "task.ts", "const producers = new Set<Vendor>(t.producerModels.map(vendorOf));", "const producers = new Set<Vendor>(t.producerModels.slice(-1).map(vendorOf));"],
  ["M15 放行 unknown 审查模型", "task.ts", 'if (reviewer === "unknown") return no(`审查模型 ${ev.reviewerModel} 认不出厂商(unknown)`);', ""],
  ["M16 豁免记成合规", "task.ts", 'gate = "waived-by-user";', 'gate = "compliant";'],
  ["M17 任何人都能豁免", "task.ts", "if (ev.waiverBy !== t.requester) return no(", "if (!ev.waiverBy) return no("],
  ["M18 超时自动算验收通过", "task.ts", 'AcceptTimeout: go((t) => ok(set(t, { state: "T8_ArchivedUnverified", badge: "unverified" }))),', 'AcceptTimeout: go((t) => ok(set(t, { state: "T8_Accepted", badge: "accepted" }))),'],
  ["M19 退回一律新开 Compute", "task.ts", "if (resumable && t.computeId) return ok(", "if (t.computeId === \"__never__\") return ok("],
  ["M20 确认卡不核对版本", "task.ts", "if (ev.constraintVer !== t.constraintVer) return ok(t);", ""],
  ["M21 取消不等真实停止", "task.ts", "if (t.computeId) return ok(set(t, { state: \"T9_StopRequested\", stopReason: reason }), [{ kind: \"stop-compute\", computeId: t.computeId }]);", "if (t.computeId) return ok(set(t, { state: reason === \"cancel\" ? \"T10_Cancelled\" : \"T11_Failed\", stopReason: reason }));"],
  ["M29 拒绝确认卡不停止任务", "task.ts", 'return ev.answer === "approve" ? ok(set(cleared, { state: "T3_Running" })) : stopThenRun(cleared, "cancel");', 'return ok(set(cleared, { state: "T3_Running" }));'],
  ["M22 停止期间允许重新认领", "task.ts", 'Claim: rej("停止期间禁止把任务重新指派给他人"),', 'Claim: go((t, e) => ok(set(t, { state: "T2_Claimed", owner: as(e, "Claim").by }))),'],
  ["M23 允许重复认领", "task.ts", 'Claim: rej("已被认领,重复认领原子拒绝(可改领子任务)"),', 'Claim: go((t, e) => ok(set(t, { owner: as(e, "Claim").by }))),'],
  ["M24 任何人都能确认验收", "task.ts", 'UserAccept: go((t, e) => as(e, "UserAccept").by === t.requester ? ok(set(t, { state: "T8_Accepted", badge: "accepted" })) : no(`只有提出者 ${t.requester} 能确认验收`)),\n    UserReject: userReject,\n    AcceptTimeout', 'UserAccept: go((t) => ok(set(t, { state: "T8_Accepted", badge: "accepted" }))),\n    UserReject: userReject,\n    AcceptTimeout'],
  ["M25 改条件不递增版本", "task.ts", "if (!t.launch) return ok(set(t, { constraintVer: t.constraintVer + 1, pendingQ: null", "if (!t.launch) return ok(set(t, { constraintVer: t.constraintVer, pendingQ: null"],
  ["M26 表里留一格空白", "task.ts", '    Dispatch: rej("尚未认领,不能派发"), ', "    Dispatch: undefined as unknown as Cell, "],
  ["M27 状态转移改入参", "task.ts", "  return Object.freeze({ ...t, ...patch,", "  Object.assign(t as object, patch);\n  return Object.freeze({ ...t, ...patch,"],
  ["A01 T7 的 Amend 改成 ignore", "task.ts", "Amend: amendRework, SubmitForReview: rej(\"已审完\")", "Amend: ign(\"变异\"), SubmitForReview: rej(\"已审完\")"],
  ["A02 T8_Accepted 的 UserReject 改成 ignore", "task.ts", "T8_Accepted: { ...terminalRow(), Amend: amendRework, UserReject: userReject },", "T8_Accepted: { ...terminalRow(), Amend: amendRework },"],
  ["A03 T1 的 Cancel 改成 ignore", "task.ts", "Cancel: cancel, StoppedConfirmed: ign(\"没有在停止的 Compute\"), ExecFailed: ign(NOT_RUNNING),", "Cancel: ign(\"变异\"), StoppedConfirmed: ign(\"没有在停止的 Compute\"), ExecFailed: ign(NOT_RUNNING),"],
  ["A04 rework 保留 reviewedCommit/reviewGate", "task.ts", "pendingQ: null, reviewedCommit: null, reviewGate: \"none\", badge: \"none\" } as const;", "pendingQ: null, badge: \"none\" } as const;"],
  ["A05 不可恢复新开时仍保留旧 computeId", "task.ts", "return relaunch(set(t, { ...base, computeId: null }), []);", "return relaunch(set(t, { ...base }), []);"],
  ["A06 删除 UserReject 的提出者身份限制", "task.ts", "return ev.by === t.requester ? rework(t, ev.computeResumable) : no(`只有提出者 ${t.requester} 能退回验收`);", "return rework(t, ev.computeResumable);"],
  ["A07 归档后允许任意非空 by 验收", "task.ts", "UserReject: userReject,\n    UserAccept: go((t, e) => as(e, \"UserAccept\").by === t.requester ?", "UserReject: userReject,\n    UserAccept: go((t, e) => as(e, \"UserAccept\").by.length > 0 ?"],
  ["A08 NeedHuman 写死 constraintVer 为 0", "task.ts", "constraintVer: t.constraintVer } })) : no(NO_COMPUTE)", "constraintVer: 0 } })) : no(NO_COMPUTE)"],
  ["A09 旧版本回复清掉新 pendingQ", "task.ts", "if (ev.constraintVer !== t.constraintVer) return ok(t);", "if (ev.constraintVer !== t.constraintVer) return ok(set(t, { pendingQ: null }));"],
  ["A10 新开 Compute 不携带交接", "task.ts", "withHandoff: true, ...launch", "withHandoff: false, ...launch"],
  ["A11 T7 发卡失败调用 rework、重跑 Compute", "task.ts", "ExecFailed: ign(\"工件已落盘,只重发卡片,不回去重跑\")", "ExecFailed: go((t) => rework(t, true))"],
  ["A12 T5 SubmitForReview 忽略新提交", "task.ts", "reviewedCommit: commit, reviewRound: round", "reviewedCommit: t.reviewedCommit, reviewRound: round"],
  ["A13 T1 Amend 不推进版本", "task.ts", "HumanReply: ign(NO_CARD), Amend: bumpVer,", "HumanReply: ign(NO_CARD), Amend: ign(\"变异\"),"],
  ["A14 删除生产厂商 unknown 守卫", "task.ts", "if (producers.has(\"unknown\")) return no(\"有生产模型认不出厂商(unknown)\");", ""],
  ["N01 审查回包不核对被审对象", "task.ts", "if (ev.round !== t.reviewRound || ev.commit !== t.reviewedCommit || ev.constraintVer !== t.constraintVer) return ok(t);", ""],
  ["N02 审查回包只核 commit 不核条件版本", "task.ts", "if (ev.round !== t.reviewRound || ev.commit !== t.reviewedCommit || ev.constraintVer !== t.constraintVer) return ok(t);", "if (ev.round !== t.reviewRound || ev.commit !== t.reviewedCommit) return ok(t);"],
  ["N03 审查打回一律当作可恢复", "task.ts", "if (ev.verdict === \"reject\") return rework(t, ev.computeResumable);", "if (ev.verdict === \"reject\") return rework(t, true);"],
  ["N04 返工入口的改条件一律当作可恢复", "task.ts", "const amendRework = go((t, e) => rework(t, as(e, \"Amend\").computeResumable));", "const amendRework = go((t) => rework(t, true));"],
  ["N05 T5 改条件不发恢复效果", "task.ts", "HumanReply: ign(NO_CARD), Amend: amendRework, SubmitForReview: go(", "HumanReply: ign(NO_CARD), Amend: amendLive, SubmitForReview: go("],
  ["N06 新开后不标记待回绑", "task.ts", "return ok(set(t, { launch, launchSeq: seq }),", "return ok(set(t, { launchSeq: seq }),"],
  ["N07 T3 拒绝新实例回绑", "task.ts", "Dispatch: go((t, e) => canBind(t, e) ? ok(bind(t, e)) : orphan(t, e) ?? no(\"已有 Compute 在执行\")),", "Dispatch: go((t, e) => orphan(t, e) ?? no(\"已有 Compute 在执行\")),"],
  ["N08 回绑不累积生产模型", "task.ts", "return set(t, { computeId: ev.computeId, launch: null, producerModels: [...new Set([...t.producerModels, ev.model])] });", "return set(t, { computeId: ev.computeId, launch: null });"],
  ["N09 启动途中取消不撤销启动", "task.ts", "if (t.launch) return ok(set(t, { state: \"T9_StopRequested\", stopReason: reason }), [{ kind: \"cancel-spawn\", requestId: t.launch.requestId }]);", ""],
  ["N10 停止期间迟到上线的新实例不被停止", "task.ts", "return ok(b, [{ kind: \"stop-compute\", computeId: b.computeId! }]);", "return ok(b);"],
  ["N11 未回绑也允许向人提问", "task.ts", "NeedHuman: go((t, e) => t.computeId ? ok(", "NeedHuman: go((t, e) => true ? ok("],
  ["N12 确认卡不冻结", "task.ts", "q ? Object.freeze({ qId: String(q.qId), constraintVer: Number(q.constraintVer) }) : null", "q ? { qId: String(q.qId), constraintVer: Number(q.constraintVer) } : null"],
  ["N13 确认卡沿用外部引用不重新快照", "task.ts", "pendingQ: snapQ(q), launch", "pendingQ: q, launch"],
  ["N14 卡片绑定版本不与任务版本比对", "task.ts", "if (q.constraintVer !== t.constraintVer) return no(`卡片绑定版本 ${q.constraintVer} 与任务当前版本 ${t.constraintVer} 不一致`);", ""],
  ["B01 可恢复返工把负责人改成提出者", "task.ts", "if (resumable && t.computeId) return ok(set(t, { ...base, launch: null }),", "if (resumable && t.computeId) return ok(set(t, { ...base, launch: null, owner: t.requester }),"],
  ["B02 可恢复返工只保留末次生产模型", "task.ts", "if (resumable && t.computeId) return ok(set(t, { ...base, launch: null }),", "if (resumable && t.computeId) return ok(set(t, { ...base, launch: null, producerModels: t.producerModels.slice(-1) }),"],
  ["B03 T5 忽略 ProducerModelAdded", "task.ts", "Dispatch: dispatchElse(\"已有 Compute\"), ProducerModelAdded: addModel, NeedHuman: rej(\"审查中不再向人提问\")", "Dispatch: dispatchElse(\"已有 Compute\"), ProducerModelAdded: ign(\"变异\"), NeedHuman: rej(\"审查中不再向人提问\")"],
  ["B04 T5 改条件一律按可恢复", "task.ts", "const amendRework = go((t, e) => rework(t, as(e, \"Amend\").computeResumable));", "const amendRework = go((t, e) => rework(t, t.state === \"T5_InReview\" ? true : as(e, \"Amend\").computeResumable));"],
  ["B05 T7 改条件一律按可恢复", "task.ts", "const amendRework = go((t, e) => rework(t, as(e, \"Amend\").computeResumable));", "const amendRework = go((t, e) => rework(t, t.state === \"T7_Delivering\" ? true : as(e, \"Amend\").computeResumable));"],
  ["B06 Accepted 退回一律按可恢复", "task.ts", "return ev.by === t.requester ? rework(t, ev.computeResumable) :", "return ev.by === t.requester ? rework(t, t.state === \"T8_Accepted\" ? true : ev.computeResumable) :"],
  ["B07 Archived 退回一律按可恢复", "task.ts", "return ev.by === t.requester ? rework(t, ev.computeResumable) :", "return ev.by === t.requester ? rework(t, t.state === \"T8_ArchivedUnverified\" ? true : ev.computeResumable) :"],
  ["B08 T9 迟到回绑把负责人改成提出者", "task.ts", "      const b = bind(t, e);", "      const b = set(bind(t, e), { owner: t.requester });"],
  ["B10 未回绑即可提审", "task.ts", "SubmitForReview: go((t, e) => t.computeId ? submit(t, e) : no(NO_COMPUTE)),", "SubmitForReview: go(submit),"],
  ["R01 停止确认不核对身份", "task.ts", "if (t.computeId ? ev.computeId !== t.computeId : t.launch ? ev.requestId !== t.launch.requestId : false) return ok(t);", ""],
  ["R02 只有在途启动时任意停止确认都算", "task.ts", "t.launch ? ev.requestId !== t.launch.requestId : false", "false"],
  ["R03 回绑不核对启动请求号", "task.ts", " && as(e, \"Dispatch\").requestId === t.launch.requestId;", ";"],
  ["R04 别的请求号的实例不停止", "task.ts", "return ok(t, [{ kind: \"stop-compute\", computeId: ev.computeId }]);", "return ok(t);"],
  ["R05 启动中改条件不重新发起", "task.ts", "return relaunch(set(t, { constraintVer: t.constraintVer + 1 }), [{ kind: \"cancel-spawn\", requestId: t.launch.requestId }]);", "return ok(set(t, { constraintVer: t.constraintVer + 1 }));"],
  ["R06 启动中改条件不撤销旧启动", "task.ts", "relaunch(set(t, { constraintVer: t.constraintVer + 1 }), [{ kind: \"cancel-spawn\", requestId: t.launch.requestId }]);", "relaunch(set(t, { constraintVer: t.constraintVer + 1 }), []);"],
  ["R07 启动请求号复用", "task.ts", "const seq = t.launchSeq + 1;", "const seq = 1;"],
  ["R08 启动请求绑旧条件版本", "task.ts", "requestId: `${t.id}#L${seq}`, constraintVer: t.constraintVer };", "requestId: `${t.id}#L${seq}`, constraintVer: 0 };"],
  ["R09 先比卡号再比版本(旧卡号旧版本被拒)", "task.ts", "      if (ev.constraintVer !== t.constraintVer) return ok(t);\n      if (!q || q.qId !== ev.qId) return no(`回复的卡片 ${ev.qId} 不是当前待回复的卡`);", "      if (!q || q.qId !== ev.qId) return no(`回复的卡片 ${ev.qId} 不是当前待回复的卡`);\n      if (ev.constraintVer !== t.constraintVer) return ok(t);"],
  ["R10 审查轮次不递增", "task.ts", "const round = t.reviewRound + 1;", "const round = 1;"],
  ["R11 审查回包不核对轮次", "task.ts", "ev.round !== t.reviewRound || ", ""],
  ["M28 vendor 两家都像时取第一家", "vendor.ts", "return hits.size === 1 ? [...hits][0]! : \"unknown\";", "return hits.size >= 1 ? [...hits][0]! : \"unknown\";"],
];

function run(dir) {
  const files = fs.readdirSync(path.join(dir, "src")).filter((f) => f.endsWith(".test.ts")).map((f) => path.join("src", f));
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: dir, encoding: "utf8" });
  // 文件级失败(加载或语法错误)的条目名就是测试文件路径,不算具名测试被杀死
  const failed = [...(r.stdout ?? "").matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]).filter((n) => !/\.test\.ts$/.test(n));
  const passed = [...(r.stdout ?? "").matchAll(/^ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { code: r.status, failed, passed };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "domain-mut-"));
const copy = (name) => {
  const d = path.join(tmp, name);
  fs.cpSync(PKG, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}proof`) });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"));
  return d;
};
let ok = true;
const clean = run(copy("clean"));
console.log(`${clean.code === 0 ? "✓" : "✗"} 原样副本:${clean.passed.length} 绿 / ${clean.failed.length} 红`);
if (clean.code !== 0) ok = false;
M.forEach(([name, file, from, to], i) => {
  const d = copy(`m${i}`);
  const f = path.join(d, "src", file);
  const src = fs.readFileSync(f, "utf8");
  const hits = src.split(from).length - 1;
  if (hits !== 1) { ok = false; console.log(`✗ ${name}:注入点出现 ${hits} 次,必须恰好 1 次(实现已变,更新本脚本)`); return; }
  fs.writeFileSync(f, src.replace(from, to));
  const r = run(d);
  const killed = r.failed.length > 0;
  if (!killed) ok = false;
  console.log(`${killed ? "✓" : "✗"} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红${killed ? `,被「${r.failed[0]}」发现` : ",存活"}`);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
