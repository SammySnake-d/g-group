import { expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// 壳(R1)拆分后补的行为用例:提示条(sonner)、删除可撤销、私聊回退确认框、Esc 逐层退、@ 选人。
// 这些路径拆分前没有用例覆盖,补上免得以后再挪代码时悄悄坏掉。

const order = (page: Page) => page.locator("[data-scroll=chat] [data-msg]").evaluateAll((els) => els.map((e) => e.getAttribute("data-msg")));

test("提示条:右键置顶会话出现「已置顶」;多选删除后点撤销,消息回到原位置", async ({ page }) => {
  await page.goto("/?freeze=1&conv=g");
  await page.getByTestId("conv-dm-claude").click({ button: "right" });
  await page.getByTestId("pin-dm-claude").click();
  await expect(page.getByTestId("toast")).toHaveText("已置顶");
  await expect(page.getByTestId("conv-dm-claude")).toHaveAttribute("data-pinned", "1");

  await page.getByTestId("conv-dm-claude").click();
  await page.getByText("过完了，提了 5 处修改，都已经合进去了。").click({ button: "right" });
  await page.getByTestId("ctx-multi").click();
  await page.locator('[data-msg="d3"]').click();
  await expect(page.getByTestId("select-bar")).toContainText("已选 1 条");
  await page.getByTestId("select-delete").click();
  await expect(page.locator('[data-msg="d3"]')).toHaveCount(0);
  await expect(page.getByTestId("select-bar")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toHaveText("已删除 1 条，只在你这边看不到；别人那边还在");
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.locator('[data-msg="d3"]')).toHaveCount(1);
  const ids = await order(page);
  expect(ids.indexOf("d3")).toBeGreaterThan(ids.indexOf("d1"));
  expect(ids.indexOf("d3")).toBeLessThan(ids.indexOf("d4"));
});

test("私聊回退:确认框写明撤下几条,Esc 只关确认框;确认后撤下,点恢复全部回来", async ({ page }) => {
  await page.goto("/?freeze=1&conv=dm-claude");
  const ask = async () => {
    await page.getByText("过完了，提了 5 处修改，都已经合进去了。").click({ button: "right" });
    await page.getByTestId("ctx-rewind").click();
  };
  await ask();
  const dlg = page.getByTestId("rewind-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("之后的 4 条会撤下");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(page.getByTestId("conv-dm-claude")).toHaveAttribute("data-active", "1");
  await expect(page.locator('[data-msg="d4"]')).toHaveCount(1);

  await ask();
  await page.getByTestId("rewind-confirm").click();
  await expect(dlg).toHaveCount(0);
  const line = page.getByTestId("rewind-line");
  await expect(line).toContainText("之后 4 条已撤下");
  await expect(page.locator('[data-msg="d4"]')).toHaveCount(0);
  await line.locator("[data-testid^=rewind-undo-]").click();
  await expect(page.getByTestId("toast")).toHaveText("已恢复撤下的消息");
  await expect(page.locator('[data-msg="d4"]')).toHaveCount(1);
  await expect(page.locator('[data-msg="d6"]')).toHaveCount(1);
});

test("Esc 逐层退:先收右侧浮层,再收分栏", async ({ page }) => {
  await page.goto("/?freeze=1&conv=g");
  await page.getByTestId("head-side").click();
  await expect(page.getByTestId("split")).toBeVisible();
  await page.getByTestId("chat-more").click();
  await expect(page.getByTestId("scrim")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("scrim")).toHaveCount(0);
  await expect(page.getByTestId("split")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("split")).toHaveCount(0);
});

test("@ 选人:打 @ 弹出,第一项是 Helper;方向键移动、回车填进输入框,焦点一直在输入框", async ({ page }) => {
  await page.goto("/?freeze=1&conv=g");
  const input = page.getByTestId("composer");
  await input.click();
  await page.keyboard.type("@");
  const picker = page.getByTestId("at-picker");
  await expect(picker).toBeVisible();
  const selected = picker.locator('[aria-selected="true"]');
  await expect(selected).toHaveAttribute("data-testid", "at-helper");
  await page.keyboard.press("ArrowDown");
  await expect(selected).not.toHaveAttribute("data-testid", "at-helper");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(input).toHaveValue(/^@\S+( \S+)* $/);
  await expect(input).toBeFocused();
});

for (const theme of ["light", "dark"] as const) {
  test(`提示条和 / 命令菜单跟着主题 token(${theme})`, async ({ page }) => {
    await page.goto(`/?freeze=1&conv=g${theme === "dark" ? "&theme=dark" : ""}`);
    const elev = await page.getByTestId("composer-box").evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.getByTestId("conv-dm-claude").click({ button: "right" });
    await page.getByTestId("pin-dm-claude").click();
    const toast = page.locator("[data-sonner-toast]").first();
    await expect(toast).toBeVisible();
    expect(await toast.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(elev);
    await shot(page, `r1/${theme}-toast`, 500);
    await page.getByTestId("composer").click();
    await page.keyboard.type("/");
    const menu = page.getByTestId("slash-menu");
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(elev);
    await shot(page, `r1/${theme}-slash-menu`);
  });
}

test("键盘走通:分隔条 Tab 聚焦后 ←/→ 调宽并夹在范围里;会话列表 ↑/↓ 在行间移动焦点", async ({ page }) => {
  await page.goto("/?freeze=1&conv=g");
  const list = page.getByTestId("list");
  const w0 = (await list.boundingBox())!.width;
  const div = page.getByTestId("div-list");
  await div.focus();
  await page.keyboard.press("ArrowRight");
  await expect(div).toHaveAttribute("aria-valuenow", String(w0 + 16));
  await expect.poll(async () => (await list.boundingBox())!.width).toBe(w0 + 16);
  for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowRight");
  await expect(div).toHaveAttribute("aria-valuenow", await div.getAttribute("aria-valuemax") as string);
  const rows = page.locator("[data-testid=list] [data-testid^=conv-]");
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(rows.first()).toBeFocused();
});
