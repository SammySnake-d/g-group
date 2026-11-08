import { expect, type Page, test } from "@playwright/test";

// #719:「我感觉他主面板太长了」「消息悬浮的菜单项……根本不贴着消息，漂移太严重」

type Box = { x: number; y: number; width: number; height: number };
const gap = (a: Box, b: Box) => {
  const dx = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
  const dy = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
  return Math.hypot(dx, dy);
};

async function checkBarsHugBubbles(page: Page, max = 14) {
  const ids = await page.locator("[data-scroll=chat] [data-anchor]").evaluateAll((els) => els.map((e) => e.getAttribute("data-anchor")!));
  expect(ids.length).toBeGreaterThan(5);
  let checked = 0;
  for (const id of ids.slice(-max)) {
    const anchor = page.locator(`[data-anchor="${id}"]`);
    const bar = page.getByTestId(`hoverbar-${id}`);
    if ((await bar.count()) === 0) continue;
    await anchor.scrollIntoViewIfNeeded();
    await anchor.hover({ position: { x: 8, y: 8 } });
    await expect(bar).toHaveCSS("opacity", "1");
    const a = (await anchor.boundingBox())!;
    const b = (await bar.boundingBox())!;
    const side = await bar.getAttribute("data-side");
    // 贴着:和气泡的间隙不超过 8px(压在右上角时与气泡相交,间隙为 0)
    expect(gap(a, b), `消息 ${id} 的工具条离气泡 ${gap(a, b).toFixed(1)}px(side=${side})`).toBeLessThanOrEqual(8 + (side === "before" && (await anchor.locator("[data-testid^=receipt-slot]").count()) ? 28 : 0));
    // 不漂:工具条的竖向范围和气泡有重叠(外侧放置时),不会挂到别的消息旁边
    if (side !== "inside") expect(b.y < a.y + a.height && b.y + b.height > a.y, `消息 ${id} 的工具条和气泡没有竖向重叠`).toBe(true);
    // 不出界:在聊天区里看得全
    const sc = (await page.locator("[data-scroll=chat]").boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(sc.x - 1);
    expect(b.x + b.width).toBeLessThanOrEqual(sc.x + sc.width + 1);
    checked++;
  }
  expect(checked).toBeGreaterThan(5);
}

test("悬浮工具条贴着每条消息的气泡(1440 宽)", async ({ page }) => {
  await page.goto("/?conv=g");
  await checkBarsHugBubbles(page);
});

test("悬浮工具条在窄窗口和超宽窗口下也贴着气泡", async ({ page }) => {
  for (const width of [1024, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?conv=g");
    await checkBarsHugBubbles(page, 8);
  }
});

test("工具条贴着别人的消息时在气泡右侧、自己的消息在左侧", async ({ page }) => {
  await page.goto("/?conv=g");
  const theirs = page.locator("[data-scroll=chat] [data-msg]:not([data-from=me]) [data-anchor]").last();
  await theirs.hover({ position: { x: 6, y: 6 } });
  const tid = await theirs.getAttribute("data-anchor");
  await expect(page.getByTestId(`hoverbar-${tid}`)).toHaveAttribute("data-side", "after");
  const mine = page.locator("[data-scroll=chat] [data-msg][data-from=me] [data-anchor]").last();
  await mine.hover({ position: { x: 6, y: 6 } });
  const mid = await mine.getAttribute("data-anchor");
  await expect(page.getByTestId(`hoverbar-${mid}`)).toHaveAttribute("data-side", "before");
});

test("主面板不再横跨整个窗口:超宽窗口下消息栏和输入框收在居中的阅读栏里", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto("/?conv=g");
  const col = (await page.getByTestId("chat-column").boundingBox())!;
  const comp = (await page.getByTestId("composer-column").boundingBox())!;
  const chat = (await page.getByTestId("chat").boundingBox())!;
  expect(col.width).toBeLessThanOrEqual(860);
  expect(comp.width).toBeLessThanOrEqual(860);
  // 居中
  expect(Math.abs(col.x + col.width / 2 - (chat.x + chat.width / 2))).toBeLessThan(2);
  // 自己的消息右边缘在阅读栏内,不再贴到窗口最右
  const mine = (await page.locator("[data-scroll=chat] [data-msg][data-from=me] [data-anchor]").last().boundingBox())!;
  expect(mine.x + mine.width).toBeLessThanOrEqual(col.x + col.width);
  expect(chat.x + chat.width - (mine.x + mine.width)).toBeGreaterThan(300);
});
