// AC-33/AC-07: new neutral port, unchanged legacy import surface.
import assert from "node:assert/strict";
import test from "node:test";
import { CC_BUILTIN_TOOLS, checkBrief, checkSnapshot, isCredentialRef } from "../src/brief.ts";
import { freezeDeep, isPlainRecord, plainData } from "../src/plain.ts";

test("S-PORT-01: kernel Compute port preserves CC aliases and keeps tool policies distinct", async () => {
  let shared;
  let importFailure = "";
  try { shared = await import("@g-group/kernel/compute"); }
  catch (error) { importFailure = error instanceof Error ? error.message : String(error); }
  assert.ok(shared, `S-PORT-01: neutral Compute port is unavailable: ${importFailure}`);
  assert.equal(plainData, shared.plainData, "legacy plainData must be a direct re-export");
  assert.equal(freezeDeep, shared.freezeDeep, "legacy freezeDeep must be a direct re-export");
  assert.equal(isPlainRecord, shared.isPlainRecord, "legacy record guard must be a direct re-export");
  assert.equal(checkSnapshot, shared.checkSnapshot, "legacy snapshot validator must be a direct re-export");
  assert.equal(isCredentialRef, shared.isCredentialRef, "legacy credential guard must be a direct re-export");

  const input = { task: "write an artifact", rules: ["only authorized files"], tools: ["Bash"], credentialRefs: ["secret://test-owner"], placement: "local" };
  const legacy = checkBrief(input);
  assert.ok(legacy.ok, "the original CC tool remains accepted");
  assert.deepEqual(shared.checkComputeBrief(input, CC_BUILTIN_TOOLS), legacy);
  assert.ok(Object.isFrozen(legacy.brief));
  assert.ok(Object.isFrozen(legacy.brief.rules));
  assert.ok(Object.isFrozen(legacy.brief.tools));
  assert.ok(Object.isFrozen(legacy.brief.credentialRefs));
  assert.deepEqual(checkBrief({ ...input, tools: ["native_exec"] }), {
    ok: false,
    reason: `brief.tools 只收具体的内置工具名(${CC_BUILTIN_TOOLS.join("/")}),拒绝 "native_exec"`,
  }, "CC must not inherit another harness's tools");
  assert.deepEqual(shared.checkComputeBrief(input, ["native_exec"]), {
    ok: false,
    reason: 'brief.tools 只收具体的内置工具名(native_exec),拒绝 "Bash"',
  }, "the neutral validator must not hardcode the CC tool table");
  const native = shared.checkComputeBrief({ ...input, tools: ["native_exec"] }, ["native_exec"]);
  assert.equal(native.ok, true);
  if (native.ok) {
    assert.deepEqual(native.brief.tools, ["native_exec"]);
    assert.ok(Object.isFrozen(native.brief.tools));
  }
  assert.equal(shared.checkComputeBrief({ ...input, credentialRefs: ["RAW_FIXTURE_NOT_A_SECRET"] }, ["Bash"]).ok, false);
  assert.equal(checkSnapshot({ constraintVer: 3, openQuestions: [], doneSideEffects: ["artifact written"] }).ok, true);
  assert.equal(checkSnapshot({ openQuestions: [], doneSideEffects: [] }).ok, false);
  let calls = 0;
  const getter = Object.defineProperty({}, "task", { enumerable: true, get() { calls++; return "do not read"; } });
  assert.equal(shared.checkComputeBrief(getter, []).ok, false);
  assert.equal(calls, 0, "extraction must preserve descriptor-only validation");
  const undefinedField = plainData({ extra: undefined }, "fixture");
  assert.ok(undefinedField.ok);
  assert.ok(Object.hasOwn(undefinedField.value, "extra"), "do not substitute kernel root plainData, which drops undefined properties");
});
