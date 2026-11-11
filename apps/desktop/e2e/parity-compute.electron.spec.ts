import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// 按原型补全前端 · Compute 块(连真实后端:GG_BACKEND=server,规则替身脑子 + 桌面替身 Compute,只点界面、只读界面)。
// 桌面替身 Compute 按派的活说话:一般的活「动手 · 正在<活>」→「完成:<活>」;活里带「验证码」停在受阻等你接手;
// 带「会失败」一开始就失败、宿主出原位失败卡;带「慢慢」每步之间停很久,好按停止。
// 对应原型功能项:F-LIVE / F-NO-ACCEPT(做完挂在交付消息下)、F-COMPUTE-RO(分屏只读、会话 / 过程读真实记录、回会话 @联系人)、
// F-CAPTCHA / F-CAPTCHA-NO(卡在验证码交给你,接手交还 / 不做就取消)、F-ERROR / F-FAIL3(出错原地变红、重试)、
// F-STOP2(停止两步,停下后可继续)、F-FILES(文件区读真实文件、来处在正文右侧、点了回原消息)。
const appDir = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "ELECTRON_RUN_AS_NODE" && typeof e[1] === "string"));
const LONG = { timeout: 30_000 };

const rows = (win: Page) => win.getByTestId("chat-column").locator("[data-msg]");
const computeLine = (win: Page, title: string) => win.getByTestId("chat-column").locator('[data-testid^="compute-line-"]').filter({ hasText: title });

/** 起应用、等连上后端、建联系人「小克」并进它的私聊 */
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

/** 联系人说的那几条里含这句的(不算你发的,也不算它派出的 Compute 那一行) */
const said = (win: Page, text: string): Locator => rows(win).filter({ hasText: text }).and(win.locator('[data-msg]:not([data-from="me"]):not([data-msg$="~c"])'));

test("做完的 Compute 挂在联系人的交付消息下面;点开分屏:运行位置与 harness 照原型,会话 / 过程读真实记录,只读、回会话 @联系人", async () => {
  test.setTimeout(150_000);
  const { win, errors, done } = await boot();
  try {
    await send(win, "帮我整理周报");
    const delivered = said(win, "做完了:完成:整理周报");
    await expect(delivered).toHaveCount(1, LONG);
    // F-LIVE / F-NO-ACCEPT(#1790 消息优先):做完后 Compute 那一行挂在交付消息最下面,不再单独占一行;交付消息下没有验收按钮
    const trail = delivered.locator('[data-testid^="trail-"] [data-testid^="compute-line-"]');
    await expect(trail).toHaveCount(1, LONG);
    await expect(trail).toHaveAttribute("data-state", "done");
    await expect(win.locator('[data-msg$="~c"]').filter({ hasText: "整理周报" })).toHaveCount(0);
    await expect(delivered.getByText(/去验收|等你验收/)).toHaveCount(0);
    // 替身 Compute 按派的活说话,联系人转述的进度是这件事本身
    await expect(said(win, "进度:正在整理周报")).toHaveCount(1, LONG);
    await expect(rows(win).filter({ hasText: "hello.txt" })).toHaveCount(0);
    await shot(win, "F-LIVE-delivered-trail");

    await trail.click();
    // 运行位置、harness、模型照原型写在头部
    await expect(win.getByTestId("compute-placement")).toHaveText("运行在：本机");
    await expect(win.getByTestId("compute-harness")).toHaveText("Claude Code");
    // 「会话」页:联系人交给它的话 + 它自己报的每一步 + 结论,都来自后端;不再是「还没拿到 harness 记录」
    const session = win.getByTestId("harness-session");
    await expect(session).toContainText("整理周报", LONG);
    await expect(session).toContainText("动手 · 正在整理周报");
    await expect(session).toContainText("完成:整理周报");
    await expect(session).not.toContainText("还没拿到");
    await shot(win, "F-COMPUTE-RO-session");
    // 「过程」页:开始 → 动手 → 完成
    await win.getByTestId("cview-activity").click();
    const acts = win.getByTestId("activity");
    await expect(acts).toContainText("动手 · 正在整理周报");
    await expect(acts).toContainText("完成:整理周报");
    await shot(win, "F-COMPUTE-RO-activity");
    // F-COMPUTE-RO:分屏里没有给 Compute 的输入框;底部「回私聊 @小克」带着引用回到会话
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
    // F-CAPTCHA:那一行变成「要你来」,写明卡在哪;是联系人在会话里 @你 说明的,不是 Compute 自己说话
    await expect(line).toHaveAttribute("data-state", "human", LONG);
    await expect(line).toContainText("验证码");
    await expect(said(win, "这一步得你来")).toHaveCount(1, LONG);
    await shot(win, "F-CAPTCHA-human");
    await line.getByRole("button", { name: "我来处理" }).click();
    await expect(line).toContainText("你在处理");
    await line.getByRole("button", { name: /交还给 小克/ }).click();
    // 交还 = 回答它卡住的那一步;它接着做完、联系人交付
    await expect(said(win, "做完了:完成:登录后台查日志(要验证码)")).toHaveCount(1, LONG);
    await expect(computeLine(win, "登录后台查日志")).toHaveAttribute("data-state", "done", LONG);
    await shot(win, "F-CAPTCHA-returned");

    // F-CAPTCHA-NO:你不做 → 任务取消、Compute 停下
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
    // F-ERROR:聊天里那一行原地变红写明原因,重试离指针最近;输入框上方没有错误卡
    await expect(line).toHaveAttribute("data-state", "error", LONG);
    await expect(line).toContainText("平台拒绝");
    await expect(line.getByRole("button", { name: "重试", exact: true })).toBeVisible();
    await expect(win.locator('[data-testid="pending"][data-kind="error"]')).toHaveCount(0);
    // F-FAIL3:另一条路照失败卡上真有的写(放弃这件写成卡上的原话「不重试了」;备用模型配了才有「换个模型」)
    await expect(line.getByRole("button", { name: "不重试了" })).toBeVisible();
    await shot(win, "F-ERROR-line");
    await line.getByRole("button", { name: "重试", exact: true }).click();
    await expect(said(win, "做完了:完成:抓取网页(会失败)")).toHaveCount(1, LONG);
    await expect(computeLine(win, "抓取网页")).toHaveAttribute("data-state", "done", LONG);
    // 你点的「重试」以你的名义记进会话(决定是共享上下文)
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
    // 在跑:Compute 行挂在联系人「接了任务」那句下面,不另起头像
    await expect(win.locator('[data-msg$="~c"]').filter({ has: win.locator('[data-testid^="compute-line-"]'), hasText: "慢慢整理资料" })).toHaveAttribute("data-first", "0");
    // 这件活慢慢做:过几秒还在跑,来得及按停止
    await win.waitForTimeout(3000);
    await expect(line).toHaveAttribute("data-state", "running");
    await line.click();
    await win.getByTestId("compute-stop").click();
    // F-STOP2:确认它启动的程序都退出了才到「已停止」,注明算力已归还;按下去之后不再有停止按钮
    await expect(win.getByTestId("compute-stop")).toHaveCount(0);
    await expect(line).toHaveAttribute("data-state", "stopped", LONG);
    await expect(win.getByTestId("split")).toContainText("算力已归还");
    // 你点停止以你的名义记进会话
    await expect(rows(win).filter({ hasText: "取消任务" }).and(win.locator('[data-from="me"]'))).toHaveCount(1);
    await shot(win, "F-STOP2-stopped");
    // 继续:按运行台账重跑(联系人说明是重跑,开一件新的在跑)
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
    // 正文是后端读来的产出原文
    await expect(win.getByTestId("file-preview")).toContainText("做完了:完成:写周报", LONG);
    // 来处在正文右侧:来自和小克的私聊,交付那一站是小克
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
