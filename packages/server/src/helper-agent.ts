// Helper 运行时(U04/U05、U94/D28.1、D07.0、AC-52)。空壳:待实现。
import { fileURLToPath } from "node:url";
import type { ApiResult, HelperContextItem, HelperOpResult, MethodName } from "@g-group/api-contract";
import { type HelperToolResult, type McpServer, createHelperMcpServer } from "@g-group/kernel";
import type { HelperDesk, HelperEntryInput } from "./helper.ts";
import type { Host } from "./host.ts";

/** 调用方:用户本人(缺省),或 Helper。 */
export type ServiceCaller = { readonly kind: "user" } | { readonly kind: "helper"; readonly entry: HelperEntryInput };
type Handle = (method: string, params: unknown, caller?: ServiceCaller) => Promise<ApiResult<MethodName>>;
export type { HelperContextItem };
export interface HelperAskResult {
  reply: string;
  ops: HelperOpResult[];
  context: HelperContextItem[];
}
export const HELPER_CONTEXT_MESSAGES = 30;
export const HELPER_SKILL_FILE = fileURLToPath(new URL("../skills/helper/SKILL.md", import.meta.url));
export function helperSkill(): string {
  return "";
}
export const argsSha256 = (_op: string, _args: unknown): string => "";

const agents = new WeakMap<Host, HelperAgent>();
export function helperAgentOf(host: Host): HelperAgent | undefined {
  return agents.get(host);
}
export async function whenHelperIdle(_host: Host): Promise<void> {}

export class HelperAgent {
  constructor(host: Host, _desk: HelperDesk, _handle: Handle) {
    agents.set(host, this);
  }
  async idle(): Promise<void> {}
  ask(_entry: HelperEntryInput, _text: string, _clientActionId: string): Promise<HelperAskResult> {
    return Promise.resolve({ reply: "", ops: [], context: [] });
  }
  mcpServer(_entry: HelperEntryInput, _askId: string): McpServer {
    return createHelperMcpServer({ tools: [], call: async () => ({ ok: false, text: "" }) });
  }
  runTool(_entry: HelperEntryInput, _name: string, _args: unknown, _askId: string): Promise<HelperToolResult> {
    return Promise.resolve({ ok: false, text: "" });
  }
}

export function helperOpsOf(_host: Host, _askId?: string): { askId: string | null; entry: string; op: string; argsSha256: string; ok: boolean; result: string }[] {
  return [];
}
