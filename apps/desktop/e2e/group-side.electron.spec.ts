import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// 群资料与群管理(连真实后端,只点界面、只读界面;GG_BACKEND=server、规则替身脑子、剧本 Compute):
//   公告(AC-55)发布 / 改 / 撤下,顶栏公告条与各联系人「已装配 vN」;群设置改名、置顶、免打扰;群临时算力上限(U09);
//   群清单(AC-47)新建任务、交给联系人认领;拍一拍;把成员拖出群(AC-49);定时页读后端(重启还在);解散群(U03)。
// 规则替身脑子:被 @ 时正文以「帮我/请」开头才派活,否则回「收到:…」。
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

/** 建两位联系人、拉进一个新群,停在群聊里 */
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
const rows = (win: Page) => win.getByTestId("chat-column").locator("[data-msg]");
const side = (win: Page) => win.getByTestId("group-side");
async function openTab(win: Page, tab: "members" | "notice" | "list" | "cron" | "plugin" | "tools") {
  if (!(await side(win).isVisible())) await win.getByTestId("head-side").click();
  await win.getByTestId(`side-tab-${tab}`).click();
}
/** 在群里 @ 某人说一句(选人菜单开着时回车选中) */
async function say(win: Page, text: string, at: string) {
  const box = win.getByTestId("composer");
  await box.fill(`${text} @${at}`);
  await box.press("Enter");
  await expect(box).toHaveValue(`${text} @${at} `);
  await box.press("Enter");
}

test("群资料·公告与群设置:发布、改、撤下公告并写明各联系人装配到第几版;改群名、置顶、免打扰、群临时算力上限", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-gside-"));
  const { app, win, errors } = await launch(dataDir);
  try {
    await groupWith(win, "公告群", ["小克", "小林"]);

    await test.step("右栏页签读后端:成员 3(你和两位联系人),公告 0", async () => {
      await openTab(win, "members");
      await expect(win.getByTestId("side-tab-members")).toContainText("成员 3");
      await expect(win.getByTestId("side-members-drop").locator('[data-testid^="side-member-"]')).toHaveCount(3);
      await expect(win.getByTestId("side-tab-notice")).toContainText("公告 0");
      await expect(win.getByTestId("strip-empty")).toBeVisible();
    });

    await test.step("发布公告:写进后端,顶栏公告条显示它,两位联系人都还没装配(0/2 已装配 v1)", async () => {
      await openTab(win, "notice");
      await win.getByTestId("notice-add").click();
      await win.getByTestId("notice-input").fill("派活先 @ 对应的人");
      await win.getByTestId("notice-save").click();
      await expect(win.getByTestId("notice-block")).toHaveAttribute("data-count", "1", LONG);
      await expect(win.getByTestId("side-tab-notice")).toContainText("公告 1");
      await expect(win.getByTestId("strip-text")).toContainText("群公告：派活先 @ 对应的人");
      await expect(win.getByTestId("strip-loaded")).toHaveText("0/2 已装配 v1");
    });

    await test.step("@小克 之后它这一轮装配了公告:已装配数跟着后端变", async () => {
      await say(win, "看下公告", "小克");
      await expect(rows(win).filter({ hasText: "收到:看下公告" })).toHaveCount(1, LONG);
      await expect(win.getByTestId("strip-loaded")).toHaveText(/^[12]\/2 已装配 v1$/, LONG);
    });

    await test.step("改公告:版本 +1,下一轮之前联系人还是旧版(0/2 已装配 v2),下一轮装配后跟上", async () => {
      const block = win.getByTestId("notice-block");
      await block.getByRole("button", { name: "改", exact: true }).click();
      await block.locator('[data-testid^="notice-edit-input-"]').fill("派活先 @ 对应的人,做完先复核");
      await block.getByRole("button", { name: "改到 v2" }).click();
      await expect(win.getByTestId("strip-text")).toContainText("做完先复核", LONG);
      await expect(win.getByTestId("strip-loaded")).toHaveText("0/2 已装配 v2");
      await say(win, "再看一眼", "小克");
      await expect(win.getByTestId("strip-loaded")).toHaveText(/^[12]\/2 已装配 v2$/, LONG);
    });

    await test.step("再发一条:两条都在(新的在前),顶栏公告条可以切换;撤下一条后只剩一条", async () => {
      await win.getByTestId("notice-add").click();
      await win.getByTestId("notice-input").fill("周五不发版");
      await win.getByTestId("notice-save").click();
      await expect(win.getByTestId("notice-block")).toHaveAttribute("data-count", "2", LONG);
      await expect(win.getByTestId("strip-next")).toContainText("1/2");
      await win.getByTestId("notice-title").click();
      const list = win.getByTestId("notice-list");
      await expect(list.locator("li")).toHaveCount(2);
      await expect(list.locator("li").first()).toContainText("周五不发版");
      await shot(win, "notice-multi");
      const item = list.locator("li").filter({ hasText: "周五不发版" });
      await item.getByRole("button", { name: "撤下", exact: true }).click();
      await item.getByRole("button", { name: "撤下这条", exact: true }).click();
      await expect(win.getByTestId("notice-block")).toHaveAttribute("data-count", "1", LONG);
      await expect(win.getByTestId("side-tab-notice")).toContainText("公告 1");
      await expect(win.getByTestId("strip-text")).toContainText("做完先复核");
    });

    await test.step("群设置:改群名、置顶、免打扰都写进后端", async () => {
      await win.getByTestId("chat-more").click();
      await win.getByTestId("group-rename").click();
      await win.getByLabel("群名").fill("公告群·改");
      await win.getByLabel("群名").press("Enter");
      await expect(win.getByTestId("chat-title")).toContainText("公告群·改", LONG);
      await expect(convItem(win, "公告群·改")).toHaveCount(1);
      await win.getByTestId("gp-pin").click();
      await expect(win.getByTestId("gp-pin")).toHaveAttribute("aria-checked", "true", LONG);
      await expect(convItem(win, "公告群·改")).toHaveAttribute("data-pinned", "1");
      await win.getByTestId("gp-mute").click();
      await expect(win.getByTestId("gp-mute")).toHaveAttribute("aria-checked", "true", LONG);
      await win.keyboard.press("Escape");
    });

    await test.step("群临时算力:你是群主,能设上限;设成 2 格写进后端", async () => {
      await openTab(win, "tools");
      await win.getByTestId("tool-compute").click();
      const pool = win.getByTestId("pool-page");
      await expect(pool).toHaveAttribute("data-max", "0");
      await win.getByTestId("pool-max-2").click();
      await expect(pool).toHaveAttribute("data-max", "2", LONG);
      await expect(pool).toContainText("借出 0 / 2 格");
      await shot(win, "pool");
      await win.keyboard.press("Escape");
    });

    await test.step("没有演示数据、页面不抛错", async () => {
      for (const name of ["模型助手群聊", "Argon", "Astra"]) await expect(win.getByText(name, { exact: false })).toHaveCount(0);
      expect(errors, "页面不该抛错").toEqual([]);
    });
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("群资料·清单与成员:新建任务、交给联系人认领;拍一拍;把成员拖出群", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-gside-"));
  const { app, win, errors } = await launch(dataDir);
  try {
    await groupWith(win, "清单群", ["小克", "小林"]);

    await test.step("没有清单时顶栏不放清单胶囊;新建一项(不指定人)进清单、待认领", async () => {
      await expect(win.getByTestId("strip-list")).toHaveCount(0);
      await openTab(win, "list");
      await win.getByTestId("side-task-add").click();
      await win.getByTestId("task-form-title").fill("整理发票");
      await win.getByTestId("task-form-desc").fill("按部门分表");
      await win.getByTestId("task-form-submit").click();
      const item = win.getByTestId("side-checklist").locator('[data-testid^="task-"][data-status]').filter({ hasText: "整理发票" });
      await expect(item).toHaveCount(1, LONG);
      await expect(item).toHaveAttribute("data-status", "待认领");
      await expect(item).toContainText("按部门分表");
      await expect(win.getByTestId("strip-list")).toContainText("清单 0/1");
      await expect(rows(win).filter({ hasText: "新建任务:整理发票" })).toHaveCount(1, LONG);
    });

    await test.step("交给小林:它认领并起 Compute,清单项写明是它在做", async () => {
      const item = win.getByTestId("side-checklist").locator('[data-testid^="task-"][data-status]').filter({ hasText: "整理发票" });
      await item.getByRole("button", { name: "交给…" }).click();
      await win.getByTestId("task-assign-menu").getByRole("menuitem", { name: "小林" }).click();
      await expect(item).toHaveAttribute("data-status", /进行中|待验收/, LONG);
      await expect(item).toContainText("小林");
      await expect(rows(win).filter({ hasText: "把任务「整理发票」交给 小林" })).toHaveCount(1, LONG);
    });

    await test.step("新建时直接指定小克:建好就是小克在做", async () => {
      await win.getByTestId("side-task-add").click();
      await win.getByTestId("task-form-title").fill("写周报");
      await win.locator('[data-testid^="task-form-who-"]').filter({ hasText: "小克" }).click();
      await win.getByTestId("task-form-submit").click();
      const item = win.getByTestId("side-checklist").locator('[data-testid^="task-"][data-status]').filter({ hasText: "写周报" });
      await expect(item).toHaveAttribute("data-status", /进行中|待验收/, LONG);
      await expect(item).toContainText("小克");
      await expect(win.getByTestId("side-tab-list")).toContainText("/2");
      await shot(win, "checklist");
    });

    await test.step("拍一拍小克:群里出现一条 @它 的消息,它回话", async () => {
      await openTab(win, "members");
      await win.getByTestId("side-members-drop").locator('[data-testid^="side-member-"]').filter({ hasText: "小克" }).click();
      await win.getByTestId("menu-more").click();
      await win.getByTestId("menu-poke").click();
      await expect(rows(win).filter({ hasText: "拍了拍 @小克" }).and(win.locator('[data-from="me"]'))).toHaveCount(1, LONG);
      await expect(rows(win).filter({ hasText: "收到:拍了拍" })).toHaveCount(1, LONG);
    });

    await test.step("把小林拖到「移出群」:成员里没有它了,群人数变成 2", async () => {
      await openTab(win, "members");
      await shot(win, "members");
      const who = win.getByTestId("side-members-drop").locator('[data-testid^="side-member-"]').filter({ hasText: "小林" });
      await who.hover();
      await win.mouse.down();
      const box = (await who.boundingBox())!;
      await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 12, { steps: 4 });
      const out = win.getByTestId("side-drop-out");
      await expect(out).toBeVisible();
      await out.hover();
      await expect(out).toHaveAttribute("data-over", "1");
      await shot(win, "member-drag-out");
      await win.mouse.up();
      await expect(win.getByTestId("side-members-drop").locator('[data-testid^="side-member-"]').filter({ hasText: "小林" })).toHaveCount(0, LONG);
      await expect(win.getByTestId("chat-title")).toContainText("(2)");
    });

    expect(errors, "页面不该抛错").toEqual([]);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("群资料·定时读后端、解散群:定时重启后还在;解散后群消失,重启也不回来", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-gside-"));
  let run = await launch(dataDir);
  try {
    await groupWith(run.win, "定时群", ["小克", "小林"]);

    await test.step("定时页就地新建一条:列在本群定时里", async () => {
      const { win } = run;
      await openTab(win, "cron");
      await win.getByTestId("side-cron-add").click();
      await win.getByTestId("cron-editor-text").fill("每天写日报");
      await win.locator('[data-testid^="cron-editor-who-"]').filter({ hasText: "小克" }).click();
      await win.getByTestId("cron-editor-save").click();
      await expect(win.getByTestId("side-crons")).toContainText("每天写日报", LONG);
      await expect(win.getByTestId("side-tab-cron")).toContainText("定时 1");
    });

    await test.step("重启应用:定时页从后端读回这一条", async () => {
      await run.app.close();
      run = await launch(dataDir);
      const { win } = run;
      await convItem(win, "定时群").click();
      await openTab(win, "cron");
      await expect(win.getByTestId("side-crons")).toContainText("每天写日报", LONG);
      await expect(win.getByTestId("side-tab-cron")).toContainText("定时 1");
      await expect(win.getByTestId("strip-cron")).toContainText("定时 1");
      await shot(run.win, "crons");
    });

    await test.step("解散群:确认后群从会话列表消失", async () => {
      const { win } = run;
      await win.getByTestId("chat-more").click();
      await win.getByTestId("group-dissolve").click();
      await win.getByTestId("leave-confirm-go").click();
      await expect(convItem(win, "定时群")).toHaveCount(0, LONG);
    });

    await test.step("再重启:解散的群不回来", async () => {
      await run.app.close();
      run = await launch(dataDir);
      await expect(convItem(run.win, "定时群")).toHaveCount(0);
      expect(run.errors, "页面不该抛错").toEqual([]);
    });
  } finally {
    await run.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
