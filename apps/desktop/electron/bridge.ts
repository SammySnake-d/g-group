// 主进程这一侧的后端桥:按 @g-group/api-contract 的方法表校验参数,转给宿主服务,回包前校验结果。
import { type ApiError, type ApiResult, checkParams, checkResult, formatIssues, isMethodName, type MethodName, type ServerEvent } from "@g-group/api-contract";

export type HostServer = {
  handle(method: MethodName, params: unknown): Promise<ApiResult<MethodName>>;
  subscribe(listener: (e: ServerEvent) => void, sinceEventSeq?: number): () => void;
};

let server: HostServer | null = null;
export function attachServer(s: HostServer | null) {
  server = s;
}
export const isConnected = () => server !== null;

const fail = (code: ApiError["code"], message: string, detail?: unknown): { ok: false; error: ApiError } => ({ ok: false, error: detail === undefined ? { code, message } : { code, message, detail } });

export async function handleInvoke(method: string, params: unknown): Promise<ApiResult<MethodName>> {
  if (!isMethodName(method)) return fail("unknown_method", `不认识的方法 ${method}`);
  const p = checkParams(method, params);
  if (!p.ok) return fail("invalid_params", formatIssues(p.issues), p.issues);
  if (!server) return fail("unavailable", "后端未连接");
  const r = await server.handle(method, p.value);
  if (r.ok) {
    const c = checkResult(method, r.value);
    if (!c.ok) return fail("internal", `宿主回包不符合合同:${formatIssues(c.issues)}`);
  }
  return r;
}

export function subscribe(listener: (e: ServerEvent) => void, sinceEventSeq?: number): () => void {
  return server ? server.subscribe(listener, sinceEventSeq) : () => {};
}
