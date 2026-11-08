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

    test("双击就回复:指针在消息上双击 = 引用并 @ 作者,光标进输入框;按住 ⌥ 双击照常选词", async ({ page }) => {
      await page.goto(`/?conv=g&freeze${q}`);
      const bubble = page.locator('[data-anchor="g6"]');
      // 第一次走远路(悬浮条「回复」):轻提示一次双击也能回复;第二次不再提示
      await bubble.scrollIntoViewIfNeeded();
      await bubble.hover({ position: { x: 8, y: 8 } });
      await page.getByTestId("reply-g6").click();
      await expect(page.getByTestId("toast")).toContainText("双击");
      await page.getByTestId("quote-bar").getByRole("button").last().click();
      await expect(page.getByTestId("quote-bar")).toHaveCount(0);
      await composer(page).fill("");
      await expect(page.getByTestId("toast")).toHaveCount(0, { timeout: 8000 });
      await bubble.hover({ position: { x: 8, y: 8 } });
      await page.getByTestId("reply-g6").click();
      await page.waitForTimeout(300);
      await expect(page.getByTestId("toast")).toHaveCount(0);
      await page.getByTestId("quote-bar").getByRole("button").last().click();
      await composer(page).fill("");
      // 按住 ⌥ 双击:不回复(留给系统选词)
      await bubble.dblclick({ position: { x: 220, y: 14 }, modifiers: ["Alt"] });
      await expect(page.getByTestId("quote-bar")).toHaveCount(0);

      // 直接双击:回复 Codex,草稿自动 @ 它,输入框拿到焦点,气泡给一下按下回馈
      await bubble.dblclick({ position: { x: 220, y: 14 } });
      await expect(page.getByTestId("quote-bar")).toBeVisible();
      await expect(page.getByTestId("quote-bar")).toContainText("首屏");
      await expect(composer(page)).toBeFocused();
      await expect(composer(page)).toHaveValue(/^@Codex /);
      await expect(bubble).toHaveAttribute("data-dblreply", "1");
      expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");

      // 和悬浮条「回复」是同一个动作:换一条双击,回复对象跟着换(上一条降为普通引用,@ 也跟着换)
      const other = page.locator('[data-anchor="g12"]');
      await other.scrollIntoViewIfNeeded();
      await other.dblclick({ position: { x: 200, y: 14 } });
      await expect(composer(page)).toHaveValue(/^@Argon /);
      await expect(composer(page)).not.toHaveValue(/@Codex/);
      await expect(page.getByTestId("quote-bar")).toContainText("回复Argon");
      await page.mouse.move(0, 0);
      await shot(page, `concept/dblreply-${theme}`, 300);
    });

    test("等你刻度:右缘刻度标出每件等你的事,点一下 / ⌥↓ 跳过去;办完刻度自己消失", async ({ page }) => {
      await page.goto(`/?conv=g&freeze${q}`);
      const ruler = page.getByTestId("waiting-ruler");
      await expect(ruler).toBeVisible();
      // 群里三件等你的事:Codex 做完等验收(g6)、Argon 等你选(g12)、Argon 等你同意(g13p),按消息先后排
      const ticks = ruler.locator("[data-testid^=ruler-tick-]");
      await expect(ticks).toHaveCount(3);
      const ids = await ticks.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("ruler-tick-", "")));
      expect(ids).toEqual(["g6", "g12", "g13p"]);
      await expect(page.getByTestId("ruler-tick-g6")).toHaveAttribute("data-kind", "accept");
      await expect(page.getByTestId("ruler-tick-g12")).toHaveAttribute("data-kind", "ask");
      // 刻度的上下位置和消息的先后一致(位置即信息)
      const ys = await ticks.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
      expect(ys[0]).toBeLessThan(ys[1]);
      expect(ys[1]).toBeLessThan(ys[2]);

      // 点刻度 → 跳到那条消息并高亮
      await page.getByTestId("ruler-tick-g6").click();
      await expect(page.locator("#m-g6")).toHaveAttribute("data-hl", "1");
      await expect(page.locator("#m-g6")).toBeInViewport();
      await page.waitForTimeout(800);
      // 手不离键盘:⌥↓ 跳到下一件
      await page.keyboard.press("Alt+ArrowDown");
      await expect(page.locator("#m-g12")).toHaveAttribute("data-hl", "1");
      await expect(page.locator("#m-g12")).toBeInViewport();
      // 输入框里有字时 ⌥↓ 不抢(留给输入框自己的光标移动)
      await composer(page).fill("写到一半");
      await page.waitForTimeout(2000);
      await page.keyboard.press("Alt+ArrowDown");
      await page.waitForTimeout(300);
      await expect(page.locator("[data-hl=\"1\"]")).toHaveCount(0);
      await composer(page).fill("");

      // 回答了 Argon 的提问 → 那道刻度消失,剩两件
      await page.getByTestId("quick-g12-0").click();
      await expect(page.getByTestId("ruler-tick-g12")).toHaveCount(0);
      await expect(ticks).toHaveCount(2);

      await page.getByTestId("ruler-tick-g13p").hover();
      await expect(page.getByRole("tooltip").first()).toContainText("等你同意");
      await shot(page, `concept/ruler-${theme}`, 300);
    });
  });
}
