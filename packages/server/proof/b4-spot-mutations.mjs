// Standalone offline proof. Each fault lives only in a new workspace copy with rebound package aliases.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const load = (p) => import(pathToFileURL(path.join(root, p)).href);
const { freshCopy } = await load("scripts/gates/lib.ts");
const { analyzeTestFile } = await load("scripts/gates/testlint.ts");
const adapter = "packages/adapter-pi-contact/src/";
const server = "packages/server/src/";
const ptests = `${adapter}protocols.test.ts`;
const atests = `${adapter}usage.test.ts`;
const stests = `${server}usage.test.ts`;
const swaps = `${server}b4-hotswap-speaking.test.ts`;
const mutations = [
  ["anthropic-auth-header", `${adapter}protocols.ts`, 'defaultAuthHeader: "x-api-key", load: anthropicMessagesApi', 'defaultAuthHeader: "bearer", load: anthropicMessagesApi', ptests, "anthropic-messages:工具声明"],
  ["openai-chat-codec", `${adapter}protocols.ts`, "load: openAICompletionsApi", "load: openAIResponsesApi", ptests, "openai-chat:工具声明"],
  ["openai-responses-codec", `${adapter}protocols.ts`, "load: openAIResponsesApi", "load: openAICompletionsApi", ptests, "openai-responses:工具声明"],
  ["google-codec", `${adapter}protocols.ts`, "load: googleGenerativeAIApi", "load: openAIResponsesApi", ptests, "google-generative-ai:工具声明"],
  ["chat-session-affinity", `${adapter}protocols.ts`, 'api: "openai-completions", compat: { sendSessionAffinityHeaders: affinity', 'api: "openai-completions", compat: { sendSessionAffinityHeaders: false', ptests, "B4 affinity compat"],
  ["no-precommit-failover", `${adapter}request.ts`, "if (index === choices.length - 1) throw e;", "if (index >= 0) throw e;", ptests, "B4 clean failure"],
  ["postcommit-replay", `${adapter}request.ts`, "if (attempt.committed) throw new PiContactMindError(e.code, e.message, true, e.retryableTruncation);", "", ptests, "B4 text, thinking and tool deltas"],
  ["usage-sink-not-committing", `${adapter}usage.ts`, "  commit();", "", ptests, "B4 a committed usage receipt"],
  ["probe-token-floor", `${adapter}magpie.ts`, "Math.max(cfg.maxTokens, 8192)", "Math.max(cfg.maxTokens, 1024)", ptests, "B4 probe requests"],
  ["runtime-reasoning-token-floor", `${server}pi-runtime.ts`, "selected.reasoning ? { maxTokens: 8192 }", "selected.reasoning ? { maxTokens: 4096 }", stests, "B4 Magpie reasoning models"],
  ["health-ttl-second-failure", `${adapter}protocols.ts`, "[60_000, 120_000, 300_000, 600_000]", "[60_000, 60_000, 300_000, 600_000]", ptests, "B4 cache cooldowns"],
  ["discovery-guesses-despite-endpoints", `${adapter}magpie.ts`, "endpoints === undefined ? [apiForModel(m.id)] : order.filter((p) => advertised.has(p))", "[apiForModel(m.id)]", ptests, "B4 read-only Magpie"],
  ["without-breakpoint-collapse", `${adapter}usage.ts`, "  const p = structuredClone(payload);", "  const p = structuredClone(payload); return p;", atests, "B4 breakpoint placement"],
  ["responses-prefix-missing-system", `${adapter}usage.ts`, "leading: leadingInstructions(p.input)", "leading: null", atests, "B4 Responses also hashes"],
  ["implicit-4-to-1-not-detected", `${server}cache-stats.ts`, "r.input > 0 && r.cacheRead > 0", "r.explicitBreakpoints !== false && r.input > 0 && r.cacheRead > 0", stests, "B4 RPC persists"],
  ["implicit-hits-rejected", `${server}cache-stats.ts`, "r.explicitBreakpoints !== false && r.breakpoints === 0 && r.cacheRead > 0", "r.breakpoints === 0 && r.cacheRead > 0", stests, "B4 RPC persists"],
  ["miss-ttl-ignored", `${server}cache-stats.ts`, 'ms(r.at) - ms(prev.at) > ttlMs ? "expired" : "uncached"', '"uncached"', stests, "未命中归因:同前缀"],
  ["rpc-not-registered", `${server}service.ts`, '    "usage.cacheStats": (p: Parameters<Host["usage"]["cacheStats"]>[0]) => host.usage.cacheStats(p),\n', "", stests, "B4 RPC persists"],
  ["mid-round-compactor-model-swap", `${server}host.ts`, "this.settleNote({ ...contact, speakingModel: model },", "this.settleNote({ ...contact, speakingModel: this.contactDoc(contactId).value.speakingModel },", swaps, "B4 contacts.update holds"],
  ["inheritance-never-applied", `${server}host.ts`, "for (const change of speakingUpdates)", "for (const change of [])", swaps, "B4 settings.update and models.batchReplace"],
];

const regex = (name) => `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
const run = (cwd, file, name) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=${regex(name)}`, file], { cwd, encoding: "utf8", timeout: 30_000 });
const named = (result, name, prefix) => result.stdout.split("\n").some((l) => l.replace(/^((not )?ok) \d+ - /, "$1 ") === `${prefix} ${name}`);
let killed = 0;
for (const [id, file, from, to, testFile, prefix] of mutations) {
  const names = analyzeTestFile(readFileSync(path.join(root, testFile), "utf8"), testFile).tests.map((t) => t.name).filter((n) => n.startsWith(prefix));
  assert.equal(names.length, 1, `${id}: designated test selection`);
  const [name] = names;
  const original = readFileSync(path.join(root, file), "utf8");
  assert.equal(original.split(from).length, 2, `${id}: fault anchor must exist exactly once`);
  const cwd = freshCopy(root);
  try {
    const control = run(cwd, testFile, name);
    assert.ok(control.status === 0 && named(control, name, "ok"), `${id}: unchanged control failed`);
    const scratch = path.join(cwd, file);
    writeFileSync(scratch, original.replace(from, to));
    const mutant = run(cwd, testFile, name);
    assert.ok(!mutant.error && mutant.status === 1 && named(mutant, name, "not ok"), `${id}: no named mutant failure`);
    assert.equal(readFileSync(path.join(root, file), "utf8"), original, `${id}: original changed`);
    killed++;
    console.log(`KILLED ${id} | ${testFile} | ${name}`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
console.log(`Spot mutations: ${killed}/${mutations.length} killed by their designated tests (all unchanged controls passed).`);
