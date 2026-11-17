import { expect, test } from "@playwright/test";
import { shot } from "./shots";

// #976:聊天头部右上角的成员头像组默认收拢,移上去(或键盘聚焦)才展开;悬停某个头像浮起并显示名字;点了打开群资料成员页。
for (const theme of ["light", "dark"] as const) {
  test(`成员头像组(${theme}):默认收拢,悬停 / 键盘聚焦展开,悬停头像显示名字,点了打开成员页`, async ({ page }) => {
    await page.goto(`/?conv=g${theme === "dark" ? "&theme=dark" : ""}`);
    const stack = page.getByTestId("member-stack");
    await expect(stack).toBeVisible();
    await page.mouse.move(4, 400);
    await expect(stack).toHaveAttribute("data-open", "0");
    const collapsed = (await stack.boundingBox())!;
    await shot(page, `member-stack/${theme}-collapsed`);

    // 键盘:从「查找聊天记录」Tab 过来就展开,离开就收回
    await page.getByTestId("head-search").focus();
    await page.keyboard.press("Tab");
    await expect(stack).toBeFocused();
    await expect(stack).toHaveAttribute("data-open", "1");
    await page.keyboard.press("Tab");
    // 组里只有外层按钮一个焦点:下一个 Tab 直接到「群资料」,不会停在某个头像上
    await expect(page.getByTestId("head-side")).toBeFocused();
    await expect(stack).toHaveAttribute("data-open", "0");
    await expect.poll(async () => Math.round((await stack.boundingBox())!.width)).toBe(Math.round(collapsed.width));

    // 指针移上来展开:宽度明显变大(收拢时头像大幅重叠)
    await stack.hover();
    await expect(stack).toHaveAttribute("data-open", "1");
    await expect.poll(async () => (await stack.boundingBox())!.width).toBeGreaterThan(collapsed.width + 30);
    // 等展开的弹簧停稳再去指某个头像(移动中的头像会从指针下滑走)
    let prev = 0;
    await expect.poll(async () => { const w = (await stack.boundingBox())!.width; const settled = Math.abs(w - prev) < 0.5; prev = w; return settled; }).toBe(true);

    // 悬停某个头像:浮起并显示它的名字
    const box = (await stack.locator("[data-testid^=member-stack-avatar-]").nth(1).boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(at.x, at.y, { steps: 4 });
    // 指针下面是谁,提示就写谁(浮起的头像会离开原位,按指针当下指着的那个对)
    const name = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-testid^=member-stack-avatar-]")?.querySelector("[aria-label]")?.getAttribute("aria-label") ?? "", at);
    expect(name).not.toBe("");
    await expect(page.getByTestId("member-stack-name")).toHaveText(name);
    await expect(stack).toHaveAttribute("data-open", "1");
    await shot(page, `member-stack/${theme}-expanded`, 400);

    // 移开收回
    await page.mouse.move(4, 400);
    await expect(stack).toHaveAttribute("data-open", "0");
    await expect.poll(async () => Math.round((await stack.boundingBox())!.width)).toBe(Math.round(collapsed.width));

    // 点击仍打开群资料的成员页
    await stack.click();
    await expect(page.getByTestId("side-tab-members")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("group-side")).toBeVisible();
  });
}
