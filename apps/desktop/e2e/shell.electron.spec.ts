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
    // 白名单方法可调;不认识的方法和非纯数据参数被主进程拒绝
    const info = await win.evaluate(() => (window as unknown as { gGroup: { call: (m: string, p?: unknown) => Promise<unknown> } }).gGroup.call("app.info"));
    expect(info).toMatchObject({ ok: true, data: { backend: "disconnected" } });
    const bad = await win.evaluate(() => (window as unknown as { gGroup: { call: (m: string, p?: unknown) => Promise<unknown> } }).gGroup.call("fs.readFile", { path: "/etc/passwd" }));
    expect(bad).toMatchObject({ ok: false });
    expect(String((bad as { error: string }).error)).toContain("不认识的方法");
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
