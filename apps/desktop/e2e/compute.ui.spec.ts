import { expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// #1005:Compute 是一个具体的 harness,要能「打开会话」看它和 Claude Code / Codex 的原始对话(只读)。
// 走真实入口:消息行末端与「更多」菜单的「打开会话」→ 分屏 Compute 视图的「会话」页签;完整过程面板里的 Compute 卡。

const IDS = ["login", "keys", "perf", "scrape", "logs", "feishu", "research", "review", "search", "weather"] as const;

for (const theme of ["light", "dark"] as const) {
  test.describe(`Compute 卡与 harness 会话 ${theme}`, () => {
    test.use({ colorScheme: theme });
    const go = (page: Page, q: string) => page.goto(`/?${q}${theme === "dark" ? "&theme=dark" : ""}`);
    const session = (page: Page) => page.getByTestId("split").getByTestId("harness-session");

    test("消息行点「打开会话」→ 分屏出现会话页,工具组默认折叠写「N 个调用」,展开看到每次调用与输入输出;只读、没有输入框", async ({ page }) => {
      await go(page, "conv=g");
      const line = page.getByTestId("compute-line-login");
      await expect(line).toBeVisible();
      // 「打开会话」在这一行的末端:紧挨着行的右边,同一条水平线上
      const open = page.getByTestId("open-session-login");
      const [lb, ob] = [(await line.boundingBox())!, (await open.boundingBox())!];
      expect(ob.x).toBeGreaterThanOrEqual(lb.x + lb.width - 1);
      expect(ob.x - (lb.x + lb.width)).toBeLessThan(12);
      expect(Math.abs(ob.y + ob.height / 2 - (lb.y + lb.height / 2))).toBeLessThan(4);
      expect(ob.height).toBeGreaterThanOrEqual(24);
      await line.scrollIntoViewIfNeeded();
      await shot(page, `compute/${theme}-chat-line`);

      await open.click();
      await expect(page.getByTestId("split")).toBeVisible();
      await expect(page.getByTestId("cview-session")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("compute-harness")).toHaveText("Claude Code");
      const s = session(page);
      await expect(s).toHaveAttribute("data-compute", "login");
      await expect(s.getByTestId("session-prompt").first()).toContainText("AC-24");

      const group = s.getByTestId("tool-group").first();
      await expect(group.getByTestId("tool-group-count")).toHaveText("3 个调用");
      await expect(group.getByTestId("tool-group-toggle")).toHaveAttribute("aria-expanded", "false");
      await expect(group.getByTestId("tool-group-calls")).toHaveCount(0);
      await group.getByTestId("tool-group-toggle").click();
      const calls = group.getByTestId("tool-group-calls");
      await expect(calls.getByTestId("tool-call")).toHaveCount(3);
      await expect(calls).toContainText("pages/Login.tsx");
      await expect(calls).toContainText("120 行");
      await calls.getByTestId("tool-call").first().getByRole("button").click();
      const detail = calls.getByTestId("tool-call-detail").first();
      await expect(detail).toContainText("输入");
      await expect(detail).toContainText("输出");
      await expect(detail).toContainText("bg-white、border-gray-200");

      // 失败与重试:失败那次直接露出错误一句,重试标「第 2 次」
      const failed = s.locator("[data-testid=tool-group][data-failed]").first();
      await expect(failed.getByTestId("tool-group-failed")).toHaveText("1 次失败");
      await failed.getByTestId("tool-group-toggle").click();
      await expect(failed.getByTestId("tool-call-error")).toContainText("FAIL 输入框聚焦有可见描边");
      const retry = s.getByTestId("tool-group").last();
      await retry.getByTestId("tool-group-toggle").click();
      await expect(retry.locator("[data-testid=tool-call][data-attempt='2']")).toContainText("第 2 次");

      // 子代理:一行一个,展开看任务与结果
      const agent = s.getByTestId("agent-row").first();
      await expect(agent).toContainText("9 个调用");
      await agent.getByRole("button").click();
      await expect(agent.getByTestId("agent-detail")).toContainText("Settings.tsx");

      await expect(s.getByTestId("session-deliverables")).toContainText("本轮交付");
      await expect(s.getByTestId("session-changes")).toContainText("theme/tokens.css");
      await expect(s.getByTestId("session-statusline")).toContainText("3 轮");
      await expect(s.getByTestId("session-statusline")).not.toContainText("tok");
      // 只读:会话页里没有输入框;分屏底部是「回群里 @派活的联系人」
      await expect(page.getByTestId("split").getByRole("textbox")).toHaveCount(0);
      await expect(page.getByTestId("compute-readonly")).toContainText("这里只能看");
      await expect(page.getByTestId("compute-talk")).toHaveText("回群里 @Claude Code");
      await shot(page, `compute/${theme}-split-session`, 400);
    });

    test("「更多」菜单里也有「打开会话」;分屏已开在别的页签时也会切回「会话」;点整行默认就是会话页", async ({ page }) => {
      await go(page, "conv=g");
      await page.getByTestId("compute-line-login").click();
      await expect(page.getByTestId("cview-session")).toHaveAttribute("aria-selected", "true");
      await page.getByTestId("cview-activity").click();
      await expect(page.getByTestId("cview-activity")).toHaveAttribute("aria-selected", "true");
      await expect(session(page)).toHaveCount(0);

      await page.getByTestId("compute-line-login").hover();
      await page.getByTestId("more-g9c").click();
      await page.getByTestId("more-open-session-g9c").click();
      await expect(page.getByTestId("cview-session")).toHaveAttribute("aria-selected", "true");
      await expect(session(page)).toHaveAttribute("data-compute", "login");
    });

    test("键盘走得通:Tab 到「打开会话」按回车,分屏打开会话页", async ({ page }) => {
      await go(page, "conv=g");
      await page.getByTestId("open-session-keys").focus();
      await page.keyboard.press("Enter");
      await expect(session(page)).toHaveAttribute("data-compute", "keys");
      await expect(page.getByTestId("cview-session")).toHaveAttribute("aria-selected", "true");
    });

    test("Codex 会话:分屏标 Codex;子代理组汇总已回来/失败;私聊派的活只读条写「回私聊」", async ({ page }) => {
      await go(page, "split=compute:research");
      await expect(page.getByTestId("compute-harness")).toHaveText("Codex");
      const s = session(page);
      await expect(s.getByTestId("agent-group").first()).toContainText("4 个子代理 · 3 个已回来 · 失败 1");
      await expect(s.locator("[data-testid=agent-row][data-status=failed]")).toContainText("已失败");
      await shot(page, `compute/${theme}-split-codex`, 400);

      await go(page, "conv=dm-codex");
      await page.getByTestId("open-session-logs").click();
      await expect(page.getByTestId("compute-harness")).toHaveText("Codex");
      await expect(page.getByTestId("compute-talk")).toHaveText("回私聊 @Codex");
    });

    test("完整过程面板里是 Compute 卡:进行中标签、做了什么、步骤与后台任务;卡头「打开会话」进分屏会话页", async ({ page }) => {
      await go(page, "section=contacts&contact=claude&wb=process");
      const card = page.getByTestId("compute-card-login");
      await expect(card.getByTestId("compute-status")).toHaveText("进行中");
      await expect(card.getByTestId("compute-card-work")).toHaveText("改了 3 个文件，执行了 2 条命令");
      await expect(card.getByTestId("compute-card-steps")).toBeVisible();
      await expect(card.getByTestId("compute-card-background")).toContainText("pnpm dev");
      await expect(card.getByTestId("compute-card-alert")).toHaveCount(0);
      await shot(page, `compute/${theme}-process-card-running`);
      await card.getByTestId("compute-card-open-session").click();
      await expect(session(page)).toHaveAttribute("data-compute", "login");
      await expect(page.getByTestId("cview-session")).toHaveAttribute("aria-selected", "true");

      // 做完的卡默认收起,点头部展开
      await go(page, "section=contacts&contact=codex&wb=process");
      const done = page.getByTestId("compute-card-perf");
      await expect(done.getByTestId("compute-status")).toHaveText("已完成");
      await expect(done.getByTestId("compute-card-body")).toHaveCount(0);
      await done.getByTestId("compute-card-toggle").click();
      await expect(done.getByTestId("compute-card-toggle")).toHaveAttribute("aria-expanded", "true");
      await expect(done.getByTestId("compute-card-body")).toBeVisible();
    });

    test("完整过程面板里失败的卡:「出错了」+ 一条细线提示条(不是红底块),重试原地可点", async ({ page }) => {
      await go(page, "section=contacts&contact=grok&wb=process");
      const card = page.getByTestId("compute-card-scrape");
      await expect(card.getByTestId("compute-status")).toHaveText("出错了");
      await expect(card.getByTestId("compute-card-phase")).toHaveText("停在第 2/3 步");
      const alert = card.getByTestId("compute-card-alert");
      await expect(alert).toContainText("打开网页失败");
      await expect(alert).toContainText("网页打不开");
      const look = await alert.evaluate((el) => {
        const s = getComputedStyle(el);
        return { top: s.borderTopWidth, bg: s.backgroundColor };
      });
      expect(look.top).toBe("1px");
      expect(look.bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
      await expect(alert.getByTestId("compute-card-switch")).toBeVisible();
      await expect(alert.getByTestId("compute-card-skip")).toBeVisible();
      await shot(page, `compute/${theme}-process-card-error`);
      await alert.getByTestId("compute-card-retry").click();
      await expect(card.getByTestId("compute-status")).not.toHaveText("出错了");
      await expect(card.getByTestId("compute-card-alert")).toHaveCount(0);
    });

    test("停止照 mirasim(v3.20 §8.1 已定 16):停的过程中卡上写「正在停止…」,都确认退出才「已停止」并注明范围", async ({ page }) => {
      await page.clock.install();
      await go(page, "section=contacts&contact=claude&wb=process&split=compute:login");
      const card = page.getByTestId("compute-card-login");
      await expect(card.getByTestId("compute-status")).toHaveText("进行中");
      await expect(session(page)).toBeVisible();
      // 停住时间,好让「停止中」这一刻稳定可查、可截图(真实的确认退出要等一会儿)
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
      await page.getByTestId("compute-stop").click();
      await expect(card.getByTestId("compute-status")).toHaveText("正在停止…");
      await expect(card.getByTestId("compute-card-alert")).toContainText("等助手启动的程序及其子程序都确认退出");
      await expect(card.getByTestId("compute-card-background")).toContainText("正在关");
      await expect(session(page).getByTestId("session-statusline")).toContainText("正在停止…");
      await shot(page, `compute/${theme}-process-card-stopping`, 0);

      await page.clock.runFor(3000);
      await expect(card.getByTestId("compute-status")).toHaveText("已停止");
      await expect(card.getByTestId("compute-card-alert")).toContainText("只保证到助手启动的那些程序");
      const s = session(page);
      await expect(s.getByTestId("session-statusline")).toContainText("已停止 · 只保证到助手启动的那些程序");
      // 停下后记录里还标着在跑的那次测试显示成中断,不再转圈
      await page.clock.resume();
      const last = s.getByTestId("tool-group").last();
      await expect(last).toHaveAttribute("data-failed", "1");
      await last.getByTestId("tool-group-toggle").click();
      await expect(last.locator("[data-testid=tool-call][data-attempt='2']")).toHaveAttribute("data-status", "failed");
      await expect(last.getByTestId("tool-call-error")).toContainText("已中断");
      await expect(last.locator(".spin-ring")).toHaveCount(0);
      await shot(page, `compute/${theme}-process-card-stopped`, 400);
    });

    test("每个演示 Compute 在分屏里都能打开会话,对话流不空", async ({ page }) => {
      for (const id of IDS) {
        await go(page, `split=compute:${id}`);
        const s = session(page);
        await expect(s, id).toHaveAttribute("data-compute", id);
        await expect(s.getByTestId("session-prompt").first(), id).toBeVisible();
        await expect(s.getByTestId("tool-group").first(), id).toBeVisible();
      }
    });
  });
}
