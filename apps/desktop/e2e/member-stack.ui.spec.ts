import { expect, test } from "@playwright/test";
import { shot } from "./shots";

for (const theme of ["light", "dark"] as const) {
  test(`成员头像组(${theme}):默认收拢,悬停 / 键盘聚焦展开,悬停头像显示名字,点了打开成员页`, async ({ page }) => {
    await page.goto(`/?conv=g${theme === "dark" ? "&theme=dark" : ""}`);
    const stack = page.getByTestId("member-stack");
    await expect(stack).toBeVisible();
    await page.mouse.move(4, 400);
    await expect(stack).toHaveAttribute("data-open", "0");
    const collapsed = (await stack.boundingBox())!;
    await shot(page, `member-stack/${theme}-collapsed`);

    await page.getByTestId("head-search").focus();
    await page.keyboard.press("Tab");
    await expect(stack).toBeFocused();
    await expect(stack).toHaveAttribute("data-open", "1");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("head-side")).toBeFocused();
    await expect(stack).toHaveAttribute("data-open", "0");
    await expect.poll(async () => Math.round((await stack.boundingBox())!.width)).toBe(Math.round(collapsed.width));

    await stack.hover();
    await expect(stack).toHaveAttribute("data-open", "1");
    await expect.poll(async () => (await stack.boundingBox())!.width).toBeGreaterThan(collapsed.width + 30);
    let prev = 0;
    await expect.poll(async () => { const w = (await stack.boundingBox())!.width; const settled = Math.abs(w - prev) < 0.5; prev = w; return settled; }).toBe(true);

    const box = (await stack.locator("[data-testid^=member-stack-avatar-]").nth(1).boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(at.x, at.y, { steps: 4 });
    const name = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-testid^=member-stack-avatar-]")?.querySelector("[aria-label]")?.getAttribute("aria-label") ?? "", at);
    expect(name).not.toBe("");
    await expect(page.getByTestId("member-stack-name")).toHaveText(name);
    await expect(stack).toHaveAttribute("data-open", "1");
    await shot(page, `member-stack/${theme}-expanded`, 400);

    await page.mouse.move(4, 400);
    await expect(stack).toHaveAttribute("data-open", "0");
    await expect.poll(async () => Math.round((await stack.boundingBox())!.width)).toBe(Math.round(collapsed.width));

    await stack.click();
    await expect(page.getByTestId("side-tab-members")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("group-side")).toBeVisible();
  });
}
