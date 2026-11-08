#!/usr/bin/env node
// 宿主汇报工具:最小 stdio MCP 服务器,只暴露 report_progress(来自原型 g-group-prototype/report-mcp.mjs,
// 加了交接快照的三个结构化字段)。工具定义与校验都取自 src/report-schema.ts,拒收的调用返回 isError,适配器只认被接收的调用。
// 设了 REPORT_LOG 时每次 tools/call 另追加一行 JSONL,便于事后核对。
// 每行先解析;不是 JSON 回 -32700,解析结果不是对象(null、数字、字符串、布尔、数组)回 -32600,均带 id:null,进程继续处理后续行(R4-02)。
// tools/call 的工具名不是 report_progress 时回 -32602,不当成汇报处理、不入日志(R5-02)。
// R8-02:JSON-RPC id 只收字符串或整数(MCP 2025-06-18),其余(对象、数组、布尔、null、小数)回 -32600、id 为 null,不处理、不入日志;
// 回复里只放核对过类型的 id 与本服务器自己构造的值,initialize 的 protocolVersion 不是字符串时回本服务器版本。
// 日志只写有界安全的表示:参数是通过纯数据判定(嵌套不超过 32 层)的对象才展开记录,否则只记一句固定说明(omitted),
// ts/valid/errs 由服务器写在最后,参数里的同名字段不能改写它们。
// 每一行的处理都在受控边界里:任何异常(含日志写不进)只让这一条请求回 -32603,不回"已记录",进程继续处理后续行。
import fs from "node:fs";
import readline from "node:readline";
import { isPlainRecord, plainData } from "../src/plain.ts";
import { reportErrors, reportToolDefinition } from "../src/report-schema.ts";

const LOG = process.env.REPORT_LOG;
const tool = reportToolDefinition();

const PROTOCOL_VERSION = "2025-06-18";
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
/** JSON-RPC id 只收字符串或整数(MCP 2025-06-18:不能是 null) */
const validId = (id) => typeof id === "string" || Number.isInteger(id);
/** 写进日志的参数:通过纯数据判定(有界深度、只有数据属性)才展开,否则只记固定说明,不碰原值 */
const loggedArgs = (a) => {
  const p = plainData(a, "参数");
  return p.ok && isPlainRecord(p.value) ? p.value : { omitted: "参数不是可安全记录的纯数据对象(如嵌套过深),原值未写入日志" };
};

function handle(m, reply) {
  if (m.method === "initialize") {
    const pv = m.params?.protocolVersion;
    reply({ result: { protocolVersion: typeof pv === "string" && pv ? pv : PROTOCOL_VERSION,
      capabilities: { tools: {} }, serverInfo: { name: "host-report", version: "0.2.0" } } });
  } else if (m.method === "tools/list") {
    reply({ result: { tools: [tool] } });
  } else if (m.method === "tools/call") {
    // R5-02:先核对工具名,只认 tools/list 列出的 report_progress。未知、缺失或非字符串名称按 MCP 2025-06-18 工具规范
    // 回协议错误 -32602(Invalid params),不校验参数、不写 REPORT_LOG、不回"已记录"
    const name = m.params?.name;
    if (name !== tool.name) {
      reply({ id: m.id ?? null, error: { code: -32602,
        message: typeof name === "string" ? `Unknown tool: ${name}` : "Invalid params: tools/call 缺少字符串工具名 name" } });
      return;
    }
    const a = m.params?.arguments || {};
    // 与适配器同一份 schema 规则:类型、枚举、条件必填、constraintVer、未知字段都查,不合规一律拒收
    const errs = reportErrors(a);
    if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ ...loggedArgs(a), ts: new Date().toISOString(), valid: errs.length === 0, errs })}\n`);
    reply({ result: { content: [{ type: "text",
      text: errs.length ? `已拒收:${errs.join(";")}。请修正后重报。` : "已记录。" }], isError: errs.length > 0 } });
  } else if (m.id !== undefined) {
    reply({ error: { code: -32601, message: "method not found" } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  // 回复用的 id:核对过类型之后才取请求里的值,之前一律为 null
  let id = null;
  try {
    let m;
    try { m = JSON.parse(line); } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: 请求必须是 JSON 对象" } });
      return;
    }
    if (m.id !== undefined && !validId(m.id)) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: id 必须是字符串或整数" } });
      return;
    }
    id = m.id ?? null;
    handle(m, (body) => send({ jsonrpc: "2.0", id: m.id, ...body }));
  } catch (err) {
    // 受控边界:这一条请求处理失败只回 -32603,不越过这一行;进程继续处理后续请求
    const why = err instanceof Error ? err.name : "未知错误";
    process.stderr.write(`report-mcp:处理请求时出错(${why}),已回 -32603\n`);
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: "internal error: 这条请求处理失败,未记录" } });
  }
});
