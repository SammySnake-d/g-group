import { expect, type Locator, type Page, test } from "@playwright/test";

// 斜杠命令 + 引用条 + 输入框高度。全部用真实键盘、鼠标驱动,断言用户看得到的结果。
// 设了 GG_SHOTS_DIR 就顺手存走查截图(1440×900 @2x,见 playwright.config.ts 的 renderer 项目)。
const SHOTS = process.env.GG_SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

const open = async (page: Page, conv = "g") => {
  await page.goto(`/?freeze=1&conv=${conv}`);
  const input = page.getByTestId("composer");
  await input.click();
  return input;
};
const box = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error("元素不可见,拿不到位置");
  return b;
};
const item = (page: Page, name: string) => page.getByTestId(`slash-item-${name}`);

test("打 / 弹出命令菜单:贴着输入框上沿、左对齐;每行有 /名字、中文名、说明、来源;没挂的插件灰显写原因", async ({ page }) => {
  await open(page);
  await page.keyboard.type("/");
  const menu = page.getByTestId("slash-menu");
  await expect(menu).toBeVisible();
  // 旧「工具」页签的 8 项都在菜单里
  for (const n of ["summary", "playbook", "files", "workspace", "links", "pins", "pool", "clone"]) await expect(item(page, n)).toBeVisible();
  await expect(item(page, "summary")).toContainText("/summary");
  await expect(item(page, "summary")).toContainText("总结未读");
  await expect(item(page, "summary").getByTestId("slash-src")).toHaveText("内置");
  await expect(item(page, "feishu").getByTestId("slash-src")).toHaveText(/插件 · 飞书$/);
  await expect(item(page, "mail").getByTestId("slash-src")).toHaveText(/插件 · Gmail$/);
  await expect(item(page, "review").getByTestId("slash-src")).toHaveText(/助手 · Claude Code$/);
  // Webhook 装了但没挂在本群、Telegram 没装:灰显并说明原因
  await expect(item(page, "webhook").getByTestId("slash-disabled")).toHaveText("Webhook 没挂在这个会话");
  await expect(item(page, "telegram").getByTestId("slash-disabled")).toHaveText("Telegram 群 插件还没安装");
  // Grok 不在这个群,它的命令不出现
  await expect(item(page, "research")).toHaveCount(0);
  // 位置:菜单下沿贴着输入框上沿(间隔 6px),左边和输入框对齐
  const m = await box(menu);
  const b = await box(page.getByTestId("composer-box"));
  expect(Math.abs(m.y + m.height + 6 - b.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(m.x - b.x)).toBeLessThanOrEqual(1);
  await shot(page, "slash-menu");
});

test("私聊里只出私聊能用的命令:群命令不出现,私聊对象声明的命令出现", async ({ page }) => {
  await open(page, "dm-claude");
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await expect(item(page, "files")).toBeVisible();
  await expect(item(page, "review")).toBeVisible();
  for (const n of ["summary", "todo", "notice", "handoff", "pool"]) await expect(item(page, n)).toHaveCount(0);
});

test("继续打 sch 或 定时 过滤出 schedule;别名 ketchup 找到 summary;没有匹配时说没有这个命令", async ({ page }) => {
  const input = await open(page);
  await page.keyboard.type("/sch");
  const rows = page.getByTestId("slash-menu").getByRole("option");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-testid", "slash-item-schedule");
  await shot(page, "slash-filter");
  await input.fill("");
  await page.keyboard.type("/定时");
  await expect(rows.first()).toHaveAttribute("data-testid", "slash-item-schedule");
  await input.fill("");
  await page.keyboard.type("/ketc");
  await expect(rows.first()).toHaveAttribute("data-testid", "slash-item-summary");
  await expect(rows.first()).toContainText("/ketchup");
  await input.fill("");
  await page.keyboard.type("/zzz");
  await expect(page.getByTestId("slash-empty")).toHaveText("没有这个命令：/zzz");
});

test("↑↓ 和 Enter 选中 schedule 后输入框变成 /schedule ,高亮当前该填的参数,发送旁说明缺什么;填完能执行", async ({ page }) => {
  const input = await open(page);
  await page.keyboard.type("/s");
  const selected = page.locator('[data-testid="slash-menu"] [aria-selected="true"]');
  await expect(selected).toHaveAttribute("data-testid", "slash-item-summary");
  await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveAttribute("data-testid", "slash-item-schedule");
  await page.keyboard.press("ArrowUp");
  await expect(selected).toHaveAttribute("data-testid", "slash-item-summary");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("/schedule ");
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
  // 输入框里接着显示参数:何时高亮,做什么灰色
  await expect(page.getByTestId("slash-arg-何时")).toHaveAttribute("data-current", "1");
  await expect(page.getByTestId("slash-arg-做什么")).not.toHaveAttribute("data-current", "1");
  await expect(page.getByTestId("slash-hint")).toContainText("何时");
  await expect(page.getByTestId("slash-missing")).toHaveText("还差 何时、做什么");
  await expect(page.getByTestId("send")).toBeDisabled();
  await expect(page.getByTestId("send")).toHaveText("执行");
  // 参数提示紧跟在 "/schedule " 后面(同一行,左边不早于打的字)
  const ghost = await box(page.getByTestId("slash-arg-何时"));
  const ib = await box(input);
  expect(ghost.y).toBeLessThan(ib.y + 30);
  expect(ghost.x).toBeGreaterThan(ib.x + 60);
  await shot(page, "slash-args");
  await page.keyboard.type("每天9点 ");
  await expect(page.getByTestId("slash-arg-做什么")).toHaveAttribute("data-current", "1");
  await expect(page.getByTestId("slash-missing")).toHaveText("还差 做什么");
  // 必填没填时回车不执行
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("schedule-dialog")).toHaveCount(0);
  await expect(input).toHaveValue("/schedule 每天9点 ");
  await page.keyboard.type("写日报");
  await expect(page.getByTestId("slash-missing")).toHaveCount(0);
  await expect(page.getByTestId("send")).toBeEnabled();
  await page.keyboard.press("Enter");
  // 打开定时编辑,按参数预填
  const dlg = page.getByTestId("schedule-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId("cron-form-text")).toHaveValue("写日报");
  await expect(dlg.getByTestId("cron-form-time")).toHaveValue("09:00");
  await expect(dlg.getByTestId("cron-form-repeat")).toHaveValue("每天");
  await expect(input).toHaveValue("");
  await dlg.getByTestId("cron-form-who-claude").click();
  await dlg.getByTestId("cron-form-save").click();
  await expect(dlg).toHaveCount(0);
  await expect(page.getByText("你给 Claude Code 加了定时：每天 09:00「写日报」")).toBeVisible();
});

test("Esc 关掉菜单,再打字重新弹出;工具栏 / 按钮也能打开同一个菜单", async ({ page }) => {
  const input = await open(page);
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
  await expect(input).toHaveValue("/");
  await page.keyboard.type("f");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await input.fill("");
  await page.getByTestId("tool-slash").click();
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await expect(input).toHaveValue("/");
  await expect(input).toBeFocused();
  // 点选一样能用:点「群文件」打开群文件页
  await item(page, "files").click();
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("float")).toHaveAttribute("data-page", "files");
});

test("网址、路径、分数里的 / 不弹菜单", async ({ page }) => {
  const input = await open(page);
  await page.keyboard.type("看下 https://example.com/a/b");
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
  await input.fill("");
  await page.keyboard.type("进度 1/2");
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
  await input.fill("");
  await page.keyboard.type("打开 /tmp/a");
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
});

test("/todo 某事 回车后群清单里多出这一项", async ({ page }) => {
  const input = await open(page);
  await page.keyboard.type("/todo 买一台测试机");
  await expect(page.getByTestId("slash-hint")).toContainText("回车执行");
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("");
  await page.getByTestId("head-side").click();
  await page.getByTestId("side-tab-list").click();
  await expect(page.getByTestId("side-checklist")).toContainText("买一台测试机");
});

test("/summary 回车直接触发总结;/ketchup 是同一条命令", async ({ page }) => {
  const input = await open(page);
  await page.keyboard.type("/summary");
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("");
  await expect(page.locator('[data-testid^="summary-sm"]').first()).toContainText("你离开的这段时间");
  const before = await page.locator('[data-testid^="summary-sm"]').count();
  await page.keyboard.type("/ketchup ");
  await expect(page.getByTestId("slash-hint")).toContainText("/summary");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid^="summary-sm"]')).toHaveCount(before + 1);
});

test("插件命令:飞书打开勾选外部消息页;Gmail 如实说要等后端、草稿留着;没挂的插件手打也执行不了", async ({ page }) => {
  const input = await open(page);
  await page.keyboard.type("/feis");
  await expect(item(page, "feishu").getByTestId("slash-src")).toHaveText(/插件 · 飞书$/);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("float")).toHaveAttribute("data-page", "source");
  await expect(page.getByTestId("srcmsg-0")).toBeVisible();
  await page.getByTestId("float-close").click();
  await input.click();
  await input.fill("");
  await page.keyboard.type("/mail wang@team.com 周报见附件");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("toast")).toContainText("插件命令要等后端连接");
  await expect(input).toHaveValue("/mail wang@team.com 周报见附件");
  await input.fill("");
  await page.keyboard.type("/webhook 结果");
  await expect(page.getByTestId("slash-hint")).toContainText("Webhook 没挂在这个会话");
  await expect(page.getByTestId("send")).toBeDisabled();
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("/webhook 结果");
  await expect(page.locator("[data-msg]").getByText("/webhook 结果")).toHaveCount(0);
});

test("/handoff @助手 事:发出一条 @ 它的消息;@ 不在群里的人报错不发", async ({ page }) => {
  const input = await open(page);
  await page.keyboard.type("/handoff @Claude Code 把首页的骨架屏补上");
  await expect(page.getByTestId("slash-missing")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("");
  await expect(page.locator("[data-msg]").getByText("@Claude Code 把首页的骨架屏补上")).toBeVisible();
  await page.keyboard.type("/handoff @Grok 查资料");
  await expect(page.getByTestId("slash-error")).toHaveText("这里没有叫「Grok」的成员");
  await expect(page.getByTestId("send")).toBeDisabled();
});

test("引用条:卡片按内容收缩,× 紧挨引用文字;多条各占一行;空输入框 Backspace / Esc 去掉最后一条;切会话回来还在", async ({ page }) => {
  const input = await open(page);
  await page.getByText("我来记。写进了群协作手册的「交接」一节。").click({ button: "right" });
  await page.getByTestId("ctx-quote").click();
  const chips = page.getByTestId("quote-chip");
  await expect(chips).toHaveCount(1);
  const text = await box(chips.first().getByTestId("quote-text"));
  const x = await box(chips.first().getByTestId("quote-x"));
  const area = await box(page.getByTestId("composer-box"));
  const gap = x.x - (text.x + text.width);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(24);
  const truncated = await chips.first().getByTestId("quote-text").evaluate((el) => el.scrollWidth > el.clientWidth);
  if (!truncated) expect(area.x + area.width - (x.x + x.width)).toBeGreaterThan(40);
  // 第二条引用:各占一行
  await page.getByText("好，我分一个 Compute 去查。").click({ button: "right" });
  await page.getByTestId("ctx-quote").click();
  await expect(chips).toHaveCount(2);
  const a = await box(chips.nth(0));
  const b = await box(chips.nth(1));
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
  await input.hover();
  await shot(page, "quote-bar");
  // 切到别的会话再回来,引用还在
  await page.getByTestId("conv-dm-claude").click();
  await expect(chips).toHaveCount(0);
  await page.getByTestId("conv-g").click();
  await expect(chips).toHaveCount(2);
  // 空输入框:Backspace 去掉最后一条,Esc 再去掉一条
  await input.click();
  await expect(input).toHaveValue("");
  await page.keyboard.press("Backspace");
  await expect(chips).toHaveCount(1);
  await expect(chips.first().getByTestId("quote-text")).toHaveText("我来记。写进了群协作手册的「交接」一节。");
  await page.keyboard.press("Escape");
  await expect(chips).toHaveCount(0);
});

test("外部来源的引用挂在引用条上,标「不可信·外部」;入口是输入框左下角的 +", async ({ page }) => {
  await open(page);
  await page.getByTestId("tool-plus").click();
  await expect(page.getByTestId("plus-menu")).toBeVisible();
  // CVE 订阅只推提醒,没有可勾的消息
  await expect(page.getByTestId("plus-p-cve")).toBeDisabled();
  await page.getByTestId("plus-p-feishu").click();
  await page.getByTestId("srcmsg-0").click();
  await page.getByTestId("src-quote").click();
  const chip = page.getByTestId("quote-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip.getByTestId("quote-untrusted")).toHaveText("不可信·外部");
  await expect(chip.getByTestId("quote-text")).toHaveText("登录页能不能也支持深色？晚上用太刺眼了");
});

test("输入框高度自适应:空时一行(< 90px),多行变高,超过 8 行后在框里滚动", async ({ page }) => {
  const input = await open(page);
  const empty = await box(input);
  expect(empty.height).toBeLessThan(50);
  expect((await box(page.getByTestId("composer-box"))).height).toBeLessThan(90);
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+Enter");
  const four = await box(input);
  expect(four.height).toBeGreaterThan(empty.height * 2.5);
  for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+Enter");
  const capped = await box(input);
  expect(capped.height).toBeLessThan(empty.height * 6);
  expect(await input.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await input.fill("");
  await expect.poll(async () => (await box(input)).height).toBeLessThan(50);
});
