import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// 前端对照原型接通真实后端 · 第二轮 · 联系人工作台与模型设置(连真实后端:GG_BACKEND=server、规则替身脑子、剧本 Compute;只点界面、只读界面)。
// 要验的事:
//   - 工作台「职责与预设」:默认职位 = 联系人资料里那一句(bio),预设读写后端;后端不收就提示原因、界面还是原值;
//   - 工作台「设置」:技能和工具来自后端能力库,开关写进后端;说话模型、Compute 个数写进后端;
//   - 设置页「默认」:全局默认和模型目录读后端(不是演示目录),改全局默认、批量替换都真的改到后端;
//   - 合同里没有的(按群分工、卡死判定单独设、记忆)如实关着并写明原因;「完整过程」读这位联系人的运行台账;
//   - 「存进后端」一律用关掉应用、同一个数据目录重开来验。
// 替身环境里后端的模型目录是空的(settings.models 默认 []),所以换模型走「填别的模型 id」;全局默认是哪个模型由后端定,用例从界面上读。
// 能力库在数据目录的 library 下(宿主从那里读),用例开头往里放一个技能、一个工具——和用户自己放进去是同一条路。
const appDir = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "ELECTRON_RUN_AS_NODE" && typeof e[1] === "string"));
const LONG = { timeout: 30_000 };
/** 模型下拉里「填别的模型 id…」那一项的值 */
const OTHER = "__other__";

type Run = { app: ElectronApplication; win: Page; errors: string[] };

async function launch(dataDir: string): Promise<Run> {
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

/** 右侧浮层(设置页等)开着就先收起:它的遮罩盖着整个窗口 */
async function closeFloat(win: Page) {
  const scrim = win.getByTestId("scrim");
  if (await scrim.count()) {
    await win.keyboard.press("Escape");
    await expect(scrim).toHaveCount(0);
  }
}

const contactRow = (win: Page, name: string) => win.getByTestId("list").locator('[data-testid^="contact-"]').filter({ hasText: name });

/** 通讯录里点开这位联系人的工作台,切到某一页 */
async function workbench(win: Page, name: string, tab: "duty" | "memory" | "settings" | "process") {
  await closeFloat(win);
  await win.getByTestId("nav-contacts").click();
  await contactRow(win, name).click();
  await expect(win.locator('[data-testid^="workbench-"] h1')).toHaveText(name, LONG);
  await win.getByTestId(`wb-tab-${tab}`).click();
}

/** 模型下拉里填一个目录里没有的模型 id */
async function typeModel(win: Page, select: string, id: string) {
  await win.getByTestId(select).selectOption(OTHER);
  await win.getByTestId(`${select}-other`).fill(id);
  await win.getByTestId(`${select}-other-ok`).click();
  await expect(win.getByTestId(select)).toHaveValue(id);
}

/** 往数据目录的能力库里放一个技能、一个工具(宿主读 <数据目录>/library/skills/<名>/SKILL.md 和 library/mcp/<名>.json) */
function seedLibrary(dataDir: string) {
  const skill = path.join(dataDir, "library", "skills", "review-notes");
  mkdirSync(skill, { recursive: true });
  writeFileSync(path.join(skill, "SKILL.md"), "---\nname: review-notes\ndescription: 按清单复核笔记\n---\n\n照清单逐条核对。\n");
  const mcp = path.join(dataDir, "library", "mcp");
  mkdirSync(mcp, { recursive: true });
  writeFileSync(path.join(mcp, "web-search.json"), JSON.stringify({ command: "node", args: ["-e", ""] }));
}

const rows = (win: Page) => win.getByTestId("chat-column").locator("[data-msg]");

test("职责与预设:默认职位就是联系人资料里那一句,改了存进后端;预设读写后端;后端不收时提示原因、界面还是原值;重开都还在", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-r2wb-"));
  let run = await launch(dataDir);
  try {
    await addContact(run.win, "小克");

    await test.step("默认职位:改成「发布负责人」,后端收下才算保存;工作台头部和通讯录读的都是这一句", async () => {
      const { win } = run;
      await workbench(win, "小克", "duty");
      await win.getByTestId("duty-default-edit").click();
      await win.getByTestId("duty-default-edit-input").fill("发布负责人");
      await win.getByTestId("duty-default-edit-save").click();
      await expect(win.getByTestId("toast")).toHaveText("已保存", LONG);
      await expect(win.getByTestId("duty-default-edit")).toHaveText("发布负责人");
      await expect(win.locator('[data-testid^="workbench-"] header')).toContainText("发布负责人");
      await expect(contactRow(win, "小克")).toContainText("发布负责人");
    });

    await test.step("后端不收(超过 2000 字):提示没保存上,界面还是原来那句", async () => {
      const { win } = run;
      await win.getByTestId("duty-default-edit").click();
      await win.getByTestId("duty-default-edit-input").fill("长".repeat(2001));
      await win.getByTestId("duty-default-edit-save").click();
      await expect(win.getByTestId("toast")).toContainText("没保存上", LONG);
      await expect(win.getByTestId("duty-default-edit")).toHaveText("发布负责人");
      await expect(contactRow(win, "小克")).toContainText("发布负责人");
    });

    await test.step("预设:读的是后端的(新联系人是空的);写一段保存,后端收下才写「已保存」", async () => {
      const { win } = run;
      const box = win.getByTestId("preset-edit");
      await expect(win.getByTestId("preset-state")).toHaveText("已保存", LONG);
      await expect(box).toHaveValue("");
      await box.fill("回答先给结论，再给依据。");
      await expect(win.getByTestId("preset-state")).toHaveText("有改动未保存");
      await win.getByTestId("preset-save").click();
      await expect(win.getByTestId("preset-state")).toHaveText("已保存", LONG);
      await expect(win.getByTestId("toast")).toHaveText("已保存");
      await shot(win, "wb-duty-live");
    });

    await test.step("改设置不往私聊里插本地灰字", async () => {
      const { win } = run;
      await win.getByTestId("wb-dm").click();
      await expect(win.getByTestId("chat").locator("header")).toContainText("小克", LONG);
      await expect(win.getByTestId("chat-column")).not.toContainText("你改了 小克 的设置");
    });

    await test.step("重开应用(同一个数据目录):默认职位、预设都还在", async () => {
      expect(run.errors, "页面不该抛错").toEqual([]);
      await run.app.close();
      run = await launch(dataDir);
      const { win } = run;
      await workbench(win, "小克", "duty");
      await expect(win.getByTestId("duty-default-edit")).toHaveText("发布负责人", LONG);
      await expect(win.getByTestId("preset-edit")).toHaveValue("回答先给结论，再给依据。", LONG);
      await expect(win.getByTestId("preset-state")).toHaveText("已保存");
      await expect(contactRow(win, "小克")).toContainText("发布负责人");
      expect(run.errors, "页面不该抛错").toEqual([]);
    });
  } finally {
    await run.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("能用的技能和工具:列表来自后端能力库,开着的是这位联系人勾选的;开关写进后端,重开还在", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-r2wb-"));
  seedLibrary(dataDir);
  let run = await launch(dataDir);
  try {
    await addContact(run.win, "小克");

    await test.step("列出能力库里的技能和工具(带说明),新联系人一个都没开;不是演示里那几样", async () => {
      const { win } = run;
      await workbench(win, "小克", "settings");
      const page = win.getByTestId("wb-settings");
      await expect(page.getByTestId("set-tool-review-notes")).toHaveCount(1, LONG);
      await expect(page.getByTestId("set-tool-web-search")).toHaveCount(1);
      await expect(page).toContainText("按清单复核笔记");
      await expect(page.getByTestId("set-tool-review-notes")).toHaveAttribute("aria-checked", "false");
      await expect(page.getByTestId("set-tool-web-search")).toHaveAttribute("aria-checked", "false");
      await expect(page).not.toContainText("读写代码仓库");
    });

    await test.step("打开技能和工具各一个:后端收下开关才变,提示已保存", async () => {
      const { win } = run;
      await win.getByTestId("set-tool-review-notes").click();
      await expect(win.getByTestId("set-tool-review-notes")).toHaveAttribute("aria-checked", "true", LONG);
      await expect(win.getByTestId("toast")).toHaveText("已保存");
      await win.getByTestId("set-tool-web-search").click();
      await expect(win.getByTestId("set-tool-web-search")).toHaveAttribute("aria-checked", "true", LONG);
      await shot(win, "wb-settings-tools-live");
    });

    await test.step("再关掉技能:职责页「允许用的技能和工具」只剩工具那一个", async () => {
      const { win } = run;
      await win.getByTestId("set-tool-review-notes").click();
      await expect(win.getByTestId("set-tool-review-notes")).toHaveAttribute("aria-checked", "false", LONG);
      await win.getByTestId("wb-tab-duty").click();
      await expect(win.getByTestId("wb-duty")).toContainText("web-search");
      await expect(win.getByTestId("wb-duty")).not.toContainText("review-notes");
    });

    await test.step("重开应用:开着的还是工具那一个", async () => {
      expect(run.errors, "页面不该抛错").toEqual([]);
      await run.app.close();
      run = await launch(dataDir);
      const { win } = run;
      await workbench(win, "小克", "settings");
      await expect(win.getByTestId("set-tool-web-search")).toHaveAttribute("aria-checked", "true", LONG);
      await expect(win.getByTestId("set-tool-review-notes")).toHaveAttribute("aria-checked", "false");
      expect(run.errors, "页面不该抛错").toEqual([]);
    });
  } finally {
    await run.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("模型:目录和全局默认读后端;改联系人说话模型和 Compute 个数、改全局默认 Compute 模型都存进后端,重开还在", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-r2wb-"));
  let run = await launch(dataDir);
  let before = "";
  try {
    await addContact(run.win, "小克");

    await test.step("联系人模型卡:下拉里是后端的模型,不是演示目录;能力库空着就写明没有可开的", async () => {
      const { win } = run;
      await workbench(win, "小克", "settings");
      const card = win.getByTestId("cm-card");
      await expect(card).toBeVisible();
      await expect(card).not.toContainText("GPT-6.1");
      before = await win.getByTestId("cm-talk").inputValue();
      expect(before, "说话模型是后端给的全局默认").not.toBe("");
      await expect(win.getByTestId("cm-speaking-summary")).toHaveText(`说话 → ${before}`);
      await expect(win.getByTestId("wb-settings")).toContainText("能力库是空的");
    });

    await test.step("说话模型:填一个模型 id 保存,后端收下才提示下一轮生效", async () => {
      const { win } = run;
      await typeModel(win, "cm-talk", "wb-talk-model");
      await win.getByTestId("cm-save").click();
      const note = win.getByTestId("next-turn");
      await expect(note).toContainText("已保存，下一轮生效", LONG);
      await expect(note).toContainText("小克 下一次说话用 wb-talk-model");
      await expect(win.getByTestId("cm-speaking-summary")).toHaveText("说话 → wb-talk-model");
      await expect(win.getByTestId("cm-talk")).toHaveValue("wb-talk-model");
    });

    await test.step("Compute 个数:从 2 调到 3 保存", async () => {
      const { win } = run;
      const quota = win.getByTestId("cm-quota");
      await expect(quota).toContainText("2 个");
      await quota.getByRole("slider").press("ArrowRight");
      await expect(quota).toContainText("3 个");
      await win.getByTestId("cm-save").click();
      await expect(win.getByTestId("cm-save")).toHaveCount(0, LONG);
      await expect(win.getByTestId("toast")).toHaveText("已保存");
      await expect(quota).toContainText("3 个");
      await shot(win, "wb-settings-model-live");
    });

    await test.step("全局默认 Compute 模型:填一个模型 id,先看到会影响小克,保存后它继承到新值", async () => {
      const { win } = run;
      await win.getByTestId("nav-settings").click();
      const box = win.getByTestId("model-defaults");
      await expect(box).toBeVisible();
      await expect(box).not.toContainText("GPT-6.1");
      await expect(win.getByTestId("def-compute")).toHaveValue(before);
      await typeModel(win, "def-compute", "wb-compute-model");
      await expect(win.getByTestId("impact-count")).toHaveText("会影响 1 位联系人");
      await win.getByTestId("defaults-save").click();
      await expect(win.getByTestId("defaults-saved")).toContainText("已保存", LONG);
      await expect(win.getByTestId("def-compute")).toHaveValue("wb-compute-model");
      await expect(win.getByTestId("model-overview")).toContainText("Compute wb-compute-model");
      await shot(win, "settings-defaults-live");
      await workbench(win, "小克", "settings");
      await expect(win.getByTestId("cm-summary")).toContainText("继承全局 → wb-compute-model");
    });

    await test.step("重开应用:说话模型、Compute 个数、全局默认 Compute 模型都还在", async () => {
      expect(run.errors, "页面不该抛错").toEqual([]);
      await run.app.close();
      run = await launch(dataDir);
      const { win } = run;
      await workbench(win, "小克", "settings");
      await expect(win.getByTestId("cm-talk")).toHaveValue("wb-talk-model", LONG);
      await expect(win.getByTestId("cm-quota")).toContainText("3 个");
      await expect(win.getByTestId("cm-summary")).toContainText("继承全局 → wb-compute-model");
      await win.getByTestId("nav-settings").click();
      await expect(win.getByTestId("def-compute")).toHaveValue("wb-compute-model", LONG);
      await expect(win.getByTestId("def-talk")).toHaveValue(before);
      expect(run.errors, "页面不该抛错").toEqual([]);
    });
  } finally {
    await run.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("合同里没有的如实关着:按群分工、卡死判定单独设、记忆都写明原因;「完整过程」连后端时读它的运行台账", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-r2wb-"));
  const run = await launch(dataDir);
  try {
    const { win } = run;
    await groupWith(win, "分工群", ["小克", "小林"]);

    await test.step("群里 @小克 派一件活,等它做完(运行台账里要有东西)", async () => {
      const box = win.getByTestId("composer");
      await box.fill("帮我整理周报 @小克");
      await box.press("Enter"); // 选人菜单开着:回车选中小克
      await expect(box).toHaveValue("帮我整理周报 @小克 ");
      await box.press("Enter");
      await expect(rows(win).filter({ hasText: "做完了:完成:整理周报" })).toHaveCount(1, LONG);
    });

    await test.step("职责页:按群分工关着并写明原因,没有按群填写的入口;默认职位照常能改", async () => {
      await workbench(win, "小克", "duty");
      const duty = win.getByTestId("wb-duty");
      await expect(duty).toContainText("还不能按群分工");
      await expect(duty.getByTestId("duty-conv-off")).toBeVisible();
      await expect(duty.locator('[data-testid^="duty-g-"]')).toHaveCount(0);
      await expect(duty.getByTestId("duty-default-edit")).toBeEnabled();
      await shot(win, "wb-duty-conv-off");
    });

    await test.step("设置页:卡死判定单独设关着并写明原因,没有开关", async () => {
      await win.getByTestId("wb-tab-settings").click();
      const card = win.getByTestId("cm-card");
      await expect(card).toContainText("卡死判定不能单独设");
      await expect(card.getByTestId("stall-off")).toBeVisible();
      await expect(card.getByTestId("stall-own")).toHaveCount(0);
      await expect(card.getByTestId("cm-adv")).toHaveCount(0);
      await shot(win, "wb-settings-stall-off");
    });

    await test.step("记忆页:关着并写明原因,没有纠正和删除按钮", async () => {
      await win.getByTestId("wb-tab-memory").click();
      const mem = win.getByTestId("wb-memory");
      await expect(mem).toContainText("记忆先关着");
      await expect(mem.getByTestId("wb-memory-off")).toBeVisible();
      await expect(mem.getByRole("button")).toHaveCount(0);
      await shot(win, "wb-memory-off");
    });

    await test.step("完整过程:写明后端没有逐句过程,列出它的运行台账(哪一轮、哪个 Compute、在哪个群、结果和用时)", async () => {
      await win.getByTestId("wb-tab-process").click();
      const pv = win.locator('[data-testid^="process-"][data-conv]');
      await expect(pv).toContainText("运行台账", LONG);
      await expect(pv).not.toContainText("还没有过程记录");
      const session = pv.locator('[data-testid="run-row"][data-layer="compute-session"]');
      await expect(session).toHaveCount(1, LONG);
      await expect(session).toContainText("整理周报");
      await expect(session).toContainText("分工群");
      await expect(pv.locator('[data-testid="run-row"][data-layer="contact-round"]').first()).toBeVisible();
      await expect(pv.getByTestId("run-row").filter({ hasText: "完成 · 用时" }).first()).toBeVisible(LONG);
      await shot(win, "wb-process-runs");
    });

    expect(run.errors, "页面不该抛错").toEqual([]);
  } finally {
    await run.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("批量替换:把正在用的模型换成另一个,真的改到后端(全局默认和直接写了它的联系人),重开还在", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-r2wb-"));
  let run = await launch(dataDir);
  let from = "";
  try {
    await addContact(run.win, "小克");

    await test.step("设置页「默认」读的是后端的全局默认,不是演示目录", async () => {
      const { win } = run;
      await win.getByTestId("nav-settings").click();
      const box = win.getByTestId("model-defaults");
      await expect(box).toBeVisible();
      await expect(box).not.toContainText("GPT-6.1");
      from = await win.getByTestId("def-talk").inputValue();
      expect(from, "默认说话模型是后端给的").not.toBe("");
      await expect(win.getByTestId("def-compute")).toHaveValue(from);
    });

    await test.step("批量替换:预览列出全局默认两处和小克的说话模型,确认后后端真的换了", async () => {
      const { win } = run;
      await win.getByTestId("open-batch").click();
      const dlg = win.getByTestId("batch-dialog");
      await expect(dlg).toBeVisible();
      await expect(win.getByTestId("br-from")).toHaveValue(from);
      await typeModel(win, "br-to", "wb-batch-model");
      await expect(win.getByTestId("br-explicit-n")).toHaveText("3");
      await expect(win.getByTestId("br-explicit")).toContainText("小克");
      await expect(win.getByTestId("br-inheritors-n")).toHaveText("1");
      await expect(win.getByTestId("br-conflicts-n")).toHaveText("0");
      await shot(win, "batch-replace-live");
      await win.getByTestId("br-confirm").click();
      await expect(win.getByTestId("toast")).toHaveText(`已把 ${from} 换成 wb-batch-model`, LONG);
      await expect(dlg).toHaveCount(0);
      await expect(win.getByTestId("def-talk")).toHaveValue("wb-batch-model");
      await expect(win.getByTestId("def-compute")).toHaveValue("wb-batch-model");
      await expect(win.getByTestId("model-overview")).toContainText("说话 wb-batch-model");
    });

    await test.step("小克的工作台设置跟着是新模型", async () => {
      const { win } = run;
      await workbench(win, "小克", "settings");
      await expect(win.getByTestId("cm-talk")).toHaveValue("wb-batch-model");
      await expect(win.getByTestId("cm-summary")).toContainText("继承全局 → wb-batch-model");
    });

    await test.step("重开应用:全局默认和小克的说话模型都还是新模型", async () => {
      expect(run.errors, "页面不该抛错").toEqual([]);
      await run.app.close();
      run = await launch(dataDir);
      const { win } = run;
      await workbench(win, "小克", "settings");
      await expect(win.getByTestId("cm-talk")).toHaveValue("wb-batch-model", LONG);
      await win.getByTestId("nav-settings").click();
      await expect(win.getByTestId("def-talk")).toHaveValue("wb-batch-model", LONG);
      await expect(win.getByTestId("def-compute")).toHaveValue("wb-batch-model");
      await expect(win.getByTestId("model-overview")).toContainText("说话 wb-batch-model");
      expect(run.errors, "页面不该抛错").toEqual([]);
    });
  } finally {
    await run.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
