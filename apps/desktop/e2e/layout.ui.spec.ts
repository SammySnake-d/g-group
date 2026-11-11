import { expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// #719:「我感觉他主面板太长了」「消息悬浮的菜单项……根本不贴着消息，漂移太严重」
// #1032(需求变更):「用户想要回复，肯定是先移动到需要回复的消息上……为什么不能做成更贴近消息体的，在消息上方的设计呢？这样不是移动路径更短吗？」
// 工具条压在气泡右上角(照 mirasim:底边压进气泡顶边 8px、右边缩进 8px);顶上放不下才退到气泡下方。

type Box = { x: number; y: number; width: number; height: number };
const gap = (a: Box, b: Box) => {
  const dx = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
  const dy = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
  return Math.hypot(dx, dy);
};

/** 工具条相对气泡的几何:压在上边缘(或退到下边缘)、水平落在气泡范围里且右边贴近气泡末端 */
function expectHugsEnd(id: string, a: Box, b: Box, side: string | null, sc: Box) {
  expect(gap(a, b), `消息 ${id} 的工具条离气泡 ${gap(a, b).toFixed(1)}px(side=${side})`).toBeLessThanOrEqual(8);
  // 竖直:和气泡上边缘(退到下方时是下边缘)的距离 ≤ 8,压进气泡不超过工具条高度的一半
  if (side === "top") {
    const over = b.y + b.height - a.y;
    expect(over, `消息 ${id} 的工具条和气泡上边缘:压进 ${over.toFixed(1)}px`).toBeGreaterThanOrEqual(-8);
    expect(over, `消息 ${id} 的工具条压进气泡太多`).toBeLessThanOrEqual(b.height / 2);
  } else if (side === "bottom") {
    const over = a.y + a.height - b.y;
    expect(over, `消息 ${id} 的工具条和气泡下边缘:压进 ${over.toFixed(1)}px`).toBeGreaterThanOrEqual(-8);
    expect(over, `消息 ${id} 的工具条压进气泡太多`).toBeLessThanOrEqual(b.height / 2);
  } else {
    expect(side, `消息 ${id} 的工具条放置方式`).toBe("pinned");
    expect(b.y >= a.y && b.y + b.height <= a.y + a.height, `消息 ${id} 的工具条应压在气泡里`).toBe(true);
  }
  // 水平:和气泡有交集;右边贴近气泡末端(气泡太窄、工具条被可视区左右边夹住时除外)
  expect(b.x < a.x + a.width && b.x + b.width > a.x, `消息 ${id} 的工具条水平上不在气泡范围里`).toBe(true);
  const clamped = b.x <= sc.x + 6 || b.x + b.width >= sc.x + sc.width - 6;
  if (!clamped) expect(Math.abs(b.x + b.width - (a.x + a.width)), `消息 ${id} 的工具条没贴着气泡末端`).toBeLessThanOrEqual(12);
}

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
    const sc = (await page.locator("[data-scroll=chat]").boundingBox())!;
    expectHugsEnd(id, a, b, await bar.getAttribute("data-side"), sc);
    // 不出界:在聊天区里看得全
    expect(b.x).toBeGreaterThanOrEqual(sc.x - 1);
    expect(b.x + b.width).toBeLessThanOrEqual(sc.x + sc.width + 1);
    expect(b.y).toBeGreaterThanOrEqual(sc.y - 1);
    expect(b.y + b.height).toBeLessThanOrEqual(sc.y + sc.height + 1);
    checked++;
  }
  expect(checked).toBeGreaterThan(5);
}

test("悬浮工具条压在每条消息气泡的右上角(1440 宽)", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/?conv=g");
  await checkBarsHugBubbles(page);
});

test("悬浮工具条在窄窗口和超宽窗口下也压在气泡右上角", async ({ page }) => {
  // 两种宽度 × 逐条悬停,并行跑时 30 秒默认时限不够(只放宽时限,不动断言)
  test.setTimeout(90_000);
  for (const width of [1024, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?conv=g");
    await checkBarsHugBubbles(page, 8);
  }
});

test("别人的消息和自己的消息,工具条都在气泡上方、贴着末端那一角(不再放到自己气泡的左侧)", async ({ page }) => {
  await page.goto("/?conv=g");
  for (const who of ["[data-msg]:not([data-from=me])", "[data-msg][data-from=me]"]) {
    const anchor = page.locator(`[data-scroll=chat] ${who} [data-anchor]`).last();
    await anchor.hover({ position: { x: 6, y: 6 } });
    const id = (await anchor.getAttribute("data-anchor"))!;
    const bar = page.getByTestId(`hoverbar-${id}`);
    await expect(bar).toHaveCSS("opacity", "1");
    await expect(bar).toHaveAttribute("data-side", "top");
    const a = (await anchor.boundingBox())!;
    const b = (await bar.boundingBox())!;
    expect(b.y + b.height, `消息 ${id} 的工具条应在气泡上方`).toBeLessThanOrEqual(a.y + b.height / 2);
    expect(Math.abs(b.x + b.width - (a.x + a.width)), `消息 ${id} 的工具条应贴着气泡右端`).toBeLessThanOrEqual(12);
  }
});

test("悬停链不断:指针从气泡往上移到工具条,途中不消失,按钮点得到(#1032)", async ({ page }) => {
  await page.goto("/?conv=g");
  const anchor = page.locator("[data-scroll=chat] [data-msg]:not([data-from=me]) [data-anchor]").last();
  await anchor.scrollIntoViewIfNeeded();
  const id = (await anchor.getAttribute("data-anchor"))!;
  const a = (await anchor.boundingBox())!;
  await page.mouse.move(a.x + a.width - 24, a.y + a.height / 2);
  const bar = page.getByTestId(`hoverbar-${id}`);
  await expect(bar).toHaveCSS("opacity", "1");
  const r = (await page.getByTestId(`reply-${id}`).boundingBox())!;
  // 分步移动:途中每一步都触发指针事件,经过的地方要是有空隙,工具条会先消失、之后也不会再出现
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2, { steps: 12 });
  await expect(bar).toHaveCSS("opacity", "1");
  await shot(page, "hoverbar");
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByTestId("quote-chip")).toHaveCount(1);
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
