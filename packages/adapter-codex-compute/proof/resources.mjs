// Protocol resource policies tested independently of transcript assertions.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexComputeProtocol } from "../src/protocol.ts";
const root = mkdtempSync(path.join(os.tmpdir(), "p1b-resource-proof-"));
const originalPath = process.env.PATH;
const fixture = path.resolve(import.meta.dirname, "../test-support/native-wire.mjs");
const live = [];
const deltas = Number(process.env.P1B_PROGRESS_COUNT ?? 1000);
try {
  writeFileSync(path.join(root, "ps"), "#!/bin/sh\nprintf 'ps\\n' >> '" + root + "/ps-calls'\nexec /bin/ps \"$@\"\n", { mode: 0o700 });
  process.env.PATH = root + path.delimiter + originalPath;
  const make = mode => {
    const home = mkdtempSync(path.join(root, mode + "-"));
    const client = createCodexComputeProtocol({ runner: { command: process.execPath, args: [fixture], env: { FIXTURE_MODE: mode, FIXTURE_COUNT: String(deltas) } }, cwd: root, configDir: home, models: { probe: ["low"] }, timeoutMs: 1000, reapForceMs: 300 });
    live.push(client); return { client, home };
  };
  const { client } = make("progress");
  assert.equal((await client.initialize()).ok, true);
  assert.equal((await client.startThread({ model: "probe", effort: "low" })).ok, true);
  assert.equal((await client.startTurn("native-thread-1", "progress", { model: "probe", effort: "low" })).ok, true);
  await client.settled("native-thread-1", "native-turn-1");
  assert.equal((await client.quiesce(1000)).ok, true);
  const events = []; for await (const e of client.events()) events.push(e);
  assert.ok(events.some(e => e.kind === "milestone" && e.summary === "structured native progress"));
  const acts = []; for await (const e of client.activity()) acts.push(e);
  assert.equal(acts.filter(e => e.kind === "progress" && e.what === "text").length, deltas);
  assert.ok(acts.some(e => e.kind === "tool_start") && acts.some(e => e.kind === "tool_end"));
  const psCalls = readFileSync(path.join(root, "ps-calls"), "utf8").trim().split("\n").length;
  assert.ok(psCalls < 30, "R1-03: process scans must follow boundaries, never streamed lines");
  console.log("R1-03: " + deltas + " deltas + structured progress + tool start/end, ps calls=" + psCalls);
  const stubborn = make("stubborn");
  assert.equal((await stubborn.client.initialize()).ok, true);
  assert.equal((await stubborn.client.startThread({ model: "probe", effort: "low" })).ok, true);
  const at = Date.now();
  assert.equal((await stubborn.client.quiesce(100)).ok, true);
  const termAt = Number(readFileSync(path.join(stubborn.home, "term-at"), "utf8"));
  assert.ok(termAt >= at + 75, "stdin EOF gets a grace window before SIGTERM");
  assert.ok(Date.now() - termAt >= 250, "R1-05: SIGTERM gets the configured grace window before SIGKILL");
  console.log("R1-05: EOF -> SIGTERM -> SIGKILL respects 100ms + 300ms configured grace windows");
} finally {
  for (const client of live) await client.quiesce(1000);
  process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
}
