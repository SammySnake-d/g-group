import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// 前端对照原型接通真实后端(第二轮):连真实后端时还在本地假装做成的、界面在但关着的,逐项接上或如实关着。
// GG_BACKEND=server、规则替身脑子(被 @ / 私聊里正文以「帮我/请」开头才派活)、桌面替身 Compute(带「慢慢」每步停 20 秒);只点界面、只读界面。
const appDir = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "ELECTRON_RUN_AS_NODE" && typeof e[1] === "string"));
const LONG = { timeout: 30_000 };

async function launch(dataDir: string): Promise<{ app: ElectronApplication; win: Page; errors: string[] }> {
  const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...env, GG_BACKEND: "server", GG_DATA_DIR: dataDir, GG_MIND: "fake", GG_COMPUTE: "fake" } });
  const win = await app.firstWindow();
  const errors: string[] = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  const mark = win.getByTestId("backend-demo");
  await expect(mark).toHaveAttribute("data-mode", "connected", LONG);
  await expect(mark).toHaveAttribute("data-wire", "live", LONG);
  return { app, win, errors };
}

async function addContact(win: Page, name: string) {
  await win.getByTestId("nav-contacts").click();
  await win.getByTestId("list").getByText("添加联系人", { exact: true }).click();
  await win.getByPlaceholder("比如：设计师").fill(name);
  await win.getByRole("button", { name: "添加", exact: true }).click();
  await expect(win.getByTestId("chat").locator("header")).toContainText(name, LONG);
}

async function send(win: Page, text: string) {
  const box = win.getByTestId("composer");
  await box.fill(text);
  await box.press("Enter");
}

const computeLine = (win: Page, title: string): Locator => win.getByTestId("chat-column").locator('[data-testid^="compute-line-"]').filter({ hasText: title });
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

test("进展全景按真实时钟算:连后端时在跑的 Compute 写的是现在的开始时刻、已跑几秒,不是演示时钟 02:16", async () => {
  test.setTimeout(150_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-pback-"));
  const { app, win, errors } = await launch(dataDir);
  try {
    await addContact(win, "小克");
    const before = new Date();
    await send(win, "帮我慢慢整理资料");
    await expect(computeLine(win, "慢慢整理资料")).toHaveAttribute("data-state", "running", LONG);
    const after = new Date();
    await win.getByTestId("nav-activity").click();
    const card = win.getByTestId("pano-board").locator('[data-testid^="pano-compute-"]').filter({ hasText: "慢慢整理资料" });
    await expect(card).toHaveCount(1, LONG);
    // 开始时刻是刚才派活的那一分钟(派活前后各取一次,跨分钟也认),不是演示时钟
    const starts = [...new Set([hhmm(before), hhmm(after)])].map((t) => `${t} 开始`);
    await expect(card).toContainText(new RegExp(starts.join("|")));
    await expect(card).not.toContainText("02:16 开始");
    // 已跑:秒或一两分钟,不会是几小时;也不会因为「最近进展」被算到十几个小时前而判成卡住
    await expect(card).toContainText(/运行中 · 已跑 (不到 1 分|\d+ 分)/);
    await expect(card).not.toContainText(/小时|无进展|昨天/);
    await shot(win, "pano-live-clock");
    expect(errors, "页面不该抛错").toEqual([]);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("停滞检测按真实时刻:连后端时在跑的 Compute 超过 10 分钟没有新进度,那一行原地变黄写明多久没动静、卡在哪,全景卡也写无进展", async () => {
  test.setTimeout(150_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-pstall-"));
  const { app, win, errors } = await launch(dataDir);
  try {
    await addContact(win, "小克");
    await send(win, "帮我慢慢整理资料");
    const line = computeLine(win, "慢慢整理资料");
    await expect(line).toHaveAttribute("data-state", "running", LONG);
    await expect(line).not.toContainText("没动静");
    // 让界面的钟往后拨 11 分钟(只拨 Date.now,不动后端):最近一条进度还是刚才那条,于是算出 11 分钟没动静
    await win.evaluate(() => { const real = Date.now.bind(Date); Date.now = () => real() + 11 * 60_000; });
    await expect(line).toHaveAttribute("data-state", "stalled", { timeout: 45_000 });
    await expect(line).toContainText(/1[12] 分钟没动静 · 卡在「第 [12] 步 · /);
    await shot(win, "stall-line");
    await win.getByTestId("nav-activity").click();
    const card = win.getByTestId("pano-board").locator('[data-testid^="pano-compute-"]').filter({ hasText: "慢慢整理资料" });
    await expect(card).toContainText(/已 1[12] 分钟无进展/, LONG);
    expect(errors, "页面不该抛错").toEqual([]);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
