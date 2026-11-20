#!/usr/bin/env node
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
    // 回协议错误 -32602(Invalid params),不校验参数、不写 REPORT_LOG、不回"已记录"
    const name = m.params?.name;
    if (name !== tool.name) {
      send({ jsonrpc: "2.0", id: m.id ?? null, error: { code: -32602,
        message: typeof name === "string" ? `Unknown tool: ${name}` : "Invalid params: tools/call 缺少字符串工具名 name" } });
      return;
    }
    const a = m.params?.arguments || {};
    const errs = reportErrors(a);
    if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), valid: errs.length === 0, errs, ...a })}\n`);
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text",
      text: errs.length ? `已拒收:${errs.join(";")}。请修正后重报。` : "已记录。" }], isError: errs.length > 0 } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
  }
});
