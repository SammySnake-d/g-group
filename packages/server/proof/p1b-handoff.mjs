// D-layer integration: an owned native-wire child, SQLite task state, and a real task git worktree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scriptedCompute, scriptedMind } from "../src/fakes.ts";
import { Host } from "../src/host.ts";
import { createCodexComputeAdapter } from "../../adapter-codex-compute/src/adapter.ts";
const root = mkdtempSync(path.join(os.tmpdir(), "p1b-host-proof-"));
const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=P1B proof", "-c", "user.email=p1b@local.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const source = path.join(root, "source"); mkdirSync(source);
git(source, "init", "-q", "-b", "main"); writeFileSync(path.join(source, "neutral.txt"), "NEUTRAL_NO_CREDENTIALS\n"); git(source, "add", "."); git(source, "commit", "-qm", "neutral");
const repo = path.join(root, "repo.git"); git(root, "clone", "-q", "--bare", source, repo);
async function until(host, condition) {
  for (let i = 0; i < 500; i++) { await host.idle(); if (condition()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail("host proof did not reach expected boundary");
}
function mind(getHost) {
  const base = scriptedMind();
  return { async round(input, signal) {
    const out = await base.round(input, signal);
    const actions = out.actions.filter(a => a.kind !== "deliver");
    for (const f of input.fresh) if (f.kind === "message" && f.sender.kind === "user" && f.text.startsWith("补充:")) {
      const t = getHost().listTasks({ contactId: input.contact.id }).find(t => t.state === "T3_Running");
      if (t) actions.push({ kind: "forward", taskId: t.id, text: f.text.slice(3) });
    }
    return { ...out, actions };
  }};
}
try {
  for (const direction of ["claude-code", "codex"]) {
    const destination = direction === "codex" ? "claude-code" : "codex";
    const fake = scriptedCompute({ haltOnStop: true, idPrefix: "claude", script: () => [{ kind: "started", sessionId: "claude-native", resumed: false }] });
    const nativeBase = createCodexComputeAdapter({ runner: { command: process.execPath, args: [path.resolve(import.meta.dirname, "../../adapter-codex-compute/test-support/native-wire.mjs")] }, hostEnv: { FIXTURE_MODE: direction === "codex" ? "normal" : "hold" }, dataDir: path.join(root, direction, "native"), timeoutMs: 1000, reapForceMs: 300 });
    const nativePids = new Set();
    const native = { ...nativeBase, async *events() { for await (const event of nativeBase.events()) { if (event.kind === "started" && event.pid) nativePids.add(event.pid); yield event; } } };
    const host = new Host({ file: path.join(root, direction + ".db"), dataDir: path.join(root, direction), codeRepo: { repo, targetBranch: "main" }, mind: () => mind(() => host), compute: { "claude-code": () => fake.adapter, codex: () => native }, maxDeferMs: 5 });
    try {
      const models = { "claude-code": "claude-opus-5-5", codex: "gpt-6-astra" };
      host.updateSettings({ defaultHarness: direction, defaultComputeModel: models[direction], models: [{ id: models["claude-code"], label: "Claude", vendor: "anthropic", harnesses: ["claude-code"] }, { id: models.codex, label: "Codex", vendor: "openai", harnesses: ["codex"] }] });
      const c = host.createContact({ name: "proof" }), dm = host.openDm(c.id);
      host.send({ roomId: dm.id, clientActionId: "greeting", text: "你好" });
      await until(host, () => host.listMessages(dm.id, {}).messages.length >= 2);
      host.send({ roomId: dm.id, clientActionId: "begin", text: "帮我整理资料" });
      await until(host, () => host.listTasks({ contactId: c.id })[0]?.computeRuns[0]?.status === (direction === "codex" ? "completed" : "running"));
      const before = host.listTasks({ contactId: c.id })[0];
      const cwd = before.workspace.dir, branch = git(cwd, "branch", "--show-current"), sha = git(cwd, "rev-parse", "HEAD");
      host.updateContact(c.id, { harness: destination, computeModel: { mode: "explicit", model: models[destination] } });
      host.send({ roomId: dm.id, clientActionId: "switch", text: "补充:继续同一任务" });
      await new Promise(r => setTimeout(r, 40)); await host.idle();
      if (direction === "claude-code") {
        assert.equal(fake.stopped.length, 0, "in-flight Claude turn was not interrupted");
        fake.emit({ computeId: fake.spawned[0].computeId, kind: "completed", result: "preserve this milestone" });
      }
      await until(host, () => host.listTasks({ contactId: c.id })[0]?.computeRuns.length === 2);
      const after = host.listTasks({ contactId: c.id })[0];
      assert.equal(after.id, before.id);
      assert.equal(after.workspace.dir, cwd);
      assert.equal(git(cwd, "branch", "--show-current"), branch);
      assert.equal(git(cwd, "rev-parse", "HEAD"), sha);
      assert.deepEqual(after.modelAttempts.map(a => a.harness), [direction, destination]);
      assert.deepEqual(new Set(after.producerVendors), new Set(["anthropic", "openai"]));
      assert.equal(host.taskDoc(after.id).value.task.instances.length, 2);
      assert.equal(host.taskDoc(after.id).value.task.retired.includes(before.computeRuns[0].computeId), true);
      // Native process exit confirmation remains required on both cancel and rewind paths.
      if (direction === "claude-code") host.taskDecision(after.id, "cancel", "cancel");
      else host.rewind({ roomId: dm.id, toSeq: 1, clientActionId: "rewind" });
      await until(host, () => host.taskDoc(after.id).value.task.state === "T10_Cancelled");
      assert.equal(host.quota.leaseOf(after.id), undefined);
      assert.ok(nativePids.size > 0);
      for (const pid of nativePids) assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
      console.log(direction + " -> " + destination + ": in-flight boundary, worktree branch/SHA, task instances, ledger vendors, cancel/rewind and lease cleanup passed");
    } finally { fake.close(); await host.close(); }
  }
  for (const guard of ["missing", "quarantine"]) {
    const old = scriptedCompute({ idPrefix: "guard-old", script: () => [{ kind: "started", sessionId: "guard", resumed: false }, { kind: "completed", result: "checkpoint" }], ...(guard === "quarantine" ? { quiesce: async () => ({ ok: false, reason: "owned fixture has not exited", remaining: [12345] }) } : {}) });
    const next = scriptedCompute({ idPrefix: "guard-next" });
    const host = new Host({ file: path.join(root, guard + ".db"), mind: () => mind(() => host), compute: { "claude-code": () => old.adapter, ...(guard === "missing" ? {} : { codex: () => next.adapter }) }, maxDeferMs: 5 });
    try {
      host.updateSettings({ defaultComputeModel: "shared-model", models: [{ id: "shared-model", label: "shared", vendor: "unknown", harnesses: ["claude-code", "codex"] }] });
      const c = host.createContact({ name: "guard" }), dm = host.openDm(c.id);
      host.send({ roomId: dm.id, clientActionId: "guard-begin", text: "帮我整理资料" });
      await until(host, () => host.listTasks({ contactId: c.id })[0]?.computeRuns[0]?.status === "completed");
      const task = host.listTasks({ contactId: c.id })[0];
      host.updateContact(c.id, { harness: "codex" });
      host.send({ roomId: dm.id, clientActionId: "guard-switch", text: "补充:切换" });
      await until(host, () => guard === "missing" ? host.progress(task.id, 20).some(p => p.kind === "blocked") : host.listTasks({ contactId: c.id })[0].waitingFor?.includes("停止未确认"));
      assert.equal(next.spawned.length, 0);
      if (guard === "missing") assert.equal(old.stopped.length, 0);
      else assert.equal(host.quota.leaseOf(task.id)?.stopping, true);
      assert.equal(host.taskDoc(task.id).value.task.computeId, old.spawned[0].computeId);
      console.log(guard + ": destination spawn blocked, old binding retained, lease safety preserved");
    } finally { old.close(); next.close(); await host.close(); }
  }
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
