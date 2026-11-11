// G5 两段式的纯规则:标记身份(S-2)、粗筛出口、精筛批次与触发、结果解码、后台单元计时(G5-a)。
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRefine, decodeReflect, validateCapture } from "./memory-capture.ts";
import { fineTrigger, markCandidateKey, routeCapture, selectFineBatch, takeoverMarkId } from "./memory-marks.ts";
import { newRun, resolveThresholds, stallCheck } from "./run-ledger.ts";
import type { CompactMemory, ReflectSource } from "./runtime-ports.ts";

const source = (over: Partial<ReflectSource> = {}): ReflectSource => ({ roomId: "r1", seq: 2, revision: 2, senderKind: "user", senderId: "u", text: "以后都用中文回复", verifiedOutcome: false, ...over });
const memory = (over: Partial<CompactMemory> = {}): CompactMemory => ({ title: "回复语言", text: "用中文回复", anchors: ["global"], relation: null, target: null, roomId: "r1", sourceSeq: 2, evidence: "以后都用中文回复", kind: "preference", ...over });

test("G5-K1 标记身份带消息版本与原话 一条消息两件事是两个身份", () => {
  const cache = markCandidateKey("r1", 2, 2, "fact", "缓存方案定为 Redis");
  const release = markCandidateKey("r1", 2, 2, "fact", "发布定在周五");
  const spaced = markCandidateKey("r1", 2, 2, "fact", "缓存方案定为  Redis ");
  const edited = markCandidateKey("r1", 2, 7, "fact", "缓存方案定为 Redis");
  const otherRoom = markCandidateKey("r2", 2, 2, "fact", "缓存方案定为 Redis");
  const otherKind = markCandidateKey("r1", 2, 2, "decision", "缓存方案定为 Redis");
  assert.match(cache, /^[0-9a-f]{64}$/);
  assert.notEqual(cache, release, "同一 seq 的两件事不能互吞");
  assert.equal(spaced, cache, "只按规范化后的原话认同一项");
  assert.notEqual(edited, cache, "编辑后的新版本是新工作项");
  assert.notEqual(otherRoom, cache, "跨会话同 seq 不串");
  assert.notEqual(otherKind, cache);
  const takenA = takeoverMarkId("cov-a", cache, 2);
  const takenB = takeoverMarkId("cov-b", cache, 2);
  assert.match(takenA, /^[0-9a-f]{64}$/);
  assert.notEqual(takenA, takenB, "接管身份保留原覆盖工作");
  assert.notEqual(takenA, cache);
});

test("G5-K2 粗筛出口三选一 只有本人长期偏好直接写", () => {
  const s = source();
  const ok = (m: CompactMemory) => routeCapture(m, validateCapture(m, [s], [s]));
  assert.equal(ok(memory()), "direct");
  const fact = source({ text: "缓存方案定为 Redis" });
  const factMemory = memory({ kind: "fact", evidence: "缓存方案定为 Redis", anchors: ["room:r1"] });
  assert.equal(routeCapture(factMemory, validateCapture(factMemory, [fact], [fact])), "mark", "事实交精筛");
  const once = source({ text: "这次用中文回复" });
  const onceMemory = memory({ evidence: "这次用中文回复" });
  assert.equal(routeCapture(onceMemory, validateCapture(onceMemory, [once], [once])), "mark", "不是长期要求不直接写");
  assert.equal(ok(memory({ relation: "change", target: null })), "mark", "缺目标的替代交精筛");
  assert.equal(ok(memory({ relation: "conflict", target: "m-1" })), "mark", "冲突交精筛");
  assert.equal(ok(memory({ relation: "change", target: "m-1" })), "direct");
  assert.equal(ok(memory({ roomId: "elsewhere" })), "debt", "来源不合法只留债务,不包装成标记");
  const contact = source({ senderKind: "contact", senderId: "c" });
  assert.equal(routeCapture(memory(), validateCapture(memory(), [contact], [contact])), "debt");
});

test("G5-K3 精筛一批不超过条数与字节上限 最老的先", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, bytes: 100, createdAt: 100 - i }));
  const byCount = selectFineBatch(items, { maxMarks: 8, maxBytes: 24 * 1024 });
  assert.equal(byCount.take.length, 8);
  assert.deepEqual(byCount.take.slice(0, 2), ["m9", "m8"], "最老的先");
  assert.deepEqual(byCount.oversize, []);
  const byBytes = selectFineBatch(items, { maxMarks: 8, maxBytes: 250 });
  assert.deepEqual(byBytes.take, ["m9", "m8"]);
  const big = selectFineBatch([{ id: "huge", bytes: 300, createdAt: 0 }, ...items.slice(0, 1)], { maxMarks: 8, maxBytes: 250 });
  assert.deepEqual(big, { take: ["m0"], oversize: ["huge"] }, "单个超预算的单列,不挡后面的");
});

test("G5-K4 精筛触发 没有欠账不跑 显式与积压与年龄与安静期", () => {
  const p = { maxPending: 5, maxAgeMs: 1000, quietMs: 100 };
  const base = { pending: 1, oldestAt: 900, quietSince: 950, now: 1000, explicit: false };
  assert.equal(fineTrigger({ ...base, pending: 0, oldestAt: null, explicit: true }, p), null);
  assert.equal(fineTrigger(base, p), null, "对话还没安静、积压没到上限");
  assert.equal(fineTrigger({ ...base, explicit: true }, p), "explicit");
  assert.equal(fineTrigger({ ...base, pending: 5 }, p), "backlog");
  assert.equal(fineTrigger({ ...base, oldestAt: 0 }, p), "age");
  assert.equal(fineTrigger({ ...base, quietSince: 900 }, p), "quiet");
});

test("G5-K5 检查结果带标记 形状不对整份判失败", () => {
  const raw = { note: null, memories: [], personaSuggestion: null, marks: [{ roomId: "r1", seq: 2, kind: "decision", evidence: "缓存方案定为 Redis" }, { roomId: "r1", seq: 2, kind: "unsure", evidence: "可能周五发" }] };
  const ok = decodeReflect(raw);
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.marks?.map((m) => m.kind), ["decision", "unsure"]);
  const none = decodeReflect({ note: null, memories: [], personaSuggestion: null });
  assert.ok(none.ok);
  assert.equal(none.value.marks, undefined, "旧适配器不给标记就是没有");
  assert.equal(decodeReflect({ ...raw, marks: [{ roomId: "r1", seq: 2, kind: "rumor", evidence: "x" }] }).ok, false);
  assert.equal(decodeReflect({ ...raw, marks: [{ roomId: "r1", seq: 0, kind: "fact", evidence: "x" }] }).ok, false);
  assert.equal(decodeReflect({ ...raw, marks: "none" }).ok, false);
});

test("G5-K6 精筛结果每项必须指回来源", () => {
  const good = decodeRefine({ memories: [memory({ kind: "fact" })] });
  assert.ok(good.ok);
  assert.equal(good.value.memories[0]!.sourceSeq, 2);
  const { sourceSeq: _drop, ...noSeq } = memory();
  assert.equal(decodeRefine({ memories: [noSeq] }).ok, false, "缺出处不猜");
  const empty = decodeRefine({ memories: [] });
  assert.ok(empty.ok);
  assert.equal(empty.value.memories.length, 0, "空数组是有效的「没有值得记的」");
  assert.equal(decodeRefine({ memory: [] }).ok, false);
});

test("G5-K7 宿主后台单元声明计时后卡死判定与休眠宽限管得到", () => {
  const base = { id: "u", parentId: null, roomId: "r", sourceSeq: 1, contactId: "c", bootId: "b", at: 0 } as const;
  const th = resolveThresholds({ defaults: { stallMs: 1000, firstByteMs: 500 } }, "c", null);
  const timed = newRun({ ...base, layer: "background", timed: true });
  const plain = newRun({ ...base, layer: "background" });
  const judged = stallCheck(timed, 2000, th);
  assert.equal(judged.verdict?.kind, "stalled");
  assert.equal(judged.verdict?.thresholdMs, 1000);
  assert.equal(stallCheck(plain, 2000, th).verdict, null, "Compute 的后台工具任务照旧不计时");
  assert.equal(stallCheck(timed, 2000, th, { awakeSince: 1900, graceMs: 300 }).waiting, "sleep_grace");
  assert.equal(timed.timed, true);
});
