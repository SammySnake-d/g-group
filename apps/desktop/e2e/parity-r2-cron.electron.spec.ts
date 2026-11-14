import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// 前端对照原型接通真实后端 · 第二轮 · 定时残留、搜索、斜杠命令
// (连真实后端:GG_BACKEND=server、规则替身脑子、桌面替身 Compute;只点界面、只读界面;要验「存进后端」就关掉应用、同一个数据目录重开再看)。
//   定时(F-CRON-EDIT / F-CRON-PANEL):合同的 schedules.create / update 只表达按 cron 触发——另外三种触发、「有情况才说」、
//     改负责人、挪会话在编辑器里关着并写明原因;改内容、暂停以后端回包为准;删除等后端删成,重开应用确实没了。
//   搜索(F-SEARCH):搜的是后端全部历史(search.messages),不只是读进来的最近 200 条;结果带后端真实序号,点了先把那条读进来再跳回去。
//   斜杠命令(F-CRON-CHAT 的一半):执行路径已接上合同的本地命令照常可用(/todo、/notice…);后端内置的 /task /remind /stop 列在菜单里,
//     选中后随消息的 command 发出,/remind 真的建出定时;执行路径还关着的(/summary…)灰着并写明原因。
// 规则替身脑子:私聊或被 @ 时正文以「帮我/请」开头才派活,否则回「收到:…」;群里没被 @ 不说话。
const appDir = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "ELECTRON_RUN_AS_NODE" && typeof e[1] === "string"));
const LONG = { timeout: 30_000 };

async function launch(dataDir: string): Promise<{ app: ElectronApplication; win: Page; errors: string[] }> {
  const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...env, GG_BACKEND: "server", GG_DATA_DIR: dataDir, GG_MIND: "fake", GG_COMPUTE: "fake" } });
  const win = await app.firstWindow();
  const errors: string[] = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  const mark = win.getByTestId("backend-demo");
  await expect(mark).toHaveAttribute("data-mode", "connected", LONG);
  await expect(mark).toHaveAttribute("data-wire", "live", LONG);
  await expect(mark).toHaveAttribute("data-failed", "0");
  return { app, win, errors };
}

async function addContact(win: Page, name: string) {
  await win.getByTestId("nav-contacts").click();
  await win.getByTestId("list").getByText("添加联系人", { exact: true }).click();
  await win.getByPlaceholder("比如：设计师").fill(name);
  await win.getByRole("button", { name: "添加", exact: true }).click();
  await expect(win.getByTestId("chat").locator("header")).toContainText(name, LONG);
}

/** 建几位联系人、拉进一个新群,停在群聊里 */
async function groupWith(win: Page, title: string, names: string[]) {
  for (const n of names) await addContact(win, n);
  await win.getByTestId("nav-contacts").click();
  await win.getByTestId("list").getByText("发起群聊", { exact: true }).click();
  await win.getByLabel("群名").fill(title);
  for (const n of names) await win.locator("label").filter({ hasText: n }).getByRole("checkbox").click();
  await win.getByRole("button", { name: `创建群聊（${names.length + 1} 人）` }).click();
  await expect(win.getByTestId("chat-title")).toContainText(title, LONG);
}

const convItem = (win: Page, title: string) => win.getByTestId("list").locator('[data-testid^="conv-g-"]').filter({ hasText: title });
const dmItem = (win: Page, name: string) => win.getByTestId("list").locator('[data-testid^="conv-dm-"]').filter({ hasText: name });
const rows = (win: Page) => win.getByTestId("chat-column").locator("[data-msg]");
const mine = (win: Page, text: string) => rows(win).filter({ hasText: text }).and(win.locator('[data-from="me"]'));
const side = (win: Page) => win.getByTestId("group-side");
async function openTab(win: Page, tab: "members" | "notice" | "list" | "cron" | "plugin" | "tools") {
  if (!(await side(win).isVisible())) await win.getByTestId("head-side").click();
  await win.getByTestId(`side-tab-${tab}`).click();
}
async function send(win: Page, text: string) {
  const box = win.getByTestId("composer");
  await box.fill(text);
  await box.press("Enter");
}
const cronRow = (win: Page, text: string) => win.getByTestId("side-crons").locator("[data-cron-row]").filter({ hasText: text });
const who = (win: Page, name: string) => win.locator('[data-testid^="cron-editor-who-"]').filter({ hasText: name });
const slashItem = (win: Page, name: string) => win.getByTestId(`slash-item-${name}`);
/** 合同表达不了的三种触发方式 */
const OFF_KINDS = ["once", "messages", "event"] as const;

test("定时:合同表达不了的在编辑器里关着并写明原因;改内容、暂停以后端回包为准;删除后重开应用确实没了", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-r2cron-"));
  let run = await launch(dataDir);
  try {
    await groupWith(run.win, "定时群", ["小克", "小林"]);

    await test.step("新建:只能按时间重复,另外三种触发和「有情况才说」关着,原因写在控件下面;由谁做、在哪个会话新建时照常可选", async () => {
      const { win } = run;
      await openTab(win, "cron");
      await win.getByTestId("side-cron-add").click();
      await expect(win.getByTestId("cron-editor-kind-cron")).toBeEnabled();
      for (const k of OFF_KINDS) await expect(win.getByTestId(`cron-editor-kind-${k}`)).toBeDisabled();
      await expect(win.getByTestId("cron-editor-kinds-off")).toContainText("后端的定时只按时间重复");
      await expect(win.getByTestId("cron-editor-speak-always")).toBeEnabled();
      await expect(win.getByTestId("cron-editor-speak-only-if")).toBeDisabled();
      await expect(win.getByTestId("cron-editor-speak-off")).toContainText("「有情况才说」还不支持");
      // 新建时合同收负责人和会话(schedules.create 的 contactId / roomId),这两项照常可选,也不出现「改不了」那句
      await expect(win.getByTestId("cron-editor-conv")).toBeEnabled();
      await expect(who(win, "小克")).toBeEnabled();
      await expect(win.getByTestId("cron-editor-fixed-off")).toHaveCount(0);
      await shot(win, "cron-editor-new");
      await win.getByTestId("cron-editor-text").fill("每天写日报");
      await who(win, "小克").click();
      await win.getByTestId("cron-editor-save").click();
      await expect(cronRow(win, "每天写日报")).toHaveCount(1, LONG);
      // 再建一条,待会儿删它
      await win.getByTestId("side-cron-add").click();
      await win.getByTestId("cron-editor-text").fill("每周对账");
      await who(win, "小林").click();
      await win.getByTestId("cron-editor-save").click();
      await expect(cronRow(win, "每周对账")).toHaveCount(1, LONG);
      await expect(win.getByTestId("side-tab-cron")).toContainText("定时 2");
    });

    await test.step("改:由谁做、在哪个会话改不了并写明原因;触发方式、说话方式同样关着;改内容走后端,详情按回包显示", async () => {
      const { win } = run;
      await cronRow(win, "每天写日报").click();
      await win.getByTestId("cron-edit").click();
      await expect(win.getByTestId("cron-editor-conv")).toBeDisabled();
      await expect(who(win, "小克")).toBeDisabled();
      await expect(who(win, "小林")).toBeDisabled();
      await expect(win.getByTestId("cron-editor-fixed-off")).toContainText("建好后改不了");
      for (const k of OFF_KINDS) await expect(win.getByTestId(`cron-editor-kind-${k}`)).toBeDisabled();
      await expect(win.getByTestId("cron-editor-kinds-off")).toContainText("后端的定时只按时间重复");
      await expect(win.getByTestId("cron-editor-speak-only-if")).toBeDisabled();
      await shot(win, "cron-editor-edit");
      await win.getByTestId("cron-editor-text").fill("每天写周报");
      await win.getByTestId("cron-editor-save").click();
      await expect(win.getByTestId("cron-detail-text")).toHaveText("每天写周报", LONG);
    });

    await test.step("暂停:开关按后端回包变成已暂停", async () => {
      const { win } = run;
      await win.getByTestId("cron-pause").click();
      await expect(win.getByTestId("cron-pause-label")).toHaveText("已暂停", LONG);
    });

    await test.step("删除另一条:确认后等后端删成,详情写明已删掉,本群定时只剩一条", async () => {
      const { win } = run;
      await openTab(win, "cron");
      await cronRow(win, "每周对账").click();
      await win.getByTestId("cron-delete").click();
      await win.getByTestId("cron-delete-ok").click();
      await expect(win.getByTestId("cron-detail-gone")).toBeVisible(LONG);
      await openTab(win, "cron");
      await expect(cronRow(win, "每周对账")).toHaveCount(0);
      await expect(cronRow(win, "每天写周报")).toHaveCount(1);
      await expect(win.getByTestId("side-tab-cron")).toContainText("定时 1");
    });

    await test.step("重开应用:删掉的那条确实没了;改过的那条是新内容、仍然暂停着", async () => {
      await run.app.close();
      run = await launch(dataDir);
      const { win } = run;
      await convItem(win, "定时群").click();
      await openTab(win, "cron");
      await expect(cronRow(win, "每天写周报")).toHaveCount(1, LONG);
      await expect(cronRow(win, "每天写周报")).toHaveAttribute("data-paused", "true");
      await expect(cronRow(win, "每周对账")).toHaveCount(0);
      await expect(cronRow(win, "每天写日报")).toHaveCount(0);
      await expect(win.getByTestId("side-tab-cron")).toContainText("定时 1");
      await shot(win, "cron-after-restart");
      expect(run.errors, "页面不该抛错").toEqual([]);
    });
  } finally {
    await run.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("搜索:搜的是后端全部历史——搜得到没读进来的旧消息、显示后端的真实序号,点了先把它读进来再跳回去", async () => {
  test.setTimeout(480_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-r2cron-"));
  let run = await launch(dataDir);
  try {
    await groupWith(run.win, "搜索群", ["小克", "小林"]);
    let oldId = "";

    await test.step("先发一条带暗号的,再发 205 条(群里没 @ 谁,联系人不说话):暗号那条排到最近 200 条之外", async () => {
      const { win } = run;
      await send(win, "暗号芝麻开门 这是最早的一条");
      const first = mine(win, "暗号芝麻开门");
      await expect(first).toHaveCount(1, LONG);
      await expect(first).toHaveAttribute("data-msg", /#\d+$/, LONG);
      oldId = (await first.getAttribute("data-msg"))!;
      for (let i = 1; i <= 205; i++) await send(win, `凑数 ${String(i).padStart(3, "0")}`);
      // 都发到后端了(不再有本地等回包的条目)
      await expect(mine(win, "凑数 205")).toHaveCount(1, { timeout: 120_000 });
      await expect(win.getByTestId("chat-column").locator('[data-msg^="local-"]')).toHaveCount(0, { timeout: 120_000 });
      await expect(mine(win, "凑数")).toHaveCount(205);
    });

    await test.step("重开应用:只读进最近 200 条,暗号那条不在聊天里", async () => {
      await run.app.close();
      run = await launch(dataDir);
      const { win } = run;
      await convItem(win, "搜索群").click();
      await expect(mine(win, "凑数 205")).toHaveCount(1, LONG);
      await expect(win.locator(`[data-msg="${oldId}"]`)).toHaveCount(0);
    });

    await test.step("搜暗号:结果来自后端,带它在后端的真实序号", async () => {
      const { win } = run;
      const seq = /#(\d+)$/.exec(oldId)![1]!;
      await win.getByTestId("head-search").click();
      await win.getByTestId("search-input").fill("暗号芝麻开门");
      const hit = win.getByTestId(`search-hit-${oldId}`);
      await expect(hit).toHaveCount(1, LONG);
      await expect(hit).toContainText("暗号芝麻开门 这是最早的一条");
      await expect(hit.getByTestId("search-hit-seq")).toHaveText(`#${seq}`);
      await shot(win, "search-old-hit");
    });

    await test.step("点结果:先把那一段读进来,再跳回原消息并高亮", async () => {
      const { win } = run;
      await win.getByTestId(`search-hit-${oldId}`).click();
      const row = win.locator(`[data-msg="${oldId}"]`);
      await expect(row).toHaveAttribute("data-hl", "1", LONG);
      await expect(row).toBeInViewport();
      await expect(row).toContainText("暗号芝麻开门 这是最早的一条");
      // 读进来的是连着的一段:它后面紧跟的那条也在
      await expect(mine(win, "凑数 001")).toHaveCount(1);
      await shot(win, "search-jump");
      expect(run.errors, "页面不该抛错").toEqual([]);
    });
  } finally {
    await run.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("斜杠命令:/todo、/notice 连后端时可用并写进后端;后端的 /remind 在菜单里,发出后定时页出现这条定时;/summary 仍灰着并写明原因", async () => {
  test.setTimeout(300_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-r2cron-"));
  let run = await launch(dataDir);
  try {
    await groupWith(run.win, "命令群", ["小克", "小林"]);

    await test.step("打 / :后端内置的 /task /remind /stop 列在菜单里;执行路径已接上合同的本地命令不灰;还关着的灰着并写明原因", async () => {
      const { win } = run;
      const box = win.getByTestId("composer");
      await box.fill("/");
      await expect(win.getByTestId("slash-menu")).toBeVisible();
      // 后端 commands.list 给的内置命令(到了才说明这个会话的清单已经读回来)
      for (const n of ["remind", "task", "stop"]) {
        await expect(slashItem(win, n)).toHaveCount(1, LONG);
        await expect(slashItem(win, n).getByTestId("slash-disabled")).toHaveCount(0);
        await expect(slashItem(win, n).getByTestId("slash-src")).toHaveText("内置");
      }
      // 前端经已接好的合同动作就能做到的:todo→tasks.create、notice→announcements.add、schedule→定时编辑器→schedules.create、
      // handoff→发一条 @ 消息、files→文件页、pool→群临时算力、clone→群模板入口
      for (const n of ["todo", "notice", "schedule", "handoff", "files", "pool", "clone"]) {
        await expect(slashItem(win, n)).toHaveCount(1);
        await expect(slashItem(win, n).getByTestId("slash-disabled")).toHaveCount(0);
      }
      // 执行路径还关着的:灰着,原因写在菜单这一行上
      await expect(slashItem(win, "summary").getByTestId("slash-disabled")).toContainText("总结还没接上后端");
      for (const n of ["workspace", "links", "pins", "playbook"]) await expect(slashItem(win, n).getByTestId("slash-disabled")).toContainText("还没接上后端");
      await shot(win, "slash-menu-live");
      // 手打灰着的命令再回车:不发消息,话留在输入框里
      await box.fill("/summary");
      await box.press("Enter");
      await expect(box).toHaveValue("/summary");
      await expect(rows(win).filter({ hasText: "/summary" })).toHaveCount(0);
      await box.fill("");
    });

    await test.step("/todo:经 tasks.create 建进后端,群里记一条、清单里多一项待认领", async () => {
      const { win } = run;
      await send(win, "/todo 买一台测试机");
      await expect(win.getByTestId("composer")).toHaveValue("");
      await expect(rows(win).filter({ hasText: "新建任务:买一台测试机" })).toHaveCount(1, LONG);
      await openTab(win, "list");
      const task = win.getByTestId("side-checklist").locator('[data-testid^="task-"][data-status]').filter({ hasText: "买一台测试机" });
      await expect(task).toHaveCount(1, LONG);
      await expect(task).toHaveAttribute("data-status", "待认领");
    });

    await test.step("/notice:经 announcements.add 发布,顶栏公告条显示它", async () => {
      const { win } = run;
      await send(win, "/notice 周五前提测");
      await expect(win.getByTestId("composer")).toHaveValue("");
      await expect(win.getByTestId("strip-text")).toContainText("群公告：周五前提测", LONG);
      await expect(win.getByTestId("side-tab-notice")).toContainText("公告 1");
    });

    await test.step("/remind:从菜单里选中,填上谁、cron 和要做的事发出去;宿主照命令建出定时,本群定时页出现这一条", async () => {
      const { win } = run;
      const box = win.getByTestId("composer");
      await box.fill("/rem");
      await expect(slashItem(win, "remind")).toBeVisible();
      await box.press("Enter");
      await expect(box).toHaveValue("/remind ");
      await box.fill("/remind @小克 0 8 * * * 写日报");
      await expect(win.getByTestId("slash-hint")).toContainText("/remind");
      await box.press("Enter");
      await expect(box).toHaveValue("");
      await expect(mine(win, "/remind @小克 0 8 * * * 写日报")).toHaveCount(1, LONG);
      await expect(win.getByTestId("strip-cron")).toContainText("定时 1", LONG);
      await openTab(win, "cron");
      const row = cronRow(win, "写日报");
      await expect(row).toHaveCount(1, LONG);
      await expect(row).toContainText("小克");
      await expect(row.getByTestId("cron-row-expr")).toHaveText("0 8 * * *");
      await shot(win, "slash-remind-cron");
    });

    await test.step("私聊里直接「/remind 30 9 * * 1-5 站会提醒」(不用写谁,就是对方):定时总览里两条都在", async () => {
      const { win } = run;
      await dmItem(win, "小克").click();
      await expect(win.getByTestId("chat").locator("header")).toContainText("小克", LONG);
      await send(win, "/remind 30 9 * * 1-5 站会提醒");
      await expect(mine(win, "/remind 30 9 * * 1-5 站会提醒")).toHaveCount(1, LONG);
      await convItem(win, "命令群").click();
      await openTab(win, "cron");
      // 本群定时只看本群:私聊那条不混进来
      await expect(cronRow(win, "站会提醒")).toHaveCount(0);
      await win.getByTestId("side-cron-overview").click();
      await expect(win.getByTestId("pano-cron")).toContainText("站会提醒", LONG);
      await expect(win.getByTestId("pano-cron")).toContainText("写日报");
      await win.keyboard.press("Escape");
      await expect(win.getByTestId("pano-cron")).toHaveCount(0);
    });

    await test.step("重开应用:清单项、公告、/remind 建的定时都从后端读回来", async () => {
      await run.app.close();
      run = await launch(dataDir);
      const { win } = run;
      await convItem(win, "命令群").click();
      await openTab(win, "list");
      await expect(win.getByTestId("side-checklist").locator('[data-testid^="task-"][data-status]').filter({ hasText: "买一台测试机" })).toHaveCount(1, LONG);
      await expect(win.getByTestId("strip-text")).toContainText("群公告：周五前提测");
      await openTab(win, "cron");
      await expect(cronRow(win, "写日报")).toHaveCount(1, LONG);
      await expect(cronRow(win, "写日报").getByTestId("cron-row-expr")).toHaveText("0 8 * * *");
      expect(run.errors, "页面不该抛错").toEqual([]);
    });
  } finally {
    await run.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
