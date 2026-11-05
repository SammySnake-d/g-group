// 行为变异校准(R-05 阳性埋雷):对 domain 包的实现逐个注入单一故障,在隔离副本里跑本包测试,
// 每个变异都必须让至少一条具名测试失败。M01–M09 对应 Astra 审查 reviews/feat-domain-core.md 的变体清单,
// M10–M12 是不可变性埋雷,其余按文件分组见各行。原样副本必须全绿(阴性对照)。
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
  ["M19 退回一律新开 Compute", "task.ts", "resumable && t.computeId ? [{ kind: \"resume-compute\", computeId: t.computeId }] : ", ""],
  ["M20 确认卡不核对版本", "task.ts", "if (ev.constraintVer !== q.constraintVer) return ok(t);", ""],
  ["M21 取消不等真实停止", "task.ts", "? ok(set(t, { state: \"T9_StopRequested\", stopReason: reason }), [{ kind: \"stop-compute\", computeId: t.computeId }])", "? ok(set(t, { state: reason === \"cancel\" ? \"T10_Cancelled\" : \"T11_Failed\", stopReason: reason }))"],
  ["M29 拒绝确认卡不停止任务", "task.ts", 'return ev.answer === "approve" ? ok(set(cleared, { state: "T3_Running" })) : stopThenRun(cleared, "cancel");', 'return ok(set(cleared, { state: "T3_Running" }));'],
  ["M22 停止期间允许重新认领", "task.ts", 'Claim: rej("停止期间禁止把任务重新指派给他人"),', 'Claim: go((t, e) => ok(set(t, { state: "T2_Claimed", owner: as(e, "Claim").by }))),'],
  ["M23 允许重复认领", "task.ts", 'Claim: rej("已被认领,重复认领原子拒绝(可改领子任务)"),', 'Claim: go((t, e) => ok(set(t, { owner: as(e, "Claim").by }))),'],
  ["M24 任何人都能确认验收", "task.ts", 'UserAccept: go((t, e) => as(e, "UserAccept").by === t.requester ? ok(set(t, { state: "T8_Accepted", badge: "accepted" })) : no(`只有提出者 ${t.requester} 能确认验收`)),\n    UserReject: userReject,\n    AcceptTimeout', 'UserAccept: go((t) => ok(set(t, { state: "T8_Accepted", badge: "accepted" }))),\n    UserReject: userReject,\n    AcceptTimeout'],
  ["M25 改条件不递增版本", "task.ts", "const amend = go((t) => ok(set(t, { constraintVer: t.constraintVer + 1,", "const amend = go((t) => ok(set(t, { constraintVer: t.constraintVer,"],
  ["M26 表里留一格空白", "task.ts", '    Dispatch: rej("尚未认领,不能派发"), ', "    Dispatch: undefined as unknown as Cell, "],
  ["M27 状态转移改入参", "task.ts", "const set = (t: Task, patch: Partial<Task>): Task => Object.freeze({ ...t, ...patch,", "const set = (t: Task, patch: Partial<Task>): Task => Object.assign(t as object, patch) && Object.freeze({ ...t, ...patch,"],
  ["M28 vendor 两家都像时取第一家", "vendor.ts", "return hits.size === 1 ? [...hits][0]! : \"unknown\";", "return hits.size >= 1 ? [...hits][0]! : \"unknown\";"],
  ["M30 同 id 新建覆盖", "contact.ts", "if (d.contacts.has(c.id)) return { ok: false, reason: `联系人 ${c.id} 已存在,不能同 id 新建覆盖` };", ""],
  ["M31 改名时清空记忆", "contact.ts", "...(patch.name !== undefined ? { name: patch.name } : {}),", "...(patch.name !== undefined ? { name: patch.name, memory: \"\" } : {}),"],
  ["M32 不查通用工具黑名单", "contact.ts", "if (FORBIDDEN_DIRECT_TOOLS.includes(tool.name)) return", "if (false) return"],
  ["M33 不查有界", "contact.ts", "if (!tool.bounded) return", "if (false) return"],
  ["M34 Compute 说明带上记忆", "contact.ts", "brief: Object.freeze({ task: r.task,", "brief: Object.freeze({ memory: c.memory, task: r.task,"],
  ["M35 工具不过白名单", "contact.ts", "const extra = r.tools.filter((t) => !allowed.has(t));", "const extra: string[] = [];"],
  ["M36 允许明文凭据", "contact.ts", "const bad = r.credentialRefs.filter((x) => !CREDENTIAL_REF.test(x));", "const bad: string[] = [];"],
  ["M37 定时不校验时区", "contact.ts", "  if (!s.tz) return \"定时承诺必须写明时区\";\n  try { new Intl.DateTimeFormat(\"en-US\", { timeZone: s.tz }); } catch { return `时区 \"${s.tz}\" 不认识`; }", ""],
  ["M38 定时不检查误差", "contact.ts", "if (!Number.isFinite(s.toleranceSec) || s.toleranceSec < 0) return \"允许误差必须是非负秒数\";", ""],
  ["M39 定时承诺也随任务回收", "contact.ts", "if (k.status !== \"active\" || k.schedule || !k.boundTaskIds.includes(taskId)) return k;", "if (k.status !== \"active\" || !k.boundTaskIds.includes(taskId)) return k;"],
  ["M40 第一个汇报确认就回收", "contact.ts", "k.boundTaskIds.length === 0 && k.awaitingReport.length === 0 ? { ...k, status: \"done\" } : k", "({ ...k, status: \"done\" })"],
  ["M41 专职锁挡住控制指令", "contact.ts", "if (i.kind === \"control\") return \"handle\";", "if (i.kind === \"control\" && !c.focus) return \"handle\";"],
  ["M42 专职时照样接活", "contact.ts", "return i.commitmentId === c.focus.onlyCommitmentId ? \"handle\" : \"decline-focused\";", "return \"handle\";"],
  ["M43 侧边栏回复变成消息", "helper.ts", "case \"sidebar\": return { ok: true, route: { replyIn: \"sidebar\", becomesMessage: false,", "case \"sidebar\": return { ok: true, route: { replyIn: \"sidebar\", becomesMessage: true,"],
  ["M44 全局入口读当前会话", "helper.ts", "case \"global\": return { ok: true, route: { replyIn: \"global-panel\", becomesMessage: false, contextConversation: null,", "case \"global\": return { ok: true, route: { replyIn: \"global-panel\", becomesMessage: false, contextConversation: \"*\","],
  ["M45 @Helper 回复不进对话", "helper.ts", "case \"mention\": return { ok: true, route: { replyIn: \"conversation\", becomesMessage: true,", "case \"mention\": return { ok: true, route: { replyIn: \"sidebar\", becomesMessage: false,"],
  ["M46 联系人也能指挥 Helper", "helper.ts", "if (caller.kind !== \"user\" || caller.id !== owner)", "if (caller.id === \"__never__\")"],
  ["M47 Helper 可以认领任务", "helper.ts", "  return false;\n}", "  return true;\n}"],
  // 以下 I01–I26 取自 Astra 独立审查 reviews/feat-contact-helper.md 第 6 节(按返修后的源码改注入点),C01–C10 是本次返修新增判据的埋雷
  ["I01 说明带上性格", "contact.ts", "brief: Object.freeze({ task: r.task,", "brief: Object.freeze({ soul: c.soul, task: r.task,"],
  ["I02 禁项删 shell", "contact.ts", "\"bash\", \"shell\", \"exec\",", "\"bash\", \"exec\","],
  ["I03 禁项删 write_file", "contact.ts", "\"write_file\", \"edit_file\",", "\"edit_file\","],
  ["I04 禁项删 browser", "contact.ts", "\"browser\", \"computer_use\",", "\"computer_use\","],
  ["I05 说明丢合法工具", "contact.ts", "tools: Object.freeze([...r.tools])", "tools: Object.freeze([])"],
  ["I06 说明丢凭据引用", "contact.ts", "credentialRefs: Object.freeze([...r.credentialRefs])", "credentialRefs: Object.freeze([])"],
  ["I07 说明丢任务", "contact.ts", "brief: Object.freeze({ task: r.task,", "brief: Object.freeze({ task: \"\","],
  ["I08 placement 一律 local", "contact.ts", "credentialRefs: Object.freeze([...r.credentialRefs]), placement })", "credentialRefs: Object.freeze([...r.credentialRefs]), placement: \"local\" })"],
  ["I09 sourceSeq 清零", "contact.ts", "{ ...k, awaitingReport: [], reportedTaskIds: [], status: \"active\" }", "{ ...k, sourceSeq: 0, awaitingReport: [], reportedTaskIds: [], status: \"active\" }"],
  ["I10 专职锁可指向已结束承诺", "contact.ts", "k.id === f.onlyCommitmentId && k.status === \"active\"", "k.id === f.onlyCommitmentId"],
  ["I11 Helper 不查调用方类型", "helper.ts", "caller.kind !== \"user\" || caller.id !== owner", "caller.id !== owner"],
  ["I12 全局入口跳过鉴权", "helper.ts", "if (caller.kind !== \"user\" || caller.id !== owner)", "if (entry.kind !== \"global\" && (caller.kind !== \"user\" || caller.id !== owner))"],
  ["I19 误差放行 NaN/Infinity", "contact.ts", "!Number.isFinite(s.toleranceSec) || s.toleranceSec < 0", "s.toleranceSec < 0"],
  ["I26 拒绝理由写错", "contact.ts", "reason: `${tool.name} 是通用能力,只能在 Compute 里用`", "reason: \"时区不认识\""],
  ["C01 终态就回收,不等末次汇报", "contact.ts", "return { ...k, boundTaskIds, awaitingReport: [...k.awaitingReport, taskId] };", "return { ...k, boundTaskIds, status: boundTaskIds.length === 0 ? \"done\" : \"active\" };"],
  ["C02 汇报确认不回收", "contact.ts", "return retire({ ...k, awaitingReport: k.awaitingReport.filter((t) => t !== taskId) });", "return { ...k, awaitingReport: k.awaitingReport.filter((t) => t !== taskId) };"],
  ["C03 别的任务的确认也回收", "contact.ts", "if (k.awaitingReport.includes(taskId)) return retire(", "if (true) return retire("],
  ["C04 回收不解专职锁", "contact.ts", "return freezeContact(dropStaleFocus({\n    ...c,\n    commitments: c.commitments.map((k) => {\n      if (k.status !== \"active\" || k.schedule) return k;", "return freezeContact(({\n    ...c,\n    commitments: c.commitments.map((k) => {\n      if (k.status !== \"active\" || k.schedule) return k;"],
  ["C05 撤销不解专职锁", "contact.ts", "freezeContact(dropStaleFocus({ ...c, commitments: c.commitments.map((k) => (k.id === id", "freezeContact(({ ...c, commitments: c.commitments.map((k) => (k.id === id"],
  ["C06 专职锁拒一切工作", "contact.ts", "return i.commitmentId === c.focus.onlyCommitmentId ? \"handle\" : \"decline-focused\";", "return \"decline-focused\";"],
  ["C07 能力资产进直接清单", "contact.ts", "return c.tools.some((t) => t.name === name);", "return c.tools.some((t) => t.name === name) || c.computeAssets.some((x) => x.name === name);"],
  ["C08 授权集合不含能力资产", "contact.ts", "const allowed = new Set([...c.tools.map((t) => t.name), ...c.computeAssets.map((x) => x.name)]);", "const allowed = new Set(c.tools.map((t) => t.name));"],
  ["C09 能力资产登记写进直接工具", "contact.ts", "computeAssets: [...c.computeAssets, { name: a.name, kind: a.kind }]", "tools: [...c.tools, { name: a.name, bounded: true }]"],
  ["C10 撤销记成 done", "contact.ts", "(k.id === id ? { ...k, status: \"revoked\" } : k)", "(k.id === id ? { ...k, status: \"done\" } : k)"],
  // 以下 N01–N05 取自 Codex 第二轮独立复审 reviews/feat-contact-helper.md CH-08(注入点与 independent-mutations-round2.json 一致),C11–C20 是 CH-05–07 返修的埋雷
  ["N01 回收只看等待表", "contact.ts", "k.boundTaskIds.length === 0 && k.awaitingReport.length === 0 ?", "k.awaitingReport.length === 0 ?"],
  ["N02 说明只留第一条群规", "contact.ts", "rules: Object.freeze([...r.rules])", "rules: Object.freeze([...r.rules].slice(0, 1))"],
  ["N03 说明只留第一项凭据引用", "contact.ts", "credentialRefs: Object.freeze([...r.credentialRefs])", "credentialRefs: Object.freeze([...r.credentialRefs].slice(0, 1))"],
  ["N04 误差 0 被拒", "contact.ts", "s.toleranceSec < 0", "s.toleranceSec <= 0"],
  ["N05 任一承诺结束都清空专职锁", "contact.ts", "c.focus && !c.commitments.some((k) => k.id === c.focus?.onlyCommitmentId && k.status === \"active\") ? { ...c, focus: null } : c;", "c.focus ? { ...c, focus: null } : c;"],
  ["C11 先到的汇报确认被吞", "contact.ts", "if (k.boundTaskIds.includes(taskId) && !k.reportedTaskIds.includes(taskId)) return { ...k, reportedTaskIds: [...k.reportedTaskIds, taskId] };", ""],
  ["C12 终态不看已确认记录", "contact.ts", "if (k.reportedTaskIds.includes(taskId)) return retire({ ...k, boundTaskIds, reportedTaskIds: k.reportedTaskIds.filter((t) => t !== taskId) });", ""],
  ["C13 无关任务的确认也被记下", "contact.ts", "if (k.boundTaskIds.includes(taskId) && !k.reportedTaskIds.includes(taskId))", "if (!k.reportedTaskIds.includes(taskId))"],
  ["C14 重放确认重复记录", "contact.ts", "if (k.boundTaskIds.includes(taskId) && !k.reportedTaskIds.includes(taskId))", "if (k.boundTaskIds.includes(taskId))"],
  ["C15 先确认就回收,不等终态", "contact.ts", "return { ...k, reportedTaskIds: [...k.reportedTaskIds, taskId] };", "return { ...k, status: \"done\" };"],
  ["C16 终态回收不解专职锁", "contact.ts", "export function settleTask(c: Contact, taskId: string): Contact {\n  return freezeContact(dropStaleFocus({", "export function settleTask(c: Contact, taskId: string): Contact {\n  return freezeContact(({"],
  ["C17 Compute 专用资产可同名授为直接工具", "contact.ts", "if (c.computeAssets.some((x) => x.name === tool.name)) return { ok: false, reason: `${tool.name} 已登记为只给 Compute 用的能力资产,不能再当直接工具` };", ""],
  ["C18 直接工具不查空名", "contact.ts", "if (!tool.name.trim()) return { ok: false, reason: \"工具名不能为空\" };", ""],
  ["C19 直接工具只查空串不查空白", "contact.ts", "if (!tool.name.trim()) return", "if (!tool.name) return"],
  ["C20 说明不查空工具名", "contact.ts", "if (r.tools.some((t) => !t.trim())) return { ok: false, reason: \"派给 Compute 的工具名不能为空\" };", ""],
  // 以下 P01–P05 取自 Codex 第三轮独立复审 reviews/feat-contact-helper.md CH-11(注入点与 independent-mutations-round3.json 一致),C21–C25 是 CH-09/CH-10 返修的埋雷
  ["P01 汇报确认不查承诺是否有效", "contact.ts", "if (k.status !== \"active\" || k.schedule) return k;", "if (k.schedule) return k;"],
  ["P02 任务终态不查承诺是否有效", "contact.ts", "if (k.status !== \"active\" || k.schedule || !k.boundTaskIds.includes(taskId)) return k;", "if (k.schedule || !k.boundTaskIds.includes(taskId)) return k;"],
  ["P03 说明只留第一项工具", "contact.ts", "tools: Object.freeze([...r.tools])", "tools: Object.freeze([...r.tools].slice(0, 1))"],
  ["P04 汇报确认丢等待表第一项", "contact.ts", "awaitingReport: k.awaitingReport.filter((t) => t !== taskId)", "awaitingReport: k.awaitingReport.slice(1)"],
  ["P05 终态消耗第一项确认记录", "contact.ts", "reportedTaskIds: k.reportedTaskIds.filter((t) => t !== taskId)", "reportedTaskIds: k.reportedTaskIds.slice(1)"],
  ["C21 回执不看点名的承诺", "contact.ts", "if (!receipt.commitmentIds.includes(k.id) || k.sourceSeq > receipt.basedOnSeq) return k;", "if (k.sourceSeq > receipt.basedOnSeq) return k;"],
  ["C22 回执不看承诺出处位置", "contact.ts", "if (!receipt.commitmentIds.includes(k.id) || k.sourceSeq > receipt.basedOnSeq) return k;", "if (!receipt.commitmentIds.includes(k.id)) return k;"],
  ["C23 出处等于依据位置也拒", "contact.ts", "k.sourceSeq > receipt.basedOnSeq", "k.sourceSeq >= receipt.basedOnSeq"],
  ["C24 回执只认第一条点名承诺", "contact.ts", "receipt.commitmentIds.includes(k.id)", "receipt.commitmentIds.slice(0, 1).includes(k.id)"],
  ["C25 能力资产只查空串不查空白", "contact.ts", "if (!a.name.trim()) return", "if (!a.name) return"],
];
function run(dir) {
  const files = fs.readdirSync(path.join(dir, "src")).filter((f) => f.endsWith(".test.ts")).map((f) => path.join("src", f));
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: dir, encoding: "utf8" });
  const failed = [...(r.stdout ?? "").matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
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
  if (!src.includes(from)) { ok = false; console.log(`✗ ${name}:注入点不存在(实现已变,更新本脚本)`); return; }
  fs.writeFileSync(f, src.replace(from, to));
  const r = run(d);
  const killed = r.failed.length > 0;
  if (!killed) ok = false;
  console.log(`${killed ? "✓" : "✗"} ${name}:${r.passed.length} 绿 / ${r.failed.length} 红${killed ? `,被「${r.failed[0]}」发现` : ",存活"}`);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(ok ? "变异校准通过" : "变异校准失败");
process.exit(ok ? 0 : 1);
