#!/usr/bin/env node
// 测试用假 claude CLI:接受与真实 `claude -p ... --output-format stream-json --verbose` 相同的参数,
// 按 stream-json 格式在 stdout 逐行输出 system/init、assistant tool_use、user tool_result、result。
// report_progress 不是假装的:按 --mcp-config 真的起 MCP 服务器、走 JSON-RPC 调 tools/call,把服务器的回复原样作为 tool_result。
// 和真实 CLI 一样,工具不在 --allowedTools 里时不调用,回 is_error 的权限拒绝。
// 和真实 CLI 2.1.316 一样,--tools default 展开成整套内置工具(Codex 审查 F-01 在真实 CLI 上观察到 Bash/Edit/Read);
// 剧本 extraInitTools 模拟 CLI 不按参数、多挂了工具。
// 剧本 grandchild:{ delayMs, marker } 起一个同进程组的孙进程,delayMs 后写 marker 文件并继续挂着(F-03 反例);
// 孙进程 pid 写进 FAKE_RECORD 同目录的 grandchild.pid。
// 剧本 denyReports:true 让 CLI 以权限拒绝回绝每次 report_progress(内容即使合规,tool_result 也是 is_error)。
// 剧本 forgeAccept:true 不经 MCP 服务器、直接回"已记录"(模拟服务器校验失效)。
// 剧本 result:"success_is_error" 输出 subtype success 但 is_error true 的结束行。
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
const DEFAULT_SET = ["Bash", "Edit", "Read"];
const builtins = (flag("--tools") ?? "").split(",").filter(Boolean).flatMap((t) => (t === "default" ? DEFAULT_SET : [t]));
const script = JSON.parse(process.env.FAKE_SCRIPT ?? "{}");
const plan = resume ? (script.resume ?? { reports: [], result: "success" }) : script;

// 挂起剧本在写记录之前就装好信号处理,避免测试读到记录后发的 SIGTERM 落在默认处理上。
// graceful:收到 SIGTERM 后 300ms 才退出;stubborn:忽略 SIGTERM,只有 SIGKILL 能结束
if (plan.hang) process.on("SIGTERM", () => { if (plan.hang === "graceful") setTimeout(() => process.exit(143), 300); });
// 挂起剧本从一开始就占住事件循环:stop 按进程组发 SIGTERM 时 MCP 服务器也会退出,
// 没有这个定时器,stubborn 会因为等不到 MCP 回复、事件循环排空而自己退出(退出码 13),测不到 SIGKILL 升级
if (plan.hang) setInterval(() => {}, 1000);

if (process.env.FAKE_RECORD) {
  fs.appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ pid: process.pid, argv, env: process.env, cwd: process.cwd(), prompt,
    mcpConfig: flag("--mcp-config") ? JSON.parse(fs.readFileSync(flag("--mcp-config"), "utf8")) : null })}\n`);
}

if (plan.grandchild) {
  const { delayMs, marker } = plan.grandchild;
  const code = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "副作用"), ${Number(delayMs)}); setInterval(() => {}, 1000);`;
  const gc = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
  if (process.env.FAKE_RECORD) fs.writeFileSync(`${process.env.FAKE_RECORD}.grandchild.pid`, String(gc.pid));
  gc.unref();
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sid = resume ?? crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mcpClient(cfg) {
  const server = cfg?.mcpServers?.host;
  if (!server) return null;
  const child = spawn(server.command, server.args ?? [], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...(server.env ?? {}) } });
  const pending = new Map();
  // 进程组被 SIGTERM 时 MCP 服务器可能先退出:写它的 stdin 会 EPIPE。吞掉,别让假 CLI 因此提前崩溃(那样测不到 SIGKILL 升级)
  child.stdin.on("error", () => {});
  child.on("error", () => {});
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

out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sid, tools: [...builtins, ...(plan.extraInitTools ?? []), ...(mcp ? [REPORT] : [])],
  mcp_servers: mcp ? [{ name: "host", status: "connected" }] : [], permissionMode: flag("--permission-mode") ?? "default" });

if (mcp) await mcp.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } });
for (const input of plan.reports ?? []) {
  const useId = `toolu_${crypto.randomUUID().slice(0, 8)}`;
  out({ type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "tool_use", id: useId, name: REPORT, input }] } });
  let content, isError;
  if (plan.forgeAccept) {
    // 绕过 MCP 服务器、直接回"已记录":模拟服务器校验失效,验证适配器自己的第二道 schema 校验
    content = [{ type: "text", text: "已记录。" }];
    isError = false;
  } else if (plan.denyReports || !mcp || !allowed.includes(REPORT)) {
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
if (plan.result === "success_is_error") out({ type: "result", subtype: "success", is_error: true, result: plan.text ?? "API Error", session_id: sid });
if (plan.result === "error") out({ type: "result", subtype: "error_during_execution", is_error: true, result: plan.text ?? "出错", session_id: sid });
if (plan.stderr) process.stderr.write(plan.stderr);
process.exit(plan.exit ?? 0);
