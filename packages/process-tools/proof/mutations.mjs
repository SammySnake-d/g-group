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
// --control: the same copies with no injection; every named witness must pass there (positive control for this harness)
const control = process.argv[3] === "--control";
fs.mkdirSync(out, { recursive: true });
const hash = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const cleanup = "packages/process-tools/src/cleanup.ts";
const gate = "scripts/gates/gates.ts";
const resident = "packages/adapter-cc-compute/src/resident.ts";
const oneShot = "packages/adapter-cc-compute/src/adapter.ts";
const r2 = "packages/process-tools/src/cleanup-confirm.test.ts";
const cc2 = "packages/adapter-cc-compute/src/shared-process-r2.test.ts";
const host = "packages/server/src/resident-stop.test.ts";
// Round-2 cases that cross packages copy every package and link node_modules/@g-group/* to the copy, so the mutant is what runs.
const whole = { dirs: ["packages", "scripts/gates"], links: true, timeout: 120000 };
// Round-2 process-tools cases keep the default copy; their witnesses use bounded waits of up to 15s, so they get a longer limit.
const own = { timeout: 60000 };
const cases = [
  { id: "M-PROC-01-main-not-exited", file: cleanup, from: 'if (!done) return { ok: false, reason: "CLI 主进程没有退出", remaining: pid === undefined ? [] : [pid] };', to: 'if (!done) return { ok: true, killed: 0 };', test: "packages/process-tools/src/cleanup.test.ts", name: "S-PROC-02" },
  { id: "M-PROC-02-forget-captured-setsid", file: cleanup, from: 'const after = treeNow(pid);', to: 'known = null; const after = treeNow(pid);', test: "packages/process-tools/src/cleanup.test.ts", name: "S-PROC-01" },
  { id: "M-PROC-03-no-force-escalation", file: cleanup, from: 'const timer = setTimeout(() => signalGroup(pid, "SIGKILL"), forceMs);', to: 'const timer = setTimeout(() => signalGroup(pid, "SIGTERM"), forceMs);', test: "packages/process-tools/src/cleanup.test.ts", name: "S-PROC-03" },
  { id: "M-PROC-04-unreadable-means-empty", file: cleanup, from: 'if (after === null || known === null) return { ok: false, reason: "读不到进程表,无法确认它启动的子进程都已退出", remaining: [] };', to: 'if (after === null || known === null) return { ok: true, killed: 0 };', test: "packages/process-tools/src/cleanup.test.ts", name: "S-PROC-05" },
  { id: "M-PROC-05-exit0-three-children-is-stopped", file: cleanup, from: 'if (pid === undefined) return { ok: true, killed: 0 };', to: 'return { ok: true, killed: 0 };', test: "packages/process-tools/src/cleanup.test.ts", name: "S-PROC-06" },
  { id: "M-LAYER-01-adapter-adapter-allowed", file: gate, from: 'adapter: ["domain", "kernel", "process"]', to: 'adapter: ["domain", "kernel", "process", "adapter"]', test: "scripts/gates/process-layer.test.ts", name: "S-PROC-LAYER-02" },
  { id: "M-LAYER-02-kernel-process-allowed", file: gate, from: 'kernel: ["domain"]', to: 'kernel: ["domain", "process"]', test: "scripts/gates/process-layer.test.ts", name: "S-PROC-LAYER-03" },
  { id: "M-LAYER-03-new-location-denied", file: gate, from: 'adapter: ["domain", "kernel", "process"]', to: 'adapter: ["domain", "kernel"]', test: "scripts/gates/process-layer.test.ts", name: "S-PROC-LAYER-01" },
  { id: "M-LAYER-04-relative-bypass", file: gate, from: 'if (!target.startsWith(`${ownInfo.dir}/`))', to: 'if (false && !target.startsWith(`${ownInfo.dir}/`))', test: "scripts/gates/process-layer.test.ts", name: "S-PROC-LAYER-05" },
  // ---- review round 1 (R1-01..R1-03), appended; the nine cases above are unchanged
  { id: "M-PROC-06-forget-confirmation", file: cleanup, from: "if (confirmed) return confirmed;", to: "/* confirmation forgotten */", test: r2, name: "S-PROC-07", ...own },
  { id: "M-PROC-07-group-kill-without-anchor", file: cleanup, from: 'if (snap && groupHeldByKnown(snap, pid)) signalGroup(pid, "SIGKILL");', to: 'signalGroup(pid, "SIGKILL");', test: r2, name: "S-PROC-07", ...own },
  { id: "M-PROC-08-adopt-reused-group-ps", file: cleanup, from: "if (snap) return groupHeldByKnown(snap, main) ? stamp(treeOf(main, snap.table), snap) : [];", to: "if (snap) return stamp(treeOf(main, snap.table), snap);", test: r2, name: "S-PROC-08", ...own },
  { id: "M-PROC-09-adopt-reused-group-pgrep", file: cleanup, from: "return group.some((k) => known?.get(k)?.pgid === main) ? groupRows(group, main) : [];", to: "return groupRows(group, main);", test: r2, name: "S-PROC-08", ...own },
  { id: "M-PROC-10-capture-after-exit", file: cleanup, from: "if (pid === undefined || pid <= 1 || windows || confirmed || mainExited()) return;", to: "if (pid === undefined || pid <= 1 || windows || confirmed) return;", test: r2, name: "S-PROC-08", ...own },
  { id: "M-PROC-11-exit-snapshot-reused-ps", file: cleanup, from: "if (snap) { remember(snap.table.some((r) => r.pid === pid) ? [] : stamp(treeOf(pid, snap.table), snap)); return true; }", to: "if (snap) { remember(stamp(treeOf(pid, snap.table), snap)); return true; }", test: r2, name: "S-PROC-09", ...own },
  { id: "M-PROC-12-exit-snapshot-reused-pgrep", file: cleanup, from: "remember(group.includes(pid) ? [] : groupRows(group, pid));", to: "remember(groupRows(group, pid));", test: r2, name: "S-PROC-09", ...own },
  { id: "M-PROC-13-A1-no-refresh-ps", file: cleanup, from: "for (const row of stamp(treeOf(root.pid, snap.table), snap)) known.set(row.pid, row);", to: "void root;", test: r2, name: "S-PROC-10", ...own },
  { id: "M-PROC-14-A1-no-refresh-pgrep", file: cleanup, from: "for (const row of treeByPgrep(root.pid, pgrep) ?? []) if (!known.has(row.pid)) known.set(row.pid, row);", to: "void root;", test: r2, name: "S-PROC-10", ...own },
  { id: "M-PROC-15-A12-captured-unreadable-continues", file: cleanup, from: 'if (after === null || known === null) return { ok: false, reason: "读不到进程表,无法确认它启动的子进程都已退出", remaining: [] };', to: 'if (after === null && known === null) return { ok: false, reason: "读不到进程表,无法确认它启动的子进程都已退出", remaining: [] };', test: r2, name: "S-PROC-11", ...own },
  { id: "M-PROC-16-A13-requeststop-not-idempotent", file: cleanup, from: "if (requested) return;", to: "/* not idempotent */", test: r2, name: "S-PROC-12", ...own },
  { id: "M-PROC-17-A11-windows-claims-success", file: cleanup, from: 'if (windows) return { ok: false, reason: "当前平台无法确认完整进程树已退出", remaining: [] };', to: "if (windows) return { ok: true, killed: 0 };", test: r2, name: "S-PROC-13", ...own },
  { id: "M-PROC-18-no-exit-snapshot", file: cleanup, from: "if (pid === undefined || pid <= 1 || windows) return true;", to: "return true;", test: r2, name: "S-PROC-14", ...own },
  { id: "M-PROC-19-identity-ignores-start-time", file: cleanup, from: "return r.born === undefined || now === undefined || Math.abs(now - r.born) <= BORN_SLACK_MS;", to: "return true;", test: r2, name: "S-PROC-15", ...own },
  { id: "M-PROC-20-no-start-time-slack", file: cleanup, from: "const BORN_SLACK_MS = 2000;", to: "const BORN_SLACK_MS = 0;", test: r2, name: "S-PROC-15", ...own },
  { id: "M-PROC-21-later-group-adopted", file: cleanup, from: "if (snap) return groupHeldByKnown(snap, main) ? stamp(treeOf(main, snap.table), snap) : [];", to: "if (snap) return stamp(treeOf(main, snap.table), snap);", test: r2, name: "S-PROC-16", ...own },
  { id: "M-PROC-22-A1-literal-refresh-left-to-pgrep", file: cleanup, from: "        if (snap) {\n          for (const root of", to: "        if (false) {\n          for (const root of", test: r2, name: "S-PROC-10", ...own },
  { id: "M-PROC-23-failed-spawn-waits-forever", file: cleanup, from: "if (child.pid === undefined) resolve();", to: "if (child.pid !== undefined) resolve();", test: r2, name: "S-PROC-17", ...own },
  { id: "M-PROC-24-pgrep-exit-record-dropped", file: cleanup, from: "    remember(group.includes(pid) ? [] : groupRows(group, pid));\n    return true;", to: "    return true;", test: r2, name: "S-PROC-14", ...own },
  { id: "M-PROC-25-unreadable-exit-record-ignored", file: cleanup, from: 'if (exitRecord === "unreadable") return { ok: false, reason: "读不到进程表,无法确认它启动的子进程都已退出", remaining: [] };', to: "/* unreadable exit record ignored */", test: r2, name: "S-PROC-18", ...own },
  { id: "M-CC-01-R1-01-failed-turn-requires-exit", file: resident, from: "if (!st.stopped) return { ok: true as const, killed: 0 };", to: "/* unstopped resident must exit */", test: host, name: "S-PROC-HOST-01", ...whole },
  { id: "M-CC-02-A6-confirm-only-last-handle", file: resident, from: "for (const cleanup of [...st.cleanups]) {", to: "for (const cleanup of st.cleanups.slice(-1)) {", test: cc2, name: "S-PROC-CC-03", ...whole },
  { id: "M-CC-03-A7-retire-without-capture", file: resident, from: "    proc.cleanup.capture();", to: "    void proc;", test: cc2, name: "S-PROC-CC-03", ...whole },
  { id: "M-CC-04-keep-confirmed-handles", file: resident, from: "st.cleanups.splice(st.cleanups.indexOf(cleanup), 1);", to: "void cleanup;", test: cc2, name: "S-PROC-CC-03", ...whole },
  { id: "M-CC-06-A16-resident-does-not-wait-for-main-exit", file: resident, from: "const result = await cleanup.quiesce(timeoutMs, resolveReapForceMs(cfg.reapForceMs, process.env.MIRASIM_REAP_FORCE_MS) + timeoutMs);", to: "const result = await cleanup.quiesce(timeoutMs, 0);", test: cc2, name: "S-PROC-CC-05", ...whole },
  { id: "M-CC-05-A10-frozen-stop-without-capture", file: oneShot, from: "if (!IS_WINDOWS && round.pid !== undefined && !round.exited) round.cleanup.capture();", to: "/* no capture before the frozen group SIGKILL */", test: cc2, name: "S-PROC-CC-04", ...whole },
];
const seal = Object.fromEntries([...new Set(cases.map((c) => c.file))].map((f) => [f, hash(path.join(root, f))]));
const results = [];
// Q08_MUT_ONLY=id1,id2 re-runs selected cases only (e.g. a case truncated by machine load); the full list is the proof
const only = process.env.Q08_MUT_ONLY ? new Set(process.env.Q08_MUT_ONLY.split(",")) : null;
for (const c of cases) {
  if (only && !only.has(c.id)) continue;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "q08-process-mutant-"));
  try {
    for (const dir of c.dirs ?? ["packages/process-tools", "scripts/gates"]) fs.cpSync(path.join(root, dir), path.join(temp, dir), { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
    if (!c.links) fs.symlinkSync(path.join(root, "node_modules"), path.join(temp, "node_modules"), "dir");
    else {
      // third-party modules from the checkout; workspace packages resolve to the mutated copy
      fs.mkdirSync(path.join(temp, "node_modules/@g-group"), { recursive: true });
      for (const e of fs.readdirSync(path.join(root, "node_modules"))) if (e !== "@g-group") fs.symlinkSync(path.join(root, "node_modules", e), path.join(temp, "node_modules", e));
      for (const pkg of fs.readdirSync(path.join(temp, "packages"))) fs.symlinkSync(path.join(temp, "packages", pkg), path.join(temp, "node_modules/@g-group", pkg), "dir");
    }
    const f = path.join(temp, c.file), source = fs.readFileSync(f, "utf8");
    assert.equal(source.split(c.from).length - 1, 1, `${c.id}: exact injection count`);
    if (!control) fs.writeFileSync(f, source.replace(c.from, c.to));
    const cmd = [process.execPath, "--test", "--test-reporter=tap", "--test-name-pattern", c.name, c.test];
    const p = spawnSync(cmd[0], cmd.slice(1), { cwd: temp, encoding: "utf8", timeout: c.timeout ?? 20000, maxBuffer: 2 * 1024 * 1024 });
    const text = (p.stdout ?? "") + (p.stderr ?? "");
    fs.writeFileSync(path.join(out, `${c.id}${control ? ".control" : ""}.txt`), text);
    if (control) {
      const passed = p.status === 0 && !p.error && new RegExp(`^ok \\d+ - ${c.name}\\b`, "m").test(text);
      results.push({ id: c.id, expectedTest: c.name, command: cmd, exit: p.status, signal: p.signal, executorError: p.error?.message ?? null, passed });
      assert.ok(passed, `${c.id}: named witness does not pass on the unmutated copy`);
      continue;
    }
    const namedFailure = new RegExp(`^not ok \\d+ - ${c.name}\\b`, "m").test(text);
    const result = { id: c.id, expectedTest: c.name, command: cmd, exit: p.status, signal: p.signal, executorError: p.error?.message ?? null, namedFailure, killed: p.status === 1 && !p.error && namedFailure };
    results.push(result);
    assert.ok(result.killed, `${c.id} survived or failed for an unrelated reason`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
const unchanged = Object.entries(seal).every(([f, h]) => hash(path.join(root, f)) === h);
assert.ok(unchanged, "candidate inputs changed during mutation proof");
if (control) {
  fs.writeFileSync(path.join(out, "control.json"), JSON.stringify({ results, sourceSeal: seal, sourceUnchanged: unchanged, passed: results.filter((r) => r.passed).length }, null, 2));
  console.log(JSON.stringify({ control: true, passed: results.length, sourceUnchanged: unchanged }));
} else {
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ results, sourceSeal: seal, sourceUnchanged: unchanged, killed: results.filter((r) => r.killed).length, survived: results.filter((r) => !r.killed).length }, null, 2));
  console.log(JSON.stringify({ killed: results.length, survived: 0, sourceUnchanged: unchanged }));
}
