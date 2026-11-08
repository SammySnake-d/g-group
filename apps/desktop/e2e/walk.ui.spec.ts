import { expect, type Page, test } from "@playwright/test";

// 固定走查(pstack:从用户真实入口一步步点下去,每步断言 + 截图,亮暗两套各一遍)。
// 只从左侧导航、聊天头部、群资料页签这些用户看得到的入口进,不用 URL 直达中间状态。
const OUT = process.env.GG_SHOTS ?? "/Users/snakesammy/.mirasim/assistants/deliverables/g-group-desktop-ui/shots";

async function snap(page: Page, theme: string, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/walk/${theme}/${name}.png` });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`走查 ${theme}`, () => {
    test.use({ colorScheme: theme });
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(theme === "dark" ? "/?theme=dark" : "/");
      await expect(page.getByTestId("rail")).toBeVisible();
    });

    test(`W1 聊天主界面 → 群资料各页签`, async ({ page }) => {
      await page.getByTestId("conv-g").click();
      await expect(page.getByTestId("chat-column")).toBeVisible();
      await snap(page, theme, "w1-chat");
      await page.getByTestId("head-side").click();
      await expect(page.getByTestId("split")).toBeVisible();
      for (const tab of await page.locator("[data-testid^=side-tab-]").all()) {
        const id = (await tab.getAttribute("data-testid"))!.replace("side-tab-", "");
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await snap(page, theme, `w1-side-${id}`);
      }
    });

    test(`W2 通讯录 → 联系人工作台各页签`, async ({ page }) => {
      await page.getByTestId("nav-contacts").click();
      await page.getByTestId("contact-claude").click();
      await snap(page, theme, "w2-workbench");
      const tabs = page.locator("[data-testid^=wb-tab-]");
      const n = await tabs.count();
      for (let i = 0; i < n; i++) {
        const t = tabs.nth(i);
        const id = (await t.getAttribute("data-testid"))!.replace("wb-tab-", "");
        await t.click();
        await snap(page, theme, `w2-wb-${id}`);
      }
    });

    test(`W3 文件 / 进展全景 / 插件 / 设置`, async ({ page }) => {
      await page.getByTestId("nav-files").click();
      await snap(page, theme, "w3-files");
      await page.getByTestId("nav-activity").click();
      await expect(page.getByTestId("pano-overlay")).toBeVisible();
      await snap(page, theme, "w3-pano");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("pano-overlay")).toBeHidden();
      await page.getByTestId("nav-plugins").click();
      await snap(page, theme, "w3-plugins");
      await page.getByTestId("nav-settings").click();
      await snap(page, theme, "w3-settings");
    });
  });
}
