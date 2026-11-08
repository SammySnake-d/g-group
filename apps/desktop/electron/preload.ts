// 最小 preload:只暴露一个 call(method, params) 和只读的版本信息,不暴露 ipcRenderer 本身。
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("gGroup", {
  shell: "electron",
  call: (method: string, params?: unknown) => ipcRenderer.invoke("gg:call", { method, params: params ?? null }),
});
