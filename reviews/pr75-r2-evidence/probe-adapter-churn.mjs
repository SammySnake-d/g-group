// PR #75 第 2 轮探针:经生产适配器入口 createComputeAdapter → spawn → stop → quiesce(不直接调 confirmStopped)。
// 用法: node probe-adapter-churn.mjs <仓库绝对路径> [trials]   判据:quiesce 返回 ok:true 后仍有本探针登记过的进程存活 → defect
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
const [repo, trialsArg] = process.argv.slice(2); const trials = Number(trialsArg ?? 5);
const { createComputeAdapter } = await import(pathToFileURL(path.join(repo, "packages/adapter-cc-compute/src/adapter.ts")));
const FAKE = path.join(repo, "packages/adapter-cc-compute/test-support/fake-claude.mjs");
const WRAP = fileURLToPath(new URL("./churn-cli-wrapper.mjs", import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const brief = { task: "跑一个很慢的脚本", rules: [], tools: ["Read"], credentialRefs: [], placement: "local" };
const runs = [];
for (let i = 0; i < trials; i++) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr75-r2-adapter-")); const rec = { trial: i };
  const pids = () => { try { return fs.readFileSync(path.join(dir, "pids"), "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; } };
  const a = createComputeAdapter({ runner: { command: process.execPath, args: [WRAP, `--fake-dir=${dir}${path.sep}`] }, hostEnv: { FAKE_SCRIPT: JSON.stringify({ reports: [{ kind: "started", summary: "开始" }], hang: "graceful" }), FAKE_RECORD: path.join(dir, "record.jsonl"), CHURN_DIR: dir, CHURN_FAKE: FAKE, CHURN_GAP: process.env.CHURN_GAP ?? "0.015" }, reapForceMs: 800 });
  try {
    const r = await a.spawn(brief); if (!r.ok) throw new Error(`spawn 失败 ${JSON.stringify(r)}`);
    for await (const e of a.events()) if (e.computeId === r.computeId && e.kind === "started") break;
    const end = Date.now() + 8000; while (pids().length < 1) { if (Date.now() > end) throw new Error("负载未就绪"); await delay(5); }
    fs.writeFileSync(path.join(dir, "go"), "x"); await delay(80);
    rec.stop = await a.stop(r.computeId);
    rec.quiesce = await a.quiesce(r.computeId, 5000);
    await delay(30);
    const all = pids(); rec.registered = all.length; rec.survivors = all.filter(alive).length;
    rec.defect = rec.quiesce.ok === true && rec.survivors > 0;
  } catch (e) { rec.error = String(e?.stack ?? e).split("\n").slice(0, 3).join(" | "); }
  finally {
    fs.writeFileSync(path.join(dir, "go"), "x"); fs.writeFileSync(path.join(dir, "finish"), "x");
    const end = Date.now() + 6000; while (pids().some(alive) && Date.now() < end) await delay(50);
    rec.leftAfterCleanup = pids().filter(alive).length;
    try { await a.close?.(); } catch { /* 无 close */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  runs.push(rec);
}
const summary = { trials, quiesceOk: runs.filter((r) => r.quiesce?.ok === true).length, defects: runs.filter((r) => r.defect).length, errors: runs.filter((r) => r.error).length, survivors: runs.map((r) => r.survivors ?? null), left: runs.map((r) => r.leftAfterCleanup) };
console.log(JSON.stringify({ repo, summary, runs }, null, 1));
process.exit(summary.defects ? 1 : summary.errors ? 3 : 0);
