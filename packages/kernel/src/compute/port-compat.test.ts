// AC-33/AC-07: use owning-package imports so gate mutations execute the observed implementation.
import assert from "node:assert/strict";
import test from "node:test";
import { plainData as kernelPlainData } from "../plain.ts";

test("S-PORT-02: neutral Compute validators retain baseline input and freeze semantics", async () => {
  let shared: typeof import("./index.ts") | undefined;
  let failure = "";
  try { shared = await import("./index.ts"); }
  catch (error) { failure = error instanceof Error ? error.message : String(error); }
  assert.ok(shared, `S-PORT-02: neutral Compute implementation is unavailable: ${failure}`);
  const input = { task: "write an artifact", rules: ["authorized files"], tools: ["Bash"], credentialRefs: ["secret://fixture"], placement: "local" };
  const good = shared.checkComputeBrief(input, ["Bash"]);
  assert.ok(good.ok);
  assert.deepEqual(good.brief, input);
  assert.notEqual(good.brief, input);
  for (const value of [good.brief, good.brief.rules, good.brief.tools, good.brief.credentialRefs]) assert.ok(Object.isFrozen(value));
  assert.deepEqual(shared.checkComputeBrief(input, ["native_exec"]), { ok: false, reason: 'brief.tools 只收具体的内置工具名(native_exec),拒绝 "Bash"' });
  assert.equal(shared.checkComputeBrief({ ...input, tools: ["native_exec"] }, ["native_exec"]).ok, true);
  assert.equal(shared.checkComputeBrief({ ...input, extra: undefined }, ["Bash"]).ok, false);
  assert.equal(shared.isCredentialRef("secret://fixture"), true);
  assert.equal(shared.isCredentialRef("RAW_FIXTURE_NOT_A_SECRET"), false);
  assert.equal(shared.checkComputeBrief({ ...input, credentialRefs: ["RAW_FIXTURE_NOT_A_SECRET"] }, ["Bash"]).ok, false);
  assert.equal(shared.checkSnapshot({ constraintVer: 3, openQuestions: [], doneSideEffects: ["artifact written"] }).ok, true);
  assert.equal(shared.checkSnapshot({ openQuestions: [], doneSideEffects: [] }).ok, false);
  let calls = 0;
  const getter = Object.defineProperty({}, "task", { enumerable: true, get() { calls++; return "do not read"; } });
  const proxy = new Proxy({}, { ownKeys() { calls++; throw new Error("do not invoke"); }, get() { calls++; throw new Error("do not invoke"); } });
  assert.equal(shared.checkComputeBrief(getter, []).ok, false);
  assert.equal(shared.checkComputeBrief(proxy, []).ok, false);
  assert.equal(calls, 0);
  const undefinedField = shared.plainData({ extra: undefined }, "fixture");
  assert.ok(undefinedField.ok);
  assert.ok(Object.hasOwn(undefinedField.value as object, "extra"));
  // Negative control: the pre-existing kernel root contract really does drop it.
  // The extracted Compute contract must remain observably different, not an alias to that validator.
  const rootContract = kernelPlainData({ extra: undefined }, "fixture");
  assert.ok(rootContract.ok);
  assert.equal(Object.hasOwn(rootContract.value as object, "extra"), false);
  const owned = { nested: { count: 1 } };
  assert.equal(shared.freezeDeep(owned), owned);
  assert.ok(Object.isFrozen(owned.nested));
});
