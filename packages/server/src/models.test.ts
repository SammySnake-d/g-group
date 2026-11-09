// AC-32 宿主侧:保存配置、改上游、启动 Compute 前三个时机的兼容性校验(禁止静默换模),受影响下游预览,
// 「把 X 批量换成 Y」预览与应用,任务的不可变启动快照与只追加尝试账本;经 @g-group/api-contract 的服务入口校验参数与结果。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-models-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `m${++fileNo}.db`);

const CATALOG = [
  { id: "claude-opus-5-5", label: "Opus", vendor: "anthropic", harnesses: ["claude-code" as const] },
  { id: "claude-sonnet-5-5", label: "Sonnet", vendor: "anthropic", harnesses: ["claude-code" as const] },
  { id: "gpt-6-astra", label: "Astra", vendor: "openai", harnesses: ["codex" as const] },
];

async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if ((!compute || compute.drained()) && !host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 5));
      if (!host.loop.busy()) return;
    }
  }
  throw new Error("宿主没有安静下来");
}
/** 全局默认与能力声明:claude-code 只跑两个 Anthropic 模型,gpt-6-astra 只在 codex 上。 */
const seed = (host: Host) => host.updateSettings({ defaultHarness: "claude-code", defaultSpeakingModel: "claude-sonnet-5-5", defaultComputeModel: "claude-opus-5-5", defaultEffort: "medium", models: CATALOG });
const texts = (host: Host, roomId: string) => host.listMessages(roomId, {}).messages.map((m) => `${m.sender.kind}:${m.text}`);

test("保存时机:把全局 Compute 默认改成 Harness 不支持的模型,未确认时被拒并列出受影响下游,确认后才保存", async () => {
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const service = createService(host);
  seed(host);
  const inh = host.createContact({ name: "继承者" });
  host.createContact({ name: "固定者", computeModel: { mode: "explicit", model: "claude-sonnet-5-5" } });
  const r = await service.handle("settings.update", { defaultComputeModel: "gpt-6-astra" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.code, "conflict");
  assert.equal(r.error.message, "这次改动会让 1 位联系人的 Compute 与所选 Harness 不兼容:继承者(claude-code 不支持 gpt-6-astra)。可以单独指定兼容的模型或更换 Harness;看过预览确认后再保存");
  const detail = r.error.detail as { reason: string; preview: { conflicts: number; affected: { contactId: string; involvement: string; conflict: boolean; fixes: { kind: string }[] }[] } };
  assert.equal(detail.reason, "model-incompatible");
  assert.equal(detail.preview.conflicts, 1);
  assert.deepEqual(detail.preview.affected.map((a) => [a.contactId, a.involvement, a.conflict]), [[inh.id, "downstream", true]], "固定在别的模型上的联系人不受影响");
  assert.deepEqual(detail.preview.affected[0]!.fixes.map((f) => f.kind), ["explicit-compatible-model", "change-harness"]);
  assert.equal(host.settings().defaultComputeModel, "claude-opus-5-5", "被拒时什么都没写");
  const ok = await service.handle("settings.update", { defaultComputeModel: "gpt-6-astra", confirmAffected: true });
  assert.equal(ok.ok, true);
  assert.equal(host.settings().defaultComputeModel, "gpt-6-astra");
  compute.close();
  await host.close();
});

test("保存时机:联系人改 Harness 让自己的 Compute 不兼容,保存被拒并给出两条修复路径;改说话模型影响跟随者同样预检", async () => {
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const service = createService(host);
  seed(host);
  const c = host.createContact({ name: "小克", computeModel: { mode: "follow-speaking" } });
  const r = await service.handle("contacts.update", { contactId: c.id, harness: "codex" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.message, "这次改动会让 1 位联系人的 Compute 与所选 Harness 不兼容:小克(codex 不支持 claude-sonnet-5-5)。可以单独指定兼容的模型或更换 Harness;看过预览确认后再保存");
    const d = r.error.detail as { preview: { affected: { after: { harness: string; model: string }; fixes: { kind: string; candidates: string[] }[] }[] } };
    assert.equal(d.preview.affected[0]!.after.harness, "codex");
    assert.equal(d.preview.affected[0]!.after.model, "claude-sonnet-5-5");
    assert.deepEqual(d.preview.affected[0]!.fixes, [
      { kind: "explicit-compatible-model", candidates: ["gpt-6-astra"] },
      { kind: "change-harness", candidates: ["claude-code"] },
    ]);
  }
  assert.equal(host.contactDoc(c.id).value.harness, "claude-code");
  const s = await service.handle("contacts.update", { contactId: c.id, speakingModel: "gpt-6-astra" });
  assert.equal(s.ok, false, "跟随说话模型的 Compute 会变成 claude-code 不支持的 gpt-6-astra");
  const fine = await service.handle("contacts.update", { contactId: c.id, speakingModel: "claude-opus-5-5", confirmAffected: true });
  assert.equal(fine.ok, true);
  assert.equal(host.contactDoc(c.id).value.speakingModel, "claude-opus-5-5");
  assert.equal("confirmAffected" in host.contactDoc(c.id).value, false, "确认标记不落进联系人档案");
  compute.close();
  await host.close();
});

test("启动前拦截:生效模型与 Harness 不兼容时不启动 Compute,任务失败并说明两条修复路径,联系人照常回话(埋雷:静默退回 Harness 默认模型必红)", async () => {
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const service = createService(host);
  seed(host);
  const rejected = await service.handle("contacts.create", { clientActionId: "c0", name: "小克", computeModel: { mode: "explicit", model: "gpt-6-astra" } });
  assert.equal(rejected.ok, false, "新建联系人同样先预检");
  if (!rejected.ok) assert.equal((rejected.error.detail as { reason: string }).reason, "model-incompatible");
  assert.equal(host.listContacts().length, 0, "被拒时没建出联系人");
  const c = host.createContact({ name: "小克", computeModel: { mode: "explicit", model: "gpt-6-astra" }, confirmAffected: true });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await settle(host, compute);
  assert.equal(compute.spawned.length, 0, "不兼容时一个 Compute 都不起,也不换成 Harness 默认模型起");
  const [task] = host.listTasks({ contactId: c.id });
  assert.equal(task?.state, "T11_Failed");
  const said = texts(host, dm.id).join("\n");
  assert.match(said, /claude-code 不支持模型 gpt-6-astra/);
  assert.match(said, /单独指定一个兼容的模型/);
  assert.match(said, /更换支持该模型的 Harness/);
  host.send({ roomId: dm.id, clientActionId: "u2", text: "你好" });
  await settle(host, compute);
  assert.equal(texts(host, dm.id).at(-1), "contact:收到:你好", "联系人本体照常说话");
  const view = await service.handle("contacts.get", { contactId: c.id });
  assert.equal(view.ok, true);
  if (view.ok) {
    const v = view.value as { computeResolved?: { support: string; resolved: { chain: string[] } } };
    assert.equal(v.computeResolved?.support, "unsupported");
    assert.deepEqual(v.computeResolved?.resolved.chain, ["compute 单独指定 gpt-6-astra"]);
  }
  compute.close();
  await host.close();
});

test("启动快照与尝试账本:启动写入不可变快照;批量把 X 换成 Y 后配置跟着换,在途任务快照和账本不变,固定在其他模型的不动", async () => {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const service = createService(host);
  seed(host);
  const a = host.createContact({ name: "甲", computeModel: { mode: "explicit", model: "claude-sonnet-5-5", effort: "high" } });
  const b = host.createContact({ name: "乙", speakingModel: "claude-opus-5-5", computeModel: { mode: "explicit", model: "claude-opus-5-5" } });
  const dm = host.openDm(a.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理资料" });
  await settle(host, compute);
  assert.equal(compute.spawned.length, 1);
  const before = await service.handle("tasks.list", { contactId: a.id });
  assert.equal(before.ok, true);
  if (!before.ok) return;
  const t0 = (before.value as { tasks: { id: string; modelSnapshot?: unknown; modelAttempts?: { reason: string; model: string }[]; producerVendors?: string[] }[] }).tasks[0]!;
  assert.deepEqual(t0.modelSnapshot, { harness: "claude-code", model: "claude-sonnet-5-5", effort: "high", vendor: "anthropic" });
  assert.deepEqual(t0.modelAttempts?.map((x) => [x.reason, x.model]), [["start", "claude-sonnet-5-5"]]);
  assert.deepEqual(t0.producerVendors, ["anthropic"]);

  const pv = await service.handle("models.batchReplace", { clientActionId: "b1", from: "claude-sonnet-5-5", to: "claude-opus-5-5" });
  assert.equal(pv.ok, true);
  if (!pv.ok) return;
  const preview = pv.value as { applied: boolean; preview: { affected: { contactId: string; involvement: string }[] } };
  assert.equal(preview.applied, false, "不带 apply 只预览");
  assert.ok(preview.preview.affected.some((x) => x.contactId === a.id && x.involvement === "explicit-reference"));
  assert.equal(preview.preview.affected.some((x) => x.contactId === b.id), false);
  assert.equal(host.contactDoc(a.id).value.computeModel.model, "claude-sonnet-5-5", "预览不落盘");

  const ap = await service.handle("models.batchReplace", { clientActionId: "b2", from: "claude-sonnet-5-5", to: "claude-opus-5-5", apply: true });
  assert.equal(ap.ok, true);
  assert.deepEqual(host.contactDoc(a.id).value.computeModel, { mode: "explicit", model: "claude-opus-5-5", effort: "high" });
  assert.deepEqual(host.contactDoc(b.id).value.computeModel, { mode: "explicit", model: "claude-opus-5-5" });
  assert.equal(host.settings().defaultSpeakingModel, "claude-opus-5-5", "全局默认里显式写了 X 的也换");
  const t1 = host.taskView(host.taskDoc(t0.id).value);
  assert.deepEqual(t1.modelSnapshot, t0.modelSnapshot, "在途任务的启动快照不追溯修改");
  assert.deepEqual(t1.modelAttempts, t0.modelAttempts);
  compute.close();
  await host.close();
});

test("models.preview 只预览不落盘,与之后真实保存的结果一致", async () => {
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const service = createService(host);
  seed(host);
  const c = host.createContact({ name: "丙" });
  const r = await service.handle("models.preview", { change: { kind: "defaults", defaultComputeModel: "claude-sonnet-5-5" } });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const p = r.value as { defaultsChanged: string[]; conflicts: number; affected: { contactId: string; after: { model: string } }[] };
  assert.deepEqual(p.defaultsChanged, ["computeModel"]);
  assert.equal(p.conflicts, 0);
  assert.deepEqual(p.affected.map((x) => [x.contactId, x.after.model]), [[c.id, "claude-sonnet-5-5"]]);
  assert.equal(host.settings().defaultComputeModel, "claude-opus-5-5");
  await service.handle("settings.update", { defaultComputeModel: "claude-sonnet-5-5" });
  const v = host.contactView(host.contactDoc(c.id).value);
  assert.equal(v.computeResolved?.resolved.model, "claude-sonnet-5-5");
  assert.deepEqual(v.computeResolved?.resolved.chain, ["compute 继承全局", "全局 Compute 默认 claude-sonnet-5-5"]);
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理资料" });
  await settle(host, compute);
  assert.deepEqual(host.listTasks({ contactId: c.id }).map((t) => t.modelSnapshot?.model), ["claude-sonnet-5-5"], "保存后下一次派活就用新值");
  compute.close();
  await host.close();
});
