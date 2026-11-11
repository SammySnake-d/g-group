// 应用壳的 IPC(gg-app:invoke / gg-app:event):接入模型、版本与更新。和宿主合同(gg:invoke)分开,方法白名单 + 来源校验。
import { app, BrowserWindow, ipcMain } from "electron";
import { isTrustedOrigin } from "@g-group/ui-core";
import { APP_IPC, APP_SHELL_METHODS, type AppShellEvent, type AppShellMethod, type SetupInput, type SetupView } from "../src/api/app-shell-types";
import type { AppConfig } from "./app-config.ts";
import type { Backend } from "./backend.ts";
import { log } from "./log.ts";
import { fixPath } from "./shell-env.ts";
import type { Updater } from "./updater.ts";

const isMethod = (m: unknown): m is AppShellMethod => typeof m === "string" && (APP_SHELL_METHODS as readonly string[]).includes(m);

export function broadcast(ev: AppShellEvent) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(APP_IPC.event, ev);
}

export function bindAppIpc(o: { config: AppConfig; backend: Backend; updater: Updater; devOrigin?: string }) {
  const view = (): SetupView => ({ gateway: o.config.gatewayView(), claudePath: o.backend.claudePath(), backend: o.backend.status() });
  const H: Record<AppShellMethod, (p: Record<string, unknown>) => unknown> = {
    "app.info": () => ({ version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, arch: process.arch }),
    "setup.get": () => view(),
    "setup.save": async (p) => {
      const g = o.config.saveGateway(p as unknown as SetupInput);
      log(`接入模型:网关 ${new URL(g.baseUrl).host},模型 ${g.model}`);
      await o.backend.restart();
      const v = view();
      // 后端换了一个实例:让渲染层重新探测、全量读、订阅(回包先到,再重载)
      if (v.backend.state === "running") setTimeout(() => { for (const w of BrowserWindow.getAllWindows()) w.webContents.reload(); }, 150);
      return v;
    },
    "setup.detectClaude": () => {
      fixPath();
      return view();
    },
    "update.get": () => o.updater.get(),
    "update.check": () => o.updater.check(),
    "update.download": () => o.updater.download(),
    "update.install": () => o.updater.install(),
  };
  ipcMain.handle(APP_IPC.invoke, async (event, req: unknown) => {
    if (!isTrustedOrigin(event.senderFrame?.url ?? "", o.devOrigin)) return { ok: false, error: "来源不是本应用页面" };
    const r = req as { method?: unknown; params?: unknown } | null;
    if (!r || typeof r !== "object" || !isMethod(r.method)) return { ok: false, error: `不认识的方法 ${String(r?.method)}` };
    const params = r.params && typeof r.params === "object" && !Array.isArray(r.params) ? (r.params as Record<string, unknown>) : {};
    try {
      return { ok: true, value: await H[r.method](params) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
