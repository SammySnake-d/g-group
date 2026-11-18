import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

import { codexCompute } from "./compute.ts";

test("AC-51 ⑦ server can create the Codex harness adapter for a turn-boundary handoff", () => {
  const factory = codexCompute({});
  assert.doesNotThrow(() => factory("gpt-6-astra"));
});
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
      return { actions: [...out.actions.filter((a) => a.kind !== "deliver" && !(a.kind === "reply" && a.text.startsWith("收到:补充"))), ...extra], stateNote: out.stateNote };
    },
  };
}
test("AC-51 ⑦ claude-code -> codex: boundary handoff retains task, workspace and append-only provenance; missing harness blocks before stop", async () => {
    const source = "claude-code" as const;
    const destination = "codex" as const;
    const before = scriptedCompute({ idPrefix: "old", script: () => [{ kind: "started", sessionId: "old-session", resumed: false }, { kind: "completed", result: "handoff milestone" }] });
    const next = scriptedCompute({ idPrefix: "new", script: () => [{ kind: "started", sessionId: "new-session", resumed: false }] });
    const cwd = dir;
    const host: Host = new Host({ file: file(), mind: () => forwardingMind(() => host), compute: { [source]: () => before.adapter, [destination]: () => next.adapter }, computeCwd: () => cwd, maxDeferMs: 5 });
    try {
      host.updateSettings({ defaultHarness: source, defaultComputeModel: "shared-model", models: [{ id: "shared-model", label: "shared", vendor: String(source) === "codex" ? "openai" : "anthropic", harnesses: ["claude-code", "codex"] }] });
      const c = host.createContact({ name: "handoff" }); const dm = host.openDm(c.id);
      host.send({ roomId: dm.id, clientActionId: "begin", text: "帮我整理资料" });
      await settle(host, before);
      const original = host.listTasks({ contactId: c.id })[0]!;
      host.updateContact(c.id, { harness: destination });
      assert.equal(before.stopped.length, 0, "changing config does not interrupt an in-flight turn");
      host.send({ roomId: dm.id, clientActionId: "next", text: "补充:continue in same workspace" });
      await settle(host, next);
      assert.equal(next.spawned.length, 1, "new harness starts a fresh native session");
      assert.equal(before.stopped.length, 1, "old execution is stopped before replacing the session");
      assert.equal(next.spawned[0]!.cwd, before.spawned[0]!.cwd);
      const current = host.listTasks({ contactId: c.id })[0]!;
      assert.equal(current.id, original.id);
      assert.notEqual(host.taskDoc(current.id).value.task.computeId, before.spawned[0]!.computeId);
      assert.deepEqual(current.modelAttempts?.map(a => a.harness), [source, destination]);
      assert.equal(current.modelSnapshot?.harness, source);
      assert.match(JSON.stringify(next.spawned[0]!.brief), /handoff milestone|整理资料/);
      // Once both sides exist, an incompatible model must not stop the running successor.
      host.updateSettings({ models: [{ id: "shared-model", label: "shared", vendor: "openai", harnesses: [destination] }], confirmAffected: true });
      host.updateContact(c.id, { harness: source, confirmAffected: true });
      host.send({ roomId: dm.id, clientActionId: "bad-next", text: "补充:must be refused" });
      await settle(host);
      assert.equal(before.spawned.length, 1);
      assert.equal(next.stopped.length, 0, "refused destination never tears down the current harness");
    } finally { before.close(); next.close(); await host.close(); }
});
test("AC-51 ⑦ codex -> claude-code: boundary handoff retains task, workspace and append-only provenance; missing harness blocks before stop", async () => {
    const source = "codex" as const;
    const destination = "claude-code" as const;
    const before = scriptedCompute({ idPrefix: "old", script: () => [{ kind: "started", sessionId: "old-session", resumed: false }, { kind: "completed", result: "handoff milestone" }] });
    const next = scriptedCompute({ idPrefix: "new", script: () => [{ kind: "started", sessionId: "new-session", resumed: false }] });
    const cwd = dir;
    const host: Host = new Host({ file: file(), mind: () => forwardingMind(() => host), compute: { [source]: () => before.adapter, [destination]: () => next.adapter }, computeCwd: () => cwd, maxDeferMs: 5 });
    try {
      host.updateSettings({ defaultHarness: source, defaultComputeModel: "shared-model", models: [{ id: "shared-model", label: "shared", vendor: String(source) === "codex" ? "openai" : "anthropic", harnesses: ["claude-code", "codex"] }] });
      const c = host.createContact({ name: "handoff" }); const dm = host.openDm(c.id);
      host.send({ roomId: dm.id, clientActionId: "begin", text: "帮我整理资料" });
      await settle(host, before);
      const original = host.listTasks({ contactId: c.id })[0]!;
      host.updateContact(c.id, { harness: destination });
      assert.equal(before.stopped.length, 0, "changing config does not interrupt an in-flight turn");
      host.send({ roomId: dm.id, clientActionId: "next", text: "补充:continue in same workspace" });
      await settle(host, next);
      assert.equal(next.spawned.length, 1, "new harness starts a fresh native session");
      assert.equal(before.stopped.length, 1, "old execution is stopped before replacing the session");
      assert.equal(next.spawned[0]!.cwd, before.spawned[0]!.cwd);
      const current = host.listTasks({ contactId: c.id })[0]!;
      assert.equal(current.id, original.id);
      assert.notEqual(host.taskDoc(current.id).value.task.computeId, before.spawned[0]!.computeId);
      assert.deepEqual(current.modelAttempts?.map(a => a.harness), [source, destination]);
      assert.equal(current.modelSnapshot?.harness, source);
      assert.match(JSON.stringify(next.spawned[0]!.brief), /handoff milestone|整理资料/);
      // Once both sides exist, an incompatible model must not stop the running successor.
      host.updateSettings({ models: [{ id: "shared-model", label: "shared", vendor: "openai", harnesses: [destination] }], confirmAffected: true });
      host.updateContact(c.id, { harness: source, confirmAffected: true });
      host.send({ roomId: dm.id, clientActionId: "bad-next", text: "补充:must be refused" });
      await settle(host);
      assert.equal(before.spawned.length, 1);
      assert.equal(next.stopped.length, 0, "refused destination never tears down the current harness");
    } finally { before.close(); next.close(); await host.close(); }
});


async function failedHandoff(
  t: import("node:test").TestContext,
  HostClass: typeof Host,
  opts: { missing?: boolean; quiesceFails?: boolean; throws?: boolean } = {},
) {
  const source = scriptedCompute({
    idPrefix: "source",
    script: (id) => [
      { kind: "started", sessionId: id, resumed: false },
      { kind: "completed", result: "source turn completed" },
    ],
    quiesce: async () => opts.quiesceFails
      ? { ok: false, reason: "still alive", remaining: [999] }
      : { ok: true, killed: 0 },
  });
  const sourceAdapter = {
    ...source.adapter,
    snapshot: () => ({ ok: true as const, snapshot: { constraintVer: 0, openQuestions: [], doneSideEffects: ["source milestone"] } }),
  };
  const destination = scriptedCompute({ idPrefix: "destination" });
  let attempts = 0;
  const host: Host = new HostClass({
    file: file(),
    mind: () => forwardingMind(() => host),
    compute: {
      "claude-code": () => sourceAdapter,
      ...(opts.missing ? {} : {
        codex: () => ({
          ...destination.adapter,
          async spawn() {
            attempts++;
            if (opts.throws) throw new Error("whitelist");
            return { ok: false as const, reason: "whitelist" };
          },
        }),
      }),
    },
    computeCwd: () => dir,
    maxDeferMs: 5,
  });
  t.after(async () => { source.close(); destination.close(); await host.close(); });
  host.updateSettings({
    defaultHarness: "claude-code", defaultComputeModel: "shared-model",
    models: [{ id: "shared-model", label: "shared", vendor: "anthropic", harnesses: ["claude-code", "codex"] }],
  });
  const c = host.createContact({ name: "handoff" });
  const dm = host.openDm(c.id);
  const send = (clientActionId: string, text: string) => host.send({ roomId: dm.id, clientActionId, text });
  send("begin", "帮我整理资料");
  await settle(host, source);
  const task = host.listTasks({ contactId: c.id })[0]!;
  const old = source.spawned[0]!.computeId;
  assert.equal(host.quota.leaseOf(task.id), undefined, "original turn settled");
  host.updateContact(c.id, { harness: "codex", confirmAffected: true });
  send("handoff", "补充:try Codex");
  await settle(host, source);
  return { host, source, c, task, old, send, attempts: () => attempts };
}

test("AC-51 ⑦ reports an unregistered destination before stopping the source", async (t) => {
  const { host, task, old, source } = await failedHandoff(t, Host, { missing: true });
  assert.ok(host.progress(task.id).some((p) => p.computeId === old && p.kind === "blocked" && /还没有接入它的适配器.*修复路径/.test(p.summary)));
  assert.deepEqual(source.stopped, []);
  assert.equal(host.taskDoc(task.id).value.task.computeId, old);
});

test("AC-51 ⑦ quarantines an unconfirmed stop and retains the lease without spawning", async (t) => {
  const { host, task, old, source, attempts } = await failedHandoff(t, Host, { quiesceFails: true });
  assert.deepEqual(source.stopped, [old]);
  assert.equal(attempts(), 0);
  assert.match(host.listTasks({}).find((taskView) => taskView.id === task.id)?.waitingFor ?? "", /停止未确认:still alive/);
  assert.ok(host.quota.leaseOf(task.id));
  assert.equal(Reflect.get(host, "harnessRetiring").has(old), false);
});

test("AC-51 ⑦ relaunches the retired source after refusal and delivers replacement events", async (t) => {
  const { host, task, old, source, c, send, attempts } = await failedHandoff(t, Host);
  assert.equal(attempts(), 1);
  assert.equal(Reflect.get(host, "harnessRetiring").has(old), false);
  assert.equal(host.quota.leaseOf(task.id), undefined);

  host.updateContact(c.id, { harness: "claude-code" });
  send("revert", "补充:continue on the source");
  await settle(host, source);
  assert.equal(source.spawned.length, 2);
  assert.deepEqual(source.stopped, [old]);
  assert.deepEqual(source.resumed, []);
  const replacement = source.spawned[1]!;
  assert.deepEqual(replacement.opts?.handoff, { constraintVer: 0, openQuestions: [], doneSideEffects: ["source milestone"] });
  assert.notEqual(replacement.computeId, old);
  assert.equal(host.taskDoc(task.id).value.task.computeId, replacement.computeId);
  assert.deepEqual(host.progress(task.id).filter((p) => p.computeId === replacement.computeId).map((p) => p.kind), ["started", "completed"]);
  assert.equal(host.quota.leaseOf(task.id), undefined);
});

test("AC-51 ⑦ confirms cancellation of the retired source after replacement refusal", async (t) => {
  const { host, task, old, source, attempts } = await failedHandoff(t, Host);
  assert.equal(attempts(), 1);
  host.taskDecision(task.id, "cancel", "c1");
  await settle(host, source);
  assert.equal(host.taskDoc(task.id).value.task.state, "T10_Cancelled");
  assert.deepEqual(source.stopped, [old]);
  assert.equal(host.quota.leaseOf(task.id), undefined);
});

test("AC-51 ⑦ retries a throwing replacement without stopping the retired source again", async (t) => {
  const { host, task, old, source, send, attempts } = await failedHandoff(t, Host, { throws: true });
  assert.equal(attempts(), 1);
  assert.equal(Reflect.get(host, "harnessRetiring").has(old), false);
  assert.equal(host.quota.leaseOf(task.id), undefined);
  send("retry", "补充:retry Codex");
  await settle(host, source);
  assert.equal(attempts(), 2);
  assert.deepEqual(source.stopped, [old]);
  assert.equal(host.quota.leaseOf(task.id), undefined);
});
