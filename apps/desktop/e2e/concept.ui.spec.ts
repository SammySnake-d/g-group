import { expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// 概念版(#985「有时候就只是需要一个小点子」):每个点子一条用例,断言它在真实应用里生效。
// 截图只在设了 GG_SHOTS 时存(和走查同一个开关),存到 <GG_SHOTS>/concept/<点子>-<主题>.png。

const composer = (page: Page) => page.locator("[data-testid=composer-box] textarea");


for (const theme of ["light", "dark"] as const) {
  const q = theme === "dark" ? "&theme=dark" : "";

  test.describe(`概念 ${theme}`, () => {
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

    test("目光:挂着等你的事的头像看向输入框,打字时眼睛跟着光标走;回答后眯眼笑", async ({ page }) => {
      await page.goto(`/?conv=g&freeze${q}`);
      const look = async (id: string) => (await page.getByTestId(`gaze-${id}`).getAttribute("data-look"))!.split(",").map(Number);
      // 在等你的三条:Codex 做完等验收、Argon 等你选、Argon 等你同意;不等你的消息照旧是静止头像
      for (const id of ["g6", "g12", "g13p"]) await expect(page.getByTestId(`gaze-${id}`)).toHaveAttribute("data-watching", "1");
      await expect(page.locator("[data-testid^=gaze-]")).toHaveCount(3);
      await page.locator("#m-g12").scrollIntoViewIfNeeded();
      // 没点输入框时看向输入框(在头像的右下方),而且是静帧(省电,不逐帧动)
      await expect.poll(async () => (await look("g12"))[1]).toBeGreaterThan(0.2);
      await expect(page.getByTestId("gaze-g12")).toHaveAttribute("data-live", "0");
      // 点进输入框打字:光标往右走,眼睛也往右
      await composer(page).click();
      await expect.poll(async () => (await look("g12"))[0], { timeout: 3000 }).toBeLessThan(0.6);
      const x0 = (await look("g12"))[0];
      await expect(page.getByTestId("gaze-g12")).toHaveAttribute("data-live", "1");
      await composer(page).pressSequentially("先只接飞书，按我勾选的内容引用就行，全量同步以后再说");
      await expect.poll(async () => (await look("g12"))[0]).toBeGreaterThan(x0 + 0.1);
      await shot(page, `concept/gaze-${theme}`, 400);
      await composer(page).fill("");
      // 回答了第一件:Argon 合并在同一个头像下的第二件(等你同意)还在等,头像继续看你
      await page.getByTestId("quick-g12-0").click();
      await expect(page.getByTestId("gaze-g12")).toHaveAttribute("data-watching", "1");
      // 两件都回了 → 不再盯着你,眯眼笑
      await page.getByTestId("quick-g13p-0").click();
      await expect(page.getByTestId("gaze-g12")).toHaveAttribute("data-watching", "0");
      await expect(page.getByTestId("gaze-g12")).toHaveAttribute("data-mood", "happy");
    });

    test("派活前看一眼谁闲着:@ 列表每一行写着它此刻在等你几件、在做几件、空闲", async ({ page }) => {
      await page.goto(`/?conv=g&freeze${q}`);
      await composer(page).click();
      await composer(page).pressSequentially("@");
      const picker = page.getByTestId("at-picker");
      await expect(picker).toBeVisible();
      // 手上没活的写「空闲」;在做的写占了几格;有事等你的写等你几件
      await expect(picker.getByTestId("load-astra")).toHaveText("空闲");
      await expect(picker.getByTestId("load-astra")).toHaveAttribute("data-free", "1");
      await expect(picker.getByTestId("load-claude")).toContainText(/在做 \d/);
      await expect(picker.getByTestId("load-claude")).toHaveAttribute("title", /同时最多做 3 件/);
      await expect(picker.getByTestId("load-argon")).toContainText("等你 3");
      // Helper 不是干活的人,照旧写它是什么
      await expect(picker.getByTestId("at-helper")).toContainText("软件助手");
      await page.getByTestId("at-claude").hover();
      await shot(page, `concept/load-${theme}`, 200);

      // 是实时的:回答了 Argon 一件,@ 列表里它等你的数跟着少一件
      await composer(page).fill("");
      await page.locator("#m-g12").scrollIntoViewIfNeeded();
      await page.getByTestId("quick-g12-0").click();
      await composer(page).click();
      await composer(page).fill("");
      await composer(page).pressSequentially("@");
      await expect(page.getByTestId("at-picker").getByTestId("load-argon")).toContainText("等你 2");
    });
  });
}
