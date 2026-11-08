import { expect, test } from "@playwright/test";

// #823:「a2ui 应该参考 mirasim 这种可以折叠的形式，而不是做成气泡，做成气泡如果选项很长就不好看了」
const OUT = process.env.GG_SHOTS ?? "/Users/snakesammy/.mirasim/assistants/deliverables/g-group-desktop-ui/shots";

test.beforeEach(async ({ page }) => {
  await page.goto("/?conv=g");
});

test("提问是挂在消息下的卡片:标题、等你选、整行选项(长选项不挤成气泡)、推荐标记、自己回答", async ({ page }) => {
  const card = page.getByTestId("ask-g12");
  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveAttribute("data-state", "open");
  await expect(page.getByTestId("ask-g12-head")).toContainText("飞书的聊天记录怎么带进对话");
  await expect(page.getByTestId("ask-g12-status")).toHaveText("等你选");
  await expect(card.locator("[data-layout]")).toHaveAttribute("data-layout", "rows");
  // 每个选项占满卡片宽度、互相上下排,不横向滚动
  const cb = (await card.boundingBox())!;
  const rows = card.locator("[data-testid^=quick-g12-]:not([data-testid$=-own])");
  await expect(rows).toHaveCount(3);
  let lastY = -1;
  for (let i = 0; i < 3; i++) {
    const b = (await rows.nth(i).boundingBox())!;
    expect(b.width).toBeGreaterThan(cb.width * 0.85);
    expect(b.x + b.width).toBeLessThanOrEqual(cb.x + cb.width);
    expect(b.y).toBeGreaterThan(lastY);
    lastY = b.y;
  }
  await expect(rows.nth(0)).toContainText("推荐");
  await page.screenshot({ path: `${OUT}/a2ui-open.png` });
  // 自己回答 = 引用并 @ 提问的人
  await page.getByTestId("quick-g12-own").click();
  await expect(page.getByTestId("quote-chip")).toHaveCount(1);
});

test("很长的选项在卡片里换行显示,不溢出卡片", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 860 });
  await page.goto("/?conv=g");
  const card = page.getByTestId("ask-g12");
  await card.scrollIntoViewIfNeeded();
  // 把一个选项换成很长的文字(演示数据里的选项就是真实渲染的文字节点)
  await card.locator("[data-testid=quick-g12-1] span.break-words").evaluate((el) => { el.textContent = "每天凌晨自动把飞书「产品讨论群」「设计评审群」「需求池」三个群前一天的全部聊天记录同步进来,按话题分好段,再附上原文链接和发言人,方便助手第二天一早接着读"; });
  const cb = (await card.boundingBox())!;
  const b = (await card.getByTestId("quick-g12-1").boundingBox())!;
  expect(b.x + b.width).toBeLessThanOrEqual(cb.x + cb.width);
  expect(b.height).toBeGreaterThan(40);
  const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("选了以后:以普通消息发出,你的回答显示成收起的卡片;提问卡片收起成「标题 · 你选的」,点开能看全部选项", async ({ page }) => {
  const card = page.getByTestId("ask-g12");
  await card.scrollIntoViewIfNeeded();
  await page.getByTestId("quick-g12-2").click();
  await expect(card).toHaveAttribute("data-state", "answered");
  await expect(card).toHaveAttribute("data-expanded", "0");
  await expect(page.getByTestId("ask-g12-picked")).toHaveText("只在我搜索时去查");
  await expect(page.getByTestId("ask-g12-status")).toContainText("已选");
  // 你的回答:一条普通消息(联系人照常读到正文),显示成收起的卡片
  const pill = page.locator("[data-testid^=answer-me-]:not([data-testid$=-body])").last();
  await expect(pill).toContainText("飞书的聊天记录怎么带进对话");
  await expect(pill).toContainText("只在我搜索时去查");
  await pill.locator("button").first().click();
  await expect(pill).toHaveAttribute("data-expanded", "1");
  await expect(pill.locator("[data-testid$=-body]")).toContainText("我勾选哪几条，就引用哪几条");
  await page.screenshot({ path: `${OUT}/a2ui-answered.png` });
  // 提问卡片展开:选中的打勾,其余不能再点
  await page.getByTestId("ask-g12-head").click();
  await expect(card).toHaveAttribute("data-expanded", "1");
  await expect(page.getByTestId("quick-g12-2")).toBeDisabled();
  await expect(page.getByTestId("quick-g12-0")).toBeDisabled();
  // 联系人接着回话
  await expect(page.getByText("好，按这个来。")).toBeVisible();
});

test("短选项(同意 / 先不改)排成一行小按钮;点了照样收起", async ({ page }) => {
  const card = page.getByTestId("ask-g13p");
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator("[data-layout]")).toHaveAttribute("data-layout", "chips");
  const a = (await page.getByTestId("quick-g13p-0").boundingBox())!;
  const b = (await page.getByTestId("quick-g13p-1").boundingBox())!;
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  await page.getByTestId("quick-g13p-1").click();
  await expect(card).toHaveAttribute("data-state", "answered");
  await expect(page.getByTestId("ask-g13p-picked")).toHaveText("先不改");
});
