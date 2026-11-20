import fs from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";

const DIR = process.env.GG_SHOTS ? path.join(process.env.GG_SHOTS, "concept") : null;
const VIEW = { width: 1280, height: 800 };
const THEMES = ["light", "dark"] as const;

async function open(browser: Browser, theme: string, opts: { scale?: number; slowmo?: number } = {}) {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: VIEW, deviceScaleFactor: opts.scale ?? 2, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  const page = await ctx.newPage();
  await page.goto(`/?conv=g&freeze${theme === "dark" ? "&theme=dark" : ""}${opts.slowmo ? `&slowmo=${opts.slowmo}` : ""}`);
  return page;
}

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
  const keep = frames.length <= 14 ? frames : Array.from({ length: 14 }, (_, i) => frames[Math.round((i * (frames.length - 1)) / 13)]);
  keep.forEach((b, i) => fs.writeFileSync(path.join(DIR, `${name}-cast-${theme}-${String(i).padStart(2, "0")}.jpg`), b));
  await cdp.detach();
  return r;
}

type Clip = { x: number; y: number; width: number; height: number };
async function frame(page: Page, name: string, theme: string, n: number | string, clip?: Clip) {
  if (!DIR) return;
  fs.mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: path.join(DIR, `${name}-frame-${theme}-${n}.png`), clip, animations: "allow" });
}

const box = (page: Page) => page.locator("[data-testid=composer-box] textarea");

for (const theme of THEMES) {
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
    const xs = looks.slice(1).map((l) => Number(l.split(",")[0]));
    expect(xs[1]).toBeGreaterThan(xs[0]);
    expect(xs[2]).toBeGreaterThanOrEqual(xs[1]);
    await page.context().close();
  });
}
