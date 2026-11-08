import fs from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";

// 概念版的动效证据:每条用例本身都断言动效确实发生;设了 GG_SHOTS 时顺便录一段短视频 / 连拍,存到 <GG_SHOTS>/concept/。
// 没设 GG_SHOTS 时照常跑断言,只是不录。
const DIR = process.env.GG_SHOTS ? path.join(process.env.GG_SHOTS, "concept") : null;
const VIEW = { width: 1280, height: 800 };

async function open(browser: Browser, url: string) {
  if (DIR) fs.mkdirSync(DIR, { recursive: true });
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: VIEW, deviceScaleFactor: DIR ? 1 : 2, locale: "zh-CN", timezoneId: "Asia/Shanghai", ...(DIR ? { recordVideo: { dir: DIR, size: VIEW } } : {}) });
  const page = await ctx.newPage();
  await page.goto(url);
  return { ctx, page };
}

/** 关掉上下文,把视频改名成 <name>.webm */
async function finish(page: Page, name: string) {
  const v = page.video();
  await page.context().close();
  if (DIR && v) { const tmp = await v.path(); fs.renameSync(tmp, path.join(DIR, `${name}.webm`)); }
}

/** 录像里看不见系统指针:放一个小圆点跟着鼠标,让观众看清在哪儿点、在哪儿双击 */
async function showPointer(page: Page) {
  if (!DIR) return;
  await page.addStyleTag({ content: "#gg-ptr{position:fixed;z-index:99999;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(30,30,30,.35);border:2px solid #fff;pointer-events:none;transition:transform .12s}#gg-ptr.down{transform:scale(.7)}" });
  await page.evaluate(() => {
    const d = document.createElement("div"); d.id = "gg-ptr"; document.body.appendChild(d);
    addEventListener("mousemove", (e) => { d.style.left = e.clientX + "px"; d.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => d.classList.add("down"), true);
    addEventListener("mouseup", () => d.classList.remove("down"), true);
  });
}

const box = (page: Page) => page.locator("[data-testid=composer-box] textarea");

async function moveTo(page: Page, sel: string, dx = 0.5, dy = 0.5) {
  const b = (await page.locator(sel).boundingBox())!;
  await page.mouse.move(b.x + b.width * dx, b.y + b.height * dy, { steps: 12 });
}

test("动效 · 朱印验收:落印后印停在纸面上(缩放回到 1)", async ({ browser }) => {
  const { page } = await open(browser, "/?conv=g&freeze");
  await showPointer(page);
  await page.locator('[data-anchor="g6"]').scrollIntoViewIfNeeded();
  await moveTo(page, '[data-anchor="g6"]', 0.1, 0.3);
  await page.waitForTimeout(400);
  await page.getByTestId("reply-g6").click();
  await box(page).press("End");
  await box(page).pressSequentially("通过", { delay: 120 });
  await page.waitForTimeout(300);
  await box(page).press("Enter");
  const seal = page.getByTestId("seal-perf");
  await expect(seal).toBeVisible();
  // 落印过程中缩放从大于 1 回到 1
  await page.locator('[data-anchor="g6"]').scrollIntoViewIfNeeded();
  await page.mouse.move(VIEW.width - 40, 40, { steps: 8 });
  await page.waitForTimeout(1500);
  const final = await seal.evaluate((el) => { const m = new DOMMatrix(getComputedStyle(el).transform); return Math.hypot(m.a, m.b); });
  expect(Math.abs(final - 1)).toBeLessThan(0.01);
  await expect(seal).toHaveAttribute("data-state", "stamped");
  await finish(page, "seal");
});

test("动效 · 双击就回复:气泡按下再弹回,引用进输入框", async ({ browser }) => {
  const { page } = await open(browser, "/?conv=g&freeze");
  await showPointer(page);
  const bubble = page.locator('[data-anchor="g6"]');
  await bubble.scrollIntoViewIfNeeded();
  await moveTo(page, '[data-anchor="g6"]', 0.4, 0.3);
  await page.waitForTimeout(600);
  const b = (await bubble.boundingBox())!;
  await page.mouse.dblclick(b.x + b.width * 0.4, b.y + b.height * 0.3);
  await expect(bubble).toHaveAttribute("data-dblreply", "1");
  await expect(page.getByTestId("quote-bar")).toBeVisible();
  await page.waitForTimeout(500);
  await box(page).pressSequentially("这个改动线上验证过了吗？", { delay: 90 });
  await page.waitForTimeout(1200);
  await finish(page, "dblreply");
});

test("动效 · 等你刻度:点刻度跳过去,⌥↓ 下一件,答完刻度淡出", async ({ browser }) => {
  const { page } = await open(browser, "/?conv=g&freeze");
  await showPointer(page);
  await expect(page.getByTestId("waiting-ruler")).toBeVisible();
  await moveTo(page, "[data-testid=ruler-tick-g6]");
  await page.waitForTimeout(900);
  await page.getByTestId("ruler-tick-g6").click();
  await expect(page.locator("#m-g6")).toHaveAttribute("data-hl", "1");
  await page.waitForTimeout(1400);
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.locator("#m-g12")).toHaveAttribute("data-hl", "1");
  await page.waitForTimeout(1400);
  await moveTo(page, "[data-testid=quick-g12-0]");
  await page.waitForTimeout(400);
  await page.getByTestId("quick-g12-0").click();
  await expect(page.getByTestId("ruler-tick-g12")).toHaveCount(0);
  await page.waitForTimeout(1200);
  await finish(page, "ruler");
});

test("动效 · 目光:打字时等你的头像眼睛跟着光标走(连拍)", async ({ browser }) => {
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: VIEW, deviceScaleFactor: 3, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    const page = await ctx.newPage();
    await page.goto(`/?conv=g&freeze${theme === "dark" ? "&theme=dark" : ""}`);
    const av = page.getByTestId("gaze-g13p");
    await page.locator("#m-g13p").scrollIntoViewIfNeeded();
    const looks: string[] = [];
    const frame = async (name: string) => {
      await page.waitForTimeout(700);
      looks.push((await av.getAttribute("data-look"))!);
      if (DIR) await av.screenshot({ path: path.join(DIR, `gaze-frame-${theme}-${name}.png`) });
    };
    // 1 没点输入框:看向输入框;2 光标在开头;3 打到一半;4 打到行尾;5 回完了(眯眼笑)
    await page.locator("#m-g13p").hover({ position: { x: 4, y: 4 } }).catch(() => {});
    await page.mouse.move(VIEW.width - 20, 20);
    await frame("1-idle");
    await box(page).click({ position: { x: 4, y: 10 } });
    await frame("2-start");
    await box(page).pressSequentially("同意，不过走查截图要附在交付消息里", { delay: 20 });
    await frame("3-mid");
    await box(page).pressSequentially("，别放在附件里，一眼就能看到才行", { delay: 20 });
    await frame("4-end");
    await box(page).fill("");
    await page.getByTestId("quick-g12-0").click();
    await page.getByTestId("quick-g13p-0").click();
    const happy = page.getByTestId("gaze-g12");
    await expect(happy).toHaveAttribute("data-mood", "happy");
    await page.waitForTimeout(900);
    if (DIR) await happy.screenshot({ path: path.join(DIR, `gaze-frame-${theme}-5-happy.png`) });
    // 眼睛方向真的在变:打字过程中水平分量单调往右
    const xs = looks.slice(1).map((l) => Number(l.split(",")[0]));
    expect(xs[1]).toBeGreaterThan(xs[0]);
    expect(xs[2]).toBeGreaterThanOrEqual(xs[1]);
    await ctx.close();
  }
});
