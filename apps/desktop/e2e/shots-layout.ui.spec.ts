import { test } from "@playwright/test";
import { shot } from "./shots";

// 截图走查:主界面、悬浮工具条贴着消息。图存到交付目录。

test("截图:主界面与悬浮工具条", async ({ page }) => {
  await page.goto("/?conv=g");
  await page.waitForTimeout(400);
  await shot(page, "layout-main");
  const theirs = page.locator("[data-scroll=chat] [data-msg]:not([data-from=me]) [data-anchor]").nth(-2);
  await theirs.scrollIntoViewIfNeeded();
  await theirs.hover({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(200);
  await shot(page, "hoverbar-theirs");
  const mine = page.locator("[data-scroll=chat] [data-msg][data-from=me] [data-anchor]").last();
  await mine.hover({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(200);
  await shot(page, "hoverbar-mine");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(200);
  await shot(page, "layout-1920");
});
