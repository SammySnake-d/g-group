#!/usr/bin/env node
// 手动实跑(AC-51,不进 npm test,要额度):经 createResidentComputeAdapter 起真实 Claude Code 常驻会话,跑暗号测试:
//   第 1 轮模型 A 记暗号 → 第 2 轮换 B 问暗号 → 第 3 轮换一个不存在的模型(应被拒、这一轮不发出)→ 第 4 轮换回 A 问暗号
//   → 第 5 轮模型不变只把 effort 改成 low(应只发 apply_flag_settings,网关记录的 effort 随之变成 low)。
// 结束后从网关用量日志 ~/.config/magpie/usage.jsonl 只摘本次会话(native_session = 会话 id)的行:时间、请求模型、实际模型、effort、状态。
// 用法:node packages/adapter-cc-compute/smoke/resident-real.mjs <模型A> <模型B> > proof/ac51-resident-real.txt 2>&1
// 网关地址与令牌只经 hostEnv 交给 CLI,不打印。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createResidentComputeAdapter } from "../src/resident-entry.ts";

const [A, B, BOGUS = "ai-iisbo/no-such-model-xyz"] = process.argv.slice(2);
if (!A || !B) { console.error("用法: resident-real.mjs <模型A> <模型B> [不存在的模型]"); process.exit(64); }
const pick = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const hostEnv = Object.fromEntries(pick.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
if (!hostEnv.ANTHROPIC_API_KEY && hostEnv.ANTHROPIC_AUTH_TOKEN) hostEnv.ANTHROPIC_API_KEY = hostEnv.ANTHROPIC_AUTH_TOKEN;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccr-real-"));
const t0 = new Date();
const log = (s) => console.log(`[${((Date.now() - t0.getTime()) / 1000).toFixed(1)}s] ${s}`);
log(`claude 版本: ${execFileSync("claude", ["--version"], { encoding: "utf8" }).trim()};hostEnv 键: ${Object.keys(hostEnv).join(", ")}(值不打印);cwd ${cwd}`);
log(`模型 A=${A} B=${B} 不存在的模型=${BOGUS}`);

const adapter = createResidentComputeAdapter({ hostEnv, switchTimeoutMs: 90_000 });
const events = [];
void (async () => { for await (const e of adapter.events()) { events.push(e); log(`event ${JSON.stringify(e)}`); } })();
const ends = () => events.filter((e) => e.kind === "completed" || e.kind === "failed");
const until = async (n, ms = 240_000) => { const end = Date.now() + ms; while (ends().length < n) { if (Date.now() > end) throw new Error(`第 ${n} 轮超时`); await new Promise((r) => setTimeout(r, 200)); } };
/** 续接并等这一轮结束;续接被拒(这一轮没发出)时不等 */
const turn = async (label, text, tm) => {
  const before = ends().length;
  const t = Date.now();
  const x = await adapter.resume(id, text, tm);
  log(`${label} resume(${JSON.stringify(tm)}) → ${JSON.stringify(x)}(${((Date.now() - t) / 1000).toFixed(1)}s)`);
  if (x.ok) await until(before + 1);
  log(`${label} 结束;已结束轮数 ${ends().length};同一 pid 活着=${alive(pid)}`);
  return x;
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const r = await adapter.spawn({ task: "这是一次会话测试。请记住暗号 PLUM-7731。不要调用任何工具,只回复:已记住。", rules: [], tools: [], credentialRefs: [], placement: "local" }, { cwd, model: A });
if (!r.ok) { log(`spawn 被拒 ${r.reason}`); process.exit(1); }
const id = r.computeId;
let pid;
try {
  await until(1);
  const started = events.find((e) => e.kind === "started");
  pid = started?.pid;
  log(`第 1 轮结束;pid=${pid} 会话=${started?.sessionId} 进程活着=${alive(pid)}`);
  await turn("第 2 轮", "我刚才让你记住的暗号是什么?只回复暗号本身,不要调用工具。", { model: B });
  await turn("第 3 轮(换到不存在的模型)", "如果你看到这句话,只回复:这一轮发出了。", { model: BOGUS });
  await turn("第 4 轮", "再说一次暗号,只回复暗号本身,不要调用工具。", { model: A });
  await turn("第 5 轮(只改 effort)", "最后一次:暗号是什么?只回复暗号本身。", { model: A, effort: "low" });
  log(`started 事件数=${events.filter((e) => e.kind === "started").length}`);
} finally {
  await adapter.stop(id);
  const end = Date.now() + 15_000;
  while (pid && alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  log(`stop 后进程退出=${pid ? !alive(pid) : "无 pid"}`);
}
const sid = events.find((e) => e.kind === "started")?.sessionId;
// 网关核对:只读本次会话的行,只摘非敏感字段
await new Promise((r) => setTimeout(r, 1500));
const usage = path.join(os.homedir(), ".config/magpie/usage.jsonl");
const rows = [];
for (const line of fs.readFileSync(usage, "utf8").split("\n").slice(-5000)) {
  let d; try { d = JSON.parse(line); } catch { continue; }
  if (d.native_session !== sid && d.session !== sid) continue;
  rows.push({ t: d.t, req: d.req, model: d.model, served: d.served, effort: d.effort, status: d.status, stop: d.stop });
}
console.log(`\n== 网关用量日志中本次会话(${sid})的请求,共 ${rows.length} 条 ==`);
for (const x of rows) console.log(JSON.stringify(x));
console.log("\n== 每轮结果 ==");
for (const e of ends()) console.log(JSON.stringify({ kind: e.kind, model: e.model, models: e.models, result: e.kind === "completed" ? e.result : e.reason }));
fs.rmSync(cwd, { recursive: true, force: true });
process.exit(0);
