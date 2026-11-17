// 主进程这一侧的后端桥:按 @g-group/api-contract 的方法表校验参数,转给宿主服务,回包前校验结果。
// 宿主服务(dev/integration 上的内核组装)接进来之前,所有方法如实回 unavailable「后端未连接」,
// 渲染层据此显示「演示数据」并用本地演示适配器,不假装成功。
import { type ApiError, type ApiResult, checkParams, checkResult, formatIssues, isMethodName, type MethodName, type ServerEvent } from "@g-group/api-contract";

export type HostServer = {
  handle(method: MethodName, params: unknown): Promise<ApiResult<MethodName>>;
  subscribe(listener: (e: ServerEvent) => void, sinceEventSeq?: number): () => void;
};

let server: HostServer | null = null;
/** 宿主服务就绪后调用(后端集成接上时在 main.ts 里注入)。 */
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
