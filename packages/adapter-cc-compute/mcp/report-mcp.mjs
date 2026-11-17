#!/usr/bin/env node
// 宿主汇报工具:最小 stdio MCP 服务器,只暴露 report_progress(来自原型 g-group-prototype/report-mcp.mjs,
// 加了交接快照的三个结构化字段)。工具定义与校验都取自 src/report-schema.ts,拒收的调用返回 isError,适配器只认被接收的调用。
// 设了 REPORT_LOG 时每次 tools/call 另追加一行 JSONL,便于事后核对。
// 每行先解析;不是 JSON 回 -32700,解析结果不是对象(null、数字、字符串、布尔、数组)回 -32600,均带 id:null,进程继续处理后续行(R4-02)。
// tools/call 的工具名不是 report_progress 时回 -32602,不当成汇报处理、不入日志(R5-02)。
import fs from "node:fs";
import readline from "node:readline";
import { reportErrors, reportToolDefinition } from "../src/report-schema.ts";

const LOG = process.env.REPORT_LOG;
const tool = reportToolDefinition();

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  if (typeof m !== "object" || m === null || Array.isArray(m)) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: 请求必须是 JSON 对象" } });
    return;
  }
  if (m.method === "initialize") {
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} }, serverInfo: { name: "host-report", version: "0.2.0" } } });
  } else if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [tool] } });
  } else if (m.method === "tools/call") {
    // R5-02:先核对工具名,只认 tools/list 列出的 report_progress。未知、缺失或非字符串名称按 MCP 2025-06-18 工具规范
    // 回协议错误 -32602(Invalid params),不校验参数、不写 REPORT_LOG、不回"已记录"
    const name = m.params?.name;
    if (name !== tool.name) {
      send({ jsonrpc: "2.0", id: m.id ?? null, error: { code: -32602,
        message: typeof name === "string" ? `Unknown tool: ${name}` : "Invalid params: tools/call 缺少字符串工具名 name" } });
      return;
    }
    const a = m.params?.arguments || {};
    // 与适配器同一份 schema 规则:类型、枚举、条件必填、constraintVer、未知字段都查,不合规一律拒收
    const errs = reportErrors(a);
    if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), valid: errs.length === 0, errs, ...a })}\n`);
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text",
      text: errs.length ? `已拒收:${errs.join(";")}。请修正后重报。` : "已记录。" }], isError: errs.length > 0 } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
  }
});
