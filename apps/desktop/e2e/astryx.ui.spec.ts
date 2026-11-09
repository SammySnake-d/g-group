import { expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// Astryx 底座探针:主题真生效(不是默认 neutral 色)、Tailwind 类能盖过 Astryx、键盘交互完整、无控制台报错。
const css = (page: Page, sel: string, prop: string) =>
  page.locator(sel).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
const varOf = (page: Page, name: string) =>
  page.evaluate((n) => { const d = document.createElement("div"); d.style.color = `hsl(var(${n}))`; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }, name);

for (const theme of ["light", "dark"] as const) {
  test.describe(`Astryx 探针 ${theme}`, () => {
    test("主题:主按钮是墨色、正文色/字体走「纸·墨·柿」,不是 neutral 默认值;Tailwind 类能改按钮形态", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      await page.goto(`/?preview=astryx${theme === "dark" ? "&theme=dark" : ""}`);
      const primary = page.getByRole("button", { name: "主操作" });
      await expect(primary).toBeVisible();
      expect(await css(page, "[data-testid=astryx-probe] button", "background-color")).toBe(await varOf(page, "--btn"));
      expect(await primary.evaluate((el) => getComputedStyle(el).color)).toBe(await varOf(page, "--btn-fg"));
      expect(await primary.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("PingFang SC");
      const pill = page.getByRole("button", { name: "胶囊(Tailwind 改形)" });
      const r = await pill.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
      expect(r, "Tailwind rounded-full 盖过 Astryx 圆角").toBeGreaterThan(100);
      expect(await pill.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe("24px");
      // 亮暗跟随我们自己的 dark 状态
      expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(theme);
      await shot(page, `astryx/probe-${theme}`, 0);
      expect(errors, errors.join("\n")).toEqual([]);
    });

    test("键盘:菜单方向键移动、回车选中;对话框 Esc 关闭且焦点回到触发按钮;开关空格切换", async ({ page }) => {
      await page.goto(`/?preview=astryx${theme === "dark" ? "&theme=dark" : ""}`);
      const more = page.getByRole("button", { name: "更多" });
      await more.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "打开会话" })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitem", { name: "复制" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("ax-picked")).toHaveText("复制");
      await expect(menu).toBeHidden();

      const opener = page.getByRole("button", { name: "打开对话框" });
      await opener.focus();
      await page.keyboard.press("Enter");
      const dlg = page.getByRole("dialog");
      await expect(dlg).toBeVisible();
      await expect(dlg.getByRole("button", { name: "取消" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dlg).toBeHidden();
      await expect(opener).toBeFocused();

      const sw = page.getByRole("switch", { name: "定时启用" });
      await sw.focus();
      await page.keyboard.press("Space");
      await expect(sw).toBeChecked();
    });
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`设置页 Astryx ${theme}：通知独立切换、调试状态跨导航保留、外观切换不中断操作`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(theme === "dark" ? "/?theme=dark" : "/");
    await page.getByTestId("nav-settings").click();
    const waiting = page.getByRole("switch", { name: "有事等我时提醒" });
    const error = page.getByRole("switch", { name: "出错时提醒" });
    const debug = page.getByRole("switch", { name: "调试模式", exact: true });
    await expect(waiting).toBeChecked();
    await expect(error).toBeChecked();
    await expect(debug).not.toBeChecked();
    await waiting.focus();
    await page.keyboard.press("Space");
    await expect(waiting).not.toBeChecked();
    await expect(error).toBeChecked();
    await error.click();
    await expect(error).not.toBeChecked();
    await debug.click();
    await expect(debug).toBeChecked();
    // 外观选项仍使用已验收的预览卡，不为迁移重做布局。
    await page.getByRole("radio", { name: theme === "light" ? "深色" : "浅色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "light" ? "dark" : "light");
    await expect(waiting).not.toBeChecked();
    await expect(debug).toBeChecked();
    await page.getByTestId("nav-files").click();
    await page.getByTestId("nav-settings").click();
    await expect(debug).toBeChecked();
    await debug.focus();
    await page.keyboard.press("Space");
    await expect(debug).not.toBeChecked();
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
