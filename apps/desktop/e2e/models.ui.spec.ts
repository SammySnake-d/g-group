import { expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// 模型配置(需求 D07.4 规则 1/2/5/6、U93、U92;验收 R-17、AC-32、AC-51)。全部用真实点击、下拉选择、键盘输入驱动,断言用户看得到的结果。
// 演示数据:Claude Code 说话 claude-opus-5-5、Compute 跟随说话模型、effort xhigh、Harness Claude Code,手上 3 个在跑的任务;
// Argon 的 Compute 单独指定 claude-opus-5-5;Astra 在 Codex 上继承全局;全局默认 Compute 模型 claude-sonnet-5-5、effort high。
// 目录:claude-opus-5-5 只能在 Claude Code 上跑,gpt-6 只能在 Codex 上跑,gemini-flash 只能用来说话。

const contactSettings = async (page: Page, id = "claude") => {
  await page.goto(`/?freeze=1&section=contacts&contact=${id}&wb=settings`);
  await expect(page.getByTestId("cm-card")).toBeVisible();
};
const openSettings = async (page: Page) => {
  await page.goto("/?freeze=1");
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("model-defaults")).toBeVisible();
};

test("联系人 Compute 槽位切换三态:生效值和继承链跟着变", async ({ page }) => {
  await contactSettings(page);
  const summary = page.getByTestId("cm-summary");
  const chain = page.getByTestId("chain-model");
  await expect(summary).toHaveText("Compute → 跟随说话模型 → claude-opus-5-5 · claude-code · xhigh");
  await expect(chain).toHaveText(/跟随说话模型.*联系人说话模型.*claude-opus-5-5/);
  await expect(page.getByTestId("chain-harness")).toHaveText(/联系人 Compute Harness.*claude-code/);
  await expect(page.getByTestId("cm-effective-title")).toHaveText("按现在的配置，下一轮会用");

  await page.getByTestId("cm-mode-inherit").click();
  await expect(page.getByTestId("cm-mode-inherit")).toHaveAttribute("aria-checked", "true");
  await expect(summary).toHaveText("Compute → 继承全局 → claude-sonnet-5-5 · claude-code · xhigh");
  await expect(chain).toHaveText(/继承全局.*全局默认 Compute 模型.*claude-sonnet-5-5/);
  await expect(page.getByTestId("cm-effective-title")).toHaveText("保存后，下一轮会用");

  // effort 改成跟全局:链变成「联系人没单独设 → 全局默认 effort high」
  await page.getByTestId("cm-effort").selectOption("");
  await expect(summary).toHaveText("Compute → 继承全局 → claude-sonnet-5-5 · claude-code · high");
  await expect(page.getByTestId("chain-effort")).toHaveText(/联系人没单独设.*全局默认 effort.*high/);

  // 单独指定:先带上当前生效的模型,不凭空换;再选 gpt-6.1
  await page.getByTestId("cm-mode-explicit").click();
  await expect(page.getByTestId("cm-model")).toHaveValue("claude-sonnet-5-5");
  await expect(summary).toHaveText("Compute → 单独指定 → claude-sonnet-5-5 · claude-code · high");
  await page.getByTestId("cm-model").selectOption("gpt-6.1");
  await expect(summary).toHaveText("Compute → 单独指定 → gpt-6.1 · claude-code · high");
  await expect(chain).toHaveText(/单独指定.*联系人单独指定的模型.*gpt-6\.1/);

  // 再切回跟随说话模型,链又回到说话模型
  await page.getByTestId("cm-mode-follow-speaking").click();
  await expect(summary).toHaveText("Compute → 跟随说话模型 → claude-opus-5-5 · claude-code · high");
  await expect(page.getByTestId("cm-save")).toBeEnabled();
  await page.getByTestId("cm-revert").click();
  await expect(summary).toHaveText("Compute → 跟随说话模型 → claude-opus-5-5 · claude-code · xhigh");
  await expect(page.getByTestId("cm-save")).toHaveCount(0);
});

test("选了 Harness 跑不了的模型:就地阻断、给两条修复路径、保存不可用;点「单独指定兼容模型」后恢复可保存", async ({ page }) => {
  await contactSettings(page);
  await page.getByTestId("cm-mode-explicit").click();
  await page.getByTestId("cm-model").selectOption("gpt-6");
  const box = page.getByTestId("cm-mismatch");
  await expect(box).toBeVisible();
  await expect(page.getByTestId("cm-mismatch-text")).toHaveText("Claude Code 这个 Harness 跑不了 GPT-6，不会自动换成别的模型。选一条修好再保存：");
  // 生效值原样显示 gpt-6,没被偷偷换掉;联系人说话不受影响
  await expect(page.getByTestId("cm-summary")).toHaveText("Compute → 单独指定 → gpt-6 · claude-code · xhigh");
  await expect(page.getByTestId("cm-blocked")).toHaveText("这样配，下次开 Compute 会被拦下；Claude Code 在群里说话不受影响。");
  await expect(page.getByTestId("cm-save")).toBeDisabled();
  await expect(page.getByTestId("cm-save-hint")).toHaveText("模型和 Harness 对不上，修好才能保存");
  // 两条路:单独指定兼容模型(候选是 Claude Code 能跑的,默认保持原来的 claude-opus-5-5),或换成能跑 gpt-6 的 Codex
  await expect(page.getByTestId("cm-mismatch-pin-model")).toHaveValue("claude-opus-5-5");
  const options = await page.getByTestId("cm-mismatch-pin-model").locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(options).toEqual(["gpt-6.1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gemini-4", "grok-5", "deepseek-v4"]);
  await expect(page.getByTestId("cm-mismatch-harness")).toHaveText("换 Harness 为 Codex");
  await shot(page, "models-mismatch");

  await page.getByTestId("cm-mismatch-pin-model").selectOption("gpt-6.1");
  await page.getByTestId("cm-mismatch-pin").click();
  await expect(box).toHaveCount(0);
  await expect(page.getByTestId("cm-model")).toHaveValue("gpt-6.1");
  await expect(page.getByTestId("cm-summary")).toHaveText("Compute → 单独指定 → gpt-6.1 · claude-code · xhigh");
  await expect(page.getByTestId("cm-save")).toBeEnabled();

  // 另一条路:换 Harness
  await page.getByTestId("cm-model").selectOption("gpt-6");
  await expect(page.getByTestId("cm-save")).toBeDisabled();
  await page.getByTestId("cm-mismatch-harness").click();
  await expect(page.getByTestId("cm-harness")).toHaveValue("codex");
  await expect(page.getByTestId("cm-summary")).toHaveText("Compute → 单独指定 → gpt-6 · codex · xhigh");
  await expect(page.getByTestId("cm-mismatch")).toHaveCount(0);
  await expect(page.getByTestId("cm-save")).toBeEnabled();
});

test("改上游的说话模型:跟随它的 Compute 同样拦下;只能用来说话的模型没有可换的 Harness,只给一条路", async ({ page }) => {
  await contactSettings(page);
  await page.getByTestId("cm-talk").selectOption("gemini-flash");
  await expect(page.getByTestId("cm-speaking-summary")).toHaveText("说话 → gemini-flash");
  await expect(page.getByTestId("cm-mismatch-text")).toHaveText("Claude Code 这个 Harness 跑不了 Gemini Flash，不会自动换成别的模型。选一条修好再保存：");
  await expect(page.getByTestId("cm-mismatch-noharness")).toHaveText("没有 Harness 能跑 Gemini Flash（它只能用来说话）");
  await expect(page.getByTestId("cm-mismatch-harness")).toHaveCount(0);
  await expect(page.getByTestId("cm-save")).toBeDisabled();
  await page.getByTestId("cm-mismatch-pin").click();
  // 修法是把 Compute 单独指定成兼容模型(默认保持原来的 claude-opus-5-5),说话照样用 gemini-flash
  await expect(page.getByTestId("cm-summary")).toHaveText("Compute → 单独指定 → claude-opus-5-5 · claude-code · xhigh");
  await expect(page.getByTestId("cm-speaking-summary")).toHaveText("说话 → gemini-flash");
  await expect(page.getByTestId("cm-save")).toBeEnabled();
});

test("改模型保存后提示「下一轮生效、正在跑的这一轮不打断」,私聊里留记录;换 Harness 另外说明", async ({ page }) => {
  await contactSettings(page);
  await page.getByTestId("cm-talk").selectOption("gpt-6.1");
  await page.getByTestId("cm-save").click();
  const note = page.getByTestId("next-turn");
  await expect(note).toContainText("已保存，下一轮生效，不用再手动切。");
  await expect(note).toContainText("Claude Code 下一次说话用 gpt-6.1");
  await expect(note).toContainText("Compute 下一次输入用 gpt-6.1 · claude-code · xhigh");
  await expect(note).toContainText("正在跑的 3 个任务这一轮不打断，按启动时的 Claude Opus 5.5 · Claude Code 跑完。");
  // 在跑的任务仍显示启动时的快照,另注明下一轮起用新模型
  await expect(page.getByTestId("cm-running-login")).toHaveText("「登录页深色」Claude Opus 5.5 · Claude Code");
  await expect(page.getByTestId("cm-running-next")).toHaveText("这 3 个任务这一轮照常跑完，下一轮起用 gpt-6.1 · claude-code");
  await expect(page.getByTestId("cm-summary")).toHaveText("Compute → 跟随说话模型 → gpt-6.1 · claude-code · xhigh");

  await page.getByTestId("cm-harness").selectOption("codex");
  await expect(note).toHaveCount(0);
  await page.getByTestId("cm-save").click();
  await expect(note).toContainText("换了 Harness：下一轮在 Codex 上开新会话，之前的任务和约束由软件带过去。");
  await shot(page, "models-contact");

  await page.getByTestId("wb-dm").click();
  await expect(page.getByText("你改了 Claude Code 的设置：说话模型 claude-opus-5-5 → gpt-6.1，下一轮生效")).toBeVisible();
  await expect(page.getByText("你改了 Claude Code 的设置：Compute Harness Claude Code → Codex，下一轮生效")).toBeVisible();
});

test("卡死阈值放在高级里:默认 15 分钟 / 120 秒,可以按联系人单独设,不合理的数不能保存", async ({ page }) => {
  await contactSettings(page);
  const adv = page.getByTestId("cm-adv");
  await expect(adv).toContainText("一轮 15 分钟无进展判失败 · 首字节等 120 秒（默认）");
  await adv.click();
  await page.getByTestId("stall-own").click();
  await expect(page.getByTestId("stall-turn")).toHaveValue("15");
  await expect(page.getByTestId("stall-first")).toHaveValue("120");
  await page.getByTestId("stall-turn").fill("1");
  await expect(page.getByTestId("stall-error")).toHaveText("等首字节的时间要短于整轮阈值(1 分钟 = 60 秒)");
  await expect(page.getByTestId("cm-save")).toBeDisabled();
  await page.getByTestId("stall-turn").fill("30");
  await expect(page.getByTestId("stall-error")).toHaveCount(0);
  await page.getByTestId("cm-save").click();
  await expect(adv).toContainText("一轮 30 分钟无进展判失败 · 首字节等 120 秒（单独设）");
});

test("全局默认改 Compute 模型:先显示会影响几位联系人和失配,修好才能保存;保存后继承者用新值", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("def-compute").selectOption("grok-5");
  await expect(page.getByTestId("impact-count")).toHaveText("会影响 3 位联系人");
  for (const id of ["astra", "grok", "gemini"]) await expect(page.getByTestId(`impact-row-${id}`)).toContainText("claude-sonnet-5-5 → grok-5");
  await expect(page.getByTestId("impact-row-claude")).toHaveCount(0);
  await expect(page.getByTestId("impact-mismatch-astra")).toContainText("Astra 用 Codex，Codex 这个 Harness 跑不了 Grok 5。不会自动换");
  await expect(page.getByTestId("impact-mismatch-grok")).toHaveCount(0);
  await expect(page.getByTestId("defaults-save")).toBeDisabled();
  await expect(page.getByTestId("dfix-pin-astra")).toHaveText("单独指定 Claude Sonnet 5.5（保持原来的）");
  await expect(page.getByTestId("dfix-harness-astra")).toHaveText("换 Harness 为 Claude Code");
  await shot(page, "models-settings");

  await page.getByTestId("dfix-pin-astra").click();
  await expect(page.getByTestId("impact-count")).toHaveText("会影响 2 位联系人");
  await expect(page.getByTestId("defaults-fixes")).toContainText("Astra：单独指定 Claude Sonnet 5.5");
  await page.getByTestId("defaults-save").click();
  await expect(page.getByTestId("defaults-saved")).toHaveText("已保存。受影响的 2 位联系人下一轮生效，正在跑的这一轮不打断。");
  await expect(page.getByTestId("model-row-compute-grok")).toHaveText("Compute grok-5 · claude-code");
  await expect(page.getByTestId("model-row-compute-astra")).toHaveText("Compute claude-sonnet-5-5 · codex");
  await expect(page.getByTestId("model-row-astra")).toContainText("（单独指定）");

  // 去 Astra 的工作台看:单独指定了原来的模型,Harness 没动
  await page.getByTestId("model-row-astra").click();
  await expect(page.getByTestId("cm-summary")).toHaveText("Compute → 单独指定 → claude-sonnet-5-5 · codex · high");
});

test("默认 Harness 和默认 Compute 模型组合不成立时不能保存;只改默认说话模型说明只影响新建联系人", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("def-compute").selectOption("claude-opus-5-5");
  await page.getByTestId("def-harness").selectOption("codex");
  await expect(page.getByTestId("defaults-combo-text")).toHaveText("Codex 这个 Harness 跑不了 Claude Opus 5.5，不会自动换成别的模型。选一条修好再保存：");
  await expect(page.getByTestId("defaults-save")).toBeDisabled();
  await page.getByTestId("defaults-combo-harness").click();
  await expect(page.getByTestId("def-harness")).toHaveValue("claude-code");
  await expect(page.getByTestId("defaults-combo")).toHaveCount(0);
  await page.getByTestId("defaults-cancel").click();
  await page.getByTestId("def-talk").selectOption("gpt-6.1");
  await expect(page.getByTestId("impact-count")).toHaveText("已有的联系人都不受影响");
  await expect(page.getByTestId("impact-new-only")).toHaveText("默认说话模型只用于之后新建的联系人，已有联系人各自存了自己的。");
  await expect(page.getByTestId("defaults-save")).toBeEnabled();
});

test("批量替换:预览三栏条目正确,冲突处理完才能确认;确认后联系人列表更新,在途任务按启动快照跑完", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("open-batch").click();
  const dlg = page.getByTestId("batch-dialog");
  await expect(dlg).toBeVisible();
  // Esc 只关对话框,设置页还在
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(page.getByTestId("model-defaults")).toBeVisible();
  await page.getByTestId("open-batch").click();
  await expect(dlg).toBeVisible();
  await expect(page.getByTestId("br-from")).toHaveValue("claude-opus-5-5");
  await page.getByTestId("br-to").selectOption("gpt-6");

  await expect(page.getByTestId("br-explicit-n")).toHaveText("2");
  await expect(page.getByTestId("br-ref-claude-speakingModel")).toContainText("Claude Code · 说话模型");
  await expect(page.getByTestId("br-ref-argon-computeModel.model")).toContainText("Argon · Compute（单独指定）");
  await expect(page.getByTestId("br-inheritors-n")).toHaveText("1");
  await expect(page.getByTestId("br-inh-claude")).toContainText("Claude Code · Compute（跟随说话模型）");
  await expect(page.getByTestId("br-conflicts-n")).toHaveText("2");
  await expect(page.getByTestId("br-conflict-claude")).toContainText("Claude Code 这个 Harness 跑不了 GPT-6");
  await expect(page.getByTestId("br-conflict-argon")).toContainText("Argon");
  await expect(page.getByTestId("br-inflight")).toHaveText("在途 3 个任务（「登录页深色」、「快捷键」、「搜索跳转」）按启动时的 claude-opus-5-5 跑完，快照和历史不改。");
  await expect(page.getByTestId("br-confirm")).toBeDisabled();
  await expect(page.getByTestId("br-why")).toHaveText("还有 2 处冲突，先选怎么处理");
  await shot(page, "models-batch");

  await page.getByTestId("br-harness-claude").click();
  await expect(page.getByTestId("br-resolved-claude")).toContainText("换 Harness 为 Codex");
  await expect(page.getByTestId("br-confirm")).toBeDisabled();
  await page.getByTestId("br-keep-argon").click();
  await expect(page.getByTestId("br-resolved-argon")).toContainText("保留 Claude Opus 5.5（单独指定）");
  await expect(page.getByTestId("br-conflicts-n")).toHaveText("0");
  await expect(page.getByTestId("br-confirm")).toBeEnabled();
  await page.getByTestId("br-confirm").click();
  await expect(dlg).toHaveCount(0);

  // 设置页还开着;各联系人在用的模型已更新,固定在 claude-opus-5-5 的 Argon 没被改
  await expect(page.getByTestId("model-row-talk-claude")).toHaveText("说话 gpt-6");
  await expect(page.getByTestId("model-row-compute-claude")).toHaveText("Compute gpt-6 · codex");
  await expect(page.getByTestId("model-row-compute-argon")).toHaveText("Compute claude-opus-5-5 · claude-code");

  // 工作台里:配置是新值,在跑的任务仍显示启动时的 Claude Opus 5.5
  await page.getByTestId("model-row-claude").click();
  await expect(page.getByTestId("cm-summary")).toHaveText("Compute → 跟随说话模型 → gpt-6 · codex · xhigh");
  await expect(page.getByTestId("cm-running-login")).toHaveText("「登录页深色」Claude Opus 5.5 · Claude Code");
  await expect(page.getByTestId("cm-running-next")).toHaveText("这 3 个任务这一轮照常跑完，下一轮起用 gpt-6 · codex");
});

test("模型只在两处配:资料页只显示、点了去工作台设置;添加联系人不选模型,用全局默认", async ({ page }) => {
  await page.goto("/?freeze=1&conv=dm-claude");
  await page.getByTestId("chat-more").click();
  await expect(page.getByTestId("person-model")).toContainText("Claude Opus 5.5 · Compute 跟随说话模型");
  await expect(page.locator('[data-testid="float"] select')).toHaveCount(0);
  await page.getByTestId("person-model").click();
  await expect(page.getByTestId("wb-tab-settings")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("cm-card")).toBeVisible();

  await page.getByRole("button", { name: "添加联系人" }).first().click();
  await expect(page.getByTestId("add-model-note")).toHaveText("说话用全局默认的 Claude Sonnet 5.5，Compute 继承全局（Claude Sonnet 5.5）。加好以后在它的工作台「设置」里改。");
  await expect(page.locator('[data-testid="float"] select')).toHaveCount(0);
});
