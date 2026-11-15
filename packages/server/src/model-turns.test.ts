// AC-51 宿主侧:模型改了下一轮就跟上。每一次送进 Compute 的输入(私聊、群聊主流、任务话题、退回重试)都带这一轮现场解析的
// {model, effort};同一 Compute 续接,不因换模型另起;切换失败这一轮不算发出、不静默;每轮实际模型追加进尝试账本(⑥)。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ComputeEvent } from "@g-group/adapter-cc-compute";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-turns-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `t${++fileNo}.db`);

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

/** 规则脑子 + 「补充:」开头的消息转给自己在途任务的 Compute(forward)。 */
function forwardingMind(host: () => Host): ContactMind {
  const base = scriptedMind();
  return {
    async round(input, signal) {
      const out = await base.round(input, signal);
      const extra: MindAction[] = [];
      for (const f of input.fresh) {
        if (f.kind !== "message" || f.sender.kind !== "user" || !f.text.startsWith("补充:")) continue;
        const t = host().listTasks({ contactId: input.contact.id }).find((x) => x.state === "T3_Running");
        if (t) extra.push({ kind: "forward", taskId: t.id, text: f.text.slice(3) });
      }
      return { actions: [...out.actions.filter((a) => !(a.kind === "reply" && a.text.startsWith("收到:补充"))), ...extra], stateNote: out.stateNote };
    },
  };
}
const STARTED = (model: string) => ({ kind: "started", sessionId: "s-1", resumed: false, model }) as Omit<ComputeEvent, "computeId">;

/** 全局默认:Compute 继承全局 claude-opus-5-5,effort medium。 */
const seed = (host: Host) => host.updateSettings({ defaultHarness: "claude-code", defaultSpeakingModel: "claude-sonnet-5-5", defaultComputeModel: "claude-opus-5-5", defaultEffort: "medium" });
/** 宿主选项:脑子会把「补充:」转给在途 Compute;made.n 记适配器工厂被调了几次。 */
function hostOptions(compute: ReturnType<typeof scriptedCompute>, made: { n: number }, host: () => Host): ConstructorParameters<typeof Host>[0] {
  return {
    file: file(),
    mind: () => forwardingMind(host),
    compute: () => {
      made.n++;
      return compute.adapter;
    },
    maxDeferMs: 5,
  };
}

test("私聊:联系人改了 Compute 模型,下一次转给 Compute 的输入就带新模型;同一 Compute 续接不另起,适配器实例按 Harness 复用", async () => {
  const compute = scriptedCompute({ script: () => [STARTED("claude-opus-5-5")] });
  const made = { n: 0 };
  const host: Host = new Host(hostOptions(compute, made, () => host));
  seed(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理资料" });
  await settle(host, compute);
  assert.deepEqual(compute.spawned.map((s) => [s.model, s.effort]), [["claude-opus-5-5", "medium"]], "首轮就带生效模型");
  host.updateContact(c.id, { computeModel: { mode: "explicit", model: "deepseek-v4", effort: "high" } });
  host.send({ roomId: dm.id, clientActionId: "u2", text: "补充:再加一节摘要" });
  await settle(host, compute);
  assert.equal(compute.spawned.length, 1, "换模型不另起 Compute");
  assert.deepEqual(compute.turns.map((r) => [r.computeId, r.turn?.model, r.turn?.effort]), [[compute.spawned[0]!.computeId, "deepseek-v4", "high"]]);
  host.send({ roomId: dm.id, clientActionId: "u3", text: "帮我再写一份提纲" });
  await settle(host, compute);
  assert.deepEqual(compute.spawned.map((s) => s.model), ["claude-opus-5-5", "deepseek-v4"], "第二件任务首轮就用新模型");
  assert.equal(made.n, 1, "不按模型另建适配器实例");
  const t = host.listTasks({ contactId: c.id }).find((x) => x.title === "整理资料");
  assert.deepEqual(t?.modelAttempts?.map((a) => [a.reason, a.model]), [["start", "claude-opus-5-5"], ["turn", "deepseek-v4"]]);
  assert.equal(t?.modelSnapshot?.model, "claude-opus-5-5", "启动快照仍是启动时的值");
  assert.deepEqual(t?.producerVendors, ["anthropic", "deepseek"]);
  compute.close();
  await host.close();
});

test("群聊主流、任务话题与退回重试:改了全局默认后,继承它的联系人每种入口的下一次输入都带新模型(埋雷:重试走另一条路径不带模型必红)", async () => {
  const compute = scriptedCompute({ script: (id) => [STARTED("claude-opus-5-5"), { kind: "completed", result: `完成 ${id}` }] });
  const made = { n: 0 };
  const host: Host = new Host(hostOptions(compute, made, () => host));
  seed(host);
  const c = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  const src = host.send({ roomId: g.id, clientActionId: "g1", text: "帮我写周报", mentions: [{ id: c.id, source: "manual" }] });
  await settle(host, compute);
  assert.equal(compute.spawned[0]?.model, "claude-opus-5-5");
  host.updateSettings({ defaultComputeModel: "claude-sonnet-5-5", defaultEffort: "low" });
  // 交付后退回 = 重试这一轮(显式入口 tasks.reject,与用户普通回复「退回」同一条路径)
  const [delivered] = host.listTasks({ contactId: c.id });
  assert.ok(delivered);
  host.taskDecision(delivered.id, "reject", "g2", "数据不对");
  await settle(host, compute);
  assert.deepEqual(compute.turns.map((r) => [r.turn?.model, r.turn?.effort]), [["claude-sonnet-5-5", "low"]]);
  // 任务话题里补充(带 threadRootSeq),同样现场解析
  host.updateSettings({ defaultComputeModel: "deepseek-v4" });
  host.send({ roomId: g.id, clientActionId: "g3", text: "补充:按部门分", threadRootSeq: src.seq, mentions: [{ id: c.id, source: "manual" }] });
  await settle(host, compute);
  assert.deepEqual(compute.turns.map((r) => r.turn?.model), ["claude-sonnet-5-5", "deepseek-v4"]);
  compute.close();
  await host.close();
});

test("只改 effort:下一轮 effort 变、模型不变;模型和 effort 都没改,下一轮照原值带上(由适配器判定无需切换)", async () => {
  const compute = scriptedCompute({ script: () => [STARTED("claude-opus-5-5")] });
  const made = { n: 0 };
  const host: Host = new Host(hostOptions(compute, made, () => host));
  seed(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理资料" });
  await settle(host, compute);
  host.send({ roomId: dm.id, clientActionId: "u2", text: "补充:第一条" });
  await settle(host, compute);
  host.updateContact(c.id, { computeModel: { mode: "inherit", effort: "xhigh" } });
  host.send({ roomId: dm.id, clientActionId: "u3", text: "补充:第二条" });
  await settle(host, compute);
  assert.deepEqual(compute.turns.map((r) => [r.turn?.model, r.turn?.effort]), [["claude-opus-5-5", "medium"], ["claude-opus-5-5", "xhigh"]]);
  compute.close();
  await host.close();
});

test("切换失败不静默:适配器拒绝新模型时这一轮不算发出、账本不追加,联系人拿到两条修复路径;不退回旧模型继续跑", async () => {
  const compute = scriptedCompute({
    script: () => [STARTED("claude-opus-5-5")],
    resumeResult: (_id, _t, turn) => (turn?.model === "no-such-model" ? { ok: false, reason: "harness 拒绝 no-such-model(check_failed)", code: "model-switch-failed", fixes: ["explicit-compatible-model", "change-harness"] } : null),
  });
  const made = { n: 0 };
  const host: Host = new Host(hostOptions(compute, made, () => host));
  seed(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理资料" });
  await settle(host, compute);
  host.updateContact(c.id, { computeModel: { mode: "explicit", model: "no-such-model" } });
  host.send({ roomId: dm.id, clientActionId: "u2", text: "补充:加图表" });
  await settle(host, compute);
  assert.equal(compute.resumed.length, 0, "被拒的这一轮没有发出,也没有改用旧模型重发");
  const [t] = host.listTasks({ contactId: c.id });
  assert.deepEqual(t?.modelAttempts?.map((a) => a.model), ["claude-opus-5-5"], "没跑成的一轮不进账本");
  const said = host.listMessages(dm.id, {}).messages.map((m) => m.text).join("\n");
  assert.match(said, /换模型没成功/);
  assert.match(said, /单独指定一个兼容的模型/);
  assert.match(said, /更换支持该模型的 Harness/);
  assert.ok(t?.recentProgress.some((p) => p.kind === "blocked" && /check_failed/.test(p.summary)), "失败原因记进进度");
  compute.close();
  await host.close();
});

test("续接前同样拦不兼容的生效模型(启动前校验覆盖每一轮)", async () => {
  const compute = scriptedCompute({ script: () => [STARTED("claude-opus-5-5")] });
  const made = { n: 0 };
  const host: Host = new Host(hostOptions(compute, made, () => host));
  seed(host);
  host.updateSettings({ models: [{ id: "claude-opus-5-5", label: "Opus", vendor: "anthropic", harnesses: ["claude-code"] }, { id: "gpt-6-astra", label: "Astra", vendor: "openai", harnesses: ["codex"] }] });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理资料" });
  await settle(host, compute);
  host.updateContact(c.id, { computeModel: { mode: "explicit", model: "gpt-6-astra" }, confirmAffected: true });
  host.send({ roomId: dm.id, clientActionId: "u2", text: "补充:加图表" });
  await settle(host, compute);
  assert.equal(compute.resumed.length, 0);
  assert.match(host.listMessages(dm.id, {}).messages.map((m) => m.text).join("\n"), /claude-code 不支持模型 gpt-6-astra/);
  compute.close();
  await host.close();
});

test("harness 回报这一轮实际用过的模型进账本,累积厂商集合含新旧两家(埋雷:只记启动模型必红)", async () => {
  const compute = scriptedCompute({
    script: () => [STARTED("claude-opus-5-5")],
    resumeScript: () => [{ kind: "completed", result: "好了", model: "claude-opus-5-5", models: ["claude-opus-5-5", "gpt-6-astra"] } as Omit<ComputeEvent, "computeId">],
  });
  const made = { n: 0 };
  const host: Host = new Host(hostOptions(compute, made, () => host));
  seed(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理资料" });
  await settle(host, compute);
  host.send({ roomId: dm.id, clientActionId: "u2", text: "补充:加图表" });
  await settle(host, compute);
  const [t] = host.listTasks({ contactId: c.id });
  assert.deepEqual(t?.modelAttempts?.map((a) => [a.reason, a.model]), [["start", "claude-opus-5-5"], ["turn", "claude-opus-5-5"], ["observed", "gpt-6-astra"]]);
  assert.deepEqual(t?.producerVendors, ["anthropic", "openai"]);
  const task = host.taskDoc(t!.id).value.task;
  assert.ok(task.producerModels.includes("gpt-6-astra"), "审查门禁看到的生产模型集合也含实际用过的模型");
  compute.close();
  await host.close();
});

test("没声明按轮换模型能力的旧适配器:模型变了这一轮拦下并说明,不沿用启动时的旧模型继续跑", async () => {
  const compute = scriptedCompute({ script: () => [STARTED("claude-opus-5-5")], modelAware: false });
  const made = { n: 0 };
  const host: Host = new Host(hostOptions(compute, made, () => host));
  seed(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理资料" });
  await settle(host, compute);
  assert.deepEqual(compute.spawned.map((s) => s.model), [undefined], "旧适配器只收 cwd/handoff,不硬塞 model");
  host.send({ roomId: dm.id, clientActionId: "u2", text: "补充:第一条" });
  await settle(host, compute);
  assert.equal(compute.resumed.length, 1, "模型没变照常续接");
  host.updateContact(c.id, { computeModel: { mode: "explicit", model: "deepseek-v4" } });
  host.send({ roomId: dm.id, clientActionId: "u3", text: "补充:第二条" });
  await settle(host, compute);
  assert.equal(compute.resumed.length, 1, "模型变了不送进旧进程");
  assert.match(host.listMessages(dm.id, {}).messages.map((m) => m.text).join("\n"), /不支持会话内换模型,仍是启动时的 claude-opus-5-5/);
  host.send({ roomId: dm.id, clientActionId: "u4", text: "帮我再写一份提纲" });
  await settle(host, compute);
  assert.equal(made.n, 2, "旧适配器按模型分实例:新模型另建一个,旧实例的进程环境不被拿来跑新模型");
  compute.close();
  await host.close();
});
