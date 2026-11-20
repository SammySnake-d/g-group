import { expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";


const composer = (page: Page) => page.locator("[data-testid=composer-box] textarea");


for (const theme of ["light", "dark"] as const) {
  const q = theme === "dark" ? "&theme=dark" : "";

  test.describe(`概念 ${theme}`, () => {
    test("双击就回复:指针在消息上双击 = 引用并 @ 作者,光标进输入框;按住 ⌥ 双击照常选词", async ({ page }) => {
      await page.goto(`/?conv=g&freeze${q}`);
      const bubble = page.locator('[data-anchor="g6"]');
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
      await bubble.dblclick({ position: { x: 220, y: 14 }, modifiers: ["Alt"] });
      await expect(page.getByTestId("quote-bar")).toHaveCount(0);

      await bubble.dblclick({ position: { x: 220, y: 14 } });
      await expect(page.getByTestId("quote-bar")).toBeVisible();
      await expect(page.getByTestId("quote-bar")).toContainText("首屏");
      await expect(composer(page)).toBeFocused();
      await expect(composer(page)).toHaveValue(/^@Codex /);
      await expect(bubble).toHaveAttribute("data-dblreply", "1");
      expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");

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
      const ticks = ruler.locator("[data-testid^=ruler-tick-]");
      await expect(ticks).toHaveCount(3);
      const ids = await ticks.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("ruler-tick-", "")));
      expect(ids).toEqual(["g6", "g12", "g13p"]);
      await expect(page.getByTestId("ruler-tick-g6")).toHaveAttribute("data-kind", "accept");
      await expect(page.getByTestId("ruler-tick-g12")).toHaveAttribute("data-kind", "ask");
      const ys = await ticks.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
      expect(ys[0]).toBeLessThan(ys[1]);
      expect(ys[1]).toBeLessThan(ys[2]);

      await page.getByTestId("ruler-tick-g6").click();
      await expect(page.locator("#m-g6")).toHaveAttribute("data-hl", "1");
      await expect(page.locator("#m-g6")).toBeInViewport();
      await page.waitForTimeout(800);
      await page.keyboard.press("Alt+ArrowDown");
      await expect(page.locator("#m-g12")).toHaveAttribute("data-hl", "1");
      await expect(page.locator("#m-g12")).toBeInViewport();
      await composer(page).fill("写到一半");
      await page.waitForTimeout(2000);
      await page.keyboard.press("Alt+ArrowDown");
      await page.waitForTimeout(300);
      await expect(page.locator("[data-hl=\"1\"]")).toHaveCount(0);
      await composer(page).fill("");

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
      for (const id of ["g6", "g12", "g13p"]) await expect(page.getByTestId(`gaze-${id}`)).toHaveAttribute("data-watching", "1");
      await expect(page.locator("[data-testid^=gaze-]")).toHaveCount(3);
      await page.locator("#m-g12").scrollIntoViewIfNeeded();
      await expect.poll(async () => (await look("g12"))[1]).toBeGreaterThan(0.2);
      await expect(page.getByTestId("gaze-g12")).toHaveAttribute("data-live", "0");
      await composer(page).click();
      await expect.poll(async () => (await look("g12"))[0], { timeout: 3000 }).toBeLessThan(0.6);
      const x0 = (await look("g12"))[0];
      await expect(page.getByTestId("gaze-g12")).toHaveAttribute("data-live", "1");
      await composer(page).pressSequentially("先只接飞书，按我勾选的内容引用就行，全量同步以后再说");
      await expect.poll(async () => (await look("g12"))[0]).toBeGreaterThan(x0 + 0.1);
      await shot(page, `concept/gaze-${theme}`, 400);
      await composer(page).fill("");
      await page.getByTestId("quick-g12-0").click();
      await expect(page.getByTestId("gaze-g12")).toHaveAttribute("data-watching", "1");
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
      await expect(picker.getByTestId("load-astra")).toHaveText("空闲");
      await expect(picker.getByTestId("load-astra")).toHaveAttribute("data-free", "1");
      await expect(picker.getByTestId("load-claude")).toContainText(/在做 \d/);
      await expect(picker.getByTestId("load-claude")).toHaveAttribute("title", /同时最多做 3 件/);
      await expect(picker.getByTestId("load-argon")).toContainText("等你 3");
      await expect(picker.getByTestId("at-helper")).toContainText("软件助手");
      await page.getByTestId("at-claude").hover();
      await shot(page, `concept/load-${theme}`, 200);

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
