import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const out = path.dirname(fileURLToPath(import.meta.url));
const repo = "/private/tmp/gg-req-codex-compute-protocol-20261113";
const resultPath = path.join(out, "result.json");
const owner = "/Users/snakesammy/.mirasim/agent-homes/codex-relay/config.toml";
const source = readFileSync(owner);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const cfg = JSON.parse(execFileSync("python3", ["-c", "import tomllib,json,sys;v=tomllib.load(open(sys.argv[1],'rb'));print(json.dumps({k:v.get(k) for k in ('model','model_reasoning_effort','openai_base_url')}))", owner], { encoding: "utf8" }));
const key = process.env.OPENAI_API_KEY;
assert.ok(key && cfg.model && cfg.model_reasoning_effort && cfg.openai_base_url, "declared owner config and process-local credential must resolve");
const clean = (s) => String(s).replaceAll(key, "[REDACTED_OWNER_VALUE]").replaceAll(cfg.openai_base_url, "[REDACTED_OWNER_VALUE]");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }), "");
const work = mkdtempSync("/private/tmp/q08-component-native-20261113-"); chmodSync(work, 0o700);
const configDir = path.join(work, "codex-home"), cwd = path.join(work, "workspace"); mkdirSync(configDir, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
const config = path.join(configDir, "config.toml");
writeFileSync(config, `model = ${JSON.stringify(cfg.model)}\nmodel_reasoning_effort = ${JSON.stringify(cfg.model_reasoning_effort)}\nopenai_base_url = ${JSON.stringify(cfg.openai_base_url)}\napproval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\n`.replaceAll("\\n", "\n"), { mode: 0o600 });
const runner = { command: "/Users/snakesammy/.local/bin/codex", args: ["app-server", "--listen", "stdio://"], env: { OPENAI_API_KEY: key } };
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "LANG", "LC_ALL"]) if (process.env[k]) runner.env[k] = process.env[k];
const options = { runner, cwd, configDir, models: { [cfg.model]: [cfg.model_reasoning_effort] }, timeoutMs: 15000 };
const model = { model: cfg.model, effort: cfg.model_reasoning_effort };
const result = { head, scope: "real native app-server through exported thin createCodexComputeProtocol; not a complete ComputeAdapter or Host/G2 integration", binaryVersion: execFileSync(runner.command, ["--version"], { encoding: "utf8" }).trim(), owner, ownerSha256: sha(source), credentialBinding: { configOwner: owner, processLocalEnvironment: "OPENAI_API_KEY", resolved: true, credentialLogged: false, credentialWritten: false }, requestedModel: cfg.model, requestedEffort: cfg.model_reasoning_effort, observedActualModelClaimed: false, startedAt: Date.now(), isolatedRoot: work, steps: [], events: [], quiescence: [], errors: [], complete: false };
const { createCodexComputeProtocol } = await import(pathToFileURL(path.join(repo, "packages/adapter-codex-compute/src/protocol.ts")).href);
const clients = [];
const log = (name, value) => { const row = { name, value, at: Date.now() }; result.steps.push(row); writeFileSync(path.join(out, "steps.json"), clean(JSON.stringify(result.steps, null, 2)) + "\n"); console.log("COMPONENT_NATIVE_RESULT", clean(JSON.stringify(row))); };
const bounded = async (p) => { let timer; try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("native component terminal deadline 120s")), 120000); })]); } finally { clearTimeout(timer); } };
const make = () => { console.log("command_execution", JSON.stringify({ command: [runner.command, ...runner.args], cwd, configDir, sourceHead: head, instance: clients.length + 1, secretEnvironmentValuesOmitted: true })); const c = createCodexComputeProtocol(options); clients.push(c); return c; };
async function marker(c, thread, text) { const started = await c.startTurn(thread, `Reply exactly ${text} and nothing else. Do not call any tools.`, model); assert.equal(started.ok, true); const done = await bounded(c.settled(thread, started.value.turnId)); assert.equal(done.ok, true); assert.equal(done.value.kind, "completed"); assert.equal(done.value.result.trim(), text); log(text, { threadId: thread, turnId: started.value.turnId, terminal: done.value, markerExact: true }); return started.value.turnId; }
try {
 const first = make(); assert.equal((await first.initialize()).ok, true); const started = await first.startThread(model); assert.equal(started.ok, true); const thread = started.value.threadId; log("native-thread-start", started); await marker(first, thread, "Q08_COMPONENT_NATIVE_A"); const quiet = await first.quiesce(5000); result.quiescence.push(quiet); assert.equal(quiet.ok, true); log("first-native-process-quiesced", quiet);
 const second = make(); assert.equal((await second.initialize()).ok, true); const resumed = await second.resumeThread(thread, model); assert.deepEqual(resumed, { ok: true, value: { threadId: thread } }); log("native-resume-same-thread", resumed); await marker(second, thread, "Q08_COMPONENT_NATIVE_B");
 const active = await second.startTurn(thread, "Reason in detail about a proof of convergence for a general nonconvex optimization problem, checking every assumption before giving a long answer. Do not use tools.", model); assert.equal(active.ok, true);
 const wrong = await second.steer(thread, "foreign-turn-id", "wrong id must be rejected"); assert.equal(wrong.ok, false); log("wrong-turn-refused", wrong);
 const steer = await second.steer(thread, active.value.turnId, "Instead explain why this problem has no general convergence proof. Do not use tools."); assert.equal(steer.ok, true); log("matching-native-steer-ack-only-not-semantic-claim", steer);
 const interrupt = await second.interrupt(thread, active.value.turnId); assert.deepEqual(interrupt, { ok: true, value: { status: "interrupted" } }); log("matching-native-interrupted-terminal", interrupt); const stopped = await bounded(second.settled(thread, active.value.turnId)); assert.equal(stopped.ok && stopped.value.kind, "stopped");
 const refusal = await second.startTurn(thread, "do not run", model, ["Bash"]); assert.equal(refusal.ok, false); log("nonempty-tools-refused", refusal);
 result.complete = true;
} catch (e) { result.errors.push(clean(e?.stack ?? e)); result.complete = false; console.log("COMPONENT_NATIVE_ERROR", clean(e?.stack ?? e)); }
finally {
 for (const [index, c] of clients.entries()) { try { const quiet = await c.quiesce(5000); result.quiescence.push(quiet); assert.equal(quiet.ok, true); for await (const event of c.events()) result.events.push({ instance: index + 1, event }); } catch (e) { result.errors.push(clean(e?.stack ?? e)); result.complete = false; } }
 const pids = [...new Set(result.events.map((r) => r.event.pid).filter(Number.isInteger))]; result.nativePids = pids; result.remainingOwnNativeProcesses = [];
 for (const pid of pids) { try { const text = execFileSync("ps", ["-p", String(pid), "-o", "pid=,ppid=,stat=,comm="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); if (text) result.remainingOwnNativeProcesses.push(text); } catch (e) { if (e.status !== 1) result.errors.push(clean(e)); } }
 result.ownerBytesUnchanged = readFileSync(owner).equals(source); rmSync(work, { recursive: true, force: true }); result.temporaryConfigRemoved = true; result.finishedAt = Date.now(); result.complete = result.complete && result.ownerBytesUnchanged && result.remainingOwnNativeProcesses.length === 0 && result.errors.length === 0;
 writeFileSync(resultPath, clean(JSON.stringify(result, null, 2)) + "\n"); console.log("COMPONENT_NATIVE_COMPLETE", JSON.stringify({ head, complete: result.complete, ownerBytesUnchanged: result.ownerBytesUnchanged, temporaryConfigRemoved: true, remainingOwnNativeProcesses: result.remainingOwnNativeProcesses.length }));
}
if (!result.complete) process.exitCode = 1;
