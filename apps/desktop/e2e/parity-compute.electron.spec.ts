import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { shot } from "./shots";

const appDir = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "ELECTRON_RUN_AS_NODE" && typeof e[1] === "string"));
const LONG = { timeout: 30_000 };

const rows = (win: Page) => win.getByTestId("chat-column").locator("[data-msg]");
const computeLine = (win: Page, title: string) => win.getByTestId("chat-column").locator('[data-testid^="compute-line-"]').filter({ hasText: title });

async function boot(): Promise<{ app: ElectronApplication; win: Page; errors: string[]; done: () => Promise<void> }> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-pcompute-"));
  const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...env, GG_BACKEND: "server", GG_DATA_DIR: dataDir, GG_MIND: "fake", GG_COMPUTE: "fake" } });
  const errors: string[] = [];
  const win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  const mark = win.getByTestId("backend-demo");
  await expect(mark).toHaveAttribute("data-mode", "connected", LONG);
  await expect(mark).toHaveAttribute("data-wire", "live", LONG);
  await win.getByTestId("nav-contacts").click();
  await win.getByTestId("list").getByText("添加联系人", { exact: true }).click();
  await win.getByPlaceholder("比如：设计师").fill("小克");
  await win.getByRole("button", { name: "添加", exact: true }).click();
  await expect(win.getByTestId("chat").locator("header")).toContainText("小克", LONG);
  return { app, win, errors, done: async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

async function send(win: Page, text: string) {
  const box = win.getByTestId("composer");
  await box.fill(text);
  await box.press("Enter");
}

const said = (win: Page, text: string): Locator => rows(win).filter({ hasText: text }).and(win.locator('[data-msg]:not([data-from="me"]):not([data-msg$="~c"])'));

test("做完的 Compute 挂在联系人的交付消息下面;点开分屏:运行位置与 harness 照原型,会话 / 过程读真实记录,只读、回会话 @联系人", async () => {
  test.setTimeout(150_000);
  const { win, errors, done } = await boot();
  try {
    await send(win, "帮我整理周报");
    const delivered = said(win, "做完了:完成:整理周报");
    await expect(delivered).toHaveCount(1, LONG);
    const trail = delivered.locator('[data-testid^="trail-"] [data-testid^="compute-line-"]');
    await expect(trail).toHaveCount(1, LONG);
    await expect(trail).toHaveAttribute("data-state", "done");
    await expect(win.locator('[data-msg$="~c"]').filter({ hasText: "整理周报" })).toHaveCount(0);
    await expect(delivered.getByText(/去验收|等你验收/)).toHaveCount(0);
    await expect(said(win, "进度:正在整理周报")).toHaveCount(1, LONG);
    await expect(rows(win).filter({ hasText: "hello.txt" })).toHaveCount(0);
    await shot(win, "F-LIVE-delivered-trail");

    await trail.click();
    await expect(win.getByTestId("compute-placement")).toHaveText("运行在：本机");
    await expect(win.getByTestId("compute-harness")).toHaveText("Claude Code");
    const session = win.getByTestId("harness-session");
    await expect(session).toContainText("整理周报", LONG);
    await expect(session).toContainText("动手 · 正在整理周报");
    await expect(session).toContainText("完成:整理周报");
    await expect(session).not.toContainText("还没拿到");
    await shot(win, "F-COMPUTE-RO-session");
    await win.getByTestId("cview-activity").click();
    const acts = win.getByTestId("activity");
    await expect(acts).toContainText("动手 · 正在整理周报");
    await expect(acts).toContainText("完成:整理周报");
    await shot(win, "F-COMPUTE-RO-activity");
    await expect(win.getByTestId("split").getByTestId("composer")).toHaveCount(0);
    await expect(win.getByTestId("compute-readonly")).toContainText("小克");
    await win.getByTestId("compute-talk").click();
    await expect(win.getByTestId("composer")).toHaveValue(/^@小克 /);
    await expect(win.getByTestId("quote-chip")).toHaveCount(1);
    expect(errors, "页面不该抛错").toEqual([]);
  } finally {
    await done();
  }
});

test("卡在验证码:那一行原地交给你,你接手、交还后它接着做完;另一件你点不做了就取消", async () => {
  test.setTimeout(180_000);
  const { win, errors, done } = await boot();
  try {
    await send(win, "帮我登录后台查日志(要验证码)");
    const line = computeLine(win, "登录后台查日志");
    await expect(line).toHaveAttribute("data-state", "human", LONG);
    await expect(line).toContainText("验证码");
    await expect(said(win, "这一步得你来")).toHaveCount(1, LONG);
    await shot(win, "F-CAPTCHA-human");
    await line.getByRole("button", { name: "我来处理" }).click();
    await expect(line).toContainText("你在处理");
    await line.getByRole("button", { name: /交还给 小克/ }).click();
    await expect(said(win, "做完了:完成:登录后台查日志(要验证码)")).toHaveCount(1, LONG);
    await expect(computeLine(win, "登录后台查日志")).toHaveAttribute("data-state", "done", LONG);
    await shot(win, "F-CAPTCHA-returned");

    await send(win, "帮我登录邮箱收验证码");
    const second = computeLine(win, "登录邮箱收验证码");
    await expect(second).toHaveAttribute("data-state", "human", LONG);
    await second.getByRole("button", { name: "不做了" }).click();
    await expect(second).toHaveAttribute("data-state", "stopped", LONG);
    await expect(second).not.toContainText("要你来");
    await shot(win, "F-CAPTCHA-NO-declined");
    expect(errors, "页面不该抛错").toEqual([]);
  } finally {
    await done();
  }
});

test("出错原地变红给出路:不进输入框上方,点重试后续接做完", async () => {
  test.setTimeout(150_000);
  const { win, errors, done } = await boot();
  try {
    await send(win, "帮我抓取网页(会失败)");
    const line = computeLine(win, "抓取网页");
    await expect(line).toHaveAttribute("data-state", "error", LONG);
    await expect(line).toContainText("平台拒绝");
    await expect(line.getByRole("button", { name: "重试", exact: true })).toBeVisible();
    await expect(win.locator('[data-testid="pending"][data-kind="error"]')).toHaveCount(0);
    await expect(line.getByRole("button", { name: "不重试了" })).toBeVisible();
    await shot(win, "F-ERROR-line");
    await line.getByRole("button", { name: "重试", exact: true }).click();
    await expect(said(win, "做完了:完成:抓取网页(会失败)")).toHaveCount(1, LONG);
    await expect(computeLine(win, "抓取网页")).toHaveAttribute("data-state", "done", LONG);
    await expect(rows(win).filter({ hasText: "重试" }).and(win.locator('[data-from="me"]'))).toHaveCount(1);
    await shot(win, "F-FAIL3-retried");
    expect(errors, "页面不该抛错").toEqual([]);
  } finally {
    await done();
  }
});

test("停止两步:在跑时挂在接活那句下面;按停止先「正在停止」,确认停下才写已停止、算力归还;点继续按台账重跑", async () => {
  test.setTimeout(150_000);
  const { win, errors, done } = await boot();
  try {
    await send(win, "帮我慢慢整理资料");
    const line = computeLine(win, "慢慢整理资料");
    await expect(line).toHaveAttribute("data-state", "running", LONG);
    await expect(win.locator('[data-msg$="~c"]').filter({ has: win.locator('[data-testid^="compute-line-"]'), hasText: "慢慢整理资料" })).toHaveAttribute("data-first", "0");
    await win.waitForTimeout(3000);
    await expect(line).toHaveAttribute("data-state", "running");
    await line.click();
    await win.getByTestId("compute-stop").click();
    await expect(win.getByTestId("compute-stop")).toHaveCount(0);
    await expect(line).toHaveAttribute("data-state", "stopped", LONG);
    await expect(win.getByTestId("split")).toContainText("算力已归还");
    await expect(rows(win).filter({ hasText: "取消任务" }).and(win.locator('[data-from="me"]'))).toHaveCount(1);
    await shot(win, "F-STOP2-stopped");
    await win.getByTestId("split").getByRole("button", { name: "继续" }).click();
    await expect(said(win, "重跑任务:慢慢整理资料")).toHaveCount(1, LONG);
    await expect(computeLine(win, "慢慢整理资料").and(win.locator('[data-state="running"]'))).toHaveCount(1, LONG);
    await shot(win, "F-STOP2-resumed");
    expect(errors, "页面不该抛错").toEqual([]);
  } finally {
    await done();
  }
});

test("文件:连上后端时文件区列出真实的任务产出,打开看正文,来处在正文右侧,点了回到原消息", async () => {
  test.setTimeout(150_000);
  const { win, errors, done } = await boot();
  try {
    await send(win, "帮我写周报");
    await expect(said(win, "做完了:完成:写周报")).toHaveCount(1, LONG);
    await win.getByTestId("nav-files").click();
    const card = win.getByTestId("file-shelf-grid").locator('[data-testid^="shelf-"]').filter({ hasText: "写周报 · 结果" });
    await expect(card).toHaveCount(1, LONG);
    await shot(win, "F-FILES-shelf");
    await card.click();
    await expect(win.getByTestId("file-preview")).toContainText("做完了:完成:写周报", LONG);
    const source = win.getByTestId("file-source");
    await expect(source).toContainText("小克");
    const hop = source.locator('[data-testid^="file-hop-"][data-source="true"]').filter({ visible: true });
    await expect(hop).toHaveCount(1);
    await expect(hop).toContainText("交付");
    await shot(win, "F-FILES-reader");
    await hop.click();
    await expect(win.getByTestId("chat-column")).toBeVisible();
    await expect(win.locator('[data-hl="1"]').filter({ hasText: "做完了:完成:写周报" })).toHaveCount(1, LONG);
    await expect(win.getByTestId("file-return")).toBeVisible();
    await shot(win, "F-FILES-jumped");
    expect(errors, "页面不该抛错").toEqual([]);
  } finally {
    await done();
  }
});
