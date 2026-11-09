#!/usr/bin/env node
// 宿主汇报工具:最小 stdio MCP 服务器,只暴露 report_progress(来自原型 g-group-prototype/report-mcp.mjs,
// 加了交接快照的三个结构化字段)。工具定义与校验都取自 src/report-schema.ts,拒收的调用返回 isError,适配器只认被接收的调用。
// 设了 REPORT_LOG 时每次 tools/call 另追加一行 JSONL,便于事后核对。
// 每行先解析;不是 JSON 回 -32700,解析结果不是对象(null、数字、字符串、布尔、数组)回 -32600,均带 id:null,进程继续处理后续行(R4-02)。
// tools/call 的工具名不是 report_progress 时回 -32602,不当成汇报处理、不入日志(R5-02)。
// R8-02:JSON-RPC id 只收字符串或整数(MCP 2025-06-18),其余(对象、数组、布尔、null、小数)回 -32600、id 为 null,不处理、不入日志;
// 回复里只放核对过类型的 id 与本服务器自己构造的值,initialize 的 protocolVersion 不是字符串时回本服务器版本。
// R9-02:先核对协议封套,jsonrpc 不是恰为 "2.0"(缺失、"1.0"、数字 2 等)回 -32600、id 为 null,不处理、不入日志。
// R9-03:没有 id 成员的消息是通知:不回复(连错误也不回)、不处理、不入日志;只有带 id 的请求才派发。
// R9-01:数值 id 以请求原文判定是不是整数(1E2、10.0 这类写法也是整数),是就把这段原文原样写回回复,不经浮点数,
// 9007199254740993 这类超出双精度的整数不会被改写成相邻的值;原文是小数(1.5、9007199254740993.5)回 -32600。
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
/** 写一条回复。wireId 是已经核对过的 id 的 JSON 原文(字符串 id 重新序列化,数值 id 取请求原文,无法确定时为 "null");
 *  body 是 { result } 或 { error },本服务器自己构造,不含 id */
const send = (wireId, body) => process.stdout.write(`{"jsonrpc":"2.0","id":${wireId},${JSON.stringify(body).slice(1)}\n`);
const WS = " \t\n\r";
/** 已确认是合法 JSON 对象的一行里,顶层 "id" 成员值的原文。重复键与 JSON.parse 一致取最后一个;
 *  其它成员的值整段跳过(嵌套里的同名字段不算),只扫一遍、不递归,嵌套再深也不会栈溢出 */
function topLevelIdSource(line) {
  let i = 0;
  let found;
  const ws = () => { while (i < line.length && WS.includes(line[i])) i++; };
  const str = () => { const s = i++; while (line[i] !== '"') i += line[i] === "\\" ? 2 : 1; i++; return line.slice(s, i); };
  const skipValue = () => {
    let depth = 0;
    do {
      const c = line[i];
      if (c === '"') str();
      else if (c === "{" || c === "[") { depth++; i++; }
      else if (c === "}" || c === "]") { depth--; i++; }
      else if (depth === 0) { while (i < line.length && !`,}]${WS}`.includes(line[i])) i++; }
      else i++;
    } while (depth > 0);
  };
  ws(); i++; ws();
  if (line[i] === "}") return undefined;
  for (;;) {
    ws();
    const key = JSON.parse(str());
    ws(); i++; ws();
    const start = i;
    skipValue();
    if (key === "id") found = line.slice(start, i);
    ws();
    if (line[i] !== ",") return found;
    i++;
  }
}
const NUMBER = /^-?(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;
/** JSON 数字原文的数学值是不是整数:按十进制数字与指数精确判断,不经浮点数 */
function integerSource(src) {
  const m = NUMBER.exec(src);
  if (!m) return false;
  const frac = m[2] ?? "";
  const digits = (m[1] + frac).replace(/^0+/, "");
  if (digits === "") return true;
  const trailingZeros = digits.length - digits.replace(/0+$/, "").length;
  return BigInt(m[3] ?? "0") - BigInt(frac.length) + BigInt(trailingZeros) >= 0n;
}
/** 请求 id 的回复原文:字符串照常序列化;数值只收原文是整数的,原样返回这段原文;其余(对象、数组、布尔、null、小数)为 undefined */
function idWire(id, line) {
  if (typeof id === "string") return JSON.stringify(id);
  if (typeof id !== "number") return undefined;
  const src = topLevelIdSource(line);
  return src !== undefined && integerSource(src) ? src : undefined;
}
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
      reply({ error: { code: -32602,
        message: typeof name === "string" ? `Unknown tool: ${name}` : "Invalid params: tools/call 缺少字符串工具名 name" } });
      return;
    }
    const a = m.params?.arguments || {};
    // 与适配器同一份 schema 规则:类型、枚举、条件必填、constraintVer、未知字段都查,不合规一律拒收
    const errs = reportErrors(a);
    if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ ...loggedArgs(a), ts: new Date().toISOString(), valid: errs.length === 0, errs })}\n`);
    reply({ result: { content: [{ type: "text",
      text: errs.length ? `已拒收:${errs.join(";")}。请修正后重报。` : "已记录。" }], isError: errs.length > 0 } });
  } else {
    reply({ error: { code: -32601, message: "method not found" } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  // 回复用的 id 原文:核对过之后才取请求里的值,之前一律为 null
  let wire = "null";
  try {
    let m;
    try { m = JSON.parse(line); } catch {
      send("null", { error: { code: -32700, message: "parse error" } });
      return;
    }
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      send("null", { error: { code: -32600, message: "invalid request: 请求必须是 JSON 对象" } });
      return;
    }
    if (m.jsonrpc !== "2.0") {
      send("null", { error: { code: -32600, message: 'invalid request: jsonrpc 必须是 "2.0"' } });
      return;
    }
    // 通知:不回复、不处理、不入日志
    if (!Object.hasOwn(m, "id")) return;
    const w = idWire(m.id, line);
    if (w === undefined) {
      send("null", { error: { code: -32600, message: "invalid request: id 必须是字符串或整数" } });
      return;
    }
    wire = w;
    handle(m, (body) => send(w, body));
  } catch (err) {
    // 受控边界:这一条请求处理失败只回 -32603,不越过这一行;进程继续处理后续请求
    const why = err instanceof Error ? err.name : "未知错误";
    process.stderr.write(`report-mcp:处理请求时出错(${why}),已回 -32603\n`);
    send(wire, { error: { code: -32603, message: "internal error: 这条请求处理失败,未记录" } });
  }
});
