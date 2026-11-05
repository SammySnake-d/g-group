#!/usr/bin/env node
// 测试用假 claude CLI:接受与真实 `claude -p ... --output-format stream-json --verbose` 相同的参数,
// 按 stream-json 格式在 stdout 逐行输出 system/init、assistant tool_use、user tool_result、result。
// report_progress 不是假装的:按 --mcp-config 真的起 MCP 服务器、走 JSON-RPC 调 tools/call,把服务器的回复原样作为 tool_result。
// 和真实 CLI 一样,工具不在 --allowedTools 里时不调用,回 is_error 的权限拒绝。
// 剧本来自环境变量 FAKE_SCRIPT(JSON);每次启动把 pid/argv/env/cwd/首个提示追加到 FAKE_RECORD。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const prompt = flag("-p");
const resume = flag("--resume");
const allowed = (flag("--allowedTools") ?? "").split(",").filter(Boolean);
const builtins = (flag("--tools") ?? "").split(",").filter(Boolean);
const script = JSON.parse(process.env.FAKE_SCRIPT ?? "{}");
const plan = resume ? (script.resume ?? { reports: [], result: "success" }) : script;

// 挂起剧本在写记录之前就装好信号处理,避免测试读到记录后发的 SIGTERM 落在默认处理上。
// graceful:收到 SIGTERM 后 300ms 才退出;stubborn:忽略 SIGTERM,只有 SIGKILL 能结束
if (plan.hang) process.on("SIGTERM", () => { if (plan.hang === "graceful") setTimeout(() => process.exit(143), 300); });

if (process.env.FAKE_RECORD) {
  fs.appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ pid: process.pid, argv, env: process.env, cwd: process.cwd(), prompt,
    mcpConfig: flag("--mcp-config") ? JSON.parse(fs.readFileSync(flag("--mcp-config"), "utf8")) : null })}\n`);
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sid = resume ?? crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mcpClient(cfg) {
  const server = cfg?.mcpServers?.host;
  if (!server) return null;
  const child = spawn(server.command, server.args ?? [], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...(server.env ?? {}) } });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`); });
  return { call, close: () => child.kill() };
}

const REPORT = "mcp__host__report_progress";
const cfgPath = flag("--mcp-config");
const mcp = cfgPath ? mcpClient(JSON.parse(fs.readFileSync(cfgPath, "utf8"))) : null;

out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sid, tools: [...builtins, ...(mcp ? [REPORT] : [])],
  mcp_servers: mcp ? [{ name: "host", status: "connected" }] : [], permissionMode: flag("--permission-mode") ?? "default" });

if (mcp) await mcp.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } });
for (const input of plan.reports ?? []) {
  const useId = `toolu_${crypto.randomUUID().slice(0, 8)}`;
  out({ type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "tool_use", id: useId, name: REPORT, input }] } });
  let content, isError;
  if (!mcp || !allowed.includes(REPORT)) {
    content = `Permission to use ${REPORT} has been denied.`;
    isError = true;
  } else {
    const r = await mcp.call("tools/call", { name: "report_progress", arguments: input });
    content = r.result.content;
    isError = r.result.isError === true;
  }
  out({ type: "user", session_id: sid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: useId, content, ...(isError ? { is_error: true } : {}) }] } });
}
mcp?.close();

if (plan.hang) {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
await sleep(10);
if (plan.result === "success") out({ type: "result", subtype: "success", is_error: false, result: plan.text ?? "完成", session_id: sid, num_turns: 1 });
if (plan.result === "error") out({ type: "result", subtype: "error_during_execution", is_error: true, result: plan.text ?? "出错", session_id: sid });
if (plan.stderr) process.stderr.write(plan.stderr);
process.exit(plan.exit ?? 0);
