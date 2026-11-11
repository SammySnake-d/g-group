// Helper 专属 MCP 服务(D07.0「Helper 操作软件 = Helper 专属 MCP＋CLI＋skill,三者复用同一业务能力」)。
// 只做 JSON-RPC 2.0 协议这一层(initialize / tools/list / tools/call / ping),工具 = HELPER_OPS,执行交给宿主给的 call(同一业务能力);
// 传输由调用方接:宿主进程内用 memoryMcpClient 直连 Helper 的 pi 运行时,外部用 stdio(server 包的 serveMcpStdio)。不做 I/O。
// 错误码照 MCP 2025-06-18:不是对象 -32600;没有这个方法 -32601;tools/call 的工具名不在清单 -32602(排除清单里的带上理由)。
import type { HelperOp, HelperToolResult } from "./helper-ops.ts";

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

/** 空壳:待实现。 */
export function createHelperMcpServer(_opts: { tools: readonly HelperOp[]; call: (name: string, args: unknown) => Promise<HelperToolResult>; version?: string }): McpServer {
  return { handle: async () => null };
}
/** 空壳:待实现。 */
export function memoryMcpClient(_server: McpServer): { request(method: string, params?: unknown): Promise<unknown> } {
  return { request: async () => null };
}
