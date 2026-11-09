import fs from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";

// 概念版的动效证据(连拍):每条用例本身都断言动效确实发生;设了 GG_SHOTS 时把帧存到 <GG_SHOTS>/concept/<点子>-frame-<主题>-<序号>.png。
// 云端没有 ffmpeg,不录视频;落印、按下回馈用 page.clock 把动画时钟一格一格往前拨,拍到动画中间的帧。
const DIR = process.env.GG_SHOTS ? path.join(process.env.GG_SHOTS, "concept") : null;
const VIEW = { width: 1280, height: 800 };
const THEMES = ["light", "dark"] as const;

async function open(browser: Browser, theme: string, opts: { clock?: boolean; scale?: number } = {}) {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: VIEW, deviceScaleFactor: opts.scale ?? 2, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  const page = await ctx.newPage();
  const t0 = new Date("2026-11-09T02:20:00+08:00").getTime();
  if (opts.clock) await page.clock.install({ time: t0 });
  await page.goto(`/?conv=g&freeze${theme === "dark" ? "&theme=dark" : ""}`);
  /* 停住动画时钟:之后只有 runFor 才往前走,帧是确定的 */
  if (opts.clock) await page.clock.pauseAt(t0 + 2000);
  return page;
}

type Clip = { x: number; y: number; width: number; height: number };
/** 拍一帧(只拍给定区域,CSS 像素),存成 <name>-frame-<theme>-<n>.png */
async function frame(page: Page, name: string, theme: string, n: number | string, clip?: Clip) {
  if (!DIR) return;
  fs.mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: path.join(DIR, `${name}-frame-${theme}-${n}.png`), clip, animations: "allow" });
}

const box = (page: Page) => page.locator("[data-testid=composer-box] textarea");
async function around(page: Page, sel: string, padX: number, padY: number): Promise<Clip> {
  const b = (await page.locator(sel).boundingBox())!;
  const x = Math.max(0, b.x - padX), y = Math.max(0, b.y - padY);
  return { x, y, width: Math.min(VIEW.width - x, b.width + padX * 2), height: Math.min(VIEW.height - y, b.height + padY * 2) };
}
const scaleOf = (page: Page, sel: string) => page.locator(sel).evaluate((el) => { const m = new DOMMatrix(getComputedStyle(el).transform); return Math.hypot(m.a, m.b); });

for (const theme of THEMES) {
  test(`连拍 · 朱印验收(${theme}):印从纸面上方落下、压实,停在 1`, async ({ browser }) => {
    const page = await open(browser, theme, { clock: true });
    const bubble = page.locator('[data-anchor="g6"]');
    await bubble.scrollIntoViewIfNeeded();
    await bubble.hover({ position: { x: 8, y: 8 } });
    await page.clock.runFor(300);
    await page.getByTestId("reply-g6").click();
    await page.clock.runFor(20);
    await box(page).press("End");
    await box(page).pressSequentially("通过");
    await box(page).press("Enter");
    await page.clock.runFor(1);
    await expect(page.getByTestId("seal-perf")).toBeAttached();
    await page.mouse.move(5, 5);
    await bubble.scrollIntoViewIfNeeded();
    const clip = await around(page, '[data-anchor="g6"]', 70, 50);
    // 动画时钟一格一格拨:落下途中缩放大于 1,最后停在 1
    const seen: number[] = [];
    for (const [n, ms] of [[1, 16], [2, 48], [3, 80], [4, 800]] as const) {
      await page.clock.runFor(ms);
      seen.push(await scaleOf(page, "[data-testid=seal-perf]"));
      await frame(page, "seal", theme, n, clip);
    }
    expect(Math.max(...seen.slice(0, 3))).toBeGreaterThan(1.01);
    expect(Math.abs(seen[3] - 1)).toBeLessThan(0.01);
    await page.context().close();
  });

  test(`连拍 · 双击就回复(${theme}):双击 → 气泡按下 → 弹回,引用进输入框`, async ({ browser }) => {
    const page = await open(browser, theme, { clock: true });
    const bubble = page.locator('[data-anchor="g6"]');
    await bubble.scrollIntoViewIfNeeded();
    const b = (await bubble.boundingBox())!;
    const clip: Clip = { x: 0, y: Math.max(0, b.y - 50), width: VIEW.width, height: VIEW.height - Math.max(0, b.y - 50) };
    await frame(page, "dblreply", theme, 1, clip);
    await page.mouse.dblclick(b.x + b.width * 0.4, b.y + b.height * 0.3);
    await expect(bubble).toHaveAttribute("data-dblreply", "1");
    await page.clock.runFor(30);
    const pressed = await scaleOf(page, '[data-anchor="g6"]');
    await frame(page, "dblreply", theme, 2, clip);
    await page.clock.runFor(800);
    await frame(page, "dblreply", theme, 3, clip);
    expect(pressed).toBeLessThan(1);
    expect(await scaleOf(page, '[data-anchor="g6"]')).toBeCloseTo(1, 2);
    await expect(page.getByTestId("quote-bar")).toBeVisible();
    await page.context().close();
  });

  test(`连拍 · 等你刻度(${theme}):悬停看是什么 → 点一下跳过去 → ⌥↓ 下一件 → 答完刻度消失`, async ({ browser }) => {
    const page = await open(browser, theme);
    await page.getByTestId("ruler-tick-g6").hover();
    await expect(page.getByRole("tooltip").first()).toContainText("Codex");
    await frame(page, "ruler", theme, 1);
    await page.getByTestId("ruler-tick-g6").click();
    await expect(page.locator("#m-g6")).toHaveAttribute("data-hl", "1");
    await page.mouse.move(5, 5);
    await page.waitForTimeout(700);
    await frame(page, "ruler", theme, 2);
    await page.keyboard.press("Alt+ArrowDown");
    await expect(page.locator("#m-g12")).toHaveAttribute("data-hl", "1");
    await page.waitForTimeout(700);
    await frame(page, "ruler", theme, 3);
    await page.getByTestId("quick-g12-0").click();
    await expect(page.getByTestId("ruler-tick-g12")).toHaveCount(0);
    await page.waitForTimeout(500);
    await frame(page, "ruler", theme, 4);
    await page.context().close();
  });

  test(`连拍 · 目光(${theme}):打字时等你的头像眼睛跟着光标走,回完眯眼笑`, async ({ browser }) => {
    const page = await open(browser, theme, { scale: 3 });
    const av = page.getByTestId("gaze-g13p");
    await page.locator("#m-g13p").scrollIntoViewIfNeeded();
    await page.mouse.move(VIEW.width - 20, 20);
    const looks: string[] = [];
    const snap = async (n: string) => {
      await page.waitForTimeout(700);
      looks.push((await av.getAttribute("data-look"))!);
      if (DIR) { fs.mkdirSync(DIR, { recursive: true }); await av.screenshot({ path: path.join(DIR, `gaze-frame-${theme}-${n}.png`) }); }
    };
    await snap("1-idle");
    await box(page).click({ position: { x: 4, y: 10 } });
    await snap("2-start");
    await box(page).pressSequentially("同意，不过走查截图要附在交付消息里", { delay: 20 });
    await snap("3-mid");
    await box(page).pressSequentially("，别放在附件里，一眼就能看到才行", { delay: 20 });
    await snap("4-end");
    await box(page).fill("");
    await page.getByTestId("quick-g12-0").click();
    await page.getByTestId("quick-g13p-0").click();
    const happy = page.getByTestId("gaze-g12");
    await expect(happy).toHaveAttribute("data-mood", "happy");
    await page.waitForTimeout(900);
    if (DIR) await happy.screenshot({ path: path.join(DIR, `gaze-frame-${theme}-5-happy.png`) });
    // 眼睛方向真的在变:打字过程中水平分量往右
    const xs = looks.slice(1).map((l) => Number(l.split(",")[0]));
    expect(xs[1]).toBeGreaterThan(xs[0]);
    expect(xs[2]).toBeGreaterThanOrEqual(xs[1]);
    await page.context().close();
  });
}
