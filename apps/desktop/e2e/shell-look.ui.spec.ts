import { expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// #929 两条反馈的可量化断言:
//   ① 左侧导航和页面主题割裂 → 导航底色与聊天区底色的对比度必须很低(同一张纸),导航图标仍要看得清
//   ② 回到最新放在角落、观察成本高 → 必须在阅读栏水平居中、紧贴输入框上方

function lum(rgb: string): number {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

/** 元素实际落在上面的不透明底色(往上找) */
async function bgOf(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    let n: Element | null = el;
    while (n) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && c !== "transparent" && !/rgba\(.*,\s*0\)$/.test(c)) return c;
      n = n.parentElement;
    }
    return "rgb(255, 255, 255)";
  });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`壳的观感 ${theme}`, () => {
    test.use({ colorScheme: theme });
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(theme === "dark" ? "/?theme=dark" : "/");
      await page.getByTestId("conv-g").click();
      await expect(page.getByTestId("chat-column")).toBeVisible();
    });

    test("左侧导航和聊天区是同一张纸,导航图标看得清", async ({ page }) => {
      const rail = await bgOf(page, "[data-testid=rail]");
      const chat = await bgOf(page, "[data-scroll=chat]");
      expect(contrast(rail, chat), `导航 ${rail} vs 聊天区 ${chat}`).toBeLessThan(1.2);
      const icon = page.locator("[data-testid=rail] [data-testid^=nav-]").nth(1);
      const fg = await icon.evaluate((el) => getComputedStyle(el).color);
      expect(contrast(fg, rail), `导航图标 ${fg} vs 导航底 ${rail}`).toBeGreaterThan(3);
    });

    test("进群就停在最底部:提问卡等内容展开变高后仍贴底,不冒出「回到最新」", async ({ page }) => {
      const scroller = page.locator("[data-scroll=chat]");
      // 等提问卡这类默认展开的内容长完(R3 在 box1 上量到约 1.25s 后才展开、内容变高约 200px)
      await page.waitForTimeout(2500);
      const left = await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      expect(left, "离底距离").toBeLessThan(80);
      await expect(page.getByTestId("to-bottom")).toHaveCount(0);
    });

    test("回到最新:阅读栏居中、紧贴输入框上方,点了回到底部", async ({ page }) => {
      const scroller = page.locator("[data-scroll=chat]");
      await expect(page.getByTestId("to-bottom")).toHaveCount(0);
      await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
      const jump = page.getByTestId("to-bottom");
      await expect(jump).toBeVisible();
      const b = (await jump.boundingBox())!;
      const col = (await page.getByTestId("composer-column").boundingBox())!;
      const box = (await page.getByTestId("composer-box").boundingBox())!;
      expect(Math.abs(b.x + b.width / 2 - (col.x + col.width / 2)), "水平居中偏差").toBeLessThanOrEqual(4);
      const gap = box.y - (b.y + b.height);
      expect(gap, "按钮底到输入框顶的距离").toBeGreaterThanOrEqual(4);
      expect(gap, "按钮底到输入框顶的距离").toBeLessThanOrEqual(48);
      expect(b.height, "按钮命中高度").toBeGreaterThanOrEqual(24);
      await shot(page, `walk/${theme}/w4-jump-latest`);
      await jump.click();
      await expect(jump).toHaveCount(0);
      const left = await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      expect(left).toBeLessThan(80);
    });
  });
}
