import { expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// 进展全景看板(#806 四级 + 单击即跳;#872 / #877 照 mirasim「会话全景」;#998 带暗背景的弹出遮罩)。
// 对照 g-group-progress-panel 原型 README 的 20 项核对里能在桌面端成立的部分:悬停整条链、状态筛选、各类单击落点、
// Esc / 点暗背景关闭、搜索框里 Esc 先清搜索、关了再开筛选还在、展开后收起吸底、按联系人、1024 宽子任务列自动隐藏。

const open = async (page: Page) => {
  await page.getByTestId("nav-activity").click();
  await expect(page.getByTestId("pano-overlay")).toBeVisible();
  await expect(page.getByTestId("pano-board")).toBeVisible();
};
const closed = (page: Page) => expect(page.getByTestId("pano-overlay")).toBeHidden();
const active = (page: Page, conv: string) => expect(page.getByTestId(`conv-${conv}`)).toHaveAttribute("data-active", "1");

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?freeze");
  await expect(page.getByTestId("rail")).toBeVisible();
});

test("四级:对话 → 联系人(只有群聊)→ Compute → 子任务;不显示花费;定时和任务时间线不在遮罩里", async ({ page }) => {
  await open(page);
  const board = page.getByTestId("pano-board");
  await expect(page.getByTestId("pano-root-g")).toContainText("模型助手群聊");
  await expect(page.getByTestId("pano-contact-g/claude")).toBeVisible();
  await expect(page.getByTestId("pano-compute-login")).toContainText("登录页改成深色主题");
  await expect(page.getByTestId("pano-sub-sl1")).toBeVisible();
  // 私聊没有联系人这一级
  await expect(page.getByTestId("pano-root-dm-claude")).toBeVisible();
  await expect(page.locator('[data-testid^="pano-contact-dm-"]')).toHaveCount(0);
  // 群里同一上游同一原因失败两个 → 群级提示
  await expect(page.getByTestId("pano-hint-g")).toContainText("2 个同因失败");
  await expect(board).not.toContainText("¥");
  await expect(board).not.toContainText("花费");
  await expect(page.getByTestId("pano-cron")).toHaveCount(0);
  await expect(page.getByTestId("pano-tasks")).toHaveCount(0);
  await shot(page, "progress/board");
});

test("悬停整条链亮起,其余变淡;移开恢复", async ({ page }) => {
  await open(page);
  await page.getByTestId("pano-sub-sr1").hover();
  for (const id of ["pano-sub-sr1", "pano-compute-d-pr1", "pano-root-dm-claude"]) await expect(page.getByTestId(id)).toHaveAttribute("data-lit", "");
  await expect(page.getByTestId("pano-compute-login")).toHaveAttribute("data-dim", "");
  await expect(page.getByTestId("pano-sub-sr2")).toHaveAttribute("data-dim", "");
  await page.getByTestId("pano-search").hover();
  await expect(page.getByTestId("pano-compute-login")).not.toHaveAttribute("data-dim", "");
});

test("状态块:点一下只看这一类,再点取消;关掉再开筛选还在", async ({ page }) => {
  await open(page);
  const failed = page.getByTestId("pano-kpi-failed");
  await expect(failed.locator(".bd-tile-num")).toHaveText("5");
  await failed.click();
  await expect(failed).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("pano-compute-d-ledger")).toBeVisible();
  await expect(page.getByTestId("pano-compute-login")).toHaveCount(0);
  await expect(page.locator('[data-testid^="pano-compute-"]')).toHaveCount(5);
  await page.keyboard.press("Escape");
  await closed(page);
  await open(page);
  await expect(page.getByTestId("pano-kpi-failed")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("pano-kpi-failed").click();
  await expect(page.getByTestId("pano-kpi-all")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("pano-compute-login")).toBeVisible();
  // 组内左右方向键移动焦点
  await page.getByTestId("pano-kpi-all").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("pano-kpi-wait")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("pano-kpi-done")).toBeFocused();
});

test("关闭:Esc、点暗背景、×;搜索框里 Esc 先清搜索", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Escape");
  await closed(page);

  await open(page);
  const box = (await page.getByTestId("pano-overlay").boundingBox())!;
  await page.mouse.click(box.x + 8, box.y + 8);
  await closed(page);

  await open(page);
  await page.getByTestId("pano-search").fill("provenance");
  await expect(page.locator('[data-testid^="pano-compute-"]')).toHaveCount(1);
  // 搜索命中被折叠的子任务时把它露出来
  await expect(page.getByTestId("pano-sub-sr11")).toBeVisible();
  await expect(page.getByTestId("pano-more-in:d-pr1")).toHaveText(/还有 5 个/);
  await page.getByTestId("pano-search").press("Escape");
  await expect(page.getByTestId("pano-search")).toHaveValue("");
  await expect(page.getByTestId("pano-overlay")).toBeVisible();
  await page.getByTestId("pano-close").click();
  await closed(page);
});

test("单击即跳:对话 → 聊天;群里的联系人 → 本群完整过程;群级提示 → 那个群", async ({ page }) => {
  await open(page);
  await page.getByTestId("pano-root-g-design").click();
  await closed(page);
  await active(page, "g-design");

  await open(page);
  await page.getByTestId("pano-contact-g/codex").click();
  await closed(page);
  await active(page, "g");
  await expect(page.getByTestId("process-codex")).toHaveAttribute("data-conv", "g");

  await open(page);
  await page.getByTestId("pano-hint-g").click();
  await closed(page);
  await active(page, "g");
});

test("单击即跳:Compute → 聊天 + 它的过程;等你处理的同时定位到它问你的那条消息;子任务 → 所属 Compute", async ({ page }) => {
  await open(page);
  await page.getByTestId("pano-compute-perf").click();
  await closed(page);
  await active(page, "g");
  await expect(page.getByTestId("split-tab-compute-perf")).toBeVisible();

  await open(page);
  await expect(page.getByTestId("pano-compute-feishu")).toContainText("等你回答");
  await page.getByTestId("pano-compute-feishu").click();
  await closed(page);
  await active(page, "dm-argon");
  await expect(page.getByTestId("split-tab-compute-feishu")).toBeVisible();
  await expect(page.locator("#m-x5")).toHaveAttribute("data-hl", "1");

  await open(page);
  await page.getByTestId("pano-sub-sg1").click();
  await closed(page);
  await active(page, "dm-codex");
  await expect(page.getByTestId("split-tab-compute-logs")).toBeVisible();
});

test("按联系人:每人一个根,卡片标出来自哪个群;点联系人 → 和它的私聊 + 所有群和私聊里的过程", async ({ page }) => {
  await open(page);
  await page.getByTestId("pano-group-contact").click();
  await expect(page.getByTestId("pano-root-codex")).toBeVisible();
  await expect(page.locator('[data-testid^="pano-contact-"]')).toHaveCount(0);
  await expect(page.getByTestId("pano-compute-d-ledger")).toContainText("模型助手群聊");
  await expect(page.getByTestId("pano-compute-d-mut")).toContainText("私聊");
  await shot(page, "progress/by-contact");
  await page.getByTestId("pano-root-argon").click();
  await closed(page);
  await active(page, "dm-argon");
  await expect(page.getByTestId("process-argon")).toHaveAttribute("data-conv", "all");
});

test("子任务超过 6 个折叠;展开后「收起」吸在可视区底部,点了收回并把列表顶部滚回视野", async ({ page }) => {
  await open(page);
  const more = page.getByTestId("pano-more-in:d-pr1");
  await expect(more).toHaveText(/还有 6 个/);
  await expect(page.getByTestId("pano-sub-sr11")).toHaveCount(0);
  await more.click();
  await expect(more).toHaveText(/收起/);
  await expect(page.getByTestId("pano-sub-sr11")).toBeVisible();
  // 把展开的列表顶部滚到可视区下沿附近:「收起」本来在可视区外,吸底后仍看得见
  const canvas = page.getByTestId("pano-canvas");
  const first = page.getByTestId("pano-sub-sr1");
  const cBox = (await canvas.boundingBox())!;
  const fBox = (await first.boundingBox())!;
  await canvas.evaluate((el, dy) => { el.scrollTop += dy; }, fBox.y - (cBox.y + cBox.height - 120));
  const mBox = (await more.boundingBox())!;
  expect(mBox.y + mBox.height).toBeLessThanOrEqual(cBox.y + cBox.height);
  expect(mBox.y).toBeGreaterThan(cBox.y);
  await shot(page, "progress/fold-pinned");
  await more.click();
  await expect(more).toHaveText(/还有 6 个/);
  const back = (await first.boundingBox())!;
  expect(back.y).toBeGreaterThanOrEqual(cBox.y);
  expect(back.y).toBeLessThan(cBox.y + cBox.height);
});

test("1024 宽:子任务列自动隐藏,不出横向滚动", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await open(page);
  await expect(page.getByTestId("pano-compute-d-pr1")).toBeVisible();
  await expect(page.getByTestId("pano-col-inside")).toHaveCount(0);
  await expect(page.locator('[data-testid^="pano-sub-"]')).toHaveCount(0);
  const { sw, cw } = await page.getByTestId("pano-canvas").evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
  await shot(page, "progress/narrow-1024");
});

test("键盘:Tab 顺着对话 → 群级提示 → 联系人 → Compute → 子任务走,聚焦也亮整条链,Enter 即跳", async ({ page }) => {
  await open(page);
  await page.getByTestId("pano-root-g").focus();
  await expect(page.getByTestId("pano-root-g")).toHaveAttribute("data-lit", "");
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  const order: (string | null | undefined)[] = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); order.push(await focused()); }
  expect(order[0]).toBe("pano-hint-g");
  expect(order[1]).toMatch(/^pano-contact-g\//);
  expect(order[2]).toMatch(/^pano-compute-/);
  await page.keyboard.press("Enter");
  await closed(page);
});

test("「所有会话的定时」打开的是独立的定时总览,不是看板;再从左栏打开是看板", async ({ page }) => {
  await page.getByTestId("head-side").click();
  await page.getByTestId("side-tab-cron").click();
  await page.getByTestId("side-cron-overview").click();
  await expect(page.getByTestId("pano-cron")).toBeInViewport();
  await expect(page.getByTestId("pano-board")).toHaveCount(0);
  await shot(page, "progress/cron-overview");
  await page.getByTestId("pano-cron-scope-person").click();
  await expect(page.getByTestId("pano-cron")).toContainText("Argon");
  await page.getByTestId("pano-close").click();
  await closed(page);
  await open(page);
  await expect(page.getByTestId("pano-cron")).toHaveCount(0);
});
