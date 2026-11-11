import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// 聊天主界面按原型做全(连真实后端,只点界面、只读界面):GG_BACKEND=server、规则替身脑子(每轮先等一会儿,看得见「正在回复」)、剧本 Compute。
// 覆盖:就近的消息操作(右键 / 悬停)——表情、编辑、撤回、删除(只在你这边)、多选删除、置顶、转发、私聊回到某条;
// 已读回执与草稿重启后还在;正在回复卡只写真实活动;新消息分隔线;发文件。
const appDir = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "ELECTRON_RUN_AS_NODE" && typeof e[1] === "string"));
const LONG = { timeout: 30_000 };

async function launch(dataDir: string, delayMs = 1200): Promise<{ app: ElectronApplication; win: Page; errors: string[] }> {
  const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...env, GG_BACKEND: "server", GG_DATA_DIR: dataDir, GG_MIND: "fake", GG_COMPUTE: "fake", GG_MIND_DELAY_MS: String(delayMs) } });
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
async function openConv(win: Page, kind: "dm" | "g", title: string) {
  await win.getByTestId("nav-chat").click();
  await win.getByTestId("list").locator(`[data-testid^="conv-${kind}-"]`).filter({ hasText: title }).click();
  await expect(win.getByTestId("chat").locator("header")).toContainText(title, LONG);
}
async function send(win: Page, text: string) {
  const box = win.getByTestId("composer");
  await box.fill(text);
  await box.press("Enter");
}
const rows = (win: Page) => win.getByTestId("chat-column").locator("[data-msg]");
const mine = (win: Page, text: string) => rows(win).filter({ hasText: text }).and(win.locator('[data-from="me"]'));
const theirs = (win: Page, text: string) => rows(win).filter({ hasText: text }).and(win.locator('[data-from]:not([data-from="me"])'));
/** 右键这条消息,点菜单里的一项 */
async function menu(win: Page, row: ReturnType<typeof rows>, item: string) {
  await row.locator("[data-anchor]").first().click({ button: "right" });
  const m = win.getByTestId("ctx-menu");
  await expect(m).toBeVisible();
  if (item.startsWith("ctx-")) await m.getByTestId(item).click();
  else await m.getByText(item, { exact: true }).click();
}

test("私聊里就近操作消息:表情、编辑、撤回、删除都由后端落实;重启后回执、草稿、表情、编辑、撤回、删除都还在;正在回复卡只写真实活动", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-pchat-"));
  let run = await launch(dataDir);
  try {
    const { win } = run;
    await addContact(win, "小克");

    await test.step("发一句,联系人接走时出「正在回复」卡:只写在想和时长,不编步骤;随后真实回复", async () => {
      await send(win, "你好");
      const card = win.getByTestId("typing");
      await expect(card).toBeVisible(LONG);
      await expect(card).toContainText("正在回复");
      await expect(card).toContainText("在想");
      await expect(card).toContainText("你好");
      await expect(card).not.toContainText("读了最新几条消息");
      await shot(win, "replying-live");
      await expect(theirs(win, "收到:你好")).toHaveCount(1, LONG);
      await expect(card).toHaveCount(0, LONG);
      await expect(mine(win, "你好").locator("[data-read]")).toHaveAttribute("data-unread", "0");
    });

    await test.step("右键联系人那句点 👍:表情挂上,是你点的", async () => {
      await menu(win, theirs(win, "收到:你好"), "👍");
      const chip = theirs(win, "收到:你好").locator('[data-testid^="reaction-"]');
      await expect(chip).toHaveCount(1, LONG);
      await expect(chip).toHaveAttribute("aria-pressed", "true");
    });

    await test.step("右键自己那句「编辑」:改成「你好呀」,标已编辑", async () => {
      await menu(win, mine(win, "你好"), "ctx-edit");
      await expect(win.getByTestId("edit-bar")).toBeVisible();
      const box = win.getByTestId("composer");
      await expect(box).toHaveValue("你好");
      await box.fill("你好呀");
      await box.press("Enter");
      await expect(mine(win, "你好呀")).toHaveCount(1, LONG);
      await expect(mine(win, "你好呀").locator('[data-testid^="edited-"]')).toBeVisible();
      await expect(win.getByTestId("edit-bar")).toHaveCount(0);
    });

    await test.step("撤回自己的第二句:变成灰字「你撤回了一条消息」,能重新编辑", async () => {
      await send(win, "第二句");
      await expect(theirs(win, "收到:第二句")).toHaveCount(1, LONG);
      await menu(win, mine(win, "第二句"), "ctx-recall");
      await expect(win.getByTestId("recall-line")).toContainText("你撤回了一条消息", LONG);
      await expect(win.getByTestId("recall-line").locator('[data-testid^="reedit-"]')).toBeVisible();
      await expect(mine(win, "第二句")).toHaveCount(0);
    });

    await test.step("删除联系人那句「收到:第二句」:只在你这边看不到", async () => {
      await menu(win, theirs(win, "收到:第二句"), "ctx-delete");
      await expect(theirs(win, "收到:第二句")).toHaveCount(0, LONG);
    });

    await test.step("输入框里留一句没发的话", async () => {
      await win.getByTestId("composer").fill("还没发的话");
      await win.waitForTimeout(1200);
      await shot(win, "dm-ops-before-restart");
    });

    expect(run.errors, "页面不该抛错").toEqual([]);
    await run.app.close();
    run = await launch(dataDir);
    const w2 = run.win;

    await test.step("重启后:草稿、已读回执、表情、已编辑、撤回、删除都和重启前一样", async () => {
      await openConv(w2, "dm", "小克");
      await expect(w2.getByTestId("composer")).toHaveValue("还没发的话", LONG);
      await expect(mine(w2, "你好呀")).toHaveCount(1, LONG);
      await expect(mine(w2, "你好呀").locator('[data-testid^="edited-"]')).toBeVisible();
      await expect(mine(w2, "你好呀").locator("[data-read]")).toHaveAttribute("data-unread", "0", LONG);
      await expect(theirs(w2, "收到:你好").locator('[data-testid^="reaction-"]')).toHaveAttribute("aria-pressed", "true", LONG);
      await expect(w2.getByTestId("recall-line")).toContainText("你撤回了一条消息");
      await expect(mine(w2, "第二句")).toHaveCount(0);
      await expect(theirs(w2, "收到:第二句")).toHaveCount(0);
      await shot(w2, "dm-ops-after-restart");
    });
    expect(run.errors, "页面不该抛错").toEqual([]);
  } finally {
    await run.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("群里置顶、转发、多选删除、清空:置顶条显示并在重启后还在;转发到私聊是一张转发卡;删的只在你这边", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-pchat-"));
  let run = await launch(dataDir, 0);
  try {
    const { win } = run;
    await addContact(win, "小克");
    await addContact(win, "小林");
    await win.getByTestId("nav-contacts").click();
    await win.getByTestId("list").getByText("发起群聊", { exact: true }).click();
    await win.getByLabel("群名").fill("闭环群");
    for (const n of ["小克", "小林"]) await win.locator("label").filter({ hasText: n }).getByRole("checkbox").click();
    await win.getByRole("button", { name: "创建群聊（3 人）" }).click();
    await expect(win.getByTestId("chat-title")).toContainText("闭环群", LONG);

    await test.step("置顶一条:群顶部的置顶条显示它", async () => {
      await send(win, "上线时间定在周五");
      await expect(mine(win, "上线时间定在周五")).toHaveCount(1, LONG);
      await menu(win, mine(win, "上线时间定在周五"), "ctx-pin");
      await expect(win.getByTestId("strip-text")).toContainText("上线时间定在周五", LONG);
      await shot(win, "group-pinbar");
    });

    await test.step("转发这条到小克的私聊:那边出现一张转发卡,写明来自闭环群", async () => {
      await menu(win, mine(win, "上线时间定在周五"), "ctx-forward");
      await win.locator('[data-testid^="fwd-dm-"]').filter({ hasText: "小克" }).click();
      await expect(win.getByTestId("chat").locator("header")).toContainText("小克", LONG);
      const card = rows(win).filter({ hasText: "来自「闭环群」的 1 条记录" });
      await expect(card).toHaveCount(1, LONG);
      await expect(card).toContainText("上线时间定在周五");
      await shot(win, "dm-forward-card");
    });

    await test.step("回群里多选两条一起删:只在你这边看不到", async () => {
      await openConv(win, "g", "闭环群");
      await send(win, "草稿一");
      await send(win, "草稿二");
      await expect(mine(win, "草稿二")).toHaveCount(1, LONG);
      await menu(win, mine(win, "草稿一"), "ctx-multi");
      await mine(win, "草稿一").click();
      await mine(win, "草稿二").click();
      await win.getByTestId("select-delete").click();
      await expect(mine(win, "草稿一")).toHaveCount(0, LONG);
      await expect(mine(win, "草稿二")).toHaveCount(0);
    });

    expect(run.errors, "页面不该抛错").toEqual([]);
    await run.app.close();
    run = await launch(dataDir, 0);
    const w2 = run.win;

    await test.step("重启后:置顶条还在,删掉的两条还是看不到", async () => {
      await openConv(w2, "g", "闭环群");
      await expect(w2.getByTestId("strip-text")).toContainText("上线时间定在周五", LONG);
      await expect(mine(w2, "上线时间定在周五")).toHaveCount(1);
      await expect(mine(w2, "草稿一")).toHaveCount(0);
      await expect(mine(w2, "草稿二")).toHaveCount(0);
    });

    await test.step("清空聊天记录:群里一条不剩", async () => {
      await w2.getByTestId("chat-more").click();
      await w2.getByTestId("group-clear").click();
      await w2.getByTestId("leave-confirm-go").click();
      await expect(rows(w2).filter({ hasText: "上线时间定在周五" })).toHaveCount(0, LONG);
      await expect(w2.getByTestId("strip-text")).toHaveCount(0);
    });
    expect(run.errors, "页面不该抛错").toEqual([]);
  } finally {
    await run.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("私聊回到某条:确认框写明真实要撤下几条;之后的撤下、留一行灰字;发文件是附件卡;切走时来的回复回来时有新消息分隔线", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-pchat-"));
  let run = await launch(dataDir, 1500);
  try {
    const { win } = run;
    await addContact(win, "小林");
    await addContact(win, "小克");

    await test.step("切走时小克回了话:回到小克的私聊,未读那里有「以下是新消息」", async () => {
      await send(win, "第一句");
      await openConv(win, "dm", "小林");
      await expect(win.getByTestId("list").locator('[data-testid^="conv-dm-"]').filter({ hasText: "小克" })).toContainText("收到:第一句", LONG);
      await openConv(win, "dm", "小克");
      await expect(win.locator('[data-msg="new-divider"]')).toBeVisible(LONG);
      await expect(theirs(win, "收到:第一句")).toHaveCount(1);
      await shot(win, "dm-new-divider");
    });

    await test.step("回到「第一句」:确认框说之后 3 条会撤下;确认后它们不见了,留一行灰字,没有假的「恢复」", async () => {
      await send(win, "第二句");
      await expect(theirs(win, "收到:第二句")).toHaveCount(1, LONG);
      await menu(win, mine(win, "第一句"), "ctx-rewind");
      const dlg = win.getByTestId("rewind-dialog");
      await expect(dlg).toContainText("之后的 3 条会撤下", LONG);
      await shot(win, "dm-rewind-dialog");
      await dlg.getByTestId("rewind-confirm").click();
      await expect(mine(win, "第二句")).toHaveCount(0, LONG);
      await expect(theirs(win, "收到:第二句")).toHaveCount(0);
      await expect(theirs(win, "收到:第一句")).toHaveCount(0);
      const line = win.getByTestId("rewind-line");
      await expect(line).toContainText("你把聊天退回到「第一句」", LONG);
      await expect(line).toContainText("之后 3 条已撤下");
      await expect(line.locator('[data-testid^="rewind-undo-"]')).toHaveCount(0);
      await shot(win, "dm-rewind-done");
    });

    await test.step("发一个文件:出现附件卡(名字、大小),重启后还在", async () => {
      await win.getByTestId("file-input").setInputFiles({ name: "需求补充.md", mimeType: "text/markdown", buffer: Buffer.from("# 需求补充\n第一条\n") });
      const card = win.getByTestId("chat-column").getByTestId("attachment-需求补充.md");
      await expect(card).toBeVisible(LONG);
      await expect(card).toContainText("B · 你发的");
      await shot(win, "dm-attachment");
    });

    expect(run.errors, "页面不该抛错").toEqual([]);
    await run.app.close();
    run = await launch(dataDir, 0);
    await openConv(run.win, "dm", "小克");
    await expect(run.win.getByTestId("chat-column").getByTestId("attachment-需求补充.md")).toBeVisible(LONG);
    await expect(run.win.getByTestId("rewind-line")).toContainText("你把聊天退回到「第一句」");
    await expect(mine(run.win, "第二句")).toHaveCount(0);
    expect(run.errors, "页面不该抛错").toEqual([]);
  } finally {
    await run.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
