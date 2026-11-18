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

