// Spot faults run only on disposable copies, including workspace links pointing into each copy.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../../..");
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: true });
const cleanup = "packages/process-tools/src/cleanup.ts";
const protocol = "packages/adapter-codex-compute/src/protocol.ts";
const resident = "packages/adapter-cc-compute/src/resident.ts";
const cc = "packages/adapter-cc-compute/src/adapter.ts";
const processTest = "packages/process-tools/src/cleanup-confirm.test.ts";
const wireTest = "packages/adapter-codex-compute/src/protocol.test.ts";
const ccTest = "packages/adapter-cc-compute/src/shared-process-r2.test.ts";
const cases = [
  ["R1-03-no-line-ps", protocol, "const onLine = (line: string) => {", "const onLine = (line: string) => { cleanup?.capture();", "packages/adapter-codex-compute/proof/resources.mjs", "R1-03"],
  ["R1-05-grace", protocol, "setTimeout(() => cleanup?.requestStop(reapForceMs), timeoutMs)", "setTimeout(() => cleanup?.requestStop(50), timeoutMs)", "packages/adapter-codex-compute/proof/resources.mjs", "R1-05"],
  ["A1", cleanup, "for (const row of stamp(treeOf(root.pid, snap.table), snap)) known.set(row.pid, row);", "void root;", processTest, "S-PROC-10"],
  ["A6", resident, "for (const cleanup of [...st.cleanups])", "for (const cleanup of st.cleanups.slice(-1))", ccTest, "S-PROC-CC-03"],
  ["A7", resident, "    proc.cleanup.capture();", "    void proc;", ccTest, "S-PROC-CC-03"],
  ["A10", cc, "      round.cleanup.capture();", "      void round;", ccTest, "S-PROC-CC-04"],
  ["A12", cleanup, "if (after === null || known === null)", "if (after === null && known === null)", processTest, "S-PROC-11"],
  ["A13", cleanup, "if (requested) return;", "/* repeated signals allowed */", processTest, "S-PROC-12"],
  ["memoized-exit", cleanup, "if (confirmed) return confirmed;", "/* lost receipt */", processTest, "S-PROC-07"],
  ["identity", "packages/process-tools/src/procgroup.ts", 'if (known.identity === now.identity) return "alive";', 'return "alive";', processTest, "S-PROC-15"],
  ["exit-snapshot", cleanup, 'exitRecord = recordGroupAtExit() ? "read" : "unreadable";', 'exitRecord = "read";', processTest, "S-PROC-14"],
  ["RPC-error-fidelity", protocol, "error: { code: msg.error.code, message: msg.error.message,", "error: { code: 0, message: msg.error.message,", wireTest, "lifecycle fault turn-rpc-error"],
  ["resume-id", protocol, 'r.value.thread.id !== wantedThread', "false", wireTest, "lifecycle fault resume-mismatch"],
  ["steer-id", protocol, 'r.value.turnId !== expectedTurnId', "false", wireTest, "lifecycle fault steer-mismatch"],
  ["interrupt-kind", protocol, 'terminal.value.kind === "stopped"', "true", wireTest, "lifecycle fault interrupt-completed"],
  ["persistent-thread", protocol, "ephemeral: false", "ephemeral: true", wireTest, "persistent thread options"],
  ["approval-policy", protocol, 'approvalPolicy: "never"', 'approvalPolicy: "on-request"', wireTest, "persistent thread options"],
  ["early-bound", protocol, "notes.length >= 64", "false", wireTest, "lifecycle fault early-flood"],
  ["V02-HOME", protocol, 'HOME: process.env.HOME ?? ""', "HOME: options.configDir", wireTest, "CXP-R1-02 native child"],
  ["V02-CODEX_HOME", protocol, "CODEX_HOME: options.configDir", 'CODEX_HOME: options.cwd + "/wrong"', wireTest, "CXP-01"],
  ["handoff", "packages/server/src/host.ts", "return this.switchHarness(e, row, a, resolved, reason);", 'return this.turnRefused(e.taskId, e.computeId, row, "switch disabled");', "packages/server/src/harness-switch.test.ts", "boundary handoff"],
];
const sourceHash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sealed = Object.fromEntries([...new Set(cases.map(c => c[1]))].map(file => [file, sourceHash(path.join(root, file))]));
const reference = spawnSync("git", ["show", "refs/remotes/ref/shared-process-cleanup:packages/adapter-cc-compute/src/shared-process-r2.test.ts"], { cwd: root, encoding: "utf8" });
assert.equal(reference.status, 0, "owning reference witnesses must be available");
const results = [];
for (const [id, file, from, to, test, name] of cases) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "p1b-mutant-"));
  try {
    fs.cpSync(path.join(root, "packages"), path.join(temp, "packages"), { recursive: true });
    const modules = path.join(temp, "node_modules"); fs.mkdirSync(path.join(modules, "@g-group"), { recursive: true });
    for (const name of fs.readdirSync(path.join(root, "node_modules"))) if (name !== "@g-group") fs.symlinkSync(path.join(root, "node_modules", name), path.join(modules, name));
    for (const name of fs.readdirSync(path.join(temp, "packages"))) if (fs.existsSync(path.join(temp, "packages", name, "package.json"))) fs.symlinkSync(path.join(temp, "packages", name), path.join(modules, "@g-group", name));
    fs.writeFileSync(path.join(temp, ccTest), reference.stdout);
    const target = path.join(temp, file), original = fs.readFileSync(target, "utf8");
    assert.ok(original.includes(from), id + " mutation anchor drifted");
    fs.writeFileSync(target, original.replace(from, to));
    const p = spawnSync(process.execPath, (test.endsWith(".mjs") ? [test] : ["--test", "--test-reporter=tap", "--test-name-pattern", name, test]), { cwd: temp, env: { ...process.env, P1B_PROGRESS_COUNT: "40" }, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    const text = (p.stdout ?? "") + (p.stderr ?? "");
    fs.writeFileSync(path.join(output, id + ".log"), text);
    const killed = p.status === 1 && !p.error && (test.endsWith(".mjs") || text.includes("not ok ")) && text.includes("ERR_ASSERTION");
    results.push({ id, name, killed, exit: p.status, error: p.error?.message ?? null });
    console.log(id + ": " + (killed ? "killed" : "SURVIVED / invalid execution"));
    assert.ok(killed, id + " survived or lacked an assertion witness");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
for (const [file, hash] of Object.entries(sealed)) assert.equal(sourceHash(path.join(root, file)), hash);
fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ results, sourceSeal: sealed, sourceUnchanged: true }, null, 2));
console.log("killed " + results.length + "/" + cases.length + "; candidate source unchanged");
