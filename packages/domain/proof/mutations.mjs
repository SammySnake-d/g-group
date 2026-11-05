// 行为变异校准(R-05 阳性埋雷):对 domain 包的实现逐个注入单一故障,在隔离副本里跑本包测试,
// 每个变异都必须让至少一条具名测试失败。M01–M09 对应 Astra 审查 reviews/feat-domain-core.md 的变体清单,
// M10–M12 是那次修复新增的不可变性埋雷;M13–M29 是任务生命周期作者埋雷;
// A01–A14 对应 Astra 审查 reviews/feat-task-lifecycle.md 第 3 节独立变异;N01–N14 是 CORR-01..04 修复的新增埋雷;
// B01–B10(B09 与 N09 同一注入,不重复)对应第二轮审查独立变异;R01–R11 是 R2-CORR-01..04 修复的新增埋雷;
// C01–C10(C10 与 R03 同一注入,不重复)对应第三轮审查独立变异;S01–S14 是 R3-CORR-01..03 修复的新增埋雷;
// D01–D11 对应第四轮审查独立变异;T01–T15 是 R4-CORR-01..03 修复的新增埋雷;
// E01–E10(E10 与 T04 同一注入,不重复)对应第五轮审查独立变异;U01–U11 是 R5-CORR-01..03 修复的新增埋雷;
// F01–F08 对应第六轮审查独立变异(F09 阳性对照与 U08/U09 同类不重复);V01–V10 是第六轮修复的新增埋雷;
// G01–G09 对应第七轮审查独立变异(G10 与 V09 同一注入不重复);W01–W11 是第七轮运行时形状校验的新增埋雷;
// H01–H09 对应第八轮审查独立变异(H10 为阳性对照不重复);X01–X06 是第八轮修复的新增埋雷。原样副本必须全绿(阴性对照)。
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
  ["M15 放行 unknown 审查模型", "task.ts", "  if (reviewer === \"unknown\") return new Error(`审查模型 ${reviewerModel} 认不出厂商(unknown)`);\n", ""],
  ["M16 豁免记成合规", "task.ts", "  return \"waived-by-user\";\n};", "  return \"compliant\";\n};"],
  ["M17 任何人都能豁免", "task.ts", "if (waiverBy !== t.requester) return new Error(", "if (!waiverBy) return new Error("],
  ["M18 超时自动算验收通过", "task.ts", "AcceptTimeout: forDelivery((t) => ok(set(t, { state: \"T8_ArchivedUnverified\", badge: \"unverified\" }))),", "AcceptTimeout: forDelivery((t) => ok(set(t, { state: \"T8_Accepted\", badge: \"accepted\" }))),"],
  ["M19 退回一律新开 Compute", "task.ts", "if (resumable && t.computeId) return ok(", "if (t.computeId === \"__never__\") return ok("],
  ["M20 确认卡不核对版本", "task.ts", "if (ev.constraintVer !== t.constraintVer) return ok(t);", ""],
  ["M21 取消不等真实停止", "task.ts", "if (t.computeId) return ok(set(t, { state: \"T9_StopRequested\", stopReason: reason }), [{ kind: \"stop-compute\", computeId: t.computeId }]);", "if (t.computeId) return ok(set(t, { state: reason === \"cancel\" ? \"T10_Cancelled\" : \"T11_Failed\", stopReason: reason }));"],
  ["M29 拒绝确认卡不停止任务", "task.ts", 'return ev.answer === "approve" ? ok(set(cleared, { state: "T3_Running" })) : stopThenRun(cleared, "cancel");', 'return ok(set(cleared, { state: "T3_Running" }));'],
  ["M22 停止期间允许重新认领", "task.ts", 'Claim: rej("停止期间禁止把任务重新指派给他人"),', 'Claim: go((t, e) => ok(set(t, { state: "T2_Claimed", owner: as(e, "Claim").by }))),'],
  ["M23 允许重复认领", "task.ts", 'Claim: rej("已被认领,重复认领原子拒绝(可改领子任务)"),', 'Claim: go((t, e) => ok(set(t, { owner: as(e, "Claim").by }))),'],
  ["M24 任何人都能确认验收", "task.ts", "const accept = (t: Task, e: TaskEvent): Outcome => as(e, \"UserAccept\").by === t.requester ?", "const accept = (t: Task, e: TaskEvent): Outcome => as(e, \"UserAccept\").by !== \"\" || true ?"],
  ["M25 改条件不递增版本", "task.ts", "  const ver = t.constraintVer + 1;", "  const ver = t.constraintVer;"],
  ["M26 表里留一格空白", "task.ts", '    Dispatch: rej("尚未认领,不能派发"), ', "    Dispatch: undefined as unknown as Cell, "],
  ["M27 状态转移改入参", "task.ts", "  return Object.freeze({\n    ...t, ...patch,", "  Object.assign(t as object, patch);\n  return Object.freeze({\n    ...t, ...patch,"],
  ["A01 T7 的 Amend 改成 ignore", "task.ts", "Amend: amendRework, SubmitForReview: staleOr(\"已审完\")", "Amend: ign(\"变异\"), SubmitForReview: staleOr(\"已审完\")"],
  ["A02 T8_Accepted 的 UserReject 改成 ignore", "task.ts", "T8_Accepted: { ...terminalRow(), ProducerModelAdded: lateModel, Amend: amendRework, UserReject: forDelivery(userRejectRun) },", "T8_Accepted: { ...terminalRow(), ProducerModelAdded: lateModel, Amend: amendRework },"],
  ["A03 T1 的 Cancel 改成 ignore", "task.ts", "Cancel: cancel, StoppedConfirmed: ign(\"没有在停止的 Compute\"), ExecFailed: ign(NOT_RUNNING),", "Cancel: ign(\"变异\"), StoppedConfirmed: ign(\"没有在停止的 Compute\"), ExecFailed: ign(NOT_RUNNING),"],
  ["A04 rework 保留 reviewedCommit/reviewGate", "task.ts", "pendingQ: null, reviewedCommit: null, reviewGate: \"none\", badge: \"none\", approval: null, delivery: null } as const;", "pendingQ: null, badge: \"none\", approval: null, delivery: null } as const;"],
  ["A05 不可恢复新开时仍保留旧 computeId", "task.ts", "return relaunch(set(t, { ...base, computeId: null, boundRequest: null }), [], true);", "return relaunch(set(t, { ...base, boundRequest: null }), [], true);"],
  ["A06 删除 UserReject 的提出者身份限制", "task.ts", "return ev.by === t.requester ? rework(t, ev.computeResumable) : no(`只有提出者 ${t.requester} 能退回验收`);", "return rework(t, ev.computeResumable);"],
  ["A07 归档后允许任意非空 by 验收", "task.ts", "const accept = (t: Task, e: TaskEvent): Outcome => as(e, \"UserAccept\").by === t.requester ?", "const accept = (t: Task, e: TaskEvent): Outcome => as(e, \"UserAccept\").by.length > 0 ?"],
  ["A08 NeedHuman 写死 constraintVer 为 0", "task.ts", "pendingQ: { qId: ev.qId, constraintVer: t.constraintVer } }));", "pendingQ: { qId: ev.qId, constraintVer: 0 } }));"],
  ["A09 旧版本回复清掉新 pendingQ", "task.ts", "if (ev.constraintVer !== t.constraintVer) return ok(t);", "if (ev.constraintVer !== t.constraintVer) return ok(set(t, { pendingQ: null }));"],
  ["A10 新开 Compute 不携带交接", "task.ts", "return relaunch(set(t, { ...base, computeId: null, boundRequest: null }), [], true);", "return relaunch(set(t, { ...base, computeId: null, boundRequest: null }), [], false);"],
  ["A11 T7 发卡失败调用 rework、重跑 Compute", "task.ts", "ExecFailed: ign(\"工件已落盘,只重发卡片,不回去重跑\")", "ExecFailed: go((t) => rework(t, true))"],
  ["A12 T5 SubmitForReview 忽略新提交", "task.ts", "reviewedCommit: commit, reviewRound: round", "reviewedCommit: t.reviewedCommit, reviewRound: round"],
  ["A13 T1 Amend 不推进版本", "task.ts", "HumanReply: ign(NO_CARD), Amend: bumpVer,", "HumanReply: ign(NO_CARD), Amend: ign(\"变异\"),"],
  ["A14 删除生产厂商 unknown 守卫", "task.ts", "  if (producers.has(\"unknown\")) return new Error(\"有生产模型认不出厂商(unknown)\");\n", ""],
  ["N01 审查回包不核对被审对象", "task.ts", "if (ev.round !== t.reviewRound || ev.commit !== t.reviewedCommit || ev.constraintVer !== t.constraintVer) return ok(t);", ""],
  ["N02 审查回包只核 commit 不核条件版本", "task.ts", "if (ev.round !== t.reviewRound || ev.commit !== t.reviewedCommit || ev.constraintVer !== t.constraintVer) return ok(t);", "if (ev.round !== t.reviewRound || ev.commit !== t.reviewedCommit) return ok(t);"],
  ["N03 审查打回一律当作可恢复", "task.ts", "if (ev.verdict === \"reject\") return rework(t, ev.computeResumable);", "if (ev.verdict === \"reject\") return rework(t, true);"],
  ["N04 返工入口的改条件一律当作可恢复", "task.ts", "const amendRework = go((t, e) => rework(t, as(e, \"Amend\").computeResumable));", "const amendRework = go((t) => rework(t, true));"],
  ["N05 T5 改条件不发恢复效果", "task.ts", "HumanReply: ign(NO_CARD), Amend: amendRework, SubmitForReview: go(", "HumanReply: ign(NO_CARD), Amend: amendLive, SubmitForReview: go("],
  ["N06 新开后不标记待回绑", "task.ts", "return ok(set(t, { launch, launchSeq: seq }),", "return ok(set(t, { launchSeq: seq }),"],
  ["N07 T3 拒绝新实例回绑", "task.ts", "Dispatch: go((t, e) => canBind(t, e) ? ok(bind(t, e)) : orphan(t, e) ?? no(\"已有 Compute 在执行\")),", "Dispatch: go((t, e) => orphan(t, e) ?? no(\"已有 Compute 在执行\")),"],
  ["N08 回绑不累积生产模型", "task.ts", "instances: t.instances.includes(ev.computeId) ? t.instances : [...t.instances, ev.computeId], producerModels: [...new Set([...t.producerModels, ev.model])] });", "instances: t.instances.includes(ev.computeId) ? t.instances : [...t.instances, ev.computeId] });"],
  ["N09 启动途中取消不撤销启动", "task.ts", "if (t.launch) return ok(set(t, { state: \"T9_StopRequested\", stopReason: reason }), [{ kind: \"cancel-spawn\", requestId: t.launch.requestId }]);", ""],
  ["N10 停止期间迟到上线的新实例不被停止", "task.ts", "return ok(b, [{ kind: \"stop-compute\", computeId: b.computeId! }]);", "return ok(b);"],
  ["N11 未回绑也允许向人提问", "task.ts", "const ev = as(e, \"NeedHuman\");\n      if (!t.computeId) return provablyStale(t, e) ? ok(t) : no(NO_COMPUTE);", "const ev = as(e, \"NeedHuman\");\n      if (!t.computeId) return ok(set(t, { state: \"T4b_BlockedOnHuman\", pendingQ: { qId: ev.qId, constraintVer: t.constraintVer } }));"],
  ["N12 确认卡不冻结", "task.ts", "q ? Object.freeze({ qId: String(q.qId), constraintVer: Number(q.constraintVer) }) : null", "q ? { qId: String(q.qId), constraintVer: Number(q.constraintVer) } : null"],
  ["N13 确认卡沿用外部引用不重新快照", "task.ts", "pendingQ: snapQ(q), launch", "pendingQ: q, launch"],
  ["N14 卡片绑定版本不与任务版本比对", "task.ts", "if (q.constraintVer !== t.constraintVer) return no(`卡片绑定版本 ${q.constraintVer} 与任务当前版本 ${t.constraintVer} 不一致`);", ""],
  ["B01 可恢复返工把负责人改成提出者", "task.ts", "if (resumable && t.computeId) return ok(set(t, { ...base, launch: null }),", "if (resumable && t.computeId) return ok(set(t, { ...base, launch: null, owner: t.requester }),"],
  ["B02 可恢复返工只保留末次生产模型", "task.ts", "if (resumable && t.computeId) return ok(set(t, { ...base, launch: null }),", "if (resumable && t.computeId) return ok(set(t, { ...base, launch: null, producerModels: t.producerModels.slice(-1) }),"],
  ["B03 T5 忽略 ProducerModelAdded", "task.ts", "Dispatch: dispatchElse(\"已有 Compute\"), ProducerModelAdded: addModel, NeedHuman: staleOr(\"审查中不再向人提问\")", "Dispatch: dispatchElse(\"已有 Compute\"), ProducerModelAdded: ign(\"变异\"), NeedHuman: staleOr(\"审查中不再向人提问\")"],
  ["B04 T5 改条件一律按可恢复", "task.ts", "const amendRework = go((t, e) => rework(t, as(e, \"Amend\").computeResumable));", "const amendRework = go((t, e) => rework(t, t.state === \"T5_InReview\" ? true : as(e, \"Amend\").computeResumable));"],
  ["B05 T7 改条件一律按可恢复", "task.ts", "const amendRework = go((t, e) => rework(t, as(e, \"Amend\").computeResumable));", "const amendRework = go((t, e) => rework(t, t.state === \"T7_Delivering\" ? true : as(e, \"Amend\").computeResumable));"],
  ["B06 Accepted 退回一律按可恢复", "task.ts", "return ev.by === t.requester ? rework(t, ev.computeResumable) :", "return ev.by === t.requester ? rework(t, t.state === \"T8_Accepted\" ? true : ev.computeResumable) :"],
  ["B07 Archived 退回一律按可恢复", "task.ts", "return ev.by === t.requester ? rework(t, ev.computeResumable) :", "return ev.by === t.requester ? rework(t, t.state === \"T8_ArchivedUnverified\" ? true : ev.computeResumable) :"],
  ["B08 T9 迟到回绑把负责人改成提出者", "task.ts", "      const b = bind(t, e);", "      const b = set(bind(t, e), { owner: t.requester });"],
  ["B10 未回绑即可提审", "task.ts", "const ev = as(e, \"SubmitForReview\");\n  if (!t.computeId) return provablyStale(t, e) ? ok(t) : no(NO_COMPUTE);", "const ev = as(e, \"SubmitForReview\");\n  if (!t.computeId) return ok(set(t, { state: \"T5_InReview\", reviewedCommit: ev.commit }));"],
  ["R01 停止确认不核对身份", "task.ts", "      if (c.computeId || c.launch || c.revoked.length || c.orphans.length) return r;", "      void c;"],
  ["R02 只有在途启动时任意停止确认都算", "task.ts", "else if (!t.computeId && t.launch && ev.requestId === t.launch.requestId) r = ok(set(t, { launch: null }));", "else if (!t.computeId && t.launch) r = ok(set(t, { launch: null }));"],
  ["R03 回绑不核对启动请求号", "task.ts", " && as(e, \"Dispatch\").requestId === t.launch.requestId;", ";"],
  ["R04 别的请求号的实例不停止", "task.ts", "  return ok(set(t, { orphans: [...t.orphans, ev.computeId], revoked: t.revoked.filter((r) => r !== ev.requestId) }), [{ kind: \"stop-compute\", computeId: ev.computeId }]);", "  return ok(t);"],
  ["R05 启动中改条件不重新发起", "task.ts", "  relaunch(set(t, { constraintVer: ver, revoked: [...t.revoked, launch.requestId] }), [{ kind: \"cancel-spawn\", requestId: launch.requestId }], t.state !== \"T2_Claimed\");", "  ok(set(t, { constraintVer: ver }));"],
  ["R06 启动中改条件不撤销旧启动", "task.ts", "  relaunch(set(t, { constraintVer: ver, revoked: [...t.revoked, launch.requestId] }), [{ kind: \"cancel-spawn\", requestId: launch.requestId }], t.state !== \"T2_Claimed\");", "  relaunch(set(t, { constraintVer: ver, revoked: [...t.revoked, launch.requestId] }), [], t.state !== \"T2_Claimed\");"],
  ["R07 启动请求号复用", "task.ts", "const seq = t.launchSeq + 1;", "const seq = 1;"],
  ["R08 启动请求绑旧条件版本", "task.ts", "requestId: `${t.id}#L${seq}`, constraintVer: t.constraintVer };", "requestId: `${t.id}#L${seq}`, constraintVer: 0 };"],
  ["R09 先比卡号再比版本(旧卡号旧版本被拒)", "task.ts", "      if (ev.constraintVer !== t.constraintVer) return ok(t);\n      if (!q || q.qId !== ev.qId) return no(`回复的卡片 ${ev.qId} 不是当前待回复的卡`);", "      if (!q || q.qId !== ev.qId) return no(`回复的卡片 ${ev.qId} 不是当前待回复的卡`);\n      if (ev.constraintVer !== t.constraintVer) return ok(t);"],
  ["R10 审查轮次不递增", "task.ts", "const commit = ev.commit;\n  const round = t.reviewRound + 1;", "const commit = ev.commit;\n  const round = 1;"],
  ["R11 审查回包不核对轮次", "task.ts", "ev.round !== t.reviewRound || ", ""],
  ["C01 T5 遇旧请求实例只拒不停", "task.ts", "Claim: rej(\"审查中,拒绝重复认领\"), Dispatch: dispatchElse(\"已有 Compute\"),", "Claim: rej(\"审查中,拒绝重复认领\"), Dispatch: rej(\"已有 Compute\"),"],
  ["C02 T4b 遇旧请求实例只拒不停", "task.ts", "Claim: rej(\"已在执行,拒绝重复认领\"), Dispatch: dispatchElse(\"已有 Compute 在执行\"),", "Claim: rej(\"已在执行,拒绝重复认领\"), Dispatch: rej(\"已有 Compute 在执行\"),"],
  ["C03 T8a 遇旧请求实例只拒不停", "task.ts", "Claim: rej(\"已交付\"), Dispatch: dispatchElse(\"已交付\"),", "Claim: rej(\"已交付\"), Dispatch: rej(\"已交付\"),"],
  ["C04 失败停止时不核对确认身份", "task.ts", "if (t.computeId && ev.computeId === t.computeId) r =", "if (t.computeId && (ev.computeId === t.computeId || t.stopReason === \"fail\")) r ="],
  ["C05 审查只拦较小轮次", "task.ts", "if (ev.round !== t.reviewRound || ev.commit !== t.reviewedCommit || ev.constraintVer !== t.constraintVer) return ok(t);", "if (ev.round < t.reviewRound || ev.commit !== t.reviewedCommit || ev.constraintVer !== t.constraintVer) return ok(t);"],
  ["C06 只有 approve 核对审查轮次", "task.ts", "if (ev.round !== t.reviewRound || ev.commit !== t.reviewedCommit || ev.constraintVer !== t.constraintVer) return ok(t);", "if ((ev.verdict === \"approve\" && ev.round !== t.reviewRound) || ev.commit !== t.reviewedCommit || ev.constraintVer !== t.constraintVer) return ok(t);"],
  ["C07 卡片版本封顶为 1", "task.ts", "pendingQ: { qId: ev.qId, constraintVer: t.constraintVer } }));", "pendingQ: { qId: ev.qId, constraintVer: Math.min(t.constraintVer, 1) } }));"],
  ["C08 审查请求版本封顶为 1", "task.ts", "[{ kind: \"request-review\", round, commit, constraintVer: t.constraintVer }]", "[{ kind: \"request-review\", round, commit, constraintVer: Math.min(t.constraintVer, 1) }]"],
  ["C09 回绑时启动序列归零", "task.ts", "boundRequest: ev.requestId, launch: null, instances:", "boundRequest: ev.requestId, launch: null, launchSeq: 0, instances:"],
  ["S01 当前实例重复上线回包也停止", "task.ts", "  if (ev.computeId === t.computeId) return ok(t);\n", ""],
  ["S02 孤儿实例不登记待确认", "task.ts", "orphans: [...t.orphans, ev.computeId], revoked:", "orphans: t.orphans, revoked:"],
  ["S03 孤儿上线后不划掉旧启动", "task.ts", "revoked: t.revoked.filter((r) => r !== ev.requestId) }), [{ kind: \"stop-compute\"", "revoked: t.revoked }), [{ kind: \"stop-compute\""],
  ["S04 撤销重发不登记旧启动", "task.ts", "  relaunch(set(t, { constraintVer: ver, revoked: [...t.revoked, launch.requestId] }), [{ kind: \"cancel-spawn\", requestId: launch.requestId }], t.state !== \"T2_Claimed\");", "  relaunch(set(t, { constraintVer: ver, revoked: t.revoked }), [{ kind: \"cancel-spawn\", requestId: launch.requestId }], t.state !== \"T2_Claimed\");"],
  ["S05 只等当前对象,忽略孤儿与旧启动", "task.ts", "if (c.computeId || c.launch || c.revoked.length || c.orphans.length) return r;", "if (c.computeId || c.launch) return r;"],
  ["S06 取消时不等未决旧启动", "task.ts", "  if (t.revoked.length || t.orphans.length) return ok(set(t, { state: \"T9_StopRequested\", stopReason: reason }));\n", ""],
  ["S07 孤儿停止确认不释放槽位", "task.ts", "return ok(set(t, { orphans: t.orphans.filter((c) => c !== ev.computeId), retired: [...t.retired, ev.computeId] }), [{ kind: \"release-slot\", computeId: ev.computeId }]);", "return ok(set(t, { orphans: t.orphans.filter((c) => c !== ev.computeId), retired: [...t.retired, ev.computeId] }));"],
  ["S08 提审不核对来源实例", "task.ts", "  if (ev.computeId !== t.computeId || ev.constraintVer !== t.constraintVer) return ok(t);\n  const commit", "  if (ev.constraintVer !== t.constraintVer) return ok(t);\n  const commit"],
  ["S09 提审不核对条件版本", "task.ts", "  if (ev.computeId !== t.computeId || ev.constraintVer !== t.constraintVer) return ok(t);\n  const commit", "  if (ev.computeId !== t.computeId) return ok(t);\n  const commit"],
  ["S10 提问不核对来源与版本", "task.ts", "      if (ev.computeId !== t.computeId || ev.constraintVer !== t.constraintVer) return ok(t);\n      return ok(set(t, { state: \"T4b_BlockedOnHuman\"", "      return ok(set(t, { state: \"T4b_BlockedOnHuman\""],
  ["S11 换模不核对来源实例", "task.ts", "  if (!t.instances.includes(ev.computeId)) return ok(t);\n  const m = ev.model;", "  const m = ev.model;"],
  ["S12 执行失败不核对来源", "task.ts", "const current = t.computeId ? ev.computeId === t.computeId : !!t.launch && ev.requestId === t.launch.requestId;", "const current = true;"],
  ["S13 改条件不通知当前实例新版本", "task.ts", "t.computeId ? [{ kind: \"update-constraints\", computeId: t.computeId, constraintVer: ver }] : []", "[]"],
  ["S14 恢复原实例不带新版本", "task.ts", "[{ kind: \"resume-compute\", computeId: t.computeId, constraintVer: base.constraintVer }]", "[{ kind: \"resume-compute\", computeId: t.computeId, constraintVer: t.constraintVer }]"],
  ["D01 T4b 不消费孤儿停止确认", "task.ts", "    Amend: amendLive, SubmitForReview: staleOr(\"等人确认中,不能提审\"), Review: rej(\"不在审查中\"), DeliveredCard: rej(\"等人确认中\"),\n    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),\n    Cancel: cancel, StoppedConfirmed: ack,", "    Amend: amendLive, SubmitForReview: staleOr(\"等人确认中,不能提审\"), Review: rej(\"不在审查中\"), DeliveredCard: rej(\"等人确认中\"),\n    UserAccept: rej(NOT_DELIVERED), UserReject: rej(NOT_DELIVERED), AcceptTimeout: ign(NOT_DELIVERED),\n    Cancel: cancel, StoppedConfirmed: ign(\"变异\"),"],
  ["D02 T7 不消费孤儿停止确认", "task.ts", "Cancel: cancel, StoppedConfirmed: ack, ExecFailed: ign(\"工件已落盘", "Cancel: cancel, StoppedConfirmed: ign(\"变异\"), ExecFailed: ign(\"工件已落盘"],
  ["D03 任一旧启动确认清空全部 revoked", "task.ts", "if (ev.requestId !== undefined && t.revoked.includes(ev.requestId)) return ok(set(t, { revoked: t.revoked.filter((r) => r !== ev.requestId) }));", "if (ev.requestId !== undefined && t.revoked.includes(ev.requestId)) return ok(set(t, { revoked: [] }));"],
  ["D04 任一孤儿确认清空全部 orphans", "task.ts", "return ok(set(t, { orphans: t.orphans.filter((c) => c !== ev.computeId), retired: [...t.retired, ev.computeId] }), [{ kind: \"release-slot\", computeId: ev.computeId }]);", "return ok(set(t, { orphans: [], retired: [...t.retired, ev.computeId] }), [{ kind: \"release-slot\", computeId: ev.computeId }]);"],
  ["D05 只登记第一个孤儿", "task.ts", "  if (t.orphans.includes(ev.computeId)) return ok(t);", "  if (t.orphans.length > 0) return ok(t);"],
  ["D06 revoked 不冻结", "task.ts", "revoked: Object.freeze([...(patch.revoked ?? t.revoked)]), orphans: Object.freeze([...(patch.orphans ?? t.orphans)]),", "revoked: [...(patch.revoked ?? t.revoked)], orphans: Object.freeze([...(patch.orphans ?? t.orphans)]),"],
  ["D07 orphans 不冻结", "task.ts", "revoked: Object.freeze([...(patch.revoked ?? t.revoked)]), orphans: Object.freeze([...(patch.orphans ?? t.orphans)]),", "revoked: Object.freeze([...(patch.revoked ?? t.revoked)]), orphans: [...(patch.orphans ?? t.orphans)],"],
  ["D08 返工丢掉孤儿集合", "task.ts", "const base = { state: \"T3_Running\", constraintVer: t.constraintVer + 1,", "const base = { orphans: [], state: \"T3_Running\", constraintVer: t.constraintVer + 1,"],
  ["D09 同请求不同实例当作重复", "task.ts", "  if (ev.computeId === t.computeId) return ok(t);", "  if (ev.computeId === t.computeId || ev.requestId === t.boundRequest) return ok(t);"],
  ["D10 update-constraints 版本封顶为 2", "task.ts", "[{ kind: \"update-constraints\", computeId: t.computeId, constraintVer: ver }]", "[{ kind: \"update-constraints\", computeId: t.computeId, constraintVer: Math.min(ver, 2) }]"],
  ["D11 停止确认时不等当前实例", "task.ts", "if (c.computeId || c.launch || c.revoked.length || c.orphans.length) return r;", "if (c.launch || c.revoked.length || c.orphans.length) return r;"],
  ["T01 回绑不登记曾用实例", "task.ts", "instances: t.instances.includes(ev.computeId) ? t.instances : [...t.instances, ev.computeId],", "instances: t.instances,"],
  ["T02 换模只认当前实例", "task.ts", "  if (!t.instances.includes(ev.computeId)) return ok(t);\n  const m = ev.model;", "  if (ev.computeId !== t.computeId) return ok(t);\n  const m = ev.model;"],
  ["T03 交付后迟到生产记录直接忽略", "task.ts", "T8_Accepted: { ...terminalRow(), ProducerModelAdded: lateModel,", "T8_Accepted: { ...terminalRow(), ProducerModelAdded: ign(\"变异\"),"],
  ["T04 迟到记录不重判合规", "task.ts", "  if (gate instanceof Error) return reReview(t2);", "  if (gate instanceof Error) return ok(t2);"],
  ["T05 重审不分配新轮次", "task.ts", "const reReview = (t: Task): Outcome => {\n  const round = t.reviewRound + 1;", "const reReview = (t: Task): Outcome => {\n  const round = t.reviewRound;"],
  ["T06 重审保留验收标记", "task.ts", "reviewGate: \"none\", approval: null, delivery: null, badge: \"none\" }), [{ kind: \"request-review\"", "reviewGate: \"none\", approval: null, delivery: null }), [{ kind: \"request-review\""],
  ["T07 迟到记录变成需豁免仍记合规", "task.ts", "  return ok(gate === t.reviewGate ? t2 : set(t2, { reviewGate: gate }));", "  return ok(t2);"],
  ["T08 审查通过不记审查人", "task.ts", "approval: { reviewerModel: ev.reviewerModel, waiverBy: ev.waiverBy ?? null }, delivery, deliverySeq: round }),", "approval: null, delivery, deliverySeq: round }),"],
  ["T09 旧来源回包在非接收状态也拒", "task.ts", "  return current ? no(reason) : ok(t);", "  return no(reason);"],
  ["T10 当前来源重复提问也忽略", "task.ts", "  return current ? no(reason) : ok(t);", "  return ok(t);"],
  ["T11 认领不发首派请求", "task.ts", "  return ok(set(t, { state: \"T2_Claimed\", owner: as(e, \"Claim\").by, launch }), [{ kind: \"spawn-compute\", withHandoff: false, ...launch }]);", "  return ok(set(t, { state: \"T2_Claimed\", owner: as(e, \"Claim\").by }));"],
  ["T12 首派回绑不核请求号", "task.ts", "Dispatch: go((t, e) => canBind(t, e) ? ok(set(bind(t, e), { state: \"T3_Running\" })) : orphan(t, e) ?? no(\"首派回包对不上\")),", "Dispatch: go((t, e) => ok(set(bind(t, e), { state: \"T3_Running\" }))),"],
  ["T13 首派在途改条件不撤销重发", "task.ts", "const amendQueued = go((t) => t.launch ? revokeAndRelaunch(t, t.launch, t.constraintVer + 1) : ok(", "const amendQueued = go((t) => false ? revokeAndRelaunch(t, t.launch!, t.constraintVer + 1) : ok("],
  ["T14 首派重发也带交接", "task.ts", "[{ kind: \"cancel-spawn\", requestId: launch.requestId }], t.state !== \"T2_Claimed\");", "[{ kind: \"cancel-spawn\", requestId: launch.requestId }], true);"],
  ["T15 T2 不消费停止确认", "task.ts", "    Cancel: cancel, StoppedConfirmed: ack, ExecFailed: execFailed,\n  },\n  T3_Running", "    Cancel: cancel, StoppedConfirmed: ign(\"变异\"), ExecFailed: execFailed,\n  },\n  T3_Running"],
  ["E01 换模只认最近两个曾回绑实例(审前)", "task.ts", "  if (!t.instances.includes(ev.computeId)) return ok(t);\n  const m = ev.model;", "  if (!t.instances.slice(-2).includes(ev.computeId)) return ok(t);\n  const m = ev.model;"],
  ["E02 迟到换模只认最近两个曾回绑实例(审后)", "task.ts", "if (!t.instances.includes(ev.computeId) || t.producerModels.includes(ev.model)) return ok(t);", "if (!t.instances.slice(-2).includes(ev.computeId) || t.producerModels.includes(ev.model)) return ok(t);"],
  ["E03 审后迟到的 unknown 厂商不重审", "task.ts", "  if (gate instanceof Error) return reReview(t2);", "  if (gate instanceof Error) return t2.producerModels.some((m) => vendorOf(m) === \"unknown\") ? ok(t2) : reReview(t2);"],
  ["E04 审查批准快照不冻结", "task.ts", "a ? Object.freeze({ reviewerModel: String(a.reviewerModel), waiverBy: a.waiverBy === null ? null : String(a.waiverBy) }) : null;", "a ? { reviewerModel: String(a.reviewerModel), waiverBy: a.waiverBy === null ? null : String(a.waiverBy) } : null;"],
  ["E05 审查批准沿用调用方引用", "task.ts", "approval: snapA(a), delivery: snapD(d),", "approval: a, delivery: snapD(d),"],
  ["E06 重审保留旧 approval", "task.ts", "reviewGate: \"none\", approval: null, delivery: null, badge: \"none\" }), [{ kind: \"request-review\"", "reviewGate: \"none\", delivery: null, badge: \"none\" }), [{ kind: \"request-review\""],
  ["E07 重审把负责人改成提出者", "task.ts", "return ok(set(t, { state: \"T5_InReview\", reviewRound: round,", "return ok(set(t, { state: \"T5_InReview\", owner: t.requester, reviewRound: round,"],
  ["E08 认领时首派请求绑版本 0", "task.ts", "const launch: Launch = { requestId: `${t.id}#L0`, constraintVer: t.constraintVer };", "const launch: Launch = { requestId: `${t.id}#L0`, constraintVer: 0 };"],
  ["E09 当前实例未来版本回包被拒", "task.ts", "(ev.constraintVer === undefined || ev.constraintVer === t.constraintVer);", "(ev.constraintVer === undefined || ev.constraintVer >= t.constraintVer);"],
  ["U01 旧交付代次不在入口忽略", "task.ts", "  if (staleDelivery(t, e)) return ok(t);\n", ""],
  ["U02 入口放过下一个未分配代次(原'forDelivery 不核代次'在入口校验后成等价变异,改指入口)", "task.ts", "if (DELIVERY_EVENTS.has(e.kind) && (ev.deliveryRound as number) > t.deliverySeq) return", "if (DELIVERY_EVENTS.has(e.kind) && (ev.deliveryRound as number) > t.deliverySeq + 1) return"],
  ["U03 旧代次判定不核 commit", "task.ts", "  return !t.delivery || ev.deliveryRound !== t.delivery.round || ev.commit !== t.delivery.commit;", "  return !t.delivery || ev.deliveryRound !== t.delivery.round;"],
  ["U04 交付代次不递增", "task.ts", "  const round = t.deliverySeq + 1;", "  const round = 1;"],
  ["U05 审查通过不请求发卡", "task.ts", "    [{ kind: \"send-card\", taskId: t.id, deliveryRound: round, commit: delivery.commit, constraintVer: t.constraintVer }]);", "    []);"],
  ["U06 重审不清当前交付", "task.ts", "approval: null, delivery: null, badge: \"none\" }), [{ kind: \"request-review\"", "approval: null, badge: \"none\" }), [{ kind: \"request-review\""],
  ["U07 返工不清当前交付", "task.ts", "badge: \"none\", approval: null, delivery: null } as const;", "badge: \"none\", approval: null } as const;"],
  ["U08 未回绑时可证明旧回包也拒", "task.ts", "  if (ev.constraintVer !== undefined && ev.constraintVer < t.constraintVer) return true;\n  return ev.computeId", "  if (ev.constraintVer !== undefined && false) return true;\n  return false && ev.computeId"],
  ["U09 未回绑时旧实例回包不算旧", "task.ts", "  return ev.computeId !== undefined && ev.computeId !== t.computeId && (t.instances.includes(ev.computeId) || t.orphans.includes(ev.computeId) || t.retired.includes(ev.computeId));", "  return false;"],
  ["U10 交付快照不冻结", "task.ts", "d ? Object.freeze({ round: Number(d.round), commit: String(d.commit) }) : null;", "d ? { round: Number(d.round), commit: String(d.commit) } : null;"],
  ["U11 T2 旧提问回包仍拒", "task.ts", "NeedHuman: unboundOr(NOT_RUNNING), HumanReply: ign(NO_CARD),\n    Amend: amendQueued,", "NeedHuman: rej(NOT_RUNNING), HumanReply: ign(NO_CARD),\n    Amend: amendQueued,"],
  ["F01 未回绑时不识别已登记孤儿", "task.ts", "  return ev.computeId !== undefined && ev.computeId !== t.computeId && (t.instances.includes(ev.computeId) || t.orphans.includes(ev.computeId) || t.retired.includes(ev.computeId));", "  return ev.computeId !== undefined && ev.computeId !== t.computeId && (t.instances.includes(ev.computeId) || t.retired.includes(ev.computeId));"],
  ["F02 未回绑时只认最近两个历史实例", "task.ts", "  return ev.computeId !== undefined && ev.computeId !== t.computeId && (t.instances.includes(ev.computeId) || t.orphans.includes(ev.computeId) || t.retired.includes(ev.computeId));", "  return ev.computeId !== undefined && ev.computeId !== t.computeId && (t.instances.slice(-2).includes(ev.computeId) || t.orphans.includes(ev.computeId) || t.retired.includes(ev.computeId));"],
  ["F03 只把上一代次当旧代次", "task.ts", "  return !t.delivery || ev.deliveryRound !== t.delivery.round || ev.commit !== t.delivery.commit;", "  return ev.deliveryRound >= t.deliverySeq - 1 && (!t.delivery || ev.deliveryRound !== t.delivery.round || ev.commit !== t.delivery.commit);"],
  ["F04 send-card 条件版本封顶为 1", "task.ts", "    [{ kind: \"send-card\", taskId: t.id, deliveryRound: round, commit: delivery.commit, constraintVer: t.constraintVer }]);", "    [{ kind: \"send-card\", taskId: t.id, deliveryRound: round, commit: delivery.commit, constraintVer: Math.min(t.constraintVer, 1) }]);"],
  ["F05 第三次交付 send-card commit 错误", "task.ts", "    [{ kind: \"send-card\", taskId: t.id, deliveryRound: round, commit: delivery.commit, constraintVer: t.constraintVer }]);", "    [{ kind: \"send-card\", taskId: t.id, deliveryRound: round, commit: round >= 3 ? \"__wrong__\" : delivery.commit, constraintVer: t.constraintVer }]);"],
  ["F06 归档后退回交付序列清零", "task.ts", "badge: \"none\", approval: null, delivery: null } as const;", "badge: \"none\", approval: null, delivery: null, deliverySeq: t.state === \"T8_ArchivedUnverified\" ? 0 : t.deliverySeq } as const;"],
  ["F07 只对 UserAccept 检查旧交付 commit", "task.ts", "  return !t.delivery || ev.deliveryRound !== t.delivery.round || ev.commit !== t.delivery.commit;", "  return !t.delivery || ev.deliveryRound !== t.delivery.round || (e.kind === \"UserAccept\" && ev.commit !== t.delivery.commit);"],
  ["F08 send-card 交付代次封顶为 2", "task.ts", "    [{ kind: \"send-card\", taskId: t.id, deliveryRound: round, commit: delivery.commit, constraintVer: t.constraintVer }]);", "    [{ kind: \"send-card\", taskId: t.id, deliveryRound: Math.min(round, 2), commit: delivery.commit, constraintVer: t.constraintVer }]);"],
  ["V01 孤儿确认停止后不记入退役", "task.ts", "return ok(set(t, { orphans: t.orphans.filter((c) => c !== ev.computeId), retired: [...t.retired, ev.computeId] }), [{ kind: \"release-slot\", computeId: ev.computeId }]);", "return ok(set(t, { orphans: t.orphans.filter((c) => c !== ev.computeId) }), [{ kind: \"release-slot\", computeId: ev.computeId }]);"],
  ["V02 当前实例确认停止后不记入退役", "task.ts", "computeId: null, boundRequest: null, retired: [...t.retired, t.computeId] }),", "computeId: null, boundRequest: null }),"],
  ["V03 退役实例重放上线重新登记为孤儿", "task.ts", "  if (t.retired.includes(ev.computeId)) return ok(t, [{ kind: \"stop-compute\", computeId: ev.computeId }]);\n", ""],
  ["V04 退役实例重放上线不再发停止", "task.ts", "  if (t.retired.includes(ev.computeId)) return ok(t, [{ kind: \"stop-compute\", computeId: ev.computeId }]);", "  if (t.retired.includes(ev.computeId)) return ok(t);"],
  ["V05 未回绑时退役实例回包不算旧", "task.ts", "  return ev.computeId !== undefined && ev.computeId !== t.computeId && (t.instances.includes(ev.computeId) || t.orphans.includes(ev.computeId) || t.retired.includes(ev.computeId));", "  return ev.computeId !== undefined && ev.computeId !== t.computeId && (t.instances.includes(ev.computeId) || t.orphans.includes(ev.computeId));"],
  ["V06 交付代次不校验正整数", "task.ts", "const DELIVERY_SHAPE = { taskId: \"str\", deliveryRound: \"pint\", commit: \"str\" } as const;", "const DELIVERY_SHAPE = { taskId: \"str\", commit: \"str\" } as const;"],
  ["V07 交付代次允许 0", "task.ts", "const DELIVERY_SHAPE = { taskId: \"str\", deliveryRound: \"pint\", commit: \"str\" } as const;", "const DELIVERY_SHAPE = { taskId: \"str\", deliveryRound: \"nat\", commit: \"str\" } as const;"],
  ["V08 交付代次允许小数", "task.ts", "  if (f === \"pint\") return Number.isSafeInteger(v) && (v as number) >= 1;", "  if (f === \"pint\") return Number.isFinite(v) && (v as number) >= 1;"],
  ["V09 不核对事件所属任务", "task.ts", "  if (\"taskId\" in ev && ev.taskId !== t.id) return `事件属于任务 ${ev.taskId},不是本任务 ${t.id}`;\n", ""],
  ["V10 send-card 不带任务号", "task.ts", "    [{ kind: \"send-card\", taskId: t.id, deliveryRound: round, commit: delivery.commit, constraintVer: t.constraintVer }]);", "    [{ kind: \"send-card\", taskId: \"\", deliveryRound: round, commit: delivery.commit, constraintVer: t.constraintVer }]);"],
  ["G01 失败停止的确认不核 taskId", "task.ts", "  if (\"taskId\" in ev && ev.taskId !== t.id) return", "  if (\"taskId\" in ev && ev.taskId !== t.id && !(e.kind === \"StoppedConfirmed\" && t.stopReason === \"fail\")) return"],
  ["G02 已验收状态退回不核 taskId", "task.ts", "  if (\"taskId\" in ev && ev.taskId !== t.id) return", "  if (\"taskId\" in ev && ev.taskId !== t.id && !(e.kind === \"UserReject\" && t.state === \"T8_Accepted\")) return"],
  ["G03 归档状态补确认不核 taskId", "task.ts", "  if (\"taskId\" in ev && ev.taskId !== t.id) return", "  if (\"taskId\" in ev && ev.taskId !== t.id && !(e.kind === \"UserAccept\" && t.state === \"T8_ArchivedUnverified\")) return"],
  ["G04 DeliveredCard 不校验代次", "task.ts", "  DeliveredCard: { req: DELIVERY_SHAPE },", "  DeliveredCard: { req: { taskId: \"str\", commit: \"str\" } },"],
  ["G05 retired 不冻结", "task.ts", "retired: Object.freeze([...(patch.retired ?? t.retired)]),", "retired: [...(patch.retired ?? t.retired)],"],
  ["G06 孤儿退役时只留最近一条旧记录", "task.ts", "retired: [...t.retired, ev.computeId] })", "retired: [...t.retired.slice(-1), ev.computeId] })"],
  ["G07 当前实例停止覆盖旧退役账本", "task.ts", "retired: [...t.retired, t.computeId] }),", "retired: [t.computeId] }),"],
  ["G08 未回绑时只认最近两个退役实例", "task.ts", "t.retired.includes(ev.computeId));", "t.retired.slice(-2).includes(ev.computeId));"],
  ["G09 退役实例重放时停当前实例", "task.ts", "if (t.retired.includes(ev.computeId)) return ok(t, [{ kind: \"stop-compute\", computeId: ev.computeId }]);", "if (t.retired.includes(ev.computeId)) return ok(t, [{ kind: \"stop-compute\", computeId: t.computeId ?? ev.computeId }]);"],
  ["W01 不校验必填字段", "task.ts", "  for (const [k, f] of Object.entries(shape.req)) if (!fieldOk(own(e, k), f)) return", "  for (const [k, f] of Object.entries(shape.req)) if (k === \"__never__\" && !fieldOk(own(e, k), f)) return"],
  ["W02 字符串字段只查存在", "task.ts", "  if (f === \"str\") return typeof v === \"string\" && v.trim().length > 0;", "  if (f === \"str\") return v !== undefined;"],
  ["W03 空字符串当合法", "task.ts", "  if (f === \"str\") return typeof v === \"string\" && v.trim().length > 0;", "  if (f === \"str\") return typeof v === \"string\";"],
  ["W04 非负整数允许负数", "task.ts", "  if (f === \"nat\") return Number.isSafeInteger(v) && (v as number) >= 0;", "  if (f === \"nat\") return Number.isSafeInteger(v);"],
  ["W05 布尔接受 0/1", "task.ts", "  if (f === \"bool\") return typeof v === \"boolean\";", "  if (f === \"bool\") return typeof v === \"boolean\" || v === 0 || v === 1;"],
  ["W06 枚举不查取值", "task.ts", "  return typeof v === \"string\" && f.includes(v);", "  return typeof v === \"string\";"],
  ["W07 可选字段不校验", "task.ts", "  for (const [k, f] of Object.entries(shape.opt ?? {})) if (own(e, k) !== undefined && !fieldOk(own(e, k), f)) return", "  for (const [k, f] of Object.entries(shape.opt ?? {})) if (k === \"__never__\" && !fieldOk(own(e, k), f)) return"],
  ["W08 reject 审查不要求 computeResumable", "task.ts", "  if (kind === \"Review\" && own(e, \"verdict\") === \"reject\" && !fieldOk(own(e, \"computeResumable\"), \"bool\")) return", "  if (kind === \"__never__\" && own(e, \"verdict\") === \"reject\" && !fieldOk(own(e, \"computeResumable\"), \"bool\")) return"],
  ["W09 未知事件种类放过", "task.ts", "  if (!shape) return `未知的事件种类 ${JSON.stringify(kind)}`;", "  if (!shape) return null;"],
  ["W10 入口不做形状校验", "task.ts", "  if (shape) return shape;\n", ""],
  ["W11 非对象事件放过", "task.ts", "  if (typeof e !== \"object\" || e === null || Array.isArray(e)) return \"事件不是对象\";", "  if (e === undefined) return \"事件不是对象\";"],
  ["H01 正整数不限安全范围", "task.ts", "  if (f === \"pint\") return Number.isSafeInteger(v) && (v as number) >= 1;", "  if (f === \"pint\") return Number.isInteger(v) && (v as number) >= 1;"],
  ["H02 字符串禁止非 ASCII", "task.ts", "  if (f === \"str\") return typeof v === \"string\" && v.trim().length > 0;", "  if (f === \"str\") return typeof v === \"string\" && v.trim().length > 0 && /^[\\x00-\\x7f]+$/.test(v);"],
  ["H03 拒绝未知附加字段", "task.ts", "  if (!shape) return `未知的事件种类 ${JSON.stringify(kind)}`;", "  if (!shape) return `未知的事件种类 ${JSON.stringify(kind)}`;\n  if (Object.keys(e).some((k) => k !== \"kind\" && !(k in shape.req) && !(k in (shape.opt ?? {})) && !(kind === \"Review\" && k === \"computeResumable\"))) return `${kind}.extra`;"],
  ["H04 布尔接受数组", "task.ts", "  if (f === \"bool\") return typeof v === \"boolean\";", "  if (f === \"bool\") return typeof v === \"boolean\" || Array.isArray(v);"],
  ["H05 布尔接受字符串 false", "task.ts", "  if (f === \"bool\") return typeof v === \"boolean\";", "  if (f === \"bool\") return typeof v === \"boolean\" || v === \"false\";"],
  ["H06 枚举接受 yes", "task.ts", "  return typeof v === \"string\" && f.includes(v);", "  return typeof v === \"string\" && (f.includes(v) || v === \"yes\");"],
  ["H07 枚举大小写折叠", "task.ts", "  return typeof v === \"string\" && f.includes(v);", "  return typeof v === \"string\" && f.includes(v.toLowerCase());"],
  ["H08 reject 审查只查 computeResumable 存在", "task.ts", "  if (kind === \"Review\" && own(e, \"verdict\") === \"reject\" && !fieldOk(own(e, \"computeResumable\"), \"bool\")) return \"Review.computeResumable 缺失或取值非法(应为布尔)\";", "  if (kind === \"Review\" && own(e, \"verdict\") === \"reject\" && own(e, \"computeResumable\") === undefined) return \"Review.computeResumable 缺失或取值非法(应为布尔)\";"],
  ["H09 数字 kind 放过", "task.ts", "  if (typeof kind !== \"string\") return \"事件种类缺失或不是字符串\";", "  if (typeof kind === \"number\") return null;\n  if (typeof kind !== \"string\") return \"事件种类缺失或不是字符串\";"],
  ["X01 非字符串 kind 格式化进原因", "task.ts", "  if (typeof kind !== \"string\") return \"事件种类缺失或不是字符串\";", "  if (typeof kind !== \"string\") return `未知的事件种类 ${String(kind)}`;"],
  ["X02 形状表用普通对象按名取", "task.ts", "  const shape = SHAPE_BY_KIND.get(kind);", "  const shape = (EVENT_SHAPES as unknown as Record<string, Shape>)[kind];"],
  ["X03 去掉外层兜底", "task.ts", "  try {\n    return checkShape(e);\n  } catch {\n    return \"事件无法校验\";\n  }", "  return checkShape(e);"],
  ["X04 字段读取不限自有属性", "task.ts", "const own = (o: object, k: string): unknown => (Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined);", "const own = (o: object, k: string): unknown => (o as Record<string, unknown>)[k];"],
  ["X05 全空白字符串当合法", "task.ts", "  if (f === \"str\") return typeof v === \"string\" && v.trim().length > 0;", "  if (f === \"str\") return typeof v === \"string\" && v.length > 0;"],
  ["X06 未知种类原因不点名", "task.ts", "  if (!shape) return `未知的事件种类 ${JSON.stringify(kind)}`;", "  if (!shape) return \"未知的事件种类\";"],
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
