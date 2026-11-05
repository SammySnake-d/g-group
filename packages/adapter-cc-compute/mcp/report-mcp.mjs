#!/usr/bin/env node
// 宿主汇报工具:最小 stdio MCP 服务器,只暴露 report_progress(来自原型 g-group-prototype/report-mcp.mjs,
// 加了交接快照的三个结构化字段)。按 schema 校验,拒收的调用返回 isError,适配器只认被接收的调用。
// 设了 REPORT_LOG 时每次调用另追加一行 JSONL,便于事后核对。
import fs from "node:fs";
import readline from "node:readline";

const LOG = process.env.REPORT_LOG;
const KINDS = ["started", "milestone", "blocked", "completed", "failed"];
const strArr = (x) => Array.isArray(x) && x.every((s) => typeof s === "string");
const tool = {
  name: "report_progress",
  description:
    "向宿主汇报任务进展。开始干活报 started;完成一个有意义的阶段报 milestone(带 stage);" +
    "需要用户授权/提供信息/外部条件不满足而无法继续时报 blocked(带 needs)并停下;全部完成报 completed;放弃报 failed。" +
    "知道当前生效的约束版本、未决问题或已经做完的有副作用的动作时,带上 constraintVer/openQuestions/doneSideEffects。",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: KINDS },
      summary: { type: "string", description: "一句话,给用户看" },
      stage: { type: "string", description: "阶段名(milestone 时必填)" },
      needs: { type: "string", description: "blocked 时:需要用户做什么" },
      constraintVer: { type: "integer", minimum: 0, description: "当前遵守的群规/硬约束版本号" },
      openQuestions: { type: "array", items: { type: "string" }, description: "仍未决的问题(整份替换)" },
      doneSideEffects: { type: "array", items: { type: "string" }, description: "已经完成、不可重做的副作用(追加)" },
    },
    required: ["kind", "summary"],
  },
};

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} }, serverInfo: { name: "host-report", version: "0.2.0" } } });
  } else if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [tool] } });
  } else if (m.method === "tools/call") {
    const a = m.params?.arguments || {};
    const errs = [];
    if (!KINDS.includes(a.kind)) errs.push("kind 非法");
    if (typeof a.summary !== "string" || !a.summary) errs.push("缺 summary");
    if (a.kind === "milestone" && !a.stage) errs.push("milestone 缺 stage");
    if (a.kind === "blocked" && !a.needs) errs.push("blocked 缺 needs");
    if (a.constraintVer !== undefined && !(Number.isInteger(a.constraintVer) && a.constraintVer >= 0)) errs.push("constraintVer 须为非负整数");
    if (a.openQuestions !== undefined && !strArr(a.openQuestions)) errs.push("openQuestions 须为字符串数组");
    if (a.doneSideEffects !== undefined && !strArr(a.doneSideEffects)) errs.push("doneSideEffects 须为字符串数组");
    if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), valid: errs.length === 0, errs, ...a })}\n`);
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text",
      text: errs.length ? `已拒收:${errs.join(";")}。请修正后重报。` : "已记录。" }], isError: errs.length > 0 } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
  }
});
