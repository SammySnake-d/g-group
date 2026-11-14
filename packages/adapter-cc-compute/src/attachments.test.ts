// AC-44 ② Compute 受阻时附截图:report_progress 的 blocked 可带 attachments(工作目录内文件的相对路径),
// 适配器原样透传到 blocked 事件;不是字符串数组的汇报被拒收。和 adapter.test.ts 一样起真实子进程:
// 假 CLI(test-support/fake-claude.mjs)按 --mcp-config 真的起 report_progress MCP 服务器、走 JSON-RPC 汇报。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createComputeAdapter } from "./adapter.ts";
import { reportErrors } from "./report-schema.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-claude.mjs", import.meta.url));
const brief = () => ({ task: "登录后台导出订单", rules: [], tools: ["Read", "Write"], credentialRefs: [], placement: "local" });

// 只回收本文件建的进程与目录:命令行里带本测试目录的进程才杀(做法同 adapter.test.ts RR-06)
const ownDirs = new Set<string>();
function reapOwn() {
  let out = "";
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch {
    out = "";
  }
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) <= 1 || Number(m[1]) === process.pid) continue;
    if (![...ownDirs].some((d) => m[2]!.includes(`${d}${path.sep}`))) continue;
    try {
      process.kill(-Number(m[1]), "SIGKILL");
    } catch {
      /* 不是组长或已退出 */
    }
    try {
      process.kill(Number(m[1]), "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  for (const d of ownDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  ownDirs.clear();
}
afterEach(reapOwn);
setTimeout(() => {
  reapOwn();
  console.error("attachments.test.ts 超过 120 秒,强制结束");
  process.exit(1);
}, 120_000).unref();

function fake(script: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cc-att-"));
  ownDirs.add(dir);
  const record = path.join(dir, "record.jsonl");
  return { runner: { command: process.execPath, args: [FAKE, `--fake-dir=${dir}${path.sep}`] }, hostEnv: { FAKE_SCRIPT: JSON.stringify(script), FAKE_RECORD: record }, reapForceMs: 1500 };
}

test("AC-44 ②:blocked 汇报可带 attachments(工作目录内文件的相对路径),原样透传到 blocked 事件", async () => {
  const a = createComputeAdapter(fake({ reports: [{ kind: "started", summary: "开始" }, { kind: "blocked", summary: "登录页出现验证码,截图 captcha.png", needs: "请告诉我验证码", attachments: ["captcha.png"] }], result: "success" }));
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["started", "blocked"]);
  const b = evs[1];
  assert.deepEqual(b?.kind === "blocked" ? b.attachments : null, ["captcha.png"]);
  assert.deepEqual(a.rejectedReports(r.computeId), []);
  await a.stop(r.computeId);
});

test("AC-44 ②:attachments 不是字符串数组的汇报被拒收;没带 attachments 的 blocked 事件里没有这个字段", async () => {
  assert.match(reportErrors({ kind: "blocked", summary: "x", needs: "y", attachments: "captcha.png" }).join(";"), /attachments 须为字符串数组/);
  assert.match(reportErrors({ kind: "blocked", summary: "x", needs: "y", attachments: [1] }).join(";"), /attachments 须为字符串数组/);
  assert.deepEqual(reportErrors({ kind: "blocked", summary: "x", needs: "y", attachments: ["a.png"] }), []);
  const a = createComputeAdapter(fake({ reports: [{ kind: "started", summary: "开始" }, { kind: "blocked", summary: "等令牌", needs: "请提供令牌" }], result: "success" }));
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.equal(evs[1]?.kind, "blocked");
  assert.equal(Object.hasOwn(evs[1]!, "attachments"), false);
  await a.stop(r.computeId);
});
