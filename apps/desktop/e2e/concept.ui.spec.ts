import { expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// 概念版(#985「有时候就只是需要一个小点子」):每个点子一条用例,断言它在真实应用里生效。
// 截图只在设了 GG_SHOTS 时存(和走查同一个开关),存到 <GG_SHOTS>/concept/<点子>-<主题>.png。

const composer = (page: Page) => page.locator("[data-testid=composer-box] textarea");

/** 用回复按钮回某条消息一句话(和用户真实路径一致:悬停 → 回复 → 打字 → 回车) */
async function replyTo(page: Page, msgId: string, text: string) {
  const anchor = page.locator(`[data-anchor="${msgId}"]`);
  await anchor.scrollIntoViewIfNeeded();
  await anchor.hover({ position: { x: 8, y: 8 } });
  await page.getByTestId(`reply-${msgId}`).click();
  const box = composer(page);
  await box.click();
  await box.press("End");
  await box.pressSequentially(text);
  await box.press("Enter");
}

for (const theme of ["light", "dark"] as const) {
  const q = theme === "dark" ? "&theme=dark" : "";

  test.describe(`概念 ${theme}`, () => {
    test("朱印验收:回汇报一句「通过」,汇报落款处按下柿红印;没说通过不盖", async ({ page }) => {
      await page.goto(`/?conv=g&freeze${q}`);
      await expect(page.getByTestId("seal-perf")).toHaveCount(0);

      // 只是回了一句话、没说通过,不算验收,不盖印(已读、回话都不等于验收)
      await replyTo(page, "g6", "我晚点再看");
      await expect(page.getByTestId("seal-perf")).toHaveCount(0);

      // 再回一句「通过」才算:印出现在 g6 那条汇报气泡上,而且是这次按下去的(不是打开时就在)
      await replyTo(page, "g6", "通过");
      const seal = page.locator('[data-anchor="g6"] [data-testid=seal-perf]');
      await expect(seal).toBeVisible();
      await expect(seal).toHaveAttribute("data-state", "stamped");
      await expect(seal).toHaveAttribute("aria-label", /已验收/);
      // 印压在气泡右下角(落款处),不跑到别的消息上
      // 两个框在同一帧里量(发完消息聊天区还在平滑滚动,分两次量会错位)
      const [a, s] = await seal.evaluate((el) => [el.parentElement!.getBoundingClientRect().toJSON(), el.getBoundingClientRect().toJSON()]);
      expect(s.y + s.height / 2).toBeGreaterThan(a.y + a.height / 2);
      expect(s.x + s.width / 2).toBeGreaterThan(a.x + a.width / 2);

      // 切到别的会话再回来:印还在,但不再重放按印动作(只有亲手验收的那一下才动)
      await page.getByTestId("conv-dm-claude").click();
      await page.getByTestId("conv-g").click();
      await expect(page.getByTestId("seal-perf")).toHaveAttribute("data-state", "kept");
      await page.locator('[data-anchor="g6"]').scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await shot(page, `concept/seal-${theme}`, 0);
    });
  });
}
