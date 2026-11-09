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
record({ kind: "launch", argv, model, effort, sessionId: sid, resume: resume !== undefined });
process.on("SIGTERM", () => { record({ kind: "sigterm" }); process.exit(143); });

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
const initTools = [...builtins, ...discovered];

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

async function runTurn(text) {
  inTurn = true;
  turnModels = new Set([model]);
  const plan = script.byText?.[text] ?? {};
  out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: plan.initSession ?? sid, tools: initTools, mcp_servers: client ? [{ name: "host", status: connected ? "connected" : "failed" }] : [], model, permissionMode: flag("--permission-mode") ?? "default" });
  record({ kind: "turn-start", text, model, effort });
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
