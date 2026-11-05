// 行为变异校准(R-05 阳性埋雷):对 domain 包的实现逐个注入单一故障,在隔离副本里跑本包测试,
// 每个变异都必须让至少一条具名测试失败。M01–M09 对应 Astra 审查 reviews/feat-domain-core.md 的变体清单,
// M10–M12 是那次修复新增的不可变性埋雷;M13–M29 是任务生命周期作者埋雷;
// A01–A14 对应 Astra 审查 reviews/feat-task-lifecycle.md 第 3 节独立变异;N01–N14 是 CORR-01..04 修复的新增埋雷;
// B01–B10(B09 与 N09 同一注入,不重复)对应第二轮审查独立变异;R01–R11 是 R2-CORR-01..04 修复的新增埋雷;
// C01–C10(C10 与 R03 同一注入,不重复)对应第三轮审查独立变异;S01–S14 是 R3-CORR-01..03 修复的新增埋雷。
// M30–M47 是联系人/Helper 作者埋雷;contact/helper 其余系列见各分组注释。为不和任务侧重名:
// reviews/feat-contact-helper.md 第二轮的 N01–N05 记为 CN01–CN05,contact 返修埋雷原 C01–C30 记为 K01–K30。原样副本必须全绿(阴性对照)。
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
  ["M25 改条件不递增版本", "task.ts", "  const ver = t.constraintVer + 1;", "  const ver = t.constraintVer;"],
  ["M26 表里留一格空白", "task.ts", '    Dispatch: rej("尚未认领,不能派发"), ', "    Dispatch: undefined as unknown as Cell, "],
  ["M27 状态转移改入参", "task.ts", "  return Object.freeze({\n    ...t, ...patch,", "  Object.assign(t as object, patch);\n  return Object.freeze({\n    ...t, ...patch,"],
  ["A01 T7 的 Amend 改成 ignore", "task.ts", "Amend: amendRework, SubmitForReview: rej(\"已审完\")", "Amend: ign(\"变异\"), SubmitForReview: rej(\"已审完\")"],
  ["A02 T8_Accepted 的 UserReject 改成 ignore", "task.ts", "T8_Accepted: { ...terminalRow(), Amend: amendRework, UserReject: userReject },", "T8_Accepted: { ...terminalRow(), Amend: amendRework },"],
  ["A03 T1 的 Cancel 改成 ignore", "task.ts", "Cancel: cancel, StoppedConfirmed: ign(\"没有在停止的 Compute\"), ExecFailed: ign(NOT_RUNNING),", "Cancel: ign(\"变异\"), StoppedConfirmed: ign(\"没有在停止的 Compute\"), ExecFailed: ign(NOT_RUNNING),"],
  ["A04 rework 保留 reviewedCommit/reviewGate", "task.ts", "pendingQ: null, reviewedCommit: null, reviewGate: \"none\", badge: \"none\" } as const;", "pendingQ: null, badge: \"none\" } as const;"],
  ["A05 不可恢复新开时仍保留旧 computeId", "task.ts", "return relaunch(set(t, { ...base, computeId: null, boundRequest: null }), []);", "return relaunch(set(t, { ...base, boundRequest: null }), []);"],
  ["A06 删除 UserReject 的提出者身份限制", "task.ts", "return ev.by === t.requester ? rework(t, ev.computeResumable) : no(`只有提出者 ${t.requester} 能退回验收`);", "return rework(t, ev.computeResumable);"],
  ["A07 归档后允许任意非空 by 验收", "task.ts", "UserReject: userReject,\n    UserAccept: go((t, e) => as(e, \"UserAccept\").by === t.requester ?", "UserReject: userReject,\n    UserAccept: go((t, e) => as(e, \"UserAccept\").by.length > 0 ?"],
  ["A08 NeedHuman 写死 constraintVer 为 0", "task.ts", "pendingQ: { qId: ev.qId, constraintVer: t.constraintVer } }));", "pendingQ: { qId: ev.qId, constraintVer: 0 } }));"],
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
  ["N08 回绑不累积生产模型", "task.ts", "boundRequest: ev.requestId ?? null, launch: null, producerModels: [...new Set([...t.producerModels, ev.model])] });", "boundRequest: ev.requestId ?? null, launch: null });"],
  ["N09 启动途中取消不撤销启动", "task.ts", "if (t.launch) return ok(set(t, { state: \"T9_StopRequested\", stopReason: reason }), [{ kind: \"cancel-spawn\", requestId: t.launch.requestId }]);", ""],
  ["N10 停止期间迟到上线的新实例不被停止", "task.ts", "return ok(b, [{ kind: \"stop-compute\", computeId: b.computeId! }]);", "return ok(b);"],
  ["N11 未回绑也允许向人提问", "task.ts", "      if (!t.computeId) return no(NO_COMPUTE);\n      // 旧执行器或按旧条件版本发起的提问", "      // 旧执行器或按旧条件版本发起的提问"],
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
  ["B10 未回绑即可提审", "task.ts", "  if (!t.computeId) return no(NO_COMPUTE);\n  // 旧执行器(别的实例)", "  // 旧执行器(别的实例)"],
  ["R01 停止确认不核对身份", "task.ts", "      if (c.computeId || c.launch || c.revoked.length || c.orphans.length) return r;", "      void c;"],
  ["R02 只有在途启动时任意停止确认都算", "task.ts", "else if (!t.computeId && t.launch && ev.requestId === t.launch.requestId) r = ok(set(t, { launch: null }));", "else if (!t.computeId && t.launch) r = ok(set(t, { launch: null }));"],
  ["R03 回绑不核对启动请求号", "task.ts", " && as(e, \"Dispatch\").requestId === t.launch.requestId;", ";"],
  ["R04 别的请求号的实例不停止", "task.ts", "  return ok(set(t, { orphans: [...t.orphans, ev.computeId], revoked: t.revoked.filter((r) => r !== ev.requestId) }), [{ kind: \"stop-compute\", computeId: ev.computeId }]);", "  return ok(t);"],
  ["R05 启动中改条件不重新发起", "task.ts", "return relaunch(set(t, { constraintVer: ver, revoked: [...t.revoked, t.launch.requestId] }), [{ kind: \"cancel-spawn\", requestId: t.launch.requestId }]);", "return ok(set(t, { constraintVer: ver }));"],
  ["R06 启动中改条件不撤销旧启动", "task.ts", "return relaunch(set(t, { constraintVer: ver, revoked: [...t.revoked, t.launch.requestId] }), [{ kind: \"cancel-spawn\", requestId: t.launch.requestId }]);", "return relaunch(set(t, { constraintVer: ver, revoked: [...t.revoked, t.launch.requestId] }), []);"],
  ["R07 启动请求号复用", "task.ts", "const seq = t.launchSeq + 1;", "const seq = 1;"],
  ["R08 启动请求绑旧条件版本", "task.ts", "requestId: `${t.id}#L${seq}`, constraintVer: t.constraintVer };", "requestId: `${t.id}#L${seq}`, constraintVer: 0 };"],
  ["R09 先比卡号再比版本(旧卡号旧版本被拒)", "task.ts", "      if (ev.constraintVer !== t.constraintVer) return ok(t);\n      if (!q || q.qId !== ev.qId) return no(`回复的卡片 ${ev.qId} 不是当前待回复的卡`);", "      if (!q || q.qId !== ev.qId) return no(`回复的卡片 ${ev.qId} 不是当前待回复的卡`);\n      if (ev.constraintVer !== t.constraintVer) return ok(t);"],
  ["R10 审查轮次不递增", "task.ts", "const round = t.reviewRound + 1;", "const round = 1;"],
  ["R11 审查回包不核对轮次", "task.ts", "ev.round !== t.reviewRound || ", ""],
  ["C01 T5 遇旧请求实例只拒不停", "task.ts", "Claim: rej(\"审查中,拒绝重复认领\"), Dispatch: dispatchElse(\"已有 Compute\"),", "Claim: rej(\"审查中,拒绝重复认领\"), Dispatch: rej(\"已有 Compute\"),"],
  ["C02 T4b 遇旧请求实例只拒不停", "task.ts", "Claim: rej(\"已在执行,拒绝重复认领\"), Dispatch: dispatchElse(\"已有 Compute 在执行\"),", "Claim: rej(\"已在执行,拒绝重复认领\"), Dispatch: rej(\"已有 Compute 在执行\"),"],
  ["C03 T8a 遇旧请求实例只拒不停", "task.ts", "Claim: rej(\"已交付\"), Dispatch: dispatchElse(\"已交付\"),", "Claim: rej(\"已交付\"), Dispatch: rej(\"已交付\"),"],
  ["C04 失败停止时不核对确认身份", "task.ts", "if (t.computeId && ev.computeId === t.computeId) r =", "if (t.computeId && (ev.computeId === t.computeId || t.stopReason === \"fail\")) r ="],
  ["C05 审查只拦较小轮次", "task.ts", "if (ev.round !== t.reviewRound || ev.commit !== t.reviewedCommit || ev.constraintVer !== t.constraintVer) return ok(t);", "if (ev.round < t.reviewRound || ev.commit !== t.reviewedCommit || ev.constraintVer !== t.constraintVer) return ok(t);"],
  ["C06 只有 approve 核对审查轮次", "task.ts", "if (ev.round !== t.reviewRound || ev.commit !== t.reviewedCommit || ev.constraintVer !== t.constraintVer) return ok(t);", "if ((ev.verdict === \"approve\" && ev.round !== t.reviewRound) || ev.commit !== t.reviewedCommit || ev.constraintVer !== t.constraintVer) return ok(t);"],
  ["C07 卡片版本封顶为 1", "task.ts", "pendingQ: { qId: ev.qId, constraintVer: t.constraintVer } }));", "pendingQ: { qId: ev.qId, constraintVer: Math.min(t.constraintVer, 1) } }));"],
  ["C08 审查请求版本封顶为 1", "task.ts", "[{ kind: \"request-review\", round, commit, constraintVer: t.constraintVer }]", "[{ kind: \"request-review\", round, commit, constraintVer: Math.min(t.constraintVer, 1) }]"],
  ["C09 回绑时启动序列归零", "task.ts", "boundRequest: ev.requestId ?? null, launch: null,", "boundRequest: ev.requestId ?? null, launch: null, launchSeq: 0,"],
  ["S01 当前实例重复上线回包也停止", "task.ts", "  if (ev.computeId === t.computeId) return ok(t);\n", ""],
  ["S02 孤儿实例不登记待确认", "task.ts", "orphans: [...t.orphans, ev.computeId], revoked:", "orphans: t.orphans, revoked:"],
  ["S03 孤儿上线后不划掉旧启动", "task.ts", "revoked: t.revoked.filter((r) => r !== ev.requestId) }), [{ kind: \"stop-compute\"", "revoked: t.revoked }), [{ kind: \"stop-compute\""],
  ["S04 撤销重发不登记旧启动", "task.ts", "revoked: [...t.revoked, t.launch.requestId] }), [{ kind: \"cancel-spawn\"", "revoked: t.revoked }), [{ kind: \"cancel-spawn\""],
  ["S05 只等当前对象,忽略孤儿与旧启动", "task.ts", "if (c.computeId || c.launch || c.revoked.length || c.orphans.length) return r;", "if (c.computeId || c.launch) return r;"],
  ["S06 取消时不等未决旧启动", "task.ts", "  if (t.revoked.length || t.orphans.length) return ok(set(t, { state: \"T9_StopRequested\", stopReason: reason }));\n", ""],
  ["S07 孤儿停止确认不释放槽位", "task.ts", "orphans: t.orphans.filter((c) => c !== ev.computeId) }), [{ kind: \"release-slot\", computeId: ev.computeId }]);", "orphans: t.orphans.filter((c) => c !== ev.computeId) }));"],
  ["S08 提审不核对来源实例", "task.ts", "  if (ev.computeId !== t.computeId || ev.constraintVer !== t.constraintVer) return ok(t);\n  const commit", "  if (ev.constraintVer !== t.constraintVer) return ok(t);\n  const commit"],
  ["S09 提审不核对条件版本", "task.ts", "  if (ev.computeId !== t.computeId || ev.constraintVer !== t.constraintVer) return ok(t);\n  const commit", "  if (ev.computeId !== t.computeId) return ok(t);\n  const commit"],
  ["S10 提问不核对来源与版本", "task.ts", "      if (ev.computeId !== t.computeId || ev.constraintVer !== t.constraintVer) return ok(t);\n      return ok(set(t, { state: \"T4b_BlockedOnHuman\"", "      return ok(set(t, { state: \"T4b_BlockedOnHuman\""],
  ["S11 换模不核对来源实例", "task.ts", "  if (!t.computeId || ev.computeId !== t.computeId) return ok(t);\n  const m = ev.model;", "  const m = ev.model;"],
  ["S12 执行失败不核对来源", "task.ts", "const current = t.computeId ? ev.computeId === t.computeId : !!t.launch && ev.requestId === t.launch.requestId;", "const current = true;"],
  ["S13 改条件不通知当前实例新版本", "task.ts", "t.computeId ? [{ kind: \"update-constraints\", computeId: t.computeId, constraintVer: ver }] : []", "[]"],
  ["S14 恢复原实例不带新版本", "task.ts", "[{ kind: \"resume-compute\", computeId: t.computeId, constraintVer: base.constraintVer }]", "[{ kind: \"resume-compute\", computeId: t.computeId, constraintVer: t.constraintVer }]"],
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
  // 以下 I01–I26 取自 Astra 独立审查 reviews/feat-contact-helper.md 第 6 节(按返修后的源码改注入点),K01–K10 是本次返修新增判据的埋雷
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
  ["K01 终态就回收,不等末次汇报", "contact.ts", "return { ...k, boundTaskIds, awaitingReport: [...k.awaitingReport, taskId] };", "return { ...k, boundTaskIds, status: boundTaskIds.length === 0 ? \"done\" : \"active\" };"],
  ["K02 汇报确认不回收", "contact.ts", "return retire({ ...k, awaitingReport: k.awaitingReport.filter((t) => t !== taskId) });", "return { ...k, awaitingReport: k.awaitingReport.filter((t) => t !== taskId) };"],
  ["K03 别的任务的确认也回收", "contact.ts", "if (k.awaitingReport.includes(taskId)) return retire(", "if (true) return retire("],
  ["K04 回收不解专职锁", "contact.ts", "return freezeContact(dropStaleFocus({\n    ...c,\n    commitments: c.commitments.map((k) => {\n      if (k.status !== \"active\" || k.schedule) return k;", "return freezeContact(({\n    ...c,\n    commitments: c.commitments.map((k) => {\n      if (k.status !== \"active\" || k.schedule) return k;"],
  ["K05 撤销不解专职锁", "contact.ts", "freezeContact(dropStaleFocus({ ...c, commitments: c.commitments.map((k) => (k.id === id", "freezeContact(({ ...c, commitments: c.commitments.map((k) => (k.id === id"],
  ["K06 专职锁拒一切工作", "contact.ts", "return i.commitmentId === c.focus.onlyCommitmentId ? \"handle\" : \"decline-focused\";", "return \"decline-focused\";"],
  ["K07 能力资产进直接清单", "contact.ts", "return c.tools.some((t) => t.name === name);", "return c.tools.some((t) => t.name === name) || c.computeAssets.some((x) => x.name === name);"],
  ["K08 授权集合不含能力资产", "contact.ts", "const allowed = new Set([...c.tools.map((t) => t.name), ...c.computeAssets.map((x) => x.name)]);", "const allowed = new Set(c.tools.map((t) => t.name));"],
  ["K09 能力资产登记写进直接工具", "contact.ts", "computeAssets: [...c.computeAssets, { name: a.name, kind: a.kind }]", "tools: [...c.tools, { name: a.name, bounded: true }]"],
  ["K10 撤销记成 done", "contact.ts", "(k.id === id ? { ...k, status: \"revoked\" } : k)", "(k.id === id ? { ...k, status: \"done\" } : k)"],
  // 以下 CN01–CN05(报告原编号 N01–N05)取自 Codex 第二轮独立复审 reviews/feat-contact-helper.md CH-08(注入点与 independent-mutations-round2.json 一致),K11–K20 是 CH-05–07 返修的埋雷
  ["CN01 回收只看等待表", "contact.ts", "k.boundTaskIds.length === 0 && k.awaitingReport.length === 0 ?", "k.awaitingReport.length === 0 ?"],
  ["CN02 说明只留第一条群规", "contact.ts", "rules: Object.freeze([...r.rules])", "rules: Object.freeze([...r.rules].slice(0, 1))"],
  ["CN03 说明只留第一项凭据引用", "contact.ts", "credentialRefs: Object.freeze([...r.credentialRefs])", "credentialRefs: Object.freeze([...r.credentialRefs].slice(0, 1))"],
  ["CN04 误差 0 被拒", "contact.ts", "s.toleranceSec < 0", "s.toleranceSec <= 0"],
  ["CN05 任一承诺结束都清空专职锁", "contact.ts", "c.focus && !c.commitments.some((k) => k.id === c.focus?.onlyCommitmentId && k.status === \"active\") ? { ...c, focus: null } : c;", "c.focus ? { ...c, focus: null } : c;"],
  ["K11 先到的汇报确认被吞", "contact.ts", "if (k.boundTaskIds.includes(taskId) && !k.reportedTaskIds.includes(taskId)) return { ...k, reportedTaskIds: [...k.reportedTaskIds, taskId] };", ""],
  ["K12 终态不看已确认记录", "contact.ts", "if (k.reportedTaskIds.includes(taskId)) return retire({ ...k, boundTaskIds, reportedTaskIds: k.reportedTaskIds.filter((t) => t !== taskId) });", ""],
  ["K13 无关任务的确认也被记下", "contact.ts", "if (k.boundTaskIds.includes(taskId) && !k.reportedTaskIds.includes(taskId))", "if (!k.reportedTaskIds.includes(taskId))"],
  ["K14 重放确认重复记录", "contact.ts", "if (k.boundTaskIds.includes(taskId) && !k.reportedTaskIds.includes(taskId))", "if (k.boundTaskIds.includes(taskId))"],
  ["K15 先确认就回收,不等终态", "contact.ts", "return { ...k, reportedTaskIds: [...k.reportedTaskIds, taskId] };", "return { ...k, status: \"done\" };"],
  ["K16 终态回收不解专职锁", "contact.ts", "export function settleTask(c: Contact, taskId: string): Contact {\n  return freezeContact(dropStaleFocus({", "export function settleTask(c: Contact, taskId: string): Contact {\n  return freezeContact(({"],
  ["K17 Compute 专用资产可同名授为直接工具", "contact.ts", "if (c.computeAssets.some((x) => x.name === tool.name)) return { ok: false, reason: `${tool.name} 已登记为只给 Compute 用的能力资产,不能再当直接工具` };", ""],
  ["K18 直接工具不查空名", "contact.ts", "if (!tool.name.trim()) return { ok: false, reason: \"工具名不能为空\" };", ""],
  ["K19 直接工具只查空串不查空白", "contact.ts", "if (!tool.name.trim()) return", "if (!tool.name) return"],
  ["K20 说明不查空工具名", "contact.ts", "if (r.tools.some((t) => !t.trim())) return { ok: false, reason: \"派给 Compute 的工具名不能为空\" };", ""],
  // 以下 P01–P05 取自 Codex 第三轮独立复审 reviews/feat-contact-helper.md CH-11(注入点与 independent-mutations-round3.json 一致),K21–K25 是 CH-09/CH-10 返修的埋雷
  ["P01 汇报确认不查承诺是否有效", "contact.ts", "if (k.status !== \"active\" || k.schedule) return k;", "if (k.schedule) return k;"],
  ["P02 任务终态不查承诺是否有效", "contact.ts", "if (k.status !== \"active\" || k.schedule || !k.boundTaskIds.includes(taskId)) return k;", "if (k.schedule || !k.boundTaskIds.includes(taskId)) return k;"],
  ["P03 说明只留第一项工具", "contact.ts", "tools: Object.freeze([...r.tools])", "tools: Object.freeze([...r.tools].slice(0, 1))"],
  ["P04 汇报确认丢等待表第一项", "contact.ts", "awaitingReport: k.awaitingReport.filter((t) => t !== taskId)", "awaitingReport: k.awaitingReport.slice(1)"],
  ["P05 终态消耗第一项确认记录", "contact.ts", "reportedTaskIds: k.reportedTaskIds.filter((t) => t !== taskId)", "reportedTaskIds: k.reportedTaskIds.slice(1)"],
  ["K21 回执不看点名的承诺", "contact.ts", "if (!receipt.commitmentIds.includes(k.id) || k.sourceSeq > receipt.basedOnSeq) return k;", "if (k.sourceSeq > receipt.basedOnSeq) return k;"],
  ["K22 回执不看承诺出处位置", "contact.ts", "if (!receipt.commitmentIds.includes(k.id) || k.sourceSeq > receipt.basedOnSeq) return k;", "if (!receipt.commitmentIds.includes(k.id)) return k;"],
  ["K23 出处等于依据位置也拒", "contact.ts", "k.sourceSeq > receipt.basedOnSeq", "k.sourceSeq >= receipt.basedOnSeq"],
  ["K24 回执只认第一条点名承诺", "contact.ts", "receipt.commitmentIds.includes(k.id)", "receipt.commitmentIds.slice(0, 1).includes(k.id)"],
  ["K25 能力资产只查空串不查空白", "contact.ts", "if (!a.name.trim()) return", "if (!a.name) return"],
  // 以下 Q01–Q05 取自 Codex 第四轮独立复审 reviews/feat-contact-helper.md CH-13(注入点与 independent-mutations-round4.json 一致),K26–K30 是 CH-12 返修的埋雷
  ["Q01 空作用域当成覆盖全部承诺", "contact.ts", "if (!receipt.commitmentIds.includes(k.id) || k.sourceSeq > receipt.basedOnSeq) return k;", "if ((receipt.commitmentIds.length > 0 && !receipt.commitmentIds.includes(k.id)) || k.sourceSeq > receipt.basedOnSeq) return k;"],
  ["Q02 点名承诺共用第一条的出处比较", "contact.ts", "k.sourceSeq > receipt.basedOnSeq", "c.commitments[0]!.sourceSeq > receipt.basedOnSeq"],
  ["Q03 只看上一次确认代替查已确认集合", "contact.ts", "!k.reportedTaskIds.includes(taskId)", "k.reportedTaskIds.at(-1) !== taskId"],
  ["Q04 能力资产空白校验只认空格和制表符", "contact.ts", "if (!a.name.trim()) return { ok: false, reason: \"能力资产名不能为空\" };", "if (a.name === \"\" || /^[ \\t]*$/.test(a.name)) return { ok: false, reason: \"能力资产名不能为空\" };"],
  ["Q05 出处等于依据位置也拒", "contact.ts", "if (!receipt.commitmentIds.includes(k.id) || k.sourceSeq > receipt.basedOnSeq) return k;", "if (!receipt.commitmentIds.includes(k.id) || k.sourceSeq >= receipt.basedOnSeq) return k;"],
  ["K26 承诺不校验出处位置", "contact.ts", "  if (!isSeq(k.sourceSeq)) return { ok: false, reason: `承诺出处 ${k.sourceSeq} 不是合法的消息位置(非负整数)` };\n", ""],
  ["K27 回执不校验依据位置", "contact.ts", "  if (!isSeq(receipt.basedOnSeq)) return c;\n", ""],
  ["K28 位置只查有限不查整数", "contact.ts", "Number.isSafeInteger(n) && n >= 0", "Number.isFinite(n) && n >= 0"],
  ["K29 位置不查负数", "contact.ts", "Number.isSafeInteger(n) && n >= 0", "Number.isSafeInteger(n)"],
  ["K30 位置把 0 也拒", "contact.ts", "Number.isSafeInteger(n) && n >= 0", "Number.isSafeInteger(n) && n > 0"],
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
