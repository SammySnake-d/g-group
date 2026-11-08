#!/usr/bin/env node
// 测试用假 claude CLI:接受与真实 `claude -p ... --output-format stream-json --verbose` 相同的参数,
// 按 stream-json 格式在 stdout 逐行输出 system/init、assistant tool_use、user tool_result、result。
// report_progress 不是假装的:按 --mcp-config 真的起 MCP 服务器、走 JSON-RPC 调 tools/call,把服务器的回复原样作为 tool_result。
// 和真实 CLI 一样,工具不在 --allowedTools 里时不调用,回 is_error 的权限拒绝。
// 和真实 CLI 2.1.316 一样,--tools default 展开成整套内置工具(Codex 审查 F-01 在真实 CLI 上观察到 Bash/Edit/Read);
// 剧本 extraInitTools 模拟 CLI 不按参数、多挂了工具。
// 剧本 grandchild:{ marker, setsid?, ignoreTerm? } 起一个孙进程(默认同进程组),副作用协议见 markerCode。
// 剧本 denyReports:true 让 CLI 以权限拒绝回绝每次 report_progress(内容即使合规,tool_result 也是 is_error)。
// 剧本 forgeAccept:true 不经 MCP 服务器、直接回"已记录"(模拟服务器校验失效)。
// 剧本 result:"success_is_error" 输出 subtype success 但 is_error true 的结束行。
// 剧本 grandchild.setsid:true 让孙进程另建会话与进程组(审查 RR-03 的脱组反例)。
// 剧本 daemon:{ marker } 起一个中间进程,它再起一个另建会话的守护进程后立刻退出(双 fork,守护进程被 init/launchd 收养);
// 守护进程 pid 写进 FAKE_RECORD.daemon.pid。这是已披露的不覆盖边界。
// 剧本 init:"missing" 不输出 init;"noTools" tools 不是数组;"badTools" tools 含非字符串。
// 和真实 CLI 一样先与 MCP 服务器握手、再用 tools/list 发现工具,然后输出 init:服务器起不来时 init 里 host 状态为 failed、
// 工具清单里没有 report_progress(RR-02 引用的真实 CLI 2.1.316 观察);服务器连上了但 tools/list 不含它时同样没有(R4-05)。
// 剧本 reportGapMs:相邻两次汇报之间的间隔。
// 剧本来自环境变量 FAKE_SCRIPT(JSON);每次启动把 pid/argv/env/cwd/首个提示追加到 FAKE_RECORD。
// 剧本 byTask:{ "<任务原文>": 剧本 } 按首个提示里的任务原文选剧本,没命中用顶层剧本:同一个适配器(同一份 hostEnv)
// 先后起的几个 Compute 可以走不同剧本(R7-02:一个 Compute 输出畸形 JSON 失败后,同一宿主的下一个 Compute 照常完成)。
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
// 挂起的 CLI 收到 SIGTERM 时写 FAKE_RECORD.term(主进程收到了 SIGTERM 的事件证据)
const noteTerm = () => { if (process.env.FAKE_RECORD) fs.writeFileSync(`${process.env.FAKE_RECORD}.term`, ""); };
// graceful:收到 SIGTERM 后 300ms 退出;quick:收到 SIGTERM 立即退出;stubborn:忽略 SIGTERM,只有 SIGKILL 能结束
if (plan.hang && plan.hang !== "late") process.on("SIGTERM", () => {
  noteTerm();
  if (plan.hang === "graceful") setTimeout(() => process.exit(143), 300);
  if (plan.hang === "quick") process.exit(143);
});
// hang:"late" 收到 SIGTERM 后先输出 plan.lateReport 的 tool_use 与伪造的"已记录"回执(迟到的汇报,R3-01),400ms 后退出
if (plan.hang === "late") process.on("SIGTERM", () => {
  noteTerm();
  const id = "toolu_late";
  out({ type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "tool_use", id, name: REPORT, input: plan.lateReport }] } });
  out({ type: "user", session_id: sid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "已记录。" }] }] } });
  setTimeout(() => process.exit(143), 400);
});
// 挂起剧本从一开始就占住事件循环:stop 按进程组发 SIGTERM 时 MCP 服务器也会退出,
// 没有这个定时器,stubborn 会因为等不到 MCP 回复、事件循环排空而自己退出(退出码 13),测不到 SIGKILL 升级
if (plan.hang) setInterval(() => {}, 1000);

if (process.env.FAKE_RECORD) {
  fs.appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ pid: process.pid, argv, env: process.env, cwd: process.cwd(), prompt,
    mcpConfig: flag("--mcp-config") ? JSON.parse(fs.readFileSync(flag("--mcp-config"), "utf8")) : null })}\n`);
}

// 孙进程的副作用协议(事件屏障,不靠时间):孙进程只在测试创建 `<marker>.trigger` 之后才写 marker;
// 收到 SIGTERM 就置"被要求退出"并立即退出,写之前先检查这个标记。ignoreTerm:true 的孙进程忽略 SIGTERM,只有 SIGKILL 能结束。
// 孙进程 pid 在输出 init 之前就写进 FAKE_RECORD.grandchild.pid;收到 SIGTERM 时先写 <marker>.term(谁收到了 SIGTERM 的事件证据)。
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
  // 等中间进程写完守护进程的 pid 再继续,测试拿到 started 时 pid 文件已存在
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
  // 握手:服务器在回 initialize 之前退出或出错就判连接失败
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
// 和真实 CLI 一样经 tools/list 发现 MCP 工具,按 mcp__<服务器>__<工具名> 列进 init(R4-05);
// 服务器的清单里没有 report_progress 时 init 里也就没有它。3 秒没有回复按空清单处理
const listed = mcp ? await Promise.race([mcp.call("tools/list", {}), new Promise((r) => setTimeout(() => r(null), 3000).unref())]) : null;
const discovered = Array.isArray(listed?.result?.tools) ? listed.result.tools.filter((t) => typeof t?.name === "string").map((t) => `mcp__host__${t.name}`) : [];

const initTools = [...builtins, ...(plan.extraInitTools ?? []), ...discovered];
const init = { type: "system", subtype: "init", cwd: process.cwd(), session_id: sid, tools: initTools,
  mcp_servers: client ? [{ name: "host", status: connected ? "connected" : "failed", source: "dynamic" }] : [], permissionMode: flag("--permission-mode") ?? "default" };
if (plan.init === "noTools") init.tools = "Read,Write";
if (plan.init === "badTools") init.tools = [...initTools, 42];
// 剧本 preInit:init 之前原样输出的行(字符串);postInit:init 之后、汇报之前原样输出的行(R3-03)
for (const line of plan.preInit ?? []) process.stdout.write(`${line}\n`);
if (plan.init !== "missing") out(init);
for (const line of plan.postInit ?? []) process.stdout.write(`${line}\n`);
// 输出 init 之后写 FAKE_RECORD.init:测试据此知道 CLI 已过了握手与 init 这一步
if (process.env.FAKE_RECORD) fs.writeFileSync(`${process.env.FAKE_RECORD}.init`, JSON.stringify(init));

let first = true;
for (const input of plan.reports ?? []) {
  if (!first && plan.reportGapMs) await sleep(plan.reportGapMs);
  first = false;
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
