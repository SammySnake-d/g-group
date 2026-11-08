import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const appDir = path.resolve(import.meta.dirname, "..");
// 宿主(比如在 Electron 应用里跑的终端)可能带着 ELECTRON_RUN_AS_NODE,会让 Electron 退化成纯 Node,这里去掉
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "ELECTRON_RUN_AS_NODE" && typeof e[1] === "string"));

test("Electron 壳:安全基线开着,渲染层拿不到 Node,IPC 只认白名单方法", async () => {
  const app = await electron.launch({ args: [appDir], cwd: appDir, env });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    expect(win.url()).toBe("app://renderer/index.html");
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      // getLastWebPreferences 运行时存在,类型声明里没有
      const p = (w.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences();
      return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox };
    });
    expect(prefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true });
    // 渲染层没有 require / process
    expect(await win.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe("undefined");
    expect(await win.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe("undefined");
    // 按接口合同暴露 window.gg;方法名、参数先在主进程校验,后端没接上时如实回 unavailable
    type Gg = { apiVersion: string; invoke: (m: string, p?: unknown) => Promise<{ ok: boolean; error?: { code: string; message: string } }> };
    const call = (m: string, p?: unknown) => win.evaluate(([m, p]) => (window as unknown as { gg: Gg }).gg.invoke(m as string, p), [m, p] as const);
    expect(await win.evaluate(() => (window as unknown as { gg: Gg }).gg.apiVersion)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(await call("session.hello", { clientApiVersion: "0.1.0" })).toEqual({ ok: false, error: { code: "unavailable", message: "后端未连接" } });
    const unknown = await call("fs.readFile", { path: "/etc/passwd" });
    expect(unknown.error?.code).toBe("unknown_method");
    const badParams = await call("contacts.get", {});
    expect(badParams.error?.code).toBe("invalid_params");
    expect(badParams.error?.message).toContain("contactId");
    // 没有 ipcRenderer / 旧的 gGroup 入口
    expect(await win.evaluate(() => typeof (globalThis as { gGroup?: unknown }).gGroup)).toBe("undefined");
    // 后端没接上:界面明确标出「演示」,不假装已连上
    await expect(win.getByTestId("backend-demo")).toHaveAttribute("data-mode", "demo");
    // 页面渲染出来了(左栏会话列表)
    await expect(win.locator("#root")).not.toBeEmpty();
    // 外部跳转被拦,仍停在应用页
    await win.evaluate(() => { location.href = "https://example.com/"; });
    await win.waitForTimeout(300);
    expect(win.url()).toBe("app://renderer/index.html");
  } finally {
    await app.close();
  }
});
