// g-group 桌面壳主进程。安全基线按技术栈与工程规则 §2 / Electron Security 清单:
// contextIsolation 开、nodeIntegration 关、sandbox 开、最小 preload、IPC 校验来源与参数、
// 禁止页面跳转和新窗口、自定义 app:// 协议只读 dist/ 下的文件、CSP 由页面 meta 下发。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, ipcMain, protocol, session, shell } from "electron";
import { IPC, isMethodName } from "@g-group/api-contract";
import { checkIpcRequest, isTrustedOrigin } from "@g-group/ui-core";
import { attachServer, handleInvoke, subscribe } from "./bridge.ts";
import { startBackend } from "./backend.ts";

const DEV_URL = process.env.GG_DEV_URL ?? "";
const DEV_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : undefined;
const RENDERER_DIR = path.resolve(__dirname, "../dist");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

function serveRenderer() {
  protocol.handle("app", async (req) => {
    const u = new URL(req.url);
    if (u.host !== "renderer") return new Response("not found", { status: 404 });
    const rel = decodeURIComponent(u.pathname === "/" ? "/index.html" : u.pathname);
    const file = path.resolve(RENDERER_DIR, `.${rel}`);
    // 只读 dist/ 里面的文件:解析后的路径必须仍在 dist 目录下
    if (file !== RENDERER_DIR && !file.startsWith(RENDERER_DIR + path.sep)) return new Response("forbidden", { status: 403 });
    try {
      const body = await readFile(file);
      return new Response(body, { headers: { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: "g-group",
    backgroundColor: "#f7f5f1",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const contents = win.webContents;
  // 页面里点外链:不在应用窗口里打开,交给系统浏览器(只放行 https)
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://renderer/") && !(DEV_ORIGIN && url.startsWith(DEV_ORIGIN))) e.preventDefault();
  });
  void win.loadURL(DEV_URL || "app://renderer/index.html");
  return win;
}

ipcMain.handle(IPC.invoke, async (event, req: unknown) => {
  const checked = checkIpcRequest(req, event.senderFrame?.url ?? "", { isMethod: isMethodName, ...(DEV_ORIGIN ? { devOrigin: DEV_ORIGIN } : {}) });
  if (!checked.ok) return { ok: false, error: { code: checked.error.startsWith("不认识的方法") ? "unknown_method" : "forbidden", message: checked.error } };
  return handleInvoke(checked.method, checked.params);
});

// 事件流:每个渲染进程一份订阅,窗口关掉或取消时退订
const subs = new Map<number, () => void>();
ipcMain.on(IPC.subscribe, (event, opts: unknown) => {
  if (!isTrustedOrigin(event.senderFrame?.url ?? "", DEV_ORIGIN)) return;
  const wc = event.sender;
  subs.get(wc.id)?.();
  const since = typeof (opts as { sinceEventSeq?: unknown })?.sinceEventSeq === "number" ? (opts as { sinceEventSeq: number }).sinceEventSeq : undefined;
  subs.set(wc.id, subscribe((ev) => { if (!wc.isDestroyed()) wc.send(IPC.event, ev); }, since));
  wc.once("destroyed", () => { subs.get(wc.id)?.(); subs.delete(wc.id); });
});
ipcMain.on(IPC.unsubscribe, (event) => {
  subs.get(event.sender.id)?.();
  subs.delete(event.sender.id);
});

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (e) => e.preventDefault());
});

app.whenReady().then(async () => {
  serveRenderer();
  // 宿主服务(@g-group/server)在主进程内起:GG_BACKEND=server 时接上,否则如实回「后端未连接」走演示数据
  const backend = await startBackend(app.getPath("userData"));
  if (backend) {
    attachServer(backend.service);
    app.on("before-quit", () => void backend.close());
  }
  // 渲染层不申请任何系统权限(摄像头、通知、定位……)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

