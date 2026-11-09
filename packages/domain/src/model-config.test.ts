// AC-32 ①②③ 与规则 6:Compute 模型三态继承、三时机兼容性判定(禁止静默换模)、受影响下游预览、批量替换、压缩同模。
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCompressionCall, checkCompute, compressionModel, type ContactModels, type ModelCapability, type ModelDefaults, previewChange, resolveCompute, supportOf } from "./model-config.ts";

const defaults: ModelDefaults = { harness: "claude-code", speakingModel: "claude-sonnet-5-5", computeModel: "claude-opus-5-5", effort: "medium" };
const caps: ModelCapability[] = [
  { id: "claude-opus-5-5", harnesses: ["claude-code"] },
  { id: "claude-sonnet-5-5", harnesses: ["claude-code"] },
  { id: "gpt-6-astra", harnesses: ["codex"] },
  { id: "deepseek-v4", harnesses: ["claude-code", "codex"] },
];
const contact = (id: string, over: Partial<ContactModels> = {}): ContactModels => ({ id, name: id, speakingModel: "claude-sonnet-5-5", harness: "claude-code", computeModel: { mode: "inherit" }, ...over });

test("新建联系人默认继承全局 Compute 默认,解析链写明来源,effort 用全局默认", () => {
  const r = resolveCompute(defaults, contact("a"));
  assert.equal(r.model, "claude-opus-5-5");
  assert.equal(r.modelSource, "global");
  assert.equal(r.effort, "medium");
  assert.equal(r.effortSource, "global");
  assert.equal(r.vendor, "anthropic");
  assert.equal(r.harness, "claude-code");
  assert.deepEqual(r.chain, ["compute 继承全局", "全局 Compute 默认 claude-opus-5-5"]);
});

test("跟随说话模型只跟模型 id,effort 仍按 Compute 槽位单独指定;单独指定与任务覆盖依次优先", () => {
  const follow = resolveCompute(defaults, contact("b", { speakingModel: "deepseek-v4", computeModel: { mode: "follow-speaking", effort: "xhigh" } }));
  assert.equal(follow.model, "deepseek-v4");
  assert.equal(follow.modelSource, "follow-speaking");
  assert.equal(follow.effort, "xhigh");
  assert.equal(follow.effortSource, "compute-slot");
  assert.deepEqual(follow.chain, ["compute 跟随说话模型", "说话模型 deepseek-v4"]);
  const explicit = resolveCompute(defaults, contact("c", { computeModel: { mode: "explicit", model: "gpt-6-astra" } }));
  assert.equal(explicit.model, "gpt-6-astra");
  assert.equal(explicit.modelSource, "explicit");
  assert.equal(explicit.vendor, "openai");
  const task = resolveCompute(defaults, contact("c", { computeModel: { mode: "explicit", model: "gpt-6-astra", effort: "low" } }), { model: "deepseek-v4", effort: "max" });
  assert.deepEqual([task.model, task.modelSource, task.effort, task.effortSource], ["deepseek-v4", "task", "max", "task"]);
});

test("继承链每次现场解析:改了全局默认,下一次解析就是新值,不沿用旧值", () => {
  const c = contact("a");
  assert.equal(resolveCompute(defaults, c).model, "claude-opus-5-5");
  assert.equal(resolveCompute({ ...defaults, computeModel: "deepseek-v4", effort: "high" }, c).model, "deepseek-v4");
  assert.equal(resolveCompute({ ...defaults, computeModel: "deepseek-v4", effort: "high" }, c).effort, "high");
});

test("声明不兼容即拦,给出两条修复路径;生效模型保持原值,绝不退回 Harness 默认模型(埋雷:静默回退必红)", () => {
  const r = resolveCompute(defaults, contact("x", { computeModel: { mode: "explicit", model: "gpt-6-astra" } }));
  const c = checkCompute(caps, r);
  assert.equal(c.ok, false);
  if (c.ok) return;
  assert.equal(c.code, "model-incompatible");
  assert.equal(c.resolved.model, "gpt-6-astra", "拦截时仍报所选模型,不换成 claude-code 的默认模型");
  assert.deepEqual(c.fixes, [
    { kind: "explicit-compatible-model", candidates: ["claude-opus-5-5", "claude-sonnet-5-5", "deepseek-v4"] },
    { kind: "change-harness", candidates: ["codex"] },
  ]);
  assert.equal(c.reason, "Harness claude-code 不支持模型 gpt-6-astra(compute 单独指定 gpt-6-astra),本次不启动 Compute;可以单独指定一个兼容的模型,或更换支持该模型的 Harness");
});

test("能力声明里没有的模型记 undeclared:不拦,也不替换模型;声明支持的记 supported", () => {
  assert.equal(supportOf(caps, "claude-code", "kimi-k3"), "undeclared");
  assert.equal(supportOf(caps, "codex", "deepseek-v4"), "supported");
  assert.equal(supportOf(caps, "codex", "claude-opus-5-5"), "unsupported");
  const r = resolveCompute(defaults, contact("k", { computeModel: { mode: "explicit", model: "kimi-k3" } }));
  const c = checkCompute(caps, r);
  assert.equal(c.ok, true);
  if (c.ok) {
    assert.equal(c.support, "undeclared");
    assert.equal(c.resolved.model, "kimi-k3");
  }
});

test("改全局 Compute 默认:列出所有继承它的下游联系人与冲突,单独指定和跟随说话模型的不受影响", () => {
  const cs = [contact("inh1"), contact("inh2", { harness: "codex" }), contact("fol", { computeModel: { mode: "follow-speaking" } }), contact("pin", { computeModel: { mode: "explicit", model: "deepseek-v4" } })];
  const out = previewChange(defaults, cs, caps, { kind: "defaults", patch: { computeModel: "gpt-6-astra" } });
  assert.deepEqual(out.preview.defaultsChanged, ["computeModel"]);
  assert.deepEqual(out.preview.affected.map((a) => [a.contactId, a.involvement, a.changed.join(","), a.after.model, a.support, a.conflict]), [
    ["inh1", "downstream", "compute-model", "gpt-6-astra", "unsupported", true],
    ["inh2", "downstream", "compute-model", "gpt-6-astra", "supported", false],
  ]);
  assert.deepEqual(out.preview.conflicts.map((a) => a.contactId), ["inh1"]);
  assert.equal(out.preview.conflicts[0]!.fixes[1]!.kind, "change-harness");
  assert.equal(out.defaults.computeModel, "gpt-6-astra");
  assert.equal(defaults.computeModel, "claude-opus-5-5", "预览不改入参");
});

test("改联系人说话模型:跟随说话模型的 Compute 跟着变并报冲突;改 Harness 同样预检", () => {
  const cs = [contact("fol", { computeModel: { mode: "follow-speaking" } }), contact("other")];
  const out = previewChange(defaults, cs, caps, { kind: "contact", contactId: "fol", patch: { speakingModel: "gpt-6-astra" } });
  assert.deepEqual(out.preview.affected.map((a) => [a.contactId, a.involvement, a.changed.join(","), a.after.model, a.conflict]), [["fol", "explicit-reference", "speaking-model,compute-model", "gpt-6-astra", true]]);
  const h = previewChange(defaults, cs, caps, { kind: "contact", contactId: "other", patch: { harness: "codex" } });
  assert.deepEqual(h.preview.conflicts.map((a) => [a.contactId, a.after.harness, a.after.model]), [["other", "codex", "claude-opus-5-5"]]);
  assert.equal(h.contacts.find((c) => c.id === "other")!.harness, "codex");
  assert.equal(cs[1]!.harness, "claude-code");
});

test("批量把 X 换成 Y:预览列出显式引用与下游继承者,固定在其他模型上的覆盖值不被误改", () => {
  const d = { ...defaults, computeModel: "claude-sonnet-5-5" };
  const cs = [
    contact("speaksX"),
    contact("pinX", { speakingModel: "deepseek-v4", computeModel: { mode: "explicit", model: "claude-sonnet-5-5", effort: "high" } }),
    contact("inherits", { speakingModel: "deepseek-v4" }),
    contact("pinOther", { speakingModel: "deepseek-v4", computeModel: { mode: "explicit", model: "claude-opus-5-5" } }),
  ];
  const out = previewChange(d, cs, caps, { kind: "batch-replace", from: "claude-sonnet-5-5", to: "claude-opus-5-5" });
  assert.deepEqual(out.preview.defaultsChanged, ["speakingModel", "computeModel"]);
  assert.deepEqual(out.preview.affected.map((a) => [a.contactId, a.involvement, a.changed.join(",")]), [
    ["speaksX", "explicit-reference", "speaking-model,compute-model"],
    ["pinX", "explicit-reference", "compute-model"],
    ["inherits", "downstream", "compute-model"],
  ]);
  const byId = Object.fromEntries(out.contacts.map((c) => [c.id, c]));
  assert.equal(byId.speaksX!.speakingModel, "claude-opus-5-5");
  assert.deepEqual(byId.pinX!.computeModel, { mode: "explicit", model: "claude-opus-5-5", effort: "high" });
  assert.deepEqual(byId.inherits!.computeModel, { mode: "inherit" }, "继承者只存继承标记,不被写成具体模型");
  assert.deepEqual(byId.pinOther!.computeModel, { mode: "explicit", model: "claude-opus-5-5" });
  assert.equal(out.defaults.computeModel, "claude-opus-5-5");
  assert.equal(cs[1]!.computeModel.model, "claude-sonnet-5-5", "预览不改入参");
});

test("压缩复用该联系人的说话模型;要求换成别的模型(含失败后改用其他厂商)一律拒绝", () => {
  const c = contact("z", { speakingModel: "deepseek-v4" });
  assert.deepEqual(compressionModel(c), { model: "deepseek-v4", vendor: "deepseek" });
  assert.deepEqual(checkCompressionCall(c, "deepseek-v4"), { ok: true });
  const bad = checkCompressionCall(c, "claude-opus-5-5");
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.code, "compression-model-mismatch");
    assert.match(bad.reason, /说话模型 deepseek-v4/);
  }
});
