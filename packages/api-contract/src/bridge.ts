// preload 暴露给渲染进程的桥。渲染进程只通过 window.gg 访问后端,不直接拿 ipcRenderer。
// 主进程侧:ipcMain.handle(IPC.invoke, (e, req) => server.handle(req));事件经 webContents.send(IPC.event, ev)。
import { type ApiResult, METHODS, type MethodName, type ParamsOf } from "./api.ts";
import { ServerEvent } from "./events.ts";
import { type Check, type Issue, obj, opt, seq, str } from "./schema.ts";

export const IPC = Object.freeze({
  invoke: "gg:invoke",
  subscribe: "gg:subscribe",
  unsubscribe: "gg:unsubscribe",
  event: "gg:event",
} as const);

/** 渲染进程 → 主进程的一次调用。 */
export interface InvokeRequest {
  method: string;
  params: unknown;
}
export const InvokeRequest = obj({ method: str({ min: 1, max: 100 }), params: opt({ kind: "unknown", check: (v: unknown) => ({ ok: true, value: v }) }) });

export const SubscribeRequest = obj({ sinceEventSeq: opt(seq()) });

export interface GGroupBridge {
  readonly apiVersion: string;
  invoke<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ApiResult<M>>;
  /** 订阅事件流,返回取消函数。sinceEventSeq 省略则从当前开始。 */
  subscribe(listener: (event: ServerEvent) => void, opts?: { sinceEventSeq?: number }): () => void;
}

declare global {
  interface Window {
    gg: GGroupBridge;
  }
}

export const isMethodName = (m: unknown): m is MethodName => typeof m === "string" && Object.hasOwn(METHODS, m);

/** 主进程入口用:校验方法名与参数。 */
export function checkParams<M extends MethodName>(method: M, params: unknown): Check<ParamsOf<M>> {
  return METHODS[method].params.check(params ?? {}) as Check<ParamsOf<M>>;
}
/** 主进程回包前、渲染进程收包后(开发模式)用:校验结果形状。 */
export function checkResult<M extends MethodName>(method: M, value: unknown): Check<unknown> {
  return METHODS[method].result.check(value);
}
export function checkEvent(e: unknown): Check<ServerEvent> {
  return ServerEvent.check(e);
}
export const formatIssues = (issues: readonly Issue[]): string => issues.map((i) => `${i.path}: ${i.message}`).join("; ");
