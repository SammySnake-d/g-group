// Helper 专属 MCP 服务(D07.0「Helper 操作软件 = Helper 专属 MCP＋CLI＋skill,三者复用同一业务能力」)。
// 只做 JSON-RPC 2.0 协议这一层(initialize / tools/list / tools/call / ping),工具 = HELPER_OPS,执行交给宿主给的 call(同一业务能力);
// 传输由调用方接:宿主进程内用 memoryMcpClient 直连 Helper 的 pi 运行时,外部用 stdio(server 包的 serveMcpStdio)。不做 I/O。
// 错误码照 MCP 2025-06-18:不是对象 -32600;没有这个方法 -32601;tools/call 的工具名不在清单 -32602(排除清单里的带上理由)。
import { type HelperOp, type HelperToolResult, helperExclusion, toolDescription } from "./helper-ops.ts";

export const HELPER_MCP_PROTOCOL = "2025-06-18";
export const HELPER_MCP_NAME = "g-group-helper";

export type JsonRpcResponse = { readonly jsonrpc: "2.0"; readonly id: unknown; readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string } };
export interface McpServer {
  /** 处理一条 JSON-RPC 消息;通知(没有 id)返回 null。 */
  handle(message: unknown): Promise<JsonRpcResponse | null>;
}
/** 服务端回的 JSON-RPC 错误。 */
export class McpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export function createHelperMcpServer(opts: { tools: readonly HelperOp[]; call: (name: string, args: unknown) => Promise<HelperToolResult>; version?: string }): McpServer {
  const names = new Set(opts.tools.map((t) => t.name));
  const ok = (id: unknown, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const err = (id: unknown, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
  return {
    async handle(m) {
      if (!isRecord(m)) return err(null, -32600, "invalid request: 请求必须是 JSON 对象");
      const id = m.id;
      const has = id !== undefined;
      const params = isRecord(m.params) ? m.params : {};
      switch (m.method) {
        case "initialize":
          return ok(id, { protocolVersion: typeof params.protocolVersion === "string" && params.protocolVersion ? params.protocolVersion : HELPER_MCP_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: HELPER_MCP_NAME, version: opts.version ?? "0.1.0" } });
        case "ping":
          return has ? ok(id, {}) : null;
        case "tools/list":
          return ok(id, { tools: opts.tools.map((t) => ({ name: t.name, description: toolDescription(t), inputSchema: t.params })) });
        case "tools/call": {
          const name = params.name;
          if (typeof name !== "string" || !names.has(name)) {
            const ex = typeof name === "string" ? helperExclusion(name) : null;
            return err(id ?? null, -32602, typeof name !== "string" ? "Invalid params: tools/call 缺少字符串工具名 name" : ex ? `Unknown tool: ${name}(${ex.method} 按权限不给 Helper:${ex.reason})` : `Unknown tool: ${name}`);
          }
          let r: HelperToolResult;
          try {
            r = await opts.call(name, params.arguments ?? {});
          } catch (e) {
            r = { ok: false, text: `宿主执行出错:${e instanceof Error ? e.message : String(e)}` };
          }
          return ok(id, { content: [{ type: "text", text: r.text }], isError: !r.ok });
        }
        default:
          return has ? err(id, -32601, `method not found: ${String(m.method)}`) : null;
      }
    },
  };
}

/** 进程内传输:把 McpServer 直接接成 McpClient(每次请求自增 id;error 抛 McpError)。 */
export function memoryMcpClient(server: McpServer): { request(method: string, params?: unknown): Promise<unknown> } {
  let n = 0;
  return {
    async request(method, params) {
      const res = await server.handle({ jsonrpc: "2.0", id: ++n, method, ...(params === undefined ? {} : { params }) });
      if (!res) throw new McpError(-32603, `${method} 没有回应`);
      if (res.error) throw new McpError(res.error.code, res.error.message);
      return res.result;
    },
  };
}
