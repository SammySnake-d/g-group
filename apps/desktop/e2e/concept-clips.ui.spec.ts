import fs from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";

// 概念版的动效证据(连拍):每条用例本身都断言动效确实发生;设了 GG_SHOTS 时把帧存到 <GG_SHOTS>/concept/<点子>-frame-<主题>-<序号>.png。
// 云端没有 ffmpeg,不录视频。动效是否发生由页面内按帧采样断言(真实时间);中间帧用 Chrome screencast 收真实画出的帧。
const DIR = process.env.GG_SHOTS ? path.join(process.env.GG_SHOTS, "concept") : null;
const VIEW = { width: 1280, height: 800 };
const THEMES = ["light", "dark"] as const;

/** slowmo:按库的 tempo 规则把概念版动效放慢 N 倍(只为在慢机器上拍清过程,形状不变) */
async function open(browser: Browser, theme: string, opts: { scale?: number; slowmo?: number } = {}) {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: VIEW, deviceScaleFactor: opts.scale ?? 2, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  const page = await ctx.newPage();
  await page.goto(`/?conv=g&freeze${theme === "dark" ? "&theme=dark" : ""}${opts.slowmo ? `&slowmo=${opts.slowmo}` : ""}`);
  return page;
}

/** 在页面里按帧采样某个元素的缩放(动画是真实时间跑的,不靠假时钟):返回采样期间的最小、最大值和最后一个值 */
async function sampleScale(page: Page, sel: string, ms: number) {
  return page.evaluate(([sel, ms]) => new Promise<{ min: number; max: number; last: number }>((done) => {
    let min = Infinity, max = -Infinity, last = NaN
    const t0 = performance.now()
    const tick = () => {
      const el = document.querySelector(sel as string)
      if (el) { const m = new DOMMatrix(getComputedStyle(el).transform); last = Math.hypot(m.a, m.b); min = Math.min(min, last); max = Math.max(max, last) }
      if (performance.now() - t0 < (ms as number)) requestAnimationFrame(tick); else done({ min, max, last })
    }
    tick()
  }), [sel, ms] as const);
}

/** 真实帧连拍:用 Chrome 的 screencast 把动作前后 ms 毫秒里浏览器真的画出来的每一帧收下来(和录像同源,不重放、不模拟),
 *  存成 <name>-cast-<theme>-<序号>.jpg;没设 GG_SHOTS 时只执行动作 */
async function screencast(page: Page, name: string, theme: string, ms: number, act: () => Promise<unknown>) {
  if (!DIR) return act();
  fs.mkdirSync(DIR, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames: Buffer[] = [];
  cdp.on("Page.screencastFrame", (f) => { frames.push(Buffer.from(f.data, "base64")); void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1 });
  const r = await act();
  await page.waitForTimeout(ms);
  await cdp.send("Page.stopScreencast");
  /* 只留均匀分布的 14 帧(取回云端截图包要走网络,全留太大) */
  const keep = frames.length <= 14 ? frames : Array.from({ length: 14 }, (_, i) => frames[Math.round((i * (frames.length - 1)) / 13)]);
  keep.forEach((b, i) => fs.writeFileSync(path.join(DIR, `${name}-cast-${theme}-${String(i).padStart(2, "0")}.jpg`), b));
  await cdp.detach();
  return r;
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

for (const theme of THEMES) {
  test(`连拍 · 朱印验收(${theme}):印从纸面上方落下、压实,停在 1(慢放 5 倍)`, async ({ browser }) => {
    const page = await open(browser, theme, { slowmo: 5 });
    const bubble = page.locator('[data-anchor="g6"]');
    await bubble.scrollIntoViewIfNeeded();
    await bubble.hover({ position: { x: 8, y: 8 } });
    await page.getByTestId("reply-g6").click();
    await box(page).press("End");
    await box(page).pressSequentially("通过");
    const clip = await around(page, '[data-anchor="g6"]', 70, 50);
    await page.mouse.move(5, 5);
    // 回车的同时开始按帧采样:落下途中缩放大于 1,最后停在 1;同时收下这段时间里真实画出来的帧
    const [s] = await Promise.all([sampleScale(page, "[data-testid=seal-perf]", 3000), screencast(page, "seal", theme, 3000, () => box(page).press("Enter"))]);
    expect(s.max).toBeGreaterThan(1.01);
    expect(Math.abs(s.last - 1)).toBeLessThan(0.01);
    await frame(page, "seal", theme, "end", clip);
    await page.context().close();
  });

  test(`连拍 · 双击就回复(${theme}):双击 → 气泡按下 → 弹回,引用进输入框(慢放 5 倍)`, async ({ browser }) => {
    const page = await open(browser, theme, { slowmo: 5 });
    const bubble = page.locator('[data-anchor="g6"]');
    await bubble.scrollIntoViewIfNeeded();
    const b = (await bubble.boundingBox())!;
    const clip: Clip = { x: 0, y: Math.max(0, b.y - 50), width: VIEW.width, height: VIEW.height - Math.max(0, b.y - 50) };
    await frame(page, "dblreply", theme, 1, clip);
    const [s] = await Promise.all([sampleScale(page, '[data-anchor="g6"]', 2500), screencast(page, "dblreply", theme, 2500, () => page.mouse.dblclick(b.x + b.width * 0.4, b.y + b.height * 0.3))]);
    expect(s.min).toBeLessThan(0.995);
    expect(Math.abs(s.last - 1)).toBeLessThan(0.005);
    await expect(bubble).toHaveAttribute("data-dblreply", "1");
    await expect(page.getByTestId("quote-bar")).toBeVisible();
    await frame(page, "dblreply", theme, 2, clip);
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
