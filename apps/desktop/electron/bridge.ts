// 主进程这一侧的后端桥。后端(dev/integration 上的宿主内核)接好之前,
// 除 app.info 外的方法都如实回「后端未连接」,渲染层据此走本地演示数据,不假装成功。
import type { IpcMethod } from "@g-group/ui-core";

export type AppInfo = { version: string; electron: string; platform: string };
export type CallResult = { ok: true; data: unknown } | { ok: false; error: string };

export async function handleCall(method: IpcMethod, _params: unknown, info: AppInfo): Promise<CallResult> {
  if (method === "app.info") return { ok: true, data: { ...info, backend: "disconnected" } };
  return { ok: false, error: "backend-not-connected" };
}
