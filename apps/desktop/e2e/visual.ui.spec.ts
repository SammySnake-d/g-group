import { expect, type Page, test } from "@playwright/test";

// F-VISUAL:能量化的视觉指标(开发手册原则 52),亮暗两套都跑。
// 「只有用户说好看才算好看」——这里只拦能量化的退步:顶部占用、对比度、横向溢出、阅读栏宽度、按钮折行。

function lum(rgb: string): number {
  const m = rgb.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
  const [r, g, b] = m.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

/** 取元素文字色和它实际落在上面的背景色(往上找第一个不透明背景) */
async function colors(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const fg = getComputedStyle(el).color;
    let n: Element | null = el;
    let bg = "rgb(255, 255, 255)";
    while (n) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && c !== "transparent" && !/rgba\(.*,\s*0\)$/.test(c)) { bg = c; break; }
      n = n.parentElement;
    }
    return { fg, bg };
  });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`F-VISUAL ${theme}`, () => {
    test.use({ colorScheme: theme });
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`/?conv=g${theme === "dark" ? "&theme=dark" : ""}`);
      await page.waitForTimeout(300);
    });

    test(`顶部占用不超过 100px,页面没有横向溢出`, async ({ page }) => {
      const scroll = (await page.locator("[data-scroll=chat]").boundingBox())!;
      expect(scroll.y).toBeLessThanOrEqual(100);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test(`正文、会话标题、次要文字的对比度达标`, async ({ page }) => {
      const body = await colors(page, "[data-scroll=chat] [data-msg]:not([data-from=me]) [data-anchor] > div");
      expect(contrast(body.fg, body.bg), `正文 ${body.fg} on ${body.bg}`).toBeGreaterThanOrEqual(7);
      const mine = await colors(page, "[data-scroll=chat] [data-msg][data-from=me] [data-anchor] > div:not([data-testid])");
      expect(contrast(mine.fg, mine.bg), `我的气泡 ${mine.fg} on ${mine.bg}`).toBeGreaterThanOrEqual(7);
      const title = await colors(page, "[data-testid=list] [data-testid^=conv-] .truncate");
      expect(contrast(title.fg, title.bg), `会话标题 ${title.fg} on ${title.bg}`).toBeGreaterThanOrEqual(7);
      const sub = await colors(page, "[data-testid=list] [data-testid^=conv-] .text-fg-2");
      expect(contrast(sub.fg, sub.bg), `次要文字 ${sub.fg} on ${sub.bg}`).toBeGreaterThanOrEqual(4.5);
    });

    test(`提问卡片的选项不溢出卡片,工具条不超过 5 个按钮`, async ({ page }) => {
      const cards = page.locator("[data-testid^=ask-][data-state]");
      const n = await cards.count();
      expect(n).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        const c = cards.nth(i);
        await c.scrollIntoViewIfNeeded();
        const cb = (await c.boundingBox())!;
        for (const o of await c.locator("[data-testid^=quick-]").all()) {
          const b = (await o.boundingBox())!;
          expect(b.x + b.width, `选项溢出了卡片`).toBeLessThanOrEqual(cb.x + cb.width + 0.5);
        }
      }
      const anchor = page.locator("[data-scroll=chat] [data-anchor]").last();
      await anchor.hover({ position: { x: 6, y: 6 } });
      const id = await anchor.getAttribute("data-anchor");
      const buttons = await page.getByTestId(`hoverbar-${id}`).locator(":scope > button, :scope > * > button").count();
      expect(buttons).toBeGreaterThanOrEqual(3);
      expect(buttons).toBeLessThanOrEqual(5);
    });

    test(`开着群资料分栏时聊天区仍有 480px 以上,单页分栏不再套两层页签`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.getByTestId("head-side").click();
      const chat = (await page.getByTestId("chat").boundingBox())!;
      expect(chat.width).toBeGreaterThanOrEqual(480);
      await expect(page.getByTestId("split-tabs")).toHaveAttribute("data-count", "1");
      // 只有一页时标题是纯文字,不是页签按钮
      await expect(page.getByTestId("split-tabs").locator("button")).toHaveCount(0);
    });
  });
}
