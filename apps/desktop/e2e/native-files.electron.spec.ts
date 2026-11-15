import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { shot } from "./shots";

const appDir = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "ELECTRON_RUN_AS_NODE" && typeof e[1] === "string"));
const LONG = { timeout: 30_000 };

async function launch(dir: string) {
  const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...env, GG_USER_DATA_DIR: dir, GG_BACKEND: "server", GG_MIND: "fake", GG_COMPUTE: "fake" } });
  const win = await app.firstWindow();
  await expect(win.getByTestId("backend-demo")).toHaveAttribute("data-wire", "live", LONG);
  await win.getByTestId("nav-contacts").click();
  await win.getByTestId("list").getByText("添加联系人", { exact: true }).click();
  await win.getByPlaceholder("比如：设计师").fill("附件验收");
  await win.getByRole("button", { name: "添加", exact: true }).click();
  await expect(win.getByTestId("chat").locator("header")).toContainText("附件验收", LONG);
  return { app, win };
}

test("本地文件路径:选择的真实文件能取回原路径,内存 File 没有伪造路径;附件仍可发送", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-native-path-"));
  const file = path.join(dir, "有空格的 附件.txt");
  writeFileSync(file, "来自本地文件\n");
  const { app, win } = await launch(dir);
  try {
    // 只在输入框的真实 change 事件里读取 File,不以字符串假冒本地文件。
    await win.getByTestId("file-input").evaluate((el) => {
      el.addEventListener("change", () => {
        const bridge = (window as unknown as { ggApp: { getPathForFile?: (f: File) => string } }).ggApp;
        el.setAttribute("data-native-path", bridge.getPathForFile?.((el as HTMLInputElement).files![0]!) ?? "接口缺失");
      }, { capture: true });
    });
    await win.getByTestId("file-input").setInputFiles(file);
    await expect(win.getByTestId("file-input")).toHaveAttribute("data-native-path", file);
    const memoryPath = await win.evaluate(() => (window as unknown as { ggApp: { getPathForFile: (f: File) => string } }).ggApp.getPathForFile(new File(["内容"], "内存.txt")));
    expect(memoryPath).toBe("");
    await expect(win.getByTestId("attachment-有空格的 附件.txt")).toBeVisible(LONG);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("截图:当前窗口返回有效 PNG,点击输入栏截图发送真实附件,重启后仍在", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-native-shot-"));
  let { app, win } = await launch(dir);
  try {
    const capture = await win.evaluate(() => (window as unknown as { ggApp: { invoke: (m: string, p: object) => Promise<{ ok: boolean; value?: { base64: string; width: number; height: number } }> } }).ggApp.invoke("window.capture", {}));
    expect(capture.ok).toBe(true);
    const png = Buffer.from(capture.value!.base64, "base64");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(capture.value!.width);
    expect(png.readUInt32BE(20)).toBe(capture.value!.height);
    expect(png.length).toBeGreaterThan(1000);
    await expect(win.getByTestId("tool-shot")).toBeVisible();
    await win.getByTestId("tool-shot").click();
    const card = win.locator('[data-testid^="attachment-截图 "]');
    await expect(card).toHaveCount(1, LONG);
    await expect(card).toContainText("你发的");
    const cardId = await card.getAttribute("data-testid");
    await shot(win, "native-window-shot-sent");
    await app.close();
    app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...env, GG_USER_DATA_DIR: dir, GG_BACKEND: "server", GG_MIND: "fake", GG_COMPUTE: "fake" } });
    win = await app.firstWindow();
    await expect(win.getByTestId("backend-demo")).toHaveAttribute("data-wire", "live", LONG);
    await win.getByTestId("list").locator('[data-testid^="conv-dm-"]').filter({ hasText: "附件验收" }).click();
    await expect(win.getByTestId(cardId!)).toBeVisible(LONG);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("内存附件超过通用 IPC 上限仍按上传合同发送,普通请求不放宽", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-native-large-"));
  const { app, win } = await launch(dir);
  try {
    await win.getByTestId("file-input").setInputFiles({ name: "大附件.txt", mimeType: "text/plain", buffer: Buffer.alloc(300_000, "x") });
    await expect(win.getByTestId("attachment-大附件.txt")).toBeVisible(LONG);
    const denied = await win.evaluate(() => (window as unknown as { gg: { invoke: (m: string, p: object) => Promise<{ ok: boolean; error?: { message: string } }> } }).gg.invoke("messages.send", { text: "x".repeat(300_000) }));
    expect(denied.ok).toBe(false);
    expect(denied.error?.message).toContain("超过上限");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
