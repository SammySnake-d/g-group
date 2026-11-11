// 最小 preload:按接口合同只暴露 window.gg = { apiVersion, invoke, subscribe },不暴露 ipcRenderer 本身;
// 另暴露 window.ggApp(应用壳:接入模型、版本与更新),同样只有 invoke / subscribe 两个口子。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { API_VERSION, IPC } from "@g-group/api-contract";
import { APP_IPC } from "../src/api/app-shell-types";

contextBridge.exposeInMainWorld("gg", {
  apiVersion: API_VERSION,
  invoke: (method: string, params?: unknown) => ipcRenderer.invoke(IPC.invoke, { method, params: params ?? {} }),
  subscribe: (listener: (event: unknown) => void, opts?: { sinceEventSeq?: number }) => {
    const on = (_e: IpcRendererEvent, ev: unknown) => listener(ev);
    ipcRenderer.on(IPC.event, on);
    ipcRenderer.send(IPC.subscribe, opts ?? {});
    return () => {
      ipcRenderer.removeListener(IPC.event, on);
      ipcRenderer.send(IPC.unsubscribe);
    };
  },
});

contextBridge.exposeInMainWorld("ggApp", {
  invoke: (method: string, params?: unknown) => ipcRenderer.invoke(APP_IPC.invoke, { method, params: params ?? {} }),
  subscribe: (listener: (event: unknown) => void) => {
    const on = (_e: IpcRendererEvent, ev: unknown) => listener(ev);
    ipcRenderer.on(APP_IPC.event, on);
    return () => ipcRenderer.removeListener(APP_IPC.event, on);
  },
});
