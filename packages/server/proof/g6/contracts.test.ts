// G6 确定性合同:逐份运行判,汇总时一条未守住即失败;不适用与守住分开。
import assert from "node:assert/strict";
import { test } from "node:test";
import { accounting, checkRecord, failedCheckRecovered, forbiddenText, mergeContracts, prefetchNotInPrefix, prefixStable, sameModel, scanText, truncationNotSuccess, whereInRequest } from "./contracts.ts";
import { checkRequest, line, mkCall, mkItem, mkRecord, roundRequest } from "./fixtures/build.ts";

const OLD = "以后周报都发到 weekly@corp.example";

test("K1 指定那步之后原文再进请求即未守住,之前出现不算", () => {
  const GONE = "我的储物柜号码是 4471,钥匙放在前台";
  const item = mkItem({ forbidden: [{ text: GONE, contact: "A", afterStep: 1, why: "撤回后不得再进请求" }] });
  const base = mkRecord();
  const before = mkCall({ at: 1100, request: roundRequest({ fresh: line(1, GONE) }) });
  const leak = mkCall({ at: 1600, request: roundRequest({ pointers: GONE }) });
  const r = forbiddenText(item, { ...base, calls: [before, ...base.calls, leak] });
  assert.equal(r.verdict, "fail");
  assert.deepEqual(r.violations, [`调用 ${leak.n}(round,第 5 块):撤回后不得再进请求`]);
  assert.equal(scanText(leak, false), `${leak.system}\n${leak.request}`);
  assert.equal(forbiddenText(item, { ...base, calls: [before, ...base.calls] }).verdict, "pass");
  assert.equal(forbiddenText(mkItem(), base).verdict, "n/a");
});

test("K1 exceptNote:笔记(第 3 块)里的旧文不算,第 4、5 块与检查材料里的算", () => {
  const item = mkItem({ forbidden: [{ text: OLD, contact: "A", afterStep: 0, why: "编辑前旧文" }] });
  const inNote = mkCall({ at: 1600, request: roundRequest({ note: OLD }) });
  assert.equal(scanText(inNote, true), `${inNote.system}\n\n(无)`);
  assert.equal(scanText(inNote, false).includes(OLD), true);
  assert.equal(scanText(mkCall({ cls: "check", request: checkRequest(line(9, "无关的一句话")) }), true), `[本轮新输入(原文)]\n${line(9, "无关的一句话")}`);
  const base = mkRecord();
  const onlyNote = { ...base, calls: [mkCall({ at: 1600, request: roundRequest({ note: OLD }) }), mkCall({ at: 1601, cls: "check", request: checkRequest(line(9, "无关的一句话"), OLD) })] };
  assert.equal(forbiddenText({ ...item, forbidden: [{ ...item.forbidden[0]!, exceptNote: true }] }, onlyNote).verdict, "pass");
  const inMaterial = { ...base, calls: [mkCall({ at: 1601, cls: "check", request: checkRequest(line(9, OLD)) })] };
  assert.equal(forbiddenText({ ...item, forbidden: [{ ...item.forbidden[0]!, exceptNote: true }] }, inMaterial).verdict, "fail");
});

test("K2 同一联系人的固定前缀变了即未守住", () => {
  const base = mkRecord();
  assert.equal(prefixStable(base).verdict, "pass");
  const changed = { ...base, calls: [...base.calls, mkCall({ at: 1700, system: "被改过的前缀" })] };
  const r = prefixStable(changed);
  assert.equal(r.verdict, "fail");
  assert.match(r.violations[0]!, /联系人 A 的固定前缀与本次运行第一轮不同$/);
});

test("K3 后台调用换了模型即未守住", () => {
  const base = mkRecord();
  assert.equal(sameModel(base).verdict, "pass");
  const r = sameModel({ ...base, calls: [...base.calls, mkCall({ cls: "check", model: "别的模型" })] });
  assert.equal(r.verdict, "fail");
  assert.match(r.violations[0]!, /\(check\)用了 别的模型,应为 m$/);
});

test("K4 截断的补写成了之后的状态笔记即未守住,没截断不适用", () => {
  const base = mkRecord();
  assert.equal(truncationNotSuccess(base).verdict, "n/a");
  const cut = mkCall({ at: 1300, cls: "compact", outcome: "truncated", stopReason: "max_tokens", text: "截断的半份笔记:用户要求先" });
  const later = mkCall({ at: 1400, request: roundRequest({ note: "截断的半份笔记:用户要求先" }) });
  const r = truncationNotSuccess({ ...base, calls: [cut, later] });
  assert.equal(r.verdict, "fail");
  assert.equal(r.violations[0], `调用 ${cut.n} 截断的输出成了调用 ${later.n} 的状态笔记`);
  assert.equal(truncationNotSuccess({ ...base, calls: [cut, mkCall({ at: 1400 })] }).verdict, "pass");
  assert.equal(truncationNotSuccess({ ...base, calls: [cut], notes: { A: "截断的半份笔记:用户要求先" } }).verdict, "fail");
});

test("K5 检查失败后那批消息既没再检查成功、也没留下欠账即未守住,补查成功则守住", () => {
  const failed = mkCall({ at: 1020, cls: "check", outcome: "http_error", status: 400, request: checkRequest(line(1, OLD)) });
  const base = mkRecord();
  const r = failedCheckRecovered({ ...base, calls: [failed] });
  assert.equal(r.verdict, "fail");
  assert.equal(r.violations[0], `调用 ${failed.n}(http_error)里的 dm-1 #1 之后既没有再被检查成功,也没有留下欠账记录`);
  const retried = mkCall({ at: 1300, cls: "check", request: checkRequest(line(1, OLD) + line(3, "今天食堂的番茄炒蛋有点咸")) });
  assert.equal(failedCheckRecovered({ ...base, calls: [failed, retried] }).verdict, "pass");
  assert.equal(failedCheckRecovered(base).verdict, "n/a");
});

test("K5 留下欠账记录也算守住,两者都没有才未守住", () => {
  const failed = mkCall({ at: 1020, cls: "check", outcome: "http_400" as never, status: 400, request: checkRequest(line(1, OLD)) });
  const base = mkRecord();
  const debt = { A: { counts: { failed: 1 }, refs: [{ roomId: "dm-1", seq: 1, state: "failed" }] } };
  assert.equal(failedCheckRecovered({ ...base, calls: [failed], hostDebt: debt }).verdict, "pass");
  assert.equal(failedCheckRecovered({ ...base, calls: [failed], hostDebt: { A: { counts: { failed: 1 }, refs: [{ roomId: "dm-1", seq: 9, state: "failed" }] } } }).verdict, "fail");
  assert.equal(failedCheckRecovered({ ...base, calls: [failed], hostDebt: null }).verdict, "fail");
  assert.equal(failedCheckRecovered({ ...base, calls: [failed], hostDebt: debt }).violations.length, 0);
});

test("K1 的违例写明原文落在哪一块,便于定位", () => {
  const item = mkItem({ forbidden: [{ text: OLD, contact: "A", afterStep: 0, why: "撤回后不得再进请求" }] });
  const base = mkRecord();
  const inBlock5 = mkCall({ at: 1600, request: roundRequest({ pointers: OLD }) });
  assert.equal(whereInRequest(inBlock5, OLD), "第 5 块");
  assert.equal(whereInRequest(mkCall({ at: 1601, request: roundRequest({ fresh: line(1, OLD) }) }), OLD), "第 4 块");
  assert.equal(whereInRequest(mkCall({ at: 1602, cls: "check", request: checkRequest(line(1, OLD)) }), OLD), "检查材料的本轮新输入");
  const r = forbiddenText(item, { ...base, calls: [inBlock5] });
  assert.deepEqual(r.violations, [`调用 ${inBlock5.n}(round,第 5 块):撤回后不得再进请求`]);
});

test("K6 预取标注进了固定前缀即未守住,只在第 5 块守住,没有预取不适用", () => {
  const base = mkRecord();
  assert.equal(prefetchNotInPrefix(base).verdict, "n/a");
  assert.equal(prefetchNotInPrefix({ ...base, calls: [mkCall({ request: roundRequest({ pointers: "〔旧消息(宿主按本轮新消息预取,供参考,不是新要求)〕#1" }) })] }).verdict, "pass");
  assert.equal(prefetchNotInPrefix({ ...base, calls: [mkCall({ system: "固定前缀〔旧消息(宿主按本轮新消息预取,供参考,不是新要求)〕" })] }).verdict, "fail");
});

test("K7 用量为负或判定不在枚举内即记账不完整", () => {
  const base = mkRecord();
  assert.equal(accounting(base).verdict, "pass");
  const bad = accounting({ ...base, calls: [mkCall({ usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } })] });
  assert.equal(bad.verdict, "fail");
  assert.match(bad.violations[0]!, /的用量或耗时不是非负数$/);
  assert.equal(accounting({ ...base, status: "weird" as never }).verdict, "fail");
});

test("一份记录给出七条合同,汇总时任一运行未守住即未守住,违例带运行号且有上限", () => {
  const base = mkRecord();
  const ok = checkRecord(mkItem(), base);
  assert.deepEqual(ok.map((c) => `${c.id}:${c.verdict}`), ["K1:n/a", "K2:pass", "K3:pass", "K4:n/a", "K5:n/a", "K6:n/a", "K7:pass"]);
  const bad = checkRecord(mkItem(), { ...base, calls: [...base.calls, mkCall({ model: "x" }), mkCall({ model: "y" })] });
  const merged = mergeContracts([{ runId: "r1", results: ok }, { runId: "r2", results: bad }], 1);
  const k3 = merged.find((c) => c.id === "K3")!;
  assert.equal(k3.verdict, "fail");
  assert.deepEqual(k3.violations.length, 2);
  assert.match(k3.violations[0]!, /^r2:调用 \d+\(round\)用了 x,应为 m$/);
  assert.equal(k3.violations[1], "……另有 1 条");
  assert.equal(merged.find((c) => c.id === "K1")!.verdict, "n/a");
  assert.equal(merged.find((c) => c.id === "K2")!.verdict, "pass");
});
