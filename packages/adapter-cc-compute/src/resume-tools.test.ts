// AC-17 续接换工具清单:宿主按本人授权在续接时放开或收回写工具。用假 CLI(test-support/fake-claude.mjs)核对真实传给 CLI 的参数。
// 只回收本文件自己起的进程(命令行里带本文件的临时目录),跑完删掉临时目录。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createComputeAdapter } from "./adapter.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-claude.mjs", import.meta.url));
const brief = (over: Record<string, unknown> = {}) => ({ task: "把 a.txt 改成大写", rules: ["改代码前先问我"], tools: ["Read"], credentialRefs: [], placement: "local", ...over });
const ownDirs = new Set<string>();
function reapOwn() {
  let out = "";
  try { out = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }); } catch { out = ""; }
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) <= 1 || Number(m[1]) === process.pid) continue;
    if (![...ownDirs].some((d) => m[2]!.includes(`${d}${path.sep}`))) continue;
    try { process.kill(-Number(m[1]), "SIGKILL"); } catch { /* 不是组长或已退出 */ }
    try { process.kill(Number(m[1]), "SIGKILL"); } catch { /* 已退出 */ }
  }
  for (const d of ownDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  ownDirs.clear();
}
afterEach(reapOwn);
setTimeout(() => { reapOwn(); console.error("resume-tools.test.ts 超过 120 秒,强制结束"); process.exit(1); }, 120_000).unref();
function fake(script: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cc-rt-"));
  ownDirs.add(dir);
  const record = path.join(dir, "record.jsonl");
  return { record, options: { runner: { command: process.execPath, args: [FAKE, `--fake-dir=${dir}${path.sep}`] }, hostEnv: { FAKE_SCRIPT: JSON.stringify(script), FAKE_RECORD: record }, reapForceMs: 1500 } };
}
type Launch = { argv: string[] };
const launches = (record: string): Launch[] => fs.readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Launch);
const flagOf = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

test("AC-17 续接时换工具清单:授权后下一轮 CLI 的 --tools/--allowedTools 带上 Write;不给就沿用原清单", async () => {
  const f = fake({
    reports: [{ kind: "started", summary: "开始" }, { kind: "blocked", summary: "要写 a.txt", needs: "需要用户同意写 a.txt" }], result: "success",
    resume: { reports: [{ kind: "milestone", stage: "写", summary: "已写" }], result: "success", text: "完成" },
  });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief({ tools: ["Read", "Grep"] }));
  assert.ok(r.ok);
  await a.settled(r.computeId);
  const [l1] = launches(f.record);
  assert.equal(flagOf(l1!.argv, "--tools"), "Read,Grep");
  assert.deepEqual(await a.resume(r.computeId, "用户已同意写 a.txt", undefined, { tools: ["Read", "Grep", "Write"] }), { ok: true });
  const second = await a.settled(r.computeId);
  assert.deepEqual(second.map((e) => e.kind), ["started", "milestone", "completed"]);
  const [, l2] = launches(f.record);
  assert.equal(flagOf(l2!.argv, "--tools"), "Read,Grep,Write");
  assert.ok(flagOf(l2!.argv, "--allowedTools")!.split(",").includes("Write"));
});

test("AC-17 续接的工具清单不合 brief 合同、选项多了字段:拒绝且不起新进程,冻结的一轮保持原样", async () => {
  const f = fake({
    reports: [{ kind: "started", summary: "开始" }, { kind: "blocked", summary: "要写", needs: "需要同意" }], result: "success",
    resume: { reports: [], result: "success", text: "完成" },
  });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief({ tools: ["Read"] }));
  assert.ok(r.ok);
  await a.settled(r.computeId);
  const bad = await a.resume(r.computeId, "继续", undefined, { tools: ["Read", "Bash(rm:*)"] });
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /工具清单不合格/);
  const extra = await a.resume(r.computeId, "继续", undefined, { tools: ["Read"], model: "x" } as never);
  assert.equal(extra.ok, false);
  assert.match((extra as { reason: string }).reason, /只认 tools/);
  assert.equal(launches(f.record).length, 1, "被拒的续接不起进程");
  assert.deepEqual(await a.resume(r.computeId, "继续"), { ok: true });
  await a.settled(r.computeId);
  assert.equal(flagOf(launches(f.record)[1]!.argv, "--tools"), "Read");
});

