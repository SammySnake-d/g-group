import { expect, test } from "@playwright/test";
import { shot } from "./shots";

// #1005:Compute 卡重做 + 「打开会话」进到 harness(Claude Code / Codex)的原始对话窗口,只读。
// 走开发预览入口 ?preview=compute&id=<computeId>(src/components/compute/Preview.tsx),等接进消息流后再补全链路用例。

const IDS = ["login", "keys", "perf", "scrape", "logs", "feishu", "research", "review", "search", "weather"] as const;

for (const theme of ["light", "dark"] as const) {
  test.describe(`Compute 卡与 harness 会话 ${theme}`, () => {
    test.use({ colorScheme: theme });
    const open = (page: import("@playwright/test").Page, id: string) => page.goto(`/?preview=compute&id=${id}${theme === "dark" ? "&theme=dark" : ""}`);

    test("失败的卡:状态标签写「出错了」,下面一条细线提示条带重试;不是整块红底", async ({ page }) => {
      await open(page, "scrape");
      const card = page.getByTestId("compute-card-scrape");
      await expect(card.getByTestId("compute-status")).toHaveText("出错了");
      await expect(card.getByTestId("compute-status")).toHaveAttribute("data-state", "error");
      const alert = card.getByTestId("compute-card-alert");
      await expect(alert).toBeVisible();
      await expect(alert).toContainText("网页打不开");
      await expect(alert.getByTestId("compute-card-retry")).toBeVisible();
      // 细线提示条:顶边 1px,底色透明(不是红色大底块)
      const look = await alert.evaluate((el) => {
        const s = getComputedStyle(el);
        return { top: s.borderTopWidth, bg: s.backgroundColor };
      });
      expect(look.top).toBe("1px");
      expect(look.bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
      await page.getByTestId("compute-card-retry").click();
      await expect(page.getByTestId("preview-note")).toBeVisible();
      await shot(page, `compute/${theme}-card-error`);
    });

    test("在跑的卡:进行中标签、步骤和后台任务;做完的卡默认收起,点头部展开", async ({ page }) => {
      await open(page, "login");
      const card = page.getByTestId("compute-card-login");
      await expect(card.getByTestId("compute-status")).toHaveText("进行中");
      await expect(card.getByTestId("compute-card-steps")).toBeVisible();
      await expect(card.getByTestId("compute-card-work")).toHaveText("改了 3 个文件，执行了 2 条命令");
      await expect(card.getByTestId("compute-card-background")).toContainText("pnpm dev");
      await expect(card.getByTestId("compute-card-alert")).toHaveCount(0);
      await shot(page, `compute/${theme}-card-running`);

      await open(page, "perf");
      const done = page.getByTestId("compute-card-perf");
      await expect(done.getByTestId("compute-status")).toHaveText("已完成");
      await expect(done.getByTestId("compute-card-body")).toHaveCount(0);
      await done.getByTestId("compute-card-toggle").click();
      await expect(done.getByTestId("compute-card-body")).toBeVisible();
      await expect(done.getByTestId("compute-card-toggle")).toHaveAttribute("aria-expanded", "true");
    });

    test("打开会话:窗口出现,工具组默认收起写「N 个调用」,展开看到每次调用,再点开看输入与输出;只读条在、没有输入框", async ({ page }) => {
      await open(page, "login");
      await expect(page.getByTestId("harness-session")).toHaveCount(0);
      await page.getByTestId("compute-card-open-session").click();
      const s = page.getByTestId("harness-session");
      await expect(s).toBeVisible();
      await expect(s.getByTestId("session-harness")).toHaveText("Claude Code");
      await expect(s.getByTestId("session-title")).toHaveText("登录页改成深色主题，补上测试");
      await expect(s.getByTestId("session-crumbs")).toContainText("模型助手群聊");
      await expect(s.getByTestId("session-prompt").first()).toContainText("AC-24");

      const group = s.getByTestId("tool-group").first();
      await expect(group.getByTestId("tool-group-count")).toHaveText("3 个调用");
      await expect(group.getByTestId("tool-group-toggle")).toHaveAttribute("aria-expanded", "false");
      await expect(group.getByTestId("tool-group-calls")).toHaveCount(0);
      await shot(page, `compute/${theme}-session-collapsed`);

      await group.getByTestId("tool-group-toggle").click();
      const calls = group.getByTestId("tool-group-calls");
      await expect(calls).toBeVisible();
      await expect(calls.getByTestId("tool-call")).toHaveCount(3);
      await expect(calls).toContainText("pages/Login.tsx");
      await expect(calls).toContainText("120 行");
      await calls.getByTestId("tool-call").first().getByRole("button").click();
      const detail = calls.getByTestId("tool-call-detail").first();
      await expect(detail).toContainText("输入");
      await expect(detail).toContainText("输出");
      await expect(detail).toContainText("bg-white、border-gray-200");

      // 失败与重试:失败的那次直接露出错误一句,重试标「第 2 次」
      const failedGroup = s.locator("[data-testid=tool-group][data-failed]").first();
      await expect(failedGroup.getByTestId("tool-group-failed")).toHaveText("1 次失败");
      await failedGroup.getByTestId("tool-group-toggle").click();
      await expect(failedGroup.getByTestId("tool-call-error")).toContainText("FAIL 输入框聚焦有可见描边");
      const retryGroup = s.getByTestId("tool-group").last();
      await retryGroup.getByTestId("tool-group-toggle").click();
      await expect(retryGroup.locator("[data-testid=tool-call][data-attempt='2']")).toContainText("第 2 次");

      // 子代理:一行一个,展开看任务与结果
      const agent = s.getByTestId("agent-row").first();
      await expect(agent).toContainText("9 个调用");
      await agent.getByRole("button").click();
      await expect(agent.getByTestId("agent-detail")).toContainText("Settings.tsx");

      await expect(s.getByTestId("session-deliverables")).toContainText("本轮交付");
      await expect(s.getByTestId("session-changes")).toContainText("theme/tokens.css");
      await expect(s.getByTestId("session-statusline")).toContainText("3 轮");
      await expect(s.getByTestId("session-statusline")).not.toContainText("tok");
      const ro = s.getByTestId("session-readonly");
      await expect(ro).toContainText("Compute 只读");
      await expect(ro.getByTestId("session-talk")).toHaveText("回群里 @Claude Code");
      await expect(s.getByRole("textbox")).toHaveCount(0);
      await shot(page, `compute/${theme}-session-expanded`, 400);

      await s.getByTestId("session-close").click();
      await expect(page.getByTestId("harness-session")).toHaveCount(0);

      // 键盘走得通:打开后焦点进窗口,Esc 关掉
      await page.getByTestId("compute-card-open-session").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("harness-session")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("harness-session")).toHaveCount(0);
    });

    test("Codex 会话:标签写 Codex;子代理组汇总进行中/已回来/失败;私聊派的活只读条写「回私聊」", async ({ page }) => {
      await open(page, "research");
      await page.getByTestId("compute-card-open-session").click();
      const s = page.getByTestId("harness-session");
      await expect(s.getByTestId("session-harness")).toHaveText("Codex");
      await expect(s.getByTestId("agent-group").first()).toContainText("4 个子代理 · 3 个已回来 · 失败 1");
      await expect(s.locator("[data-testid=agent-row][data-status=failed]")).toContainText("已失败");
      await shot(page, `compute/${theme}-session-codex`, 400);

      await open(page, "logs");
      await page.getByTestId("compute-card-open-session").click();
      await expect(page.getByTestId("session-talk")).toHaveText("回私聊 @Codex");
    });

    test("每个演示 Compute 都能打开会话,对话流不空", async ({ page }) => {
      for (const id of IDS) {
        await open(page, id);
        await page.getByTestId("compute-card-open-session").click();
        const s = page.getByTestId("harness-session");
        await expect(s, id).toHaveAttribute("data-compute", id);
        await expect(s.getByTestId("session-prompt").first(), id).toBeVisible();
        await expect(s.getByTestId("tool-group").first(), id).toBeVisible();
      }
    });
  });
}
