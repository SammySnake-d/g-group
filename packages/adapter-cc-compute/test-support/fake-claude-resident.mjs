#!/usr/bin/env node
// 测试用假 claude CLI(常驻模式):接受与真实 `claude -p --input-format stream-json --output-format stream-json --verbose` 相同的参数,
// 进程常驻,从 stdin 逐行读 stream-json:user 消息开一轮(输出 system/init → 汇报 → result),control_request 处理 set_model 与
// apply_flag_settings。行为照 Claude Code 2.1.319 实测(g-group-requirements/evidence/model-hotswap-20261107):
//   - 每轮开始输出一个 init,model 是会话当前模型;result 带 model_usage_since_last_result(这一轮用过的模型)与 modelUsage(会话累计);
//   - set_model 成功回 control_response success {model},并回显一条 isReplay 的 user 帧;
//   - 一轮进行中收到 set_model 立刻生效:这一轮剩下的请求由新模型发出(D27 第 3 节边界 1 —— 宿主必须压到轮边界);
//   - 换到被拒的模型回 subtype:error、error_code:check_failed,仍用原模型;
//   - priority:"now" 的 user 消息在一轮进行中当插话,不另开一轮。
// 会话上下文存在 <fake-dir>/sessions/<会话id>.json:--resume 接回同一会话时读回,换模型、重启后都能答出之前的暗号。
// 剧本(FAKE_SCRIPT,JSON):
//   rejectModels: [模型] 换到这些模型回 check_failed;rejectDelayMs:回拒绝前等多久
//   silentModels: [模型] 换到这些模型永不回包(超时);unsupportedSetModel:true set_model 回「不支持的控制请求」
//   noEffort:true apply_flag_settings 回「不支持」
//   turnMs: 每轮从 init 到 result 的时长(默认 30);byText: { "<输入原文>": { turnMs?, reports?, result?, text?, initSession? } }
//   initSession: 这一轮 init 报的会话 id(模拟 CLI 换了会话)
//   reports: 这一轮经 report_progress 汇报的内容(真的走 MCP 服务器)
//   byIncludes: { "<子串>": 剧本 } 输入原文含这个子串就用它(宿主拼的首个提示很长,按子串选剧本);byText 优先
// 勾选能力(AC-29):--mcp-config 里 host 以外的服务器照真实 CLI 列进 init(不真起进程,状态取 mcpStatus[名],默认 connected),
//   每个连上的服务器暴露 mcp__<名>__echo;extraInitMcp:[名] 模拟 CLI 多挂了未勾选的服务器。
//   skill 照真实 CLI 2.1.319 实测(packages/server/proof/v02-config-dir.txt):带 --bare 只加载 --plugin-dir 里的(<插件名>:<目录名>);
//   不带 --bare 时另加载 CLAUDE_CONFIG_DIR/skills(没设就 HOME/.claude/skills)里的。
// 活动(AC-43,D26 第 8.3 节):每轮 init 之后输出 system/status requesting(真实 CLI 每次发请求前都有);带 --include-partial-messages 时
//   回答前输出 stream_event 增量(真实 CLI 2.1.319 在 stdin 收 stream-json 时同样支持,proof/resident-partial-messages-probe.txt)。
//   每轮剧本 tools:[{ name, input, holdMs?, isError?, inner? }] 逐个输出 tool_use,等 holdMs 后输出 tool_result;inner:true 时在等待中
//   输出一条带 parent_tool_use_id 的子代理消息。hang:true 这一轮发出请求后再无输出(上游无响应),直到被停止。
// 停止确认(AC-23):每轮剧本 grandchild:{ setsid?, ignoreTerm? } 在这一轮开始时起一个常驻孙进程,pid 写进 FAKE_RECORD.grandchild.pid
//   (setsid:true 另建会话与进程组;ignoreTerm:true 忽略 SIGTERM)。顶层 ignoreTerm:true 让 CLI 主进程忽略 SIGTERM,只有组 SIGKILL 能结束。
// 每次启动、每条 stdin 输入、每个控制请求都追加到 FAKE_RECORD(JSON 行),带 pid、当时模型、是否在一轮中。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const fakeDir = (argv.find((a) => a.startsWith("--fake-dir=")) ?? "--fake-dir=").slice("--fake-dir=".length);
const script = JSON.parse(process.env.FAKE_SCRIPT ?? "{}");
const recordFile = process.env.FAKE_RECORD;
const record = (o) => { if (recordFile) fs.appendFileSync(recordFile, `${JSON.stringify({ pid: process.pid, at: Date.now(), ...o })}\n`); };
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPORT = "mcp__host__report_progress";

const resume = flag("--resume");
const sid = resume ?? flag("--session-id") ?? crypto.randomUUID();
let model = flag("--model") ?? "fake-default-model";
let effort = flag("--effort") ?? null;
const sessionsDir = path.join(fakeDir || process.cwd(), "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });
const sessionFile = path.join(sessionsDir, `${sid}.json`);
if (resume && !fs.existsSync(sessionFile)) {
  process.stderr.write(`No conversation found with session ID: ${sid}\n`);
  process.exit(1);
}
const history = resume ? JSON.parse(fs.readFileSync(sessionFile, "utf8")) : [];
const save = () => fs.writeFileSync(sessionFile, JSON.stringify(history));
save();
const pluginDirs = argv.flatMap((a, i) => (a === "--plugin-dir" ? [argv[i + 1]] : []));
const mcpConfigRaw = flag("--mcp-config") && fs.existsSync(flag("--mcp-config")) ? JSON.parse(fs.readFileSync(flag("--mcp-config"), "utf8")) : null;
record({ kind: "launch", argv, model, effort, sessionId: sid, resume: resume !== undefined, configDir: process.env.CLAUDE_CONFIG_DIR ?? null, home: process.env.HOME ?? null, pluginDirs, mcpConfig: mcpConfigRaw });
process.on("SIGTERM", () => { record({ kind: "sigterm" }); if (!script.ignoreTerm) process.exit(143); });
if (script.ignoreTerm) setInterval(() => {}, 1000);

const allowed = (flag("--allowedTools") ?? "").split(",").filter(Boolean);
const builtins = (flag("--tools") ?? "").split(",").filter(Boolean);

function mcpClient(cfg) {
  const server = cfg?.mcpServers?.host;
  if (!server) return null;
  const child = spawn(server.command, server.args ?? [], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...(server.env ?? {}) } });
  const pending = new Map();
  child.stdin.on("error", () => {});
  child.on("error", () => {});
  readline.createInterface({ input: child.stdout }).on("line", (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id); });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`); });
  const ready = new Promise((resolve) => {
    child.on("exit", () => resolve(false));
    call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude-resident", version: "0" } }).then(() => resolve(true));
    setTimeout(() => resolve(false), 3000);
  });
  return { call, ready, close: () => child.kill() };
}
const cfgPath = flag("--mcp-config");
const client = cfgPath ? mcpClient(JSON.parse(fs.readFileSync(cfgPath, "utf8"))) : null;
const connected = client ? await client.ready : false;
const mcp = connected ? client : null;
const listed = mcp ? await Promise.race([mcp.call("tools/list", {}), sleep(3000).then(() => null)]) : null;
const discovered = Array.isArray(listed?.result?.tools) ? listed.result.tools.map((t) => `mcp__host__${t.name}`) : [];
const pickedMcp = Object.keys(mcpConfigRaw?.mcpServers ?? {}).filter((n) => n !== "host");
const mcpStatus = (n) => script.mcpStatus?.[n] ?? "connected";
const skillDirSkills = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((s) => fs.existsSync(path.join(d, s, "SKILL.md"))).sort() : []);
const pluginSkills = pluginDirs.flatMap((d) => {
  const name = JSON.parse(fs.readFileSync(path.join(d, ".claude-plugin", "plugin.json"), "utf8")).name;
  return skillDirSkills(path.join(d, "skills")).map((s) => `${name}:${s}`);
});
const bare = argv.includes("--bare");
const globalSkills = bare ? [] : skillDirSkills(process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, "skills") : path.join(process.env.HOME ?? "/nonexistent", ".claude", "skills"));
const initSkills = [...globalSkills, ...pluginSkills];
const initMcp = () => [...(client ? [{ name: "host", status: connected ? "connected" : "failed" }] : []), ...pickedMcp.map((n) => ({ name: n, status: mcpStatus(n) })), ...(script.extraInitMcp ?? []).map((n) => ({ name: n, status: "connected" }))];
const initTools = [...builtins, ...discovered, ...pickedMcp.filter((n) => mcpStatus(n) === "connected").map((n) => `mcp__${n}__echo`)];
const partial = argv.includes("--include-partial-messages");

let inTurn = false;
let turnModels = new Set();
const usage = {};
const queue = [];

function reply(text) {
  const m = /记住暗号:(\S+)/.exec(text);
  if (m) return "已记住";
  if (text.includes("暗号是什么")) {
    const hit = [...history].reverse().map((h) => /记住暗号:(\S+)/.exec(h.text)).find(Boolean);
    return hit ? hit[1] : "不知道";
  }
  return "完成";
}

// 孙进程:常驻,收到 SIGTERM 时写 <FAKE_RECORD>.grandchild.term;ignoreTerm 时不退出。
// 测试目录(--fake-dir)被删掉后自己退出:门禁在 macOS 沙箱里跑测试时 ps 不让执行,测试的收尾按命令行找不到它,
// 它又不和测试共用 stdio,不自己退就会一直留着。测试进行中目录一直在,这条不影响停止确认的判定
function startGrandchild(g) {
  const term = `${recordFile}.grandchild.term`;
  const code = `const fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(term)}, ""); if (!${g.ignoreTerm === true}) process.exit(0); }); setInterval(() => { if (!fs.existsSync(${JSON.stringify(fakeDir || process.cwd())})) process.exit(0); }, 200);`;
  const gc = spawn(process.execPath, ["-e", code, "--", `--fake-grandchild=${fakeDir}`], { stdio: "ignore", detached: g.setsid === true });
  if (recordFile) fs.writeFileSync(`${recordFile}.grandchild.pid`, String(gc.pid));
  record({ kind: "grandchild", gc: gc.pid, setsid: g.setsid === true });
  gc.unref();
}

async function runTurn(text) {
  inTurn = true;
  turnModels = new Set([model]);
  const plan = script.byText?.[text] ?? Object.entries(script.byIncludes ?? {}).find(([k]) => text.includes(k))?.[1] ?? {};
  out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: plan.initSession ?? sid, tools: initTools, mcp_servers: initMcp(), skills: initSkills, model, permissionMode: flag("--permission-mode") ?? "default" });
  record({ kind: "turn-start", text, model, effort });
  if (plan.grandchild) startGrandchild(plan.grandchild);
  // 真实 CLI 输出 init 之后过一会儿才发请求;这里隔 20 毫秒,宿主先记下 started 再看到 requesting(和真实帧序一致)
  await sleep(20);
  out({ type: "system", subtype: "status", status: "requesting", session_id: sid });
  if (plan.hang) { record({ kind: "hang" }); await new Promise(() => {}); }
  if (partial) out({ type: "stream_event", event: { type: "message_start" }, session_id: sid, parent_tool_use_id: null });
  for (const t of plan.tools ?? []) {
    const id = `toolu_${crypto.randomUUID().slice(0, 8)}`;
    out({ type: "assistant", session_id: sid, parent_tool_use_id: null, message: { role: "assistant", model, content: [{ type: "tool_use", id, name: t.name, input: t.input ?? {} }] } });
    record({ kind: "tool-start", id, name: t.name });
    if (t.inner) out({ type: "assistant", session_id: sid, parent_tool_use_id: id, message: { role: "assistant", model, content: [{ type: "text", text: "子代理在查" }] } });
    await sleep(t.holdMs ?? 0);
    out({ type: "user", session_id: sid, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...(t.isError ? { is_error: true } : {}) }] } });
    record({ kind: "tool-end", id, name: t.name });
  }
  const half = (plan.turnMs ?? script.turnMs ?? 30) / 2;
  await sleep(half);
  for (const input of plan.reports ?? []) {
    const useId = `toolu_${crypto.randomUUID().slice(0, 8)}`;
    out({ type: "assistant", session_id: sid, message: { role: "assistant", model, content: [{ type: "tool_use", id: useId, name: REPORT, input }] } });
    turnModels.add(model);
    let content = `Permission to use ${REPORT} has been denied.`;
    let isError = true;
    if (mcp && allowed.includes(REPORT)) {
      const r = await mcp.call("tools/call", { name: "report_progress", arguments: input });
      content = r.result.content;
      isError = r.result.isError === true;
    }
    out({ type: "user", session_id: sid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: useId, content, ...(isError ? { is_error: true } : {}) }] } });
  }
  await sleep(half);
  // 这一轮最后一次请求由「当时」的模型发出:一轮中途换了模型,这里就是新模型(真实 CLI 的行为)
  turnModels.add(model);
  const answer = plan.text ?? reply(text);
  if (partial) out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: answer } }, session_id: sid, parent_tool_use_id: null });
  out({ type: "assistant", session_id: sid, message: { role: "assistant", model, content: [{ type: "text", text: answer }] } });
  history.push({ text, model, answer });
  save();
  const since = Object.fromEntries([...turnModels].map((m) => [m, { inputTokens: 1, outputTokens: 1 }]));
  for (const m of turnModels) usage[m] = { inputTokens: (usage[m]?.inputTokens ?? 0) + 1, outputTokens: 1 };
  record({ kind: "turn-end", text, models: [...turnModels], answer });
  const result = plan.result ?? "success";
  out({ type: "result", subtype: result === "success" ? "success" : "error_during_execution", is_error: result !== "success", result: answer, session_id: sid, modelUsage: { ...usage }, model_usage_since_last_result: since });
  inTurn = false;
  const next = queue.shift();
  if (next !== undefined) void runTurn(next);
}

async function onControl(m) {
  const req = m.request ?? {};
  const rid = m.request_id;
  record({ kind: "control", subtype: req.subtype, model: req.model ?? null, settings: req.settings ?? null, inTurn, current: model });
  if (req.subtype === "set_model") {
    if (script.unsupportedSetModel) { out({ type: "control_response", response: { subtype: "error", request_id: rid, error: "Unsupported control request subtype: set_model", error_code: "unsupported" } }); return; }
    if ((script.silentModels ?? []).includes(req.model)) return;
    if ((script.rejectModels ?? []).includes(req.model)) {
      await sleep(script.rejectDelayMs ?? 20);
      out({ type: "control_response", response: { subtype: "error", request_id: rid, error: `Model ${req.model} is not available; still using ${model}`, error_code: "check_failed" } });
      return;
    }
    model = req.model;
    if (inTurn) turnModels.add(model);
    out({ type: "control_response", response: { subtype: "success", request_id: rid, response: { model } } });
    out({ type: "user", message: { role: "user", content: `<local-command-stdout>Set model to \`${model}\`</local-command-stdout>` }, session_id: sid, isReplay: true });
    return;
  }
  if (req.subtype === "apply_flag_settings") {
    if (script.noEffort) { out({ type: "control_response", response: { subtype: "error", request_id: rid, error: "Unsupported control request subtype: apply_flag_settings", error_code: "unsupported" } }); return; }
    if (req.settings && typeof req.settings.effortLevel === "string") effort = req.settings.effortLevel;
    out({ type: "control_response", response: { subtype: "success", request_id: rid, response: {} } });
    return;
  }
  out({ type: "control_response", response: { subtype: "error", request_id: rid, error: `Unsupported control request subtype: ${req.subtype}`, error_code: "unsupported" } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === "control_request") { void onControl(m); return; }
  if (m.type === "control_response") { record({ kind: "host-control-response", response: m.response }); return; }
  if (m.type === "user") {
    const content = m.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => b.text ?? "").join("") : "";
    record({ kind: "in", text, priority: m.priority ?? null, inTurn, model, effort });
    if (inTurn && m.priority === "now") return; // 插话:进当前这一轮,不另开
    if (inTurn) { queue.push(text); return; }
    void runTurn(text);
  }
});
rl.on("close", () => { record({ kind: "stdin-closed" }); mcp?.close(); setTimeout(() => process.exit(0), 10); });
