import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { shot } from "./shots";

// 最小闭环(真实路径,只经界面):Electron 主进程里起宿主服务(GG_BACKEND=server,规则替身脑子 + 剧本 Compute),
// 全程只点界面、只读界面,不调 window.gg——
//   建联系人 → 私聊发「帮我写 hello.txt」→ 联系人回复 → Compute 从开始到完成 → 交付消息;
//   再建群、把联系人拉进群,群里 @ 它派活 → 同样的推进。
// 连上后端时界面只显示后端数据:演示联系人、演示群一个都不能出现。
const appDir = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "ELECTRON_RUN_AS_NODE" && typeof e[1] === "string"));
/** 演示数据里才有的名字(data.ts 的演示联系人与演示群);真实闭环里永远不会出现 */
const DEMO_NAMES = ["模型助手群聊", "Argon", "Astra", "Grok", "王一"];
const LONG = { timeout: 30_000 };

async function noDemoData(win: Page) {
  for (const name of DEMO_NAMES) await expect(win.getByText(name, { exact: false }), `不该出现演示数据「${name}」`).toHaveCount(0);
}

/** 通讯录 → 添加联系人 → 填名字 → 添加;连上后端时建好就进它的私聊 */
async function addContact(win: Page, name: string) {
  await win.getByTestId("nav-contacts").click();
  await win.getByTestId("list").getByText("添加联系人", { exact: true }).click();
  await win.getByPlaceholder("比如：设计师").fill(name);
  await win.getByRole("button", { name: "添加", exact: true }).click();
  await expect(win.getByTestId("chat").locator("header")).toContainText(name, LONG);
}

const rows = (win: Page) => win.getByTestId("chat-column").locator("[data-msg]");

test("闭环:只经界面建联系人、私聊派活、建群拉人后群里派活,看到回复、Compute 推进与交付", async () => {
  // 两轮派活各要等剧本 Compute 走完(每步 300ms)和联系人两三轮回话;云电脑 2 核,给足整体时间,单步等待仍各自 30 秒封顶
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-loop-"));
  const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...env, GG_BACKEND: "server", GG_DATA_DIR: dataDir, GG_MIND: "fake", GG_COMPUTE: "fake" } });
  const errors: string[] = [];
  try {
    const win = await app.firstWindow();
    win.on("pageerror", (e) => errors.push(e.message));
    await win.waitForLoadState("domcontentloaded");

    await test.step("连上后端:左下角标记写明已连接,各类数据都读到了", async () => {
      const mark = win.getByTestId("backend-demo");
      await expect(mark).toHaveAttribute("data-mode", "connected", LONG);
      await expect(mark).toHaveAttribute("data-wire", "live", LONG);
      await expect(mark).toHaveAttribute("data-failed", "0");
      await expect(mark).toHaveText("已连接");
    });

    await test.step("连上后端时没有演示数据:会话列表、聊天区、通讯录都是空的,聊天区给出添加联系人的入口", async () => {
      await expect(win.getByTestId("chat-empty")).toBeVisible();
      await expect(win.getByTestId("chat-empty").getByRole("button", { name: "添加联系人" })).toBeVisible();
      await noDemoData(win);
      await win.getByTestId("nav-contacts").click();
      await noDemoData(win);
      await expect(win.getByTestId("list").locator('[data-testid^="contact-"]')).toHaveCount(0);
    });

    await test.step("建联系人:通讯录里出现,并打开和它的私聊", async () => {
      await addContact(win, "小克");
      await win.getByTestId("nav-contacts").click();
      await expect(win.getByTestId("list").locator('[data-testid^="contact-"]').filter({ hasText: "小克" })).toHaveCount(1);
      await win.getByTestId("nav-chat").click();
      await expect(win.getByTestId("list").locator('[data-testid^="conv-dm-"]').filter({ hasText: "小克" })).toHaveCount(1);
    });

    await test.step("私聊派活:发「帮我写 hello.txt」,联系人真实回复", async () => {
      await win.getByTestId("list").locator('[data-testid^="conv-dm-"]').filter({ hasText: "小克" }).click();
      const box = win.getByTestId("composer");
      await box.fill("帮我写 hello.txt");
      await box.press("Enter");
      await expect(rows(win).filter({ hasText: "好的,我安排 Compute 去写 hello.txt" })).toHaveCount(1, LONG);
    });

    await test.step("私聊里 Compute 从开始到完成,随后联系人交付", async () => {
      const line = win.getByTestId("chat-column").locator('[data-testid^="compute-line-"]').filter({ hasText: "写 hello.txt" });
      await expect(line).toHaveCount(1, LONG);
      await expect(line).toHaveAttribute("data-state", "done", LONG);
      // 照设计:Compute 是联系人派出去的执行者——挂在联系人「接了任务」那句下面;这一行只写标题、谁在干(harness)、阶段,
      // 不搬 Compute 自己的原话(它不在聊天里说话,原话在点开后的过程里)
      await expect(rows(win).filter({ hasText: "接了任务:写 hello.txt" }).and(win.locator('[data-msg]:not([data-from="me"])'))).toHaveCount(1);
      await expect(line).toContainText("做完了");
      await expect(line).not.toContainText("完成:写");
      // 做完、交付之后(#1790 消息优先):Compute 那一行挂在联系人的交付消息下面,不再单独占一行
      // (在跑时挂在「接了任务」那句下面、不另起头像,见 parity-compute 的停止用例)
      await expect(rows(win).filter({ hasText: "做完了:完成:写 hello.txt" }).locator('[data-testid^="trail-"] [data-testid^="compute-line-"]')).toHaveCount(1, LONG);
      await expect(win.locator('[data-msg$="~c"]').filter({ hasText: "写 hello.txt" })).toHaveCount(0);
      // 替身 Compute 按派的活说话:联系人转述的进度是这件事本身
      await expect(rows(win).filter({ hasText: "进度:正在写 hello.txt" })).toHaveCount(1, LONG);
      await expect(rows(win).filter({ hasText: "做完了:完成:写 hello.txt" })).toHaveCount(1, LONG);
      // 自己发的那条:乐观显示的和事件推来的是同一条,不重复
      const mine = rows(win).filter({ hasText: "帮我写 hello.txt" }).and(win.locator('[data-from="me"]'));
      await expect(mine).toHaveCount(1);
      // 联系人接走即已读(宿主推的 receipt.updated):回执显示它读了,后面的会话更新不把它冲掉
      await expect(mine.locator("[data-read]")).toHaveAttribute("data-unread", "0");
      await shot(win, "dm-compute-done");
      // 点开看过程:开始 → 进展 → 完成,都来自后端的进度事件
      await line.click();
      await win.getByTestId("cview-activity").click();
      const acts = win.getByTestId("activity");
      await expect(acts).toContainText("已开始");
      await expect(acts).toContainText("动手 · 正在写 hello.txt");
      await expect(acts).toContainText("完成:写 hello.txt");
      await shot(win, "dm-compute-activity");
      await win.keyboard.press("Escape");
    });

    await test.step("建群:再建两位联系人,发起群聊选上小克和小林", async () => {
      await addContact(win, "小林");
      await addContact(win, "小美");
      await win.getByTestId("nav-contacts").click();
      await win.getByTestId("list").getByText("发起群聊", { exact: true }).click();
      await win.getByLabel("群名").fill("闭环群");
      for (const n of ["小克", "小林"]) await win.locator("label").filter({ hasText: n }).getByRole("checkbox").click();
      await win.getByRole("button", { name: "创建群聊（3 人）" }).click();
      await expect(win.getByTestId("chat-title")).toContainText("闭环群", LONG);
      await expect(win.getByTestId("list").locator('[data-testid^="conv-g-"]').filter({ hasText: "闭环群" })).toHaveCount(1);
    });

    await test.step("拉人:把小美的私聊拖进群成员,成员里出现小美", async () => {
      await win.getByTestId("chat-title").click();
      const drop = win.getByTestId("side-members-drop");
      await expect(drop).toBeVisible();
      await win.getByTestId("list").locator('[data-testid^="conv-dm-"]').filter({ hasText: "小美" }).dragTo(drop);
      await expect(drop.locator('[data-testid^="side-member-"]').filter({ hasText: "小美" })).toHaveCount(1, LONG);
      await expect(win.getByTestId("chat-title")).toContainText("(4)");
    });

    await test.step("群里 @小克 派活:回复、Compute 推进到完成、交付", async () => {
      const box = win.getByTestId("composer");
      await box.fill("帮我写 group.txt @小克");
      await box.press("Enter"); // 选人菜单开着:回车选中小克
      await expect(box).toHaveValue("帮我写 group.txt @小克 ");
      await box.press("Enter");
      await expect(rows(win).filter({ hasText: "好的,我安排 Compute 去写 group.txt" })).toHaveCount(1, LONG);
      const line = win.getByTestId("chat-column").locator('[data-testid^="compute-line-"]').filter({ hasText: "写 group.txt" });
      await expect(line).toHaveCount(1, LONG);
      await expect(line).toHaveAttribute("data-state", "done", LONG);
      await expect(rows(win).filter({ hasText: "进度:正在写 group.txt" })).toHaveCount(1, LONG);
      await expect(rows(win).filter({ hasText: "做完了:完成:写 group.txt" })).toHaveCount(1, LONG);
      // 没被 @ 的小林、小美不接这件事
      await expect(win.getByTestId("chat-column").locator('[data-testid^="compute-line-"]')).toHaveCount(1);
      await shot(win, "group-compute-done");
    });

    await test.step("全程没有演示数据,各区域切过去不报错", async () => {
      await noDemoData(win);
      for (const k of ["contacts", "files", "plugins", "chat"]) await win.getByTestId(`nav-${k}`).click();
      await win.getByTestId("nav-activity").click();
      await win.keyboard.press("Escape");
      await expect(win.getByTestId("rail")).toBeVisible();
      expect(errors, "页面不该抛错").toEqual([]);
    });
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
