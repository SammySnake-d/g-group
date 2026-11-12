// Thin disposable mutants only; never patch an observed candidate or old CC tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const out = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2] && !out.startsWith(`${root}/`), "external proof output required");
fs.mkdirSync(out, { recursive: true });
const hash = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const cleanup = "packages/process-tools/src/cleanup.ts";
const gate = "scripts/gates/gates.ts";
const cases = [
  { id: "M-PROC-01-main-not-exited", file: cleanup, from: 'if (!done) return { ok: false, reason: "CLI 主进程没有退出", remaining: pid === undefined ? [] : [pid] };', to: 'if (!done) return { ok: true, killed: 0 };', test: "packages/process-tools/src/cleanup.test.ts", name: "S-PROC-02" },
  { id: "M-PROC-02-forget-captured-setsid", file: cleanup, from: 'const after = treeNow(pid);', to: 'known = null; const after = treeNow(pid);', test: "packages/process-tools/src/cleanup.test.ts", name: "S-PROC-01" },
  { id: "M-PROC-03-no-force-escalation", file: cleanup, from: 'const timer = setTimeout(() => signalGroup(pid, "SIGKILL"), forceMs);', to: 'const timer = setTimeout(() => signalGroup(pid, "SIGTERM"), forceMs);', test: "packages/process-tools/src/cleanup.test.ts", name: "S-PROC-03" },
  { id: "M-PROC-04-unreadable-means-empty", file: cleanup, from: 'if (after === null || known === null) return { ok: false, reason: "读不到进程表,无法确认它启动的子进程都已退出", remaining: [] };', to: 'if (after === null || known === null) return { ok: true, killed: 0 };', test: "packages/process-tools/src/cleanup.test.ts", name: "S-PROC-05" },
  { id: "M-LAYER-01-adapter-adapter-allowed", file: gate, from: 'adapter: ["domain", "kernel", "process"]', to: 'adapter: ["domain", "kernel", "process", "adapter"]', test: "scripts/gates/process-layer.test.ts", name: "S-PROC-LAYER-02" },
  { id: "M-LAYER-02-kernel-process-allowed", file: gate, from: 'kernel: ["domain"]', to: 'kernel: ["domain", "process"]', test: "scripts/gates/process-layer.test.ts", name: "S-PROC-LAYER-03" },
  { id: "M-LAYER-03-new-location-denied", file: gate, from: 'adapter: ["domain", "kernel", "process"]', to: 'adapter: ["domain", "kernel"]', test: "scripts/gates/process-layer.test.ts", name: "S-PROC-LAYER-01" },
  { id: "M-LAYER-04-relative-bypass", file: gate, from: 'if (!target.startsWith(`${ownInfo.dir}/`))', to: 'if (false && !target.startsWith(`${ownInfo.dir}/`))', test: "scripts/gates/process-layer.test.ts", name: "S-PROC-LAYER-05" },
];
const seal = { [cleanup]: hash(path.join(root, cleanup)), [gate]: hash(path.join(root, gate)) };
const results = [];
for (const c of cases) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "q08-process-mutant-"));
  try {
    for (const dir of ["packages/process-tools", "scripts/gates"]) fs.cpSync(path.join(root, dir), path.join(temp, dir), { recursive: true });
    fs.symlinkSync(path.join(root, "node_modules"), path.join(temp, "node_modules"), "dir");
    const f = path.join(temp, c.file), source = fs.readFileSync(f, "utf8");
    assert.equal(source.split(c.from).length - 1, 1, `${c.id}: exact injection count`);
    fs.writeFileSync(f, source.replace(c.from, c.to));
    const cmd = [process.execPath, "--test", "--test-reporter=tap", "--test-name-pattern", c.name, c.test];
    const p = spawnSync(cmd[0], cmd.slice(1), { cwd: temp, encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    const text = (p.stdout ?? "") + (p.stderr ?? "");
    fs.writeFileSync(path.join(out, `${c.id}.txt`), text);
    const namedFailure = new RegExp(`^not ok \\d+ - ${c.name}\\b`, "m").test(text);
    const result = { id: c.id, expectedTest: c.name, command: cmd, exit: p.status, signal: p.signal, executorError: p.error?.message ?? null, namedFailure, killed: p.status === 1 && !p.error && namedFailure };
    results.push(result);
    assert.ok(result.killed, `${c.id} survived or failed for an unrelated reason`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
const unchanged = Object.entries(seal).every(([f, h]) => hash(path.join(root, f)) === h);
assert.ok(unchanged, "candidate inputs changed during mutation proof");
fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ results, sourceSeal: seal, sourceUnchanged: unchanged, killed: results.filter((r) => r.killed).length, survived: results.filter((r) => !r.killed).length }, null, 2));
console.log(JSON.stringify({ killed: results.length, survived: 0, sourceUnchanged: unchanged }));
