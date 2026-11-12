import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexComputeProtocol } from "./protocol.ts";
const fixture = path.resolve(import.meta.dirname, "../test-support/native-wire.mjs");
const homes: string[] = [];
function options(mode = "normal") {
  const home = mkdtempSync(path.join(os.tmpdir(), "codex-wire-test-")); homes.push(home);
  return { runner: { command: process.execPath, args: [fixture], env: { FIXTURE_MODE: mode } }, cwd: home, configDir: home, models: { "probe-A": ["low"], "probe-B": ["high"] }, timeoutMs: 500 };
}
test.after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

test("CXP-01 native initialize is acknowledged before initialized and first thread", async () => {
  const client = createCodexComputeProtocol(options());
  try {
    const initialized = await client.initialize();
    assert.equal(initialized.ok, true);
    if (!initialized.ok) throw new Error(initialized.reason);
    const thread = await client.startThread({ model: "probe-A", effort: "low" });
    assert.deepEqual(thread, { ok: true, value: { threadId: "native-thread-1" } });
  } finally { await client.quiesce(1000); }
});

test("CXP-02 native turn IDs and completed payload map to kernel ComputeEvent without a replacement loop", async () => {
  const client = createCodexComputeProtocol(options());
  try {
    assert.equal((await client.initialize()).ok, true);
    assert.equal((await client.startThread({ model: "probe-A", effort: "low" })).ok, true);
    const turn = await client.startTurn("native-thread-1", "literal task", { model: "probe-A", effort: "low" });
    assert.deepEqual(turn, { ok: true, value: { turnId: "native-turn-1" } });
    const done = await client.settled("native-thread-1", "native-turn-1");
    assert.deepEqual(done, { ok: true, value: { computeId: "native-thread-1", kind: "completed", result: "reply-native-turn-1" } });
  } finally { await client.quiesce(1000); }
});


test("CXP-03 process restart uses native thread resume and never silently creates a replacement thread", async () => {
  const cfg = options();
  const first = createCodexComputeProtocol(cfg);
  const second = createCodexComputeProtocol(cfg);
  try {
    assert.equal((await first.initialize()).ok, true);
    assert.equal((await first.startThread({ model: "probe-A", effort: "low" })).ok, true);
    assert.equal((await first.quiesce(1000)).ok, true);
    assert.equal((await second.initialize()).ok, true);
    const resumed = await second.resumeThread("native-thread-1", { model: "probe-B", effort: "high" });
    assert.deepEqual(resumed, { ok: true, value: { threadId: "native-thread-1" } });
    const wire = readFileSync(path.join(cfg.configDir, "wire-requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(wire.filter((m) => m.method === "thread/start").length, 1);
    assert.equal(wire.filter((m) => m.method === "thread/resume" && m.params.threadId === "native-thread-1").length, 1);
  } finally { await first.quiesce(1000); await second.quiesce(1000); }
});

test("CXP-04 steer binds expectedTurnId and interrupt waits for matching native interrupted terminal", async () => {
  const cfg = options("hold");
  const client = createCodexComputeProtocol(cfg);
  try {
    assert.equal((await client.initialize()).ok, true);
    assert.equal((await client.startThread({ model: "probe-A", effort: "low" })).ok, true);
    assert.equal((await client.startTurn("native-thread-1", "hold", { model: "probe-A", effort: "low" })).ok, true);
    const wrong = await client.steer("native-thread-1", "foreign-turn", "do not deliver");
    assert.equal(wrong.ok, false);
    const right = await client.steer("native-thread-1", "native-turn-1", "current input");
    assert.deepEqual(right, { ok: true, value: { turnId: "native-turn-1" } });
    const interrupted = await client.interrupt("native-thread-1", "native-turn-1");
    assert.deepEqual(interrupted, { ok: true, value: { status: "interrupted" } });
    const terminal = await client.settled("native-thread-1", "native-turn-1");
    assert.equal(terminal.ok && terminal.value.kind, "stopped");
    const requests = readFileSync(path.join(cfg.configDir, "wire-requests.jsonl"), "utf8");
    assert.equal(requests.includes("foreign-turn"), false);
    assert.equal(requests.includes('"expectedTurnId":"native-turn-1"'), true);
  } finally { await client.quiesce(1000); }
});

test("CXP-05 unknown requested model is refused before native thread input", async () => {
  const cfg = options(); const client = createCodexComputeProtocol(cfg);
  try {
    assert.equal((await client.initialize()).ok, true);
    const refused = await client.startThread({ model: "not-in-owner-catalog", effort: "low" });
    assert.equal(refused.ok, false);
    assert.equal(readFileSync(path.join(cfg.configDir, "wire-requests.jsonl"), "utf8").includes('"thread/start"'), false);
  } finally { await client.quiesce(1000); }
});

test("CXP-06 nonempty tool capability cannot silently become unrestricted native tools", async () => {
  const cfg = options(); const client = createCodexComputeProtocol(cfg);
  try {
    assert.equal((await client.initialize()).ok, true);
    const refused = await client.startThread({ model: "probe-A", effort: "low" }, ["Bash"]);
    assert.equal(refused.ok, false);
    assert.equal(readFileSync(path.join(cfg.configDir, "wire-requests.jsonl"), "utf8").includes('"thread/start"'), false);
  } finally { await client.quiesce(1000); }
});

test("CXP-07 incompatible effort is refused without falling back to harness defaults", async () => {
  const cfg = options(); const client = createCodexComputeProtocol(cfg);
  try {
    assert.equal((await client.initialize()).ok, true);
    const refused = await client.startThread({ model: "probe-A", effort: "high" });
    assert.equal(refused.ok, false);
    assert.equal(readFileSync(path.join(cfg.configDir, "wire-requests.jsonl"), "utf8").includes('"thread/start"'), false);
  } finally { await client.quiesce(1000); }
});
