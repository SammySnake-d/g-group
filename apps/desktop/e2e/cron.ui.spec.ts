import { expect, test, type Page } from "@playwright/test";

/* 定时：真实点击和键盘输入驱动，断言用户看得到的结果。
   时钟固定在 2026-11-09（周一）08:30，时区是 playwright.config 里的 Asia/Shanghai，所有「下次」「接下来」都是确定的。 */
const NOW = new Date("2026-11-09T08:30:00+08:00");

async function openGroupCrons(page: Page) {
  await page.clock.setFixedTime(NOW);
  await page.goto("/");
  await page.getByTestId("head-side").click();
  await page.getByTestId("side-tab-cron").click();
  await expect(page.getByTestId("side-crons")).toBeVisible();
}

/** 像人一样改表达式：点进输入框、全选、敲新的 */
async function typeExpr(page: Page, expr: string) {
  const input = page.getByTestId("cron-editor-expr");
  await input.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(expr);
}

const preview = (page: Page) => page.getByTestId("cron-preview").locator("[data-testid^=cron-preview-]");

test("选预设：表达式、人话和接下来几次都跟着变", async ({ page }) => {
  await openGroupCrons(page);
  await page.getByTestId("side-cron-add").click();
  const editor = page.getByTestId("cron-editor");
  await expect(editor).toBeVisible();
  await expect(page.getByTestId("cron-editor-zone")).toContainText("Asia/Shanghai · UTC+8");

  await page.getByTestId("cron-preset-weekdays-9").click();
  await expect(page.getByTestId("cron-editor-expr")).toHaveValue("0 9 * * 1-5");
  await expect(page.getByTestId("cron-preset-weekdays-9")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("cron-editor-desc")).toHaveText("工作日 09:00");
  await expect(preview(page)).toHaveText(["今天 09:00", "明天 09:00", "周三 09:00", "周四 09:00", "周五 09:00"]);

  await page.getByTestId("cron-preset-monday-9").click();
  await expect(page.getByTestId("cron-editor-expr")).toHaveValue("0 9 * * 1");
  await expect(page.getByTestId("cron-editor-desc")).toHaveText("每周一 09:00");
  await expect(preview(page)).toHaveText(["今天 09:00", "11/16 09:00", "11/23 09:00", "11/30 09:00", "12/7 09:00"]);

  await page.getByTestId("cron-preset-every-30m").click();
  await expect(page.getByTestId("cron-editor-expr")).toHaveValue("*/30 * * * *");
  await expect(page.getByTestId("cron-editor-desc")).toHaveText("每 30 分钟");
  await expect(preview(page)).toHaveText(["今天 09:00", "今天 09:30", "今天 10:00", "今天 10:30", "今天 11:00"]);

  await page.getByTestId("cron-preset-hourly").click();
  await expect(page.getByTestId("cron-editor-desc")).toHaveText("每小时整点");
  await expect(preview(page).first()).toHaveText("今天 09:00");
  await expect(page.getByTestId("cron-preset-weekdays-9")).toHaveAttribute("aria-pressed", "false");
});

test("手输非法表达式：错误指名是哪一段、那一段标红、保存不可用；改对后预览给出正确的下次时间", async ({ page }) => {
  await openGroupCrons(page);
  await page.getByTestId("side-cron-add").click();
  await page.getByTestId("cron-editor-text").click();
  await page.keyboard.type("十点那一小时每 15 分钟看一眼部署队列");
  await page.getByTestId("cron-editor-who-codex").click();
  await page.getByTestId("cron-preset-custom").click();
  await expect(page.getByTestId("cron-preset-custom")).toHaveAttribute("aria-pressed", "true");
  const save = page.getByTestId("cron-editor-save");
  await expect(save).toBeEnabled();

  await typeExpr(page, "0 25 * * *");
  await expect(page.getByTestId("cron-editor-error")).toHaveText("第 2 段（时）：25 超出 0–23");
  await expect(page.getByTestId("cron-editor-field-2")).toHaveAttribute("data-bad", "true");
  await expect(page.getByTestId("cron-editor-field-1")).not.toHaveAttribute("data-bad", "true");
  await expect(page.getByTestId("cron-preview")).toHaveCount(0);
  await expect(save).toBeDisabled();

  await typeExpr(page, "MON 9 * * *");
  await expect(page.getByTestId("cron-editor-error")).toHaveText("第 1 段（分）：不认识「MON」");
  await expect(page.getByTestId("cron-editor-field-1")).toHaveAttribute("data-bad", "true");
  await expect(save).toBeDisabled();

  await typeExpr(page, "0 0 30 2 *");
  await expect(page.getByTestId("cron-editor-error")).toHaveText("永远不会触发：2 月没有 30 日");
  await expect(save).toBeDisabled();

  await typeExpr(page, "0 9 * *");
  await expect(page.getByTestId("cron-editor-error")).toHaveText("要 5 段（分 时 日 月 周），现在是 4 段");
  await expect(save).toBeDisabled();

  await typeExpr(page, "*/15 10 * * *");
  await expect(page.getByTestId("cron-editor-error")).toHaveCount(0);
  await expect(page.getByTestId("cron-editor-desc")).toHaveText("每天 10 点每 15 分钟");
  await expect(preview(page)).toHaveText(["今天 10:00", "今天 10:15", "今天 10:30", "今天 10:45", "明天 10:00"]);
  await expect(save).toBeEnabled();
});

test("保存后本群列表出现新定时和人话描述；改时间后下次运行立刻变化", async ({ page }) => {
  await openGroupCrons(page);
  const before = await page.locator("[data-cron-row]").count();
  await page.getByTestId("side-cron-add").click();
  await expect(page.getByTestId("cron-editor-save")).toBeDisabled();
  await expect(page.getByTestId("cron-editor-missing")).toHaveText("写一下醒来做什么");
  await page.getByTestId("cron-editor-text").click();
  await page.keyboard.type("盘点一次还没合入的分支，列出卡住的原因");
  await page.getByTestId("cron-editor-who-codex").click();
  await page.getByTestId("cron-preset-custom").click();
  await typeExpr(page, "30 15 * * wed");
  await expect(page.getByTestId("cron-editor-desc")).toHaveText("每周三 15:30");
  await expect(preview(page).first()).toHaveText("周三 15:30");
  await page.getByTestId("cron-editor-speak-only-if").click();
  await page.getByTestId("cron-editor-save").click();

  await expect(page.getByTestId("cron-editor")).toHaveCount(0);
  await expect(page.locator("[data-cron-row]")).toHaveCount(before + 1);
  const row = page.locator("[data-cron-row]", { hasText: "盘点一次还没合入的分支" });
  await expect(row.getByTestId("cron-row-rule")).toHaveText("每周三 15:30");
  await expect(row.getByTestId("cron-row-expr")).toHaveText("30 15 * * WED");
  await expect(row.getByTestId("cron-row-next")).toHaveText("周三 15:30");
  await expect(row.getByTestId("cron-row-last")).toContainText("还没跑过");
  // 原会话里只插一行灰字
  await expect(page.getByText("你给 Codex 加了定时：每周三 15:30「盘点一次还没合入的分支，列出卡住的原因」")).toBeVisible();

  // 打开详情，改成每天 09:00：详情和列表的下次运行都立刻变
  await row.click();
  await expect(page.getByTestId("cron-next")).toHaveText("周三 15:30");
  await page.getByTestId("cron-edit").click();
  await expect(page.getByTestId("cron-editor-text")).toHaveValue("盘点一次还没合入的分支，列出卡住的原因");
  await expect(page.getByTestId("cron-editor-speak-only-if")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("cron-preset-daily-9").click();
  await page.getByTestId("cron-editor-save").click();
  await expect(page.getByTestId("cron-rule")).toHaveText("每天 09:00");
  await expect(page.getByTestId("cron-next")).toHaveText("今天 09:00");
  await expect(page.locator("[data-testid^=cron-detail-next-]")).toHaveText(["明天 09:00", "周三 09:00", "周四 09:00"]);
  await page.getByTestId("split-tab-group-g").click();
  await expect(row.getByTestId("cron-row-next")).toHaveText("今天 09:00");
});

test("启停开关：暂停后各处显示已暂停，再打开恢复下次时间", async ({ page }) => {
  await openGroupCrons(page);
  const row = page.getByTestId("cron-row-cr2");
  const toggle = page.getByTestId("cron-toggle-cr2");
  await expect(row.getByTestId("cron-row-next")).toHaveText("今天 09:30");
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(row).toHaveAttribute("data-paused", "true");
  await expect(row.getByTestId("cron-row-next")).toHaveText("已暂停");
  await expect(page.getByText("你把 Codex 的定时「巡检首页首屏耗时，超过 1.5 秒就报」暂停了")).toBeVisible();

  // 详情里看到的是同一个状态，从详情打开回来
  await row.click();
  await expect(page.getByTestId("cron-pause-label")).toHaveText("已暂停");
  await expect(page.getByTestId("cron-next")).toHaveText("已暂停");
  await page.getByTestId("cron-pause").click();
  await expect(page.getByTestId("cron-pause-label")).toHaveText("开着");
  await expect(page.getByTestId("cron-next")).toHaveText("今天 09:30");
  await page.getByTestId("split-tab-group-g").click();
  await expect(page.getByTestId("cron-toggle-cr2")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("cron-row-cr2").getByTestId("cron-row-next")).toHaveText("今天 09:30");
});

test("删除要二次确认：取消或 Esc 不删，确认才删", async ({ page }) => {
  await openGroupCrons(page);
  await page.getByTestId("cron-row-cr4").click();
  await expect(page.getByTestId("cron-detail-cr4")).toBeVisible();

  await page.getByTestId("cron-delete").click();
  const confirm = page.getByTestId("cron-delete-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("复核本周所有已合入的改动");
  await page.getByTestId("cron-delete-cancel").click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId("cron-detail-cr4")).toBeVisible();

  // Esc 只关确认框，不连带收起右侧分屏
  await page.getByTestId("cron-delete").click();
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId("cron-detail-cr4")).toBeVisible();

  await page.getByTestId("cron-delete").click();
  await page.getByTestId("cron-delete-ok").click();
  await expect(page.getByTestId("cron-detail-gone")).toBeVisible();
  await expect(page.getByTestId("toast")).toHaveText("已删除定时");
  await page.getByTestId("split-tab-group-g").click();
  await expect(page.getByTestId("cron-row-cr4")).toHaveCount(0);
  await expect(page.getByText("你删掉了 Astra 的定时「复核本周所有已合入的改动」")).toBeVisible();
});

test("立即跑一次：运行历史多一条；发了消息的能跳到那条消息", async ({ page }) => {
  await openGroupCrons(page);
  // 有情况才说的：试跑一次没打扰你
  await page.getByTestId("cron-row-cr1c").click();
  await expect(page.getByTestId("cron-runs-count")).toHaveText("1 次");
  await page.getByTestId("cron-run-now").click();
  await expect(page.getByTestId("cron-runs-count")).toHaveText("2 次");
  await expect(page.getByTestId("cron-run-0")).toHaveAttribute("data-result", "silent");
  await expect(page.getByTestId("cron-run-0")).toContainText("没打扰你");
  await expect(page.getByTestId("cron-run-0")).toContainText("今天 08:30");
  await expect(page.getByTestId("cron-run-1")).toContainText("0 条报错");

  // 每次都发结果的：试跑后发了消息，点「看消息」跳到那条
  await page.getByTestId("split-tab-group-g").click();
  await page.getByTestId("cron-row-cr5").click();
  await expect(page.getByTestId("cron-runs-count")).toHaveText("0 次");
  await page.getByTestId("cron-run-now").click();
  await expect(page.getByTestId("cron-runs-count")).toHaveText("1 次");
  await expect(page.getByTestId("cron-run-0")).toHaveAttribute("data-result", "said");
  await expect(page.getByTestId("cron-run-0")).toContainText("发了消息");
  const said = page.locator("[data-msg]", { hasText: "（手动试跑）把待验收的事汇总给你" });
  await expect(said).toBeVisible();
  await page.getByTestId("cron-run-jump-0").click();
  await expect(said).toHaveAttribute("data-hl", "1");
});

test("三个视角：本群只看本群，联系人看它在各会话的全部，进展里看所有", async ({ page }) => {
  await openGroupCrons(page);
  // 本群（模型助手群聊）不混进「前端设计讨论」的定时
  await expect(page.getByTestId("cron-row-cr2")).toBeVisible();
  await expect(page.getByTestId("cron-row-cr1")).toHaveCount(0);
  await expect(page.getByTestId("cron-row-cr3")).toHaveCount(0);

  // 进展总览：两个群的都在，出错的置顶
  await page.getByTestId("side-cron-overview").click();
  await expect(page.getByTestId("pano-cron")).toBeInViewport();
  await expect(page.getByTestId("pano-cron-err-cr3")).toBeVisible();
  await expect(page.getByTestId("pano-cron-cr2")).toBeVisible();
  await page.getByTestId("pano-close").click();

  // 联系人工作台：Argon 在两个会话里的定时按会话分组
  await page.getByTestId("nav-contacts").click();
  await page.getByTestId("contact-argon").click();
  await page.getByTestId("wb-tab-cron").click();
  const wb = page.getByTestId("wb-cron");
  await expect(wb.getByTestId("wb-cron-group-g").locator("[data-cron-row]")).toHaveCount(2);
  await expect(wb.getByTestId("wb-cron-group-g-design").getByTestId("cron-row-cr1")).toBeVisible();
  await expect(wb.getByTestId("cron-row-cr1").getByTestId("cron-row-next")).toHaveText("明天 08:00");
  await expect(wb.getByTestId("cron-row-cr8").getByTestId("cron-row-next")).toHaveText("再有 12 条消息");
  // 别人的定时不出现在 Argon 的工作台里
  await expect(wb.getByTestId("cron-row-cr2")).toHaveCount(0);
});

test("只跑一次：过去的时间不能保存，选将来的时间给出那一刻", async ({ page }) => {
  await openGroupCrons(page);
  await page.getByTestId("side-cron-add").click();
  await page.getByTestId("cron-editor-text").click();
  await page.keyboard.type("提醒大家周五前交周报");
  await page.getByTestId("cron-editor-who-argon").click();
  await page.getByTestId("cron-editor-kind-once").click();
  await page.getByTestId("cron-editor-once").fill("2026-11-09T08:00");
  await expect(page.getByTestId("cron-editor-error")).toHaveText("这个时间已经过去了");
  await expect(page.getByTestId("cron-editor-save")).toBeDisabled();
  await page.getByTestId("cron-editor-once").fill("2026-11-13T17:00");
  await expect(page.getByTestId("cron-preview-0")).toHaveText("周五 17:00");
  await page.getByTestId("cron-editor-save").click();
  const row = page.locator("[data-cron-row]", { hasText: "提醒大家周五前交周报" });
  await expect(row.getByTestId("cron-row-rule")).toHaveText("只跑一次：2026-11-13 17:00");
  await expect(row.getByTestId("cron-row-next")).toHaveText("周五 17:00");
});
