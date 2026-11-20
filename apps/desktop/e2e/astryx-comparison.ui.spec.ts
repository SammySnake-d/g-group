import { expect, test } from "@playwright/test";
import { shot } from "./shots";
import { BASELINE_CONSOLE } from "./console-baseline";

for (const theme of ["light", "dark"] as const) {
  test(`前后对照 ${theme}：设置全貌、通知控件、关闭回聊天`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(theme === "dark" ? "/?theme=dark" : "/");
    await page.getByTestId("conv-g").click();
    await page.getByTestId("nav-settings").click();
    await page.mouse.move(720, 20);
    await shot(page, `comparison/${theme}/settings-top`, 500);
    const debug = page.getByRole("switch", { name: "调试模式", exact: true });
    await debug.scrollIntoViewIfNeeded();
    await expect(page.getByRole("switch", { name: "有事等我时提醒" })).toBeVisible();
    await expect(debug).not.toBeChecked();
    await shot(page, `comparison/${theme}/settings-controls`, 500);
    await page.keyboard.press("Escape");
    await expect(debug).toBeHidden();
    await expect(page.getByTestId("chat-column")).toBeVisible();
    await shot(page, `comparison/${theme}/chat`, 1500);
    expect(errors, errors.join("\n")).toEqual(BASELINE_CONSOLE);
  });
}
