import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFix,
  type ContactModels,
  checkCompat,
  checkDefaults,
  checkStall,
  confirmReplace,
  DEFAULTS_KEY,
  findModel,
  gateCompute,
  launchSnapshot,
  type ModelDefaults,
  type ModelInfo,
  type ModelSlot,
  nextTurn,
  planDefaults,
  planReplace,
  resolveCompute,
  resolveSpeaking,
  resolveStall,
  suggestFixes,
  supports,
  taskModels,
  vendorOf,
} from "./models.ts";

// 目录:opus 只能在 claude-code 上跑;gpt-b 只能在 codex 上跑;flash 只能用来说话(没有 Harness 支持它跑 Compute)。
const MODELS: ModelInfo[] = [
  { id: "opus", label: "Opus", vendor: "anthropic", harnesses: ["claude-code"] },
  { id: "sonnet", label: "Sonnet", vendor: "anthropic", harnesses: ["claude-code", "codex"] },
  { id: "gpt-a", label: "GPT A", vendor: "openai", harnesses: ["codex", "claude-code"] },
  { id: "gpt-b", label: "GPT B", vendor: "openai", harnesses: ["codex"] },
  { id: "flash", label: "Flash", vendor: "google", harnesses: [] },
  { id: "stealth", label: "Stealth", vendor: "unknown", harnesses: ["claude-code"] },
];
const D: ModelDefaults = { defaultHarness: "claude-code", defaultSpeakingModel: "sonnet", defaultComputeModel: "sonnet", defaultEffort: "high", models: MODELS };
const ct = (id: string, speakingModel: string, harness: string, computeModel: ModelSlot): ContactModels => ({ id, name: id.toUpperCase(), speakingModel, harness, computeModel });

// 一组联系人:inh 继承全局;fol 跟随说话模型;pin 单独指定 opus;oth 单独指定 gpt-a;cdx 继承全局但在 codex 上
const inh = ct("inh", "gpt-a", "claude-code", { mode: "inherit" });
const fol = ct("fol", "opus", "claude-code", { mode: "follow-speaking", effort: "xhigh" });
const pin = ct("pin", "sonnet", "claude-code", { mode: "explicit", model: "opus", effort: "medium" });
const oth = ct("oth", "opus", "codex", { mode: "explicit", model: "gpt-a" });
const cdx = ct("cdx", "flash", "codex", { mode: "inherit" });
const TEAM = [inh, fol, pin, oth, cdx];

// ---------------------------------------------------------------- 规则 1

test("说话模型:联系人自己配的具体模型,链上只有联系人一层", () => {
  const r = resolveSpeaking(fol);
  assert.equal(r.value, "opus");
  assert.deepEqual(r.chain, [{ layer: "contact", setting: "speakingModel", value: "opus" }]);
});

test("Compute 继承全局:模型和 effort 都从全局默认来,链上先是联系人槽位再是全局;Harness 来自联系人", () => {
  const r = resolveCompute(inh, D);
  assert.equal(r.mode, "inherit");
  assert.equal(r.model.value, "sonnet");
  assert.deepEqual(r.model.chain, [
    { layer: "contact", setting: "computeModel.mode", value: "inherit" },
    { layer: "global", setting: "defaultComputeModel", value: "sonnet" },
  ]);
  assert.equal(r.effort.value, "high");
  assert.deepEqual(r.effort.chain, [
    { layer: "contact", setting: "computeModel.effort", value: "inherit" },
    { layer: "global", setting: "defaultEffort", value: "high" },
  ]);
  assert.deepEqual(r.harness, { value: "claude-code", chain: [{ layer: "contact", setting: "harness", value: "claude-code" }] });
});

test("Compute 跟随说话模型:只跟模型 id,effort 仍按槽位单独设的值", () => {
  const r = resolveCompute(fol, D);
  assert.equal(r.model.value, "opus");
  assert.deepEqual(r.model.chain, [
    { layer: "contact", setting: "computeModel.mode", value: "follow-speaking" },
    { layer: "contact", setting: "speakingModel", value: "opus" },
  ]);
  assert.equal(r.effort.value, "xhigh");
  assert.deepEqual(r.effort.chain, [{ layer: "contact", setting: "computeModel.effort", value: "xhigh" }]);
});

test("Compute 单独指定:模型来自槽位里写的具体模型;没写模型时生效值为空,不偷偷补一个", () => {
  const r = resolveCompute(pin, D);
  assert.equal(r.model.value, "opus");
  assert.deepEqual(r.model.chain, [
    { layer: "contact", setting: "computeModel.mode", value: "explicit" },
    { layer: "contact", setting: "computeModel.model", value: "opus" },
  ]);
  assert.equal(r.effort.value, "medium");
  const empty = resolveCompute(ct("e", "opus", "claude-code", { mode: "explicit" }), D);
  assert.equal(empty.model.value, "");
});

test("单个任务的临时覆盖是最后一层:有覆盖就以任务层为准", () => {
  const r = resolveCompute(inh, D, { model: "gpt-a", effort: "low" });
  assert.deepEqual(r.model, { value: "gpt-a", chain: [{ layer: "task", setting: "model", value: "gpt-a" }] });
  assert.deepEqual(r.effort, { value: "low", chain: [{ layer: "task", setting: "effort", value: "low" }] });
  // 只覆盖 effort 时模型照常按槽位解析
  assert.equal(resolveCompute(fol, D, { effort: "low" }).model.value, "opus");
});

test("改了全局默认,同一个联系人下一次解析就是新值(每轮现场解析,不记旧值,U93)", () => {
  assert.equal(resolveCompute(inh, D).model.value, "sonnet");
  const d2 = { ...D, defaultComputeModel: "gpt-a", defaultEffort: "low" };
  assert.equal(resolveCompute(inh, d2).model.value, "gpt-a");
  assert.equal(resolveCompute(inh, d2).effort.value, "low");
  // 跟随说话模型的联系人改了说话模型,Compute 也跟着变
  assert.equal(resolveCompute({ ...fol, speakingModel: "gpt-a" }, D).model.value, "gpt-a");
});

// ---------------------------------------------------------------- 规则 2

test("兼容:模型声明支持该 Harness 就通过", () => {
  assert.equal(checkCompat("claude-code", "opus", MODELS), null);
  assert.equal(checkCompat("codex", "sonnet", MODELS), null);
  assert.equal(supports("codex", "opus", MODELS), false);
  assert.equal(supports("codex", "ghost", MODELS), false);
  assert.equal(findModel("gpt-b", MODELS)?.vendor, "openai");
  assert.equal(vendorOf("gpt-b", MODELS), "openai");
  assert.equal(vendorOf("ghost", MODELS), "unknown");
});

test("不兼容:给两条修复路径的候选——该 Harness 支持的模型(同厂商在前)和支持该模型的 Harness", () => {
  const m = checkCompat("claude-code", "gpt-b", MODELS);
  assert.deepEqual(m, {
    harness: "claude-code",
    model: "gpt-b",
    reason: "unsupported",
    compatibleModels: ["gpt-a", "opus", "sonnet", "stealth"],
    supportingHarnesses: ["codex"],
  });
});

test("只能说话的模型:没有 Harness 支持它,路径二为空;目录里没有的模型(含空值)记 unknown-model", () => {
  const flash = checkCompat("codex", "flash", MODELS);
  assert.equal(flash?.reason, "unsupported");
  assert.deepEqual(flash?.supportingHarnesses, []);
  assert.deepEqual(flash?.compatibleModels, ["sonnet", "gpt-a", "gpt-b"]);
  const unknown = checkCompat("codex", "ghost", MODELS);
  assert.equal(unknown?.reason, "unknown-model");
  assert.deepEqual(unknown?.supportingHarnesses, []);
  assert.equal(checkCompat("claude-code", "", MODELS)?.reason, "unknown-model");
});

test("三个时机同一个判定:保存、改上游、启动前对同一配置给出相同结论;阻断时生效模型原样返回,不换成别的", () => {
  const bad = ct("bad", "gpt-b", "claude-code", { mode: "follow-speaking" });
  const gates = (["save", "upstream", "launch"] as const).map((m) => gateCompute(m, bad, D));
  assert.deepEqual(gates.map((g) => g.moment), ["save", "upstream", "launch"]);
  for (const g of gates) {
    assert.equal(g.allowed, false);
    assert.equal(g.compute.model.value, "gpt-b");
    assert.equal(g.mismatch?.model, "gpt-b");
    assert.deepEqual(g.mismatch?.supportingHarnesses, ["codex"]);
    // 联系人本体说话照常
    assert.equal(g.speaking.value, "gpt-b");
  }
  assert.deepEqual(gates[0]?.mismatch, gates[2]?.mismatch);
  assert.equal(gateCompute("save", fol, D).allowed, true);
  assert.equal(gateCompute("launch", fol, D).mismatch, null);
});

test("启动前:不兼容就不启动、不出快照;兼容才按生效值写不可变快照(厂商来自目录)", () => {
  const blocked = launchSnapshot(ct("bad", "gpt-b", "claude-code", { mode: "follow-speaking" }), D);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok ? "" : blocked.gate.moment, "launch");
  assert.equal("snapshot" in blocked, false);
  const ok = launchSnapshot(fol, D);
  assert.equal(ok.ok, true);
  const snap = ok.ok ? ok.snapshot : null;
  assert.deepEqual(snap, { harness: "claude-code", model: "opus", effort: "xhigh", vendor: "anthropic" });
  assert.equal(Object.isFrozen(snap), true);
  const stealth = launchSnapshot(ct("s", "stealth", "claude-code", { mode: "follow-speaking" }), D);
  assert.equal(stealth.ok ? stealth.snapshot.vendor : "", "unknown");
  // 任务覆盖也过同一个判定
  assert.equal(launchSnapshot(fol, D, { model: "gpt-b" }).ok, false);
});

test("全局默认组合本身也要成立", () => {
  assert.equal(checkDefaults(D), null);
  assert.deepEqual(checkDefaults({ ...D, defaultHarness: "codex", defaultComputeModel: "opus" })?.supportingHarnesses, ["claude-code"]);
});

test("任务快照:传了快照以快照为准显示实际值、列出配置已改的字段,不改快照;没传就按当前配置", () => {
  const snap = Object.freeze({ harness: "claude-code", model: "opus", effort: "xhigh", vendor: "anthropic" });
  const changed = { ...fol, speakingModel: "gpt-a" };
  const t = taskModels(snap, changed, D);
  assert.equal(t.shown, "snapshot");
  assert.equal(t.actual, snap);
  assert.equal(t.planned.model.value, "gpt-a");
  assert.deepEqual(t.drift, ["model"]);
  assert.deepEqual(snap, { harness: "claude-code", model: "opus", effort: "xhigh", vendor: "anthropic" });
  assert.deepEqual(taskModels(snap, fol, D).drift, []);
  const none = taskModels(null, fol, D);
  assert.equal(none.shown, "config");
  assert.equal(none.actual, null);
  assert.equal(none.planned.model.value, "opus");
});

// ---------------------------------------------------------------- 修复

test("修复:单独指定兼容模型保留原 effort;换 Harness 只改 Harness;id 对不上不生效;不改入参", () => {
  const p = applyFix(fol, { kind: "pin-model", contactId: "fol", model: "sonnet" });
  assert.deepEqual(p.computeModel, { mode: "explicit", model: "sonnet", effort: "xhigh" });
  assert.deepEqual(applyFix(inh, { kind: "pin-model", contactId: "inh", model: "opus" }).computeModel, { mode: "explicit", model: "opus" });
  assert.equal(applyFix(fol, { kind: "switch-harness", contactId: "fol", harness: "codex" }).harness, "codex");
  assert.equal(applyFix(fol, { kind: "switch-harness", contactId: "other", harness: "codex" }), fol);
  assert.deepEqual(fol.computeModel, { mode: "follow-speaking", effort: "xhigh" });
});

test("推荐修复:路径一优先保持原来的模型,否则取第一个兼容候选;没有支持它的 Harness 就只给路径一", () => {
  const m = checkCompat("claude-code", "gpt-b", MODELS);
  assert.ok(m);
  assert.deepEqual(suggestFixes("x", m, "sonnet"), [
    { kind: "pin-model", contactId: "x", model: "sonnet" },
    { kind: "switch-harness", contactId: "x", harness: "codex" },
  ]);
  assert.deepEqual(suggestFixes("x", m)[0], { kind: "pin-model", contactId: "x", model: "gpt-a" });
  const f = checkCompat("codex", "flash", MODELS);
  assert.ok(f);
  assert.deepEqual(suggestFixes("y", f, "sonnet"), [{ kind: "pin-model", contactId: "y", model: "sonnet" }]);
});

// ---------------------------------------------------------------- 改全局默认

test("改全局默认 Compute 模型:列出继承全局的联系人和其中会变成不兼容的,失配时不能保存", () => {
  const after = { ...D, defaultComputeModel: "opus" };
  const plan = planDefaults(TEAM, D, after);
  assert.deepEqual(plan.affected.map((a) => a.contactId), ["inh", "cdx"]);
  assert.deepEqual(plan.affected[0]?.changed, ["model"]);
  assert.equal(plan.affected[0]?.before.model.value, "sonnet");
  assert.equal(plan.affected[0]?.after.model.value, "opus");
  assert.deepEqual(plan.mismatched.map((a) => a.contactId), ["cdx"]);
  assert.deepEqual(plan.mismatched[0]?.fixes, [
    { kind: "pin-model", contactId: "cdx", model: "sonnet" },
    { kind: "switch-harness", contactId: "cdx", harness: "claude-code" },
  ]);
  assert.equal(plan.defaultsMismatch, null);
  assert.equal(plan.canSave, false);
});

test("点了修复以后重新预检:单独指定原模型的那位不再受影响,可以保存,并带回要一起写的联系人配置", () => {
  const after = { ...D, defaultComputeModel: "opus" };
  const plan = planDefaults(TEAM, D, after, [{ kind: "pin-model", contactId: "cdx", model: "sonnet" }]);
  assert.deepEqual(plan.affected.map((a) => a.contactId), ["inh"]);
  assert.equal(plan.mismatched.length, 0);
  assert.equal(plan.canSave, true);
  assert.deepEqual(plan.patched.map((c) => [c.id, c.computeModel]), [["cdx", { mode: "explicit", model: "sonnet" }]]);
  // 换 Harness 的修复:模型和 Harness 都变,但兼容
  const viaHarness = planDefaults(TEAM, D, after, [{ kind: "switch-harness", contactId: "cdx", harness: "claude-code" }]);
  assert.deepEqual(viaHarness.affected.find((a) => a.contactId === "cdx")?.changed, ["harness", "model"]);
  assert.equal(viaHarness.canSave, true);
});

test("全局默认组合不成立也不能保存;默认 Harness、默认说话模型只影响之后新建的联系人;effort 只影响没单独设的", () => {
  const bad = planDefaults(TEAM, D, { ...D, defaultHarness: "codex", defaultComputeModel: "opus" });
  assert.equal(bad.defaultsMismatch?.model, "opus");
  assert.equal(bad.canSave, false);
  const onlyNew = planDefaults(TEAM, D, { ...D, defaultHarness: "codex", defaultSpeakingModel: "gpt-a" });
  assert.deepEqual(onlyNew.newContactsOnly, ["defaultHarness", "defaultSpeakingModel"]);
  assert.equal(onlyNew.affected.length, 0);
  assert.equal(onlyNew.canSave, true);
  const effort = planDefaults(TEAM, D, { ...D, defaultEffort: "low" });
  assert.deepEqual(effort.affected.map((a) => [a.contactId, a.changed]), [["inh", ["effort"]], ["oth", ["effort"]], ["cdx", ["effort"]]]);
  assert.equal(planDefaults(TEAM, D, D).affected.length, 0);
});

// ---------------------------------------------------------------- U93

test("下一轮生效提示:生效值没变不提示;改说话模型会带动跟随它的 Compute;换 Harness 单独标出;记下不被打断的在途轮次", () => {
  assert.equal(nextTurn(fol, { ...fol }, D, 1), null);
  const talk = nextTurn(fol, { ...fol, speakingModel: "sonnet" }, D, 2);
  assert.deepEqual(talk, { speaking: true, compute: ["model"], harnessSwitch: false, running: 2 });
  const h = nextTurn(inh, { ...inh, harness: "codex" }, D, 0);
  assert.deepEqual(h, { speaking: false, compute: ["harness"], harnessSwitch: true, running: 0 });
  assert.equal(nextTurn(inh, { ...inh, computeModel: { mode: "inherit", effort: "low" } }, D, -3)?.running, 0);
});

// ---------------------------------------------------------------- 规则 6

const tasks = [{ id: "t1", model: "opus" }, { id: "t2", model: "sonnet" }];

test("批量替换预览:显式引用、下游继承者、固定在别的模型上的、在途任务分开列;兼容冲突没处理前不能确认", () => {
  const plan = planReplace({ contacts: TEAM, defaults: D, from: "opus", to: "gpt-b", tasks });
  assert.equal(plan.problem, null);
  assert.deepEqual(plan.explicit, [
    { contactId: "fol", field: "speakingModel" },
    { contactId: "pin", field: "computeModel.model" },
    { contactId: "oth", field: "speakingModel" },
  ]);
  assert.deepEqual(plan.inheritors, [{ contactId: "fol", via: "follow-speaking" }]);
  assert.deepEqual(plan.conflicts.map((c) => [c.contactId, c.mismatch.harness, c.mismatch.model]), [["fol", "claude-code", "gpt-b"], ["pin", "claude-code", "gpt-b"]]);
  assert.deepEqual(plan.conflicts[0]?.fixes, [
    { kind: "pin-model", contactId: "fol", model: "opus" },
    { kind: "switch-harness", contactId: "fol", harness: "codex" },
  ]);
  assert.deepEqual(plan.pinnedElsewhere, ["oth"]);
  assert.deepEqual(plan.inFlight, ["t1"]);
  assert.equal(plan.canConfirm, false);
  const no = confirmReplace({ contacts: TEAM, defaults: D, from: "opus", to: "gpt-b", tasks });
  assert.equal(no.ok, false);
  assert.equal(no.ok ? "" : no.reason, "还有 2 处兼容冲突没处理");
});

test("批量替换:按用户选择处理冲突后才能确认,确认才给变更列表;固定在别的模型上的不动,在途任务和历史不改", () => {
  const before = JSON.parse(JSON.stringify({ TEAM, tasks }));
  const input = { contacts: TEAM, defaults: D, from: "opus", to: "gpt-b", tasks, resolutions: { fol: { kind: "harness", harness: "codex" }, pin: { kind: "keep", model: "opus" } } as const };
  const plan = planReplace(input);
  assert.deepEqual(plan.resolved, ["fol", "pin"]);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.canConfirm, true);
  const r = confirmReplace(input);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok ? r.changes : [], [
    { contactId: "fol", field: "speakingModel", from: "opus", to: "gpt-b" },
    { contactId: "fol", field: "harness", from: "claude-code", to: "codex" },
    { contactId: "oth", field: "speakingModel", from: "opus", to: "gpt-b" },
  ]);
  // 入参(联系人、在途任务)一个字段都没被改
  assert.deepEqual(JSON.parse(JSON.stringify({ TEAM, tasks })), before);
});

test("批量替换没有冲突时直接可确认;继承全局的联系人随全局默认一起变,不单独出变更", () => {
  const input = { contacts: TEAM, defaults: D, from: "sonnet", to: "gpt-a" };
  const plan = planReplace(input);
  assert.deepEqual(plan.explicit, [
    { contactId: null, field: "defaultSpeakingModel" },
    { contactId: null, field: "defaultComputeModel" },
    { contactId: "pin", field: "speakingModel" },
  ]);
  assert.deepEqual(plan.inheritors, [{ contactId: "inh", via: "inherit" }, { contactId: "cdx", via: "inherit" }]);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.canConfirm, true);
  const r = confirmReplace(input);
  assert.deepEqual(r.ok ? r.changes : [], [
    { contactId: null, field: "defaultSpeakingModel", from: "sonnet", to: "gpt-a" },
    { contactId: null, field: "defaultComputeModel", from: "sonnet", to: "gpt-a" },
    { contactId: "pin", field: "speakingModel", from: "sonnet", to: "gpt-a" },
  ]);
});

test("批量替换碰到全局默认组合冲突:单独列出,可换默认 Harness 解决;继承者跟着判", () => {
  const d = { ...D, defaultComputeModel: "opus" };
  const team = [ct("a", "sonnet", "claude-code", { mode: "inherit" })];
  const plan = planReplace({ contacts: team, defaults: d, from: "opus", to: "gpt-b" });
  assert.deepEqual(plan.conflicts.map((c) => c.contactId), [null, "a"]);
  assert.deepEqual(plan.conflicts[0]?.fixes, [
    { kind: "pin-model", contactId: DEFAULTS_KEY, model: "opus" },
    { kind: "switch-harness", contactId: DEFAULTS_KEY, harness: "codex" },
  ]);
  const input = { contacts: team, defaults: d, from: "opus", to: "gpt-b", resolutions: { [DEFAULTS_KEY]: { kind: "harness", harness: "codex" }, a: { kind: "harness", harness: "codex" } } as const };
  assert.deepEqual(planReplace(input).resolved, [DEFAULTS_KEY, "a"]);
  const r = confirmReplace(input);
  assert.deepEqual(r.ok ? r.changes : [], [
    { contactId: null, field: "defaultHarness", from: "claude-code", to: "codex" },
    { contactId: null, field: "defaultComputeModel", from: "opus", to: "gpt-b" },
    { contactId: "a", field: "harness", from: "claude-code", to: "codex" },
  ]);
  // 选了一个仍不兼容的处理方式,冲突还在
  assert.equal(planReplace({ ...input, resolutions: { [DEFAULTS_KEY]: { kind: "keep", model: "gpt-b" } } }).conflicts[0]?.contactId, null);
});

test("批量替换的输入本身不成立:目标不在目录里、前后是同一个、没有地方直接用了 X,都不能确认", () => {
  const ghost = planReplace({ contacts: TEAM, defaults: D, from: "opus", to: "ghost" });
  assert.equal(ghost.problem, "模型目录里没有 ghost");
  assert.deepEqual(ghost.conflicts.map((c) => [c.contactId, c.mismatch.reason]), [["fol", "unknown-model"], ["pin", "unknown-model"]]);
  assert.equal(ghost.canConfirm, false);
  assert.equal(planReplace({ contacts: TEAM, defaults: D, from: "opus", to: "opus" }).canConfirm, false);
  const none = confirmReplace({ contacts: TEAM, defaults: D, from: "stealth", to: "sonnet" });
  assert.equal(none.ok ? "" : none.reason, "没有地方直接用了 stealth");
});

// ---------------------------------------------------------------- U92

test("卡死阈值:默认一轮 15 分钟无进展、首字节 120 秒;按联系人单独设的覆盖默认并标出来源", () => {
  assert.deepEqual(resolveStall(), { turnMinutes: { value: 15, source: "default" }, firstByteSeconds: { value: 120, source: "default" } });
  assert.deepEqual(resolveStall({ turnMinutes: 30 }), { turnMinutes: { value: 30, source: "contact" }, firstByteSeconds: { value: 120, source: "default" } });
  assert.equal(resolveStall({ firstByteSeconds: 60 }).firstByteSeconds.source, "contact");
});

test("卡死阈值校验:正整数、整轮不超过一天、首字节窗口短于整轮阈值", () => {
  assert.equal(checkStall({}), null);
  assert.equal(checkStall({ turnMinutes: 0 }), "整轮无进展的阈值要是正整数分钟");
  assert.equal(checkStall({ turnMinutes: 2.5 }), "整轮无进展的阈值要是正整数分钟");
  assert.equal(checkStall({ turnMinutes: 1441 }), "整轮无进展的阈值不能超过 1440 分钟(一天)");
  assert.equal(checkStall({ firstByteSeconds: 0 }), "等首字节的时间要是正整数秒");
  assert.equal(checkStall({ turnMinutes: 2, firstByteSeconds: 120 }), "等首字节的时间要短于整轮阈值(2 分钟 = 120 秒)");
  assert.equal(checkStall({ turnMinutes: 2, firstByteSeconds: 119 }), null);
});
