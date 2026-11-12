import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    if (!initialized.ok) throw new Error("native initialize refused");
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


test("CXP-08 native exit zero without matching completion is a failed turn not successful work", async () => {
  const client = createCodexComputeProtocol(options("exit0"));
  try {
    assert.equal((await client.initialize()).ok, true);
    assert.equal((await client.startThread({ model: "probe-A", effort: "low" })).ok, true);
    assert.equal((await client.startTurn("native-thread-1", "exit", { model: "probe-A", effort: "low" })).ok, true);
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([client.settled("native-thread-1", "native-turn-1"), new Promise<unknown>((r) => { timer = setTimeout(() => r({ deadline: true }), 700); })]);
    clearTimeout(timer);
    assert.deepEqual(done, { ok: true, value: { computeId: "native-thread-1", kind: "failed", reason: "native process exited before matching turn/completed", code: 0, signal: null, violations: [] } });
  } finally { await client.quiesce(1000); }
});

test("CXP-09 native started and terminal events are observable in kernel order exactly once", async () => {
  const client = createCodexComputeProtocol(options());
  try {
    assert.equal((await client.initialize()).ok, true);
    assert.equal((await client.startThread({ model: "probe-A", effort: "low" })).ok, true);
    assert.equal((await client.startTurn("native-thread-1", "events", { model: "probe-A", effort: "low" })).ok, true);
    assert.equal((await client.settled("native-thread-1", "native-turn-1")).ok, true);
    const events = client.events()[Symbol.asyncIterator]();
    const started = await events.next();
    assert.equal(started.done, false);
    assert.equal(started.value?.kind, "started");
    const completed = await events.next();
    assert.equal(completed.value?.kind, "completed");
    assert.equal((await client.quiesce(1000)).ok, true);
    assert.equal((await events.next()).done, true);
  } finally { await client.quiesce(1000); }
});


test("CXP-10 native server approval is refused instead of implicitly authorized and failed status is preserved", async () => {
  const cfg = options("approval"); const client = createCodexComputeProtocol(cfg);
  try {
    assert.equal((await client.initialize()).ok, true);
    assert.equal((await client.startThread({ model: "probe-A", effort: "low" })).ok, true);
    assert.equal((await client.startTurn("native-thread-1", "approval", { model: "probe-A", effort: "low" })).ok, true);
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([client.settled("native-thread-1", "native-turn-1"), new Promise<unknown>((r) => { timer = setTimeout(() => r({ deadline: true }), 700); })]);
    clearTimeout(timer);
    assert.deepEqual(done, { ok: true, value: { computeId: "native-thread-1", kind: "failed", reason: "unsupported native approval refused", code: null, signal: null, violations: [] } });
    const wire = readFileSync(path.join(cfg.configDir, "wire-requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(wire.some((m) => m.id === "native-approval-1" && m.error?.code === -32601), true);
  } finally { await client.quiesce(1000); }
});


test("CXP-11 main exit zero with three detached descendants is not quiescence until shared cleanup proves all exited", async () => {
  const cfg = options("children"); const client = createCodexComputeProtocol(cfg);
  let pids: number[] = [];
  try {
    assert.equal((await client.initialize()).ok, true);
    const tree = JSON.parse(readFileSync(path.join(cfg.configDir, "fixture-children.json"), "utf8")) as { helper: number; pids: number[] };
    pids = [tree.helper, ...tree.pids];
    assert.equal(tree.pids.length, 3);
    for (const pid of tree.pids) assert.equal(process.kill(pid, 0), true);
    const quiet = await client.quiesce(1500);
    assert.equal(quiet.ok, true);
    assert.equal(quiet.ok && quiet.killed >= 3, true);
    for (const pid of tree.pids) {
      let stat = "";
      try { stat = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
      catch (e) { if ((e as { status?: unknown }).status !== 1) throw e; }
      assert.equal(stat === "" || stat.startsWith("Z"), true);
    }
  } finally {
    await client.quiesce(1000);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* owned fixture already exited */ } }
  }
});

test("CXP-12 foreign response IDs and early or duplicate foreign turn notifications cannot forge completion", async () => {
  const client = createCodexComputeProtocol(options("early"));
  const foreign = createCodexComputeProtocol(options("foreign-rpc"));
  try {
    assert.equal((await foreign.initialize()).ok, true);
    assert.equal((await client.initialize()).ok, true);
    assert.equal((await client.startThread({ model: "probe-A", effort: "low" })).ok, true);
    assert.equal((await client.startTurn("native-thread-1", "early", { model: "probe-A", effort: "low" })).ok, true);
    const done = await client.settled("native-thread-1", "native-turn-1");
    assert.deepEqual(done, { ok: true, value: { computeId: "native-thread-1", kind: "completed", result: "reply-native-turn-1" } });
    const wrong = await client.settled("native-thread-1", "foreign-turn");
    assert.equal(wrong.ok, false);
    assert.equal((await client.quiesce(1000)).ok, true);
    const observed = [];
    for await (const event of client.events()) observed.push(event.kind);
    assert.deepEqual(observed, ["started", "completed"]);
  } finally { await client.quiesce(1000); await foreign.quiesce(1000); }
});

test("CXP-13 interrupt acknowledgement alone never becomes an interrupted completion or quiescence claim", async () => {
  const client = createCodexComputeProtocol(options("ack-only"));
  try {
    assert.equal((await client.initialize()).ok, true);
    assert.equal((await client.startThread({ model: "probe-A", effort: "low" })).ok, true);
    assert.equal((await client.startTurn("native-thread-1", "hold", { model: "probe-A", effort: "low" })).ok, true);
    const reply = await client.interrupt("native-thread-1", "native-turn-1");
    assert.deepEqual(reply, { ok: false, reason: "native interrupt not confirmed" });
    assert.equal((await client.quiesce(1000)).ok, true);
    const terminal = await client.settled("native-thread-1", "native-turn-1");
    assert.equal(terminal.ok && terminal.value.kind, "failed");
  } finally { await client.quiesce(1000); }
});

test("CXP-14 concurrent native turn starts cannot create a second active turn behind the caller", async () => {
  const cfg = options("hold"); const client = createCodexComputeProtocol(cfg);
  try {
    assert.equal((await client.initialize()).ok, true);
    assert.equal((await client.startThread({ model: "probe-A", effort: "low" })).ok, true);
    const [first, second] = await Promise.all([
      client.startTurn("native-thread-1", "first", { model: "probe-A", effort: "low" }),
      client.startTurn("native-thread-1", "second", { model: "probe-A", effort: "low" }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    const wire = readFileSync(path.join(cfg.configDir, "wire-requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(wire.filter((m) => m.method === "turn/start").length, 1);
    assert.equal((await client.interrupt("native-thread-1", "native-turn-1")).ok, true);
  } finally { await client.quiesce(1000); }
});

test("CXP-15 explicit next-turn model and effort are sent unchanged and unsupported capabilities never enter native input", async () => {
  const cfg = options(); const client = createCodexComputeProtocol(cfg);
  try {
    assert.equal((await client.initialize()).ok, true);
    assert.equal((await client.startThread({ model: "probe-A", effort: "low" })).ok, true);
    assert.equal((await client.startTurn("native-thread-1", "one", { model: "probe-A", effort: "low" })).ok, true);
    assert.equal((await client.settled("native-thread-1", "native-turn-1")).ok, true);
    const denied = await client.startTurn("native-thread-1", "DENIED_INPUT", { model: "probe-A", effort: "high" });
    assert.equal(denied.ok, false);
    assert.equal((await client.startTurn("native-thread-1", "two", { model: "probe-B", effort: "high" })).ok, true);
    assert.equal((await client.settled("native-thread-1", "native-turn-2")).ok, true);
    const wire = readFileSync(path.join(cfg.configDir, "wire-requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const sent = wire.filter((m) => m.method === "turn/start");
    assert.deepEqual(sent.map((m) => [m.params.model, m.params.effort]), [["probe-A", "low"], ["probe-B", "high"]]);
    assert.equal(JSON.stringify(wire).includes("DENIED_INPUT"), false);
  } finally { await client.quiesce(1000); }
});


test("CXP-16 malformed native wire fails the active turn instead of leaving settled pending forever", async () => {
  const client = createCodexComputeProtocol(options("malformed"));
  try {
    assert.equal((await client.initialize()).ok, true);
    assert.equal((await client.startThread({ model: "probe-A", effort: "low" })).ok, true);
    assert.equal((await client.startTurn("native-thread-1", "invalid-wire", { model: "probe-A", effort: "low" })).ok, true);
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([client.settled("native-thread-1", "native-turn-1"), new Promise<unknown>((r) => { timer = setTimeout(() => r({ deadline: true }), 700); })]);
    clearTimeout(timer);
    assert.deepEqual(done, { ok: true, value: { computeId: "native-thread-1", kind: "failed", reason: "invalid native JSON", code: null, signal: null, violations: [] } });
  } finally { await client.quiesce(1000); }
});

test("CXP-17 missing native config owner is an explicit refusal rather than an uncaught realpath failure", async () => {
  const client = createCodexComputeProtocol(options("wrong-owner"));
  try {
    let result: unknown;
    await assert.doesNotReject(async () => { result = await client.initialize(); });
    assert.deepEqual(result, { ok: false, reason: "native config owner mismatch" });
  } finally { await client.quiesce(1000); }
});
