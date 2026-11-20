#!/usr/bin/env node
// 剧本 grandchild:{ marker, setsid?, ignoreTerm? } 起一个孙进程(默认同进程组),副作用协议见 markerCode。
// 剧本 grandchild.setsid:true 让孙进程另建会话与进程组(审查 RR-03 的脱组反例)。
// 和真实 CLI 一样先与 MCP 服务器握手、再用 tools/list 发现工具,然后输出 init:服务器起不来时 init 里 host 状态为 failed、
// 工具清单里没有 report_progress(RR-02 引用的真实 CLI 2.1.316 观察);服务器连上了但 tools/list 不含它时同样没有(R4-05)。
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
const byTask = !resume && script.byTask ? Object.entries(script.byTask).find(([task]) => prompt?.startsWith(`[任务]\n${task}\n`) || prompt === `[任务]\n${task}`) : undefined;
const plan = resume ? (script.resume ?? { reports: [], result: "success" }) : (byTask?.[1] ?? script);

// 挂起剧本在写记录之前就装好信号处理,避免测试读到记录后发的 SIGTERM 落在默认处理上。
// graceful:收到 SIGTERM 后 300ms 才退出;stubborn:忽略 SIGTERM,只有 SIGKILL 能结束
const noteTerm = () => { if (process.env.FAKE_RECORD) fs.writeFileSync(`${process.env.FAKE_RECORD}.term`, ""); };
// graceful:收到 SIGTERM 后 300ms 退出;quick:收到 SIGTERM 立即退出;stubborn:忽略 SIGTERM,只有 SIGKILL 能结束
if (plan.hang && plan.hang !== "late") process.on("SIGTERM", () => {
  noteTerm();
  if (plan.hang === "graceful") setTimeout(() => process.exit(143), 300);
  if (plan.hang === "quick") process.exit(143);
});
if (plan.hang === "late") process.on("SIGTERM", () => {
  noteTerm();
  const id = "toolu_late";
  out({ type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "tool_use", id, name: REPORT, input: plan.lateReport }] } });
  out({ type: "user", session_id: sid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "已记录。" }] }] } });
  setTimeout(() => process.exit(143), 400);
});
// 没有这个定时器,stubborn 会因为等不到 MCP 回复、事件循环排空而自己退出(退出码 13),测不到 SIGKILL 升级
if (plan.hang) setInterval(() => {}, 1000);

if (process.env.FAKE_RECORD) {
  fs.appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ pid: process.pid, argv, env: process.env, cwd: process.cwd(), prompt,
    mcpConfig: flag("--mcp-config") ? JSON.parse(fs.readFileSync(flag("--mcp-config"), "utf8")) : null })}\n`);
}

// 孙进程的副作用协议(事件屏障,不靠时间):孙进程只在测试创建 `<marker>.trigger` 之后才写 marker;
// 不再往 stdout 打前导行(R3-03:init 之前的未认可输出会被判违规);测试拿到 started/completed 时 pid 文件一定已经存在。
const markerCode = (marker, ignoreTerm) => `const fs = require("node:fs"); let stopping = false;
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(`${marker}.term`)}, ""); if (${ignoreTerm === true}) return; stopping = true; process.exit(0); });
setInterval(() => { if (!stopping && fs.existsSync(${JSON.stringify(`${marker}.trigger`)}) && !fs.existsSync(${JSON.stringify(marker)})) fs.writeFileSync(${JSON.stringify(marker)}, "副作用"); }, 20);`;
if (plan.grandchild) {
  const { marker, setsid, ignoreTerm } = plan.grandchild;
  const gc = spawn(process.execPath, ["-e", markerCode(marker, ignoreTerm)], { stdio: "ignore", detached: setsid === true });
  if (process.env.FAKE_RECORD) fs.writeFileSync(`${process.env.FAKE_RECORD}.grandchild.pid`, String(gc.pid));
  gc.unref();
}
if (plan.daemon && process.env.FAKE_RECORD) {
  const { marker } = plan.daemon;
  const pidFile = `${process.env.FAKE_RECORD}.daemon.pid`;
  const middle = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(markerCode(marker, false))}], { stdio: "ignore", detached: true });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref(); process.exit(0);`;
  const m = spawn(process.execPath, ["-e", middle], { stdio: "ignore" });
  await new Promise((r) => m.on("exit", r));
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sid = resume ?? crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mcpClient(cfg) {
  const server = cfg?.mcpServers?.host;
  if (!server) return null;
  const child = spawn(server.command, server.args ?? [], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...(server.env ?? {}) } });
  const pending = new Map();
  child.stdin.on("error", () => {});
  child.on("error", () => {});
  readline.createInterface({ input: child.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`); });
  const ready = new Promise((resolve) => {
    child.on("exit", () => resolve(false));
    child.on("error", () => resolve(false));
    call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } }).then(() => resolve(true));
    setTimeout(() => resolve(false), 3000);
  });
  return { call, ready, close: () => child.kill() };
}

const REPORT = "mcp__host__report_progress";
const cfgPath = flag("--mcp-config");
const client = cfgPath ? mcpClient(JSON.parse(fs.readFileSync(cfgPath, "utf8"))) : null;
const connected = client ? await client.ready : false;
const mcp = connected ? client : null;
const listed = mcp ? await Promise.race([mcp.call("tools/list", {}), new Promise((r) => setTimeout(() => r(null), 3000).unref())]) : null;
const discovered = Array.isArray(listed?.result?.tools) ? listed.result.tools.filter((t) => typeof t?.name === "string").map((t) => `mcp__host__${t.name}`) : [];

// 勾选能力(AC-29):--mcp-config 里 host 以外的服务器照真实 CLI 列进 init(不真起进程;状态取剧本 mcpStatus,默认 connected),
const cfgAll = cfgPath ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : null;
const pickedMcp = Object.keys(cfgAll?.mcpServers ?? {}).filter((n) => n !== "host");
const mcpStatus = (n) => plan.mcpStatus?.[n] ?? "connected";
const pluginDirs = argv.flatMap((a, i) => (a === "--plugin-dir" ? [argv[i + 1]] : []));
const pluginSkills = pluginDirs.flatMap((d) => {
  const name = JSON.parse(fs.readFileSync(`${d}/.claude-plugin/plugin.json`, "utf8")).name;
  return fs.existsSync(`${d}/skills`) ? fs.readdirSync(`${d}/skills`).filter((s) => fs.existsSync(`${d}/skills/${s}/SKILL.md`)).sort().map((s) => `${name}:${s}`) : [];
});
const initTools = [...builtins, ...(plan.extraInitTools ?? []), ...discovered, ...pickedMcp.filter((n) => mcpStatus(n) === "connected").map((n) => `mcp__${n}__echo`)];
const init = { type: "system", subtype: "init", cwd: process.cwd(), session_id: sid, tools: initTools,
  mcp_servers: [...(client ? [{ name: "host", status: connected ? "connected" : "failed", source: "dynamic" }] : []), ...pickedMcp.map((n) => ({ name: n, status: mcpStatus(n) })), ...(plan.extraInitMcp ?? []).map((n) => ({ name: n, status: "connected" }))],
  skills: [...pluginSkills, ...(plan.extraInitSkills ?? [])], permissionMode: flag("--permission-mode") ?? "default" };
if (plan.init === "noTools") init.tools = "Read,Write";
if (plan.init === "badTools") init.tools = [...initTools, 42];
for (const line of plan.preInit ?? []) process.stdout.write(`${line}\n`);
if (plan.init !== "missing") out(init);
for (const line of plan.postInit ?? []) process.stdout.write(`${line}\n`);
if (process.env.FAKE_RECORD) fs.writeFileSync(`${process.env.FAKE_RECORD}.init`, JSON.stringify(init));

let first = true;
for (const input of plan.reports ?? []) {
  if (!first && plan.reportGapMs) await sleep(plan.reportGapMs);
  first = false;
  const useId = `toolu_${crypto.randomUUID().slice(0, 8)}`;
  out({ type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "tool_use", id: useId, name: REPORT, input }] } });
  let content, isError;
  if (plan.forgeAccept) {
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
