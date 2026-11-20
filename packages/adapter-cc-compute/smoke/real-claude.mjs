#!/usr/bin/env node
// 模型网关配置由宿主经 hostEnv 显式交给 CLI(这里从本进程环境挑出 ANTHROPIC_BASE_URL 与鉴权变量);
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createComputeAdapter } from "../src/index.ts";

const pick = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"];
const hostEnv = Object.fromEntries(pick.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
if (!hostEnv.ANTHROPIC_API_KEY && hostEnv.ANTHROPIC_AUTH_TOKEN) hostEnv.ANTHROPIC_API_KEY = hostEnv.ANTHROPIC_AUTH_TOKEN;

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-smoke-"));
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 600_000);
const adapter = createComputeAdapter({ hostEnv });
const t0 = Date.now();
const r = await adapter.spawn({
  task: "在当前目录完成两个阶段:阶段1 创建 a.txt 写入 hello;阶段2 创建 b.txt 写入 a.txt 内容的大写。每完成一个阶段用 report_progress 报 milestone,开始时报 started 并带 constraintVer=1,最后报 completed。",
  rules: ["只在当前目录内写文件"],
  tools: ["Read", "Write"],
  credentialRefs: ["vault://smoke/none"],
  placement: "local",
}, { cwd });
console.log(`cwd: ${cwd}`);
console.log(`hostEnv 键: ${Object.keys(hostEnv).join(", ")}(值不打印)`);
if (!r.ok) { console.log(`spawn 被拒: ${r.reason}`); process.exit(1); }
console.log(`manifest: ${JSON.stringify(r.manifest)}`);

const killer = setTimeout(() => { console.log(`超时 ${timeoutMs}ms,调用 stop`); void adapter.stop(r.computeId); }, timeoutMs);
const evs = await adapter.settled(r.computeId);
clearTimeout(killer);
for (const e of evs) console.log(`event: ${JSON.stringify(e)}`);
console.log(`snapshot: ${JSON.stringify(adapter.snapshot(r.computeId))}`);
for (const f of ["a.txt", "b.txt"]) console.log(`${f}: ${fs.existsSync(path.join(cwd, f)) ? JSON.stringify(fs.readFileSync(path.join(cwd, f), "utf8")) : "(不存在)"}`);
console.log(`耗时 ${Math.round((Date.now() - t0) / 1000)}s,终态 ${evs.at(-1)?.kind ?? "(无)"}`);
process.exit(evs.at(-1)?.kind === "completed" ? 0 : 2);
