import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// 第二轮「连着后端不再本地假装」· Helper、插件残留与群模板(连真实后端:GG_BACKEND=server、规则替身脑子、替身 Compute;只点界面、只读界面)。
//   F-HELPER3 / F-STORY-A / F-STORY-B:合同里没有让 Helper 生成回答的方法 → 面板与 ⌘K 如实写「还不会回答」,不出剧本回答、
//     拖进来的 CSV 不再变成写死 4 行的清单卡;⌘K 里纯界面跳转的命令照常能用。
//   F-PLUGIN / F-AUTHFAIL:宿主里的插件对所有聊天生效 → 详情里不出「挂到 / 摘下 / 谁能调用」,写明原因;卸载不往会话插本地灰字;
//     外发预授权后端没有这一项(plugins.configure 只存插件自己的配置,外发前不核对范围)→ 如实关着,不出「模拟授权失效」。
//   F-CLONE:群模板第 2 步读真实公告与联系人预设(contacts.profile),协作手册以后再定;创建新群 = rooms.createGroup + 逐条 announcements.add,
//     新群里看得到带过去的公告,重开应用还在。
// 前置里有两处经桥(window.gg)直接调合同,只为造出界面上造不出来的起点,验收仍只看界面:
//   装插件——发现页按用户决定暂不接插件市场,界面上装不了;写联系人预设——改预设在工作台那一块。
const appDir = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "ELECTRON_RUN_AS_NODE" && typeof e[1] === "string"));
const LONG = { timeout: 30_000 };
const HELPER_OFF = "Helper 还不会回答：后端还没有让 Helper 生成回答的方法";

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
const side = (win: Page) => win.getByTestId("group-side");
async function openTab(win: Page, tab: "members" | "notice" | "list" | "cron" | "plugin" | "tools") {
  if (!(await side(win).isVisible())) await win.getByTestId("head-side").click();
  await win.getByTestId(`side-tab-${tab}`).click();
}

async function addNotice(win: Page, text: string, count: number) {
  await openTab(win, "notice");
  await win.getByTestId("notice-add").click();
  await win.getByTestId("notice-input").fill(text);
  await win.getByTestId("notice-save").click();
  await expect(win.getByTestId("notice-block")).toHaveAttribute("data-count", String(count), LONG);
}

/** 正开着的这个群的公告正好是这几条(texts 按发布先后,至少两条)。右侧分屏可能还停在别的群的群资料上,所以从这个群自己的顶栏公告条进:
 *  公告条先显示最新的一条、能翻 N 条;点它打开这个群的群资料「公告」页,展开列表逐条看 */
async function expectNotices(win: Page, texts: string[]) {
  await expect(win.getByTestId("strip-text")).toContainText(`群公告：${texts[texts.length - 1]}`, LONG);
  await expect(win.getByTestId("strip-next")).toContainText(`1/${texts.length}`, LONG);
  await win.getByTestId("strip-text").click();
  await expect(win.getByTestId("notice-block")).toHaveAttribute("data-count", String(texts.length), LONG);
  const list = win.getByTestId("notice-list");
  if (!(await list.isVisible())) await win.getByTestId("notice-title").click();
  await expect(list.locator("li")).toHaveCount(texts.length);
  for (const t of texts) await expect(list).toContainText(t);
}

/** 经桥调一次合同(只用于造前置) */
type R = { ok: boolean; value?: unknown; error?: { message: string } };
const invoke = (win: Page, method: string, params: unknown): Promise<R> =>
  win.evaluate(([m, p]) => (window as unknown as { gg: { invoke: (m: string, p: unknown) => Promise<R> } }).gg.invoke(m as string, p), [method, params] as const);

test("Helper 连着后端:面板与 ⌘K 不用提问就写明还不会回答,不出剧本回答,拖进 CSV 不出清单卡;⌘K 的跳转命令照常能用", async () => {
  test.setTimeout(150_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-honest-helper-"));
  const { app, win, errors } = await launch(dataDir);
  try {
    await addContact(win, "小克");

    await test.step("聊天里的 Helper 面板:一打开就写明还不会回答,没有快捷问题、模拟拖入和输入框", async () => {
      await win.getByTestId("head-helper").click();
      const panel = win.getByTestId("helper-panel");
      await expect(panel).toContainText(HELPER_OFF);
      await expect(panel.locator('[data-testid^="hp-chip-"]')).toHaveCount(0);
      await expect(panel.getByTestId("hp-drop-csv")).toHaveCount(0);
      await expect(panel.getByTestId("hp-input")).toHaveCount(0);
      await expect(panel).not.toContainText("想另拉个群、把表格转成清单");
      await shot(win, "F-HELPER3-panel-off");
    });

    await test.step("把一个 CSV 拖进面板:不读成写死的 4 行、不出「建成本群清单」的确认卡", async () => {
      const panel = win.getByTestId("helper-panel");
      const dt = await win.evaluateHandle(() => {
        const d = new DataTransfer();
        d.items.add(new File(["标题\n飞书接入方案\n"], "功能清单.csv", { type: "text/csv" }));
        return d;
      });
      await panel.dispatchEvent("dragover", { dataTransfer: dt });
      await panel.dispatchEvent("drop", { dataTransfer: dt });
      await expect(panel.getByTestId("hp-csv-confirm")).toHaveCount(0);
      await expect(panel).not.toContainText("飞书接入方案");
      await expect(panel).not.toContainText("功能清单.csv");
      await expect(panel).toContainText(HELPER_OFF);
    });

    await test.step("⌘K:一打开就写明还不会回答;没有「试试」问 Helper 的两条和「代我发」;打一句话回车也不出回答", async () => {
      await win.keyboard.press("Control+k");
      const hg = win.getByTestId("helper-global");
      await expect(hg).toBeVisible();
      await expect(hg).toContainText(HELPER_OFF);
      await expect(hg.getByTestId("hg-cmd-read")).toHaveCount(0);
      await expect(hg.getByTestId("hg-cmd-send")).toHaveCount(0);
      await expect(hg.getByTestId("hg-cmd-say")).toHaveCount(0);
      const input = win.getByTestId("hg-input");
      await input.fill("总结一下今天说了什么");
      await input.press("Enter");
      await expect(hg).not.toContainText("我现在没有读取任何聊天");
      await expect(hg).not.toContainText("要读「");
      await expect(hg.getByTestId("hg-draft-body")).toHaveCount(0);
      await shot(win, "F-HELPER3-cmdk-off");
      await input.fill("");
    });

    await test.step("⌘K 的命令照常跳转:新建联系人、发起群聊、装插件", async () => {
      await win.getByTestId("hg-cmd-contact").click();
      await expect(win.getByTestId("helper-global")).toHaveCount(0);
      await expect(win.getByPlaceholder("比如：设计师")).toBeVisible();
      await win.keyboard.press("Control+k");
      await win.getByTestId("hg-cmd-group").click();
      await expect(win.getByLabel("群名")).toBeVisible();
      await win.keyboard.press("Control+k");
      await win.getByTestId("hg-cmd-plugins").click();
      await expect(win.getByTestId("plugin-center")).toBeVisible();
    });

    expect(errors, "页面不该抛错").toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("插件连着后端:详情里不出挂到 / 摘下 / 谁能调用并写明对所有聊天生效;外发预授权如实关着;卸载不往会话插灰字", async () => {
  test.setTimeout(150_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-honest-plugin-"));
  const { app, win, errors } = await launch(dataDir);
  try {
    await groupWith(win, "插件群", ["小克", "小林"]);
    // 前置:替身宿主的市场里有 webhook-out(输出渠道),发现页暂不接市场,经桥装上;装好后由 plugin.updated 推到界面
    const r = await invoke(win, "plugins.install", { clientActionId: "e2e-honest-webhook", source: { kind: "marketplace", id: "webhook-out" }, grantedPermissions: ["net:post"] });
    expect(r.ok, JSON.stringify(r.error ?? null)).toBe(true);

    await win.getByTestId("nav-plugins").click();
    await win.getByTestId("plg-tab-installed").click();
    const row = win.getByTestId("plg-row-webhook-out");
    await expect(row).toBeVisible(LONG);

    await test.step("已安装那一行写对所有聊天生效,不写「还没有助手能调用」", async () => {
      await expect(row).toContainText("对所有聊天生效");
      await expect(row).not.toContainText("还没有助手能调用");
    });

    await test.step("插件详情「在哪里生效」:没有挂到 / 摘下 / 谁能调用,写明插件对所有聊天生效、后端不分会话挂载", async () => {
      await row.click();
      const detail = win.getByTestId("plg-detail-webhook-out");
      await expect(detail).toBeVisible();
      await expect(detail.locator('[data-testid^="plg-conv-"]')).toHaveCount(0);
      await expect(detail.locator('[data-testid^="plg-caller-"]')).toHaveCount(0);
      await expect(detail.getByTestId("plg-where")).toContainText("插件对所有聊天生效，后端不分会话挂载");
    });

    await test.step("外发预授权:写明后端没有这一项;没有设置授权、模拟授权失效、重新授权", async () => {
      const grant = win.getByTestId("plg-grant");
      await expect(grant).toContainText("后端没有外发预授权这一项");
      await expect(grant.getByTestId("plg-grant-edit")).toHaveCount(0);
      await expect(grant.getByTestId("plg-revoke")).toHaveCount(0);
      await expect(grant.getByTestId("plg-reauth")).toHaveCount(0);
      await shot(win, "F-PLUGIN-detail-live");
    });

    await test.step("卸载:后端卸掉、已安装里没了;会话里没有本地插的「你卸载了插件」灰字", async () => {
      await win.getByTestId("plg-detail-uninstall").click();
      await win.getByTestId("plg-uninstall-yes").click();
      await win.getByTestId("plg-tab-installed").click();
      await expect(win.getByTestId("plg-row-webhook-out")).toHaveCount(0, LONG);
      await win.getByTestId("nav-chat").click();
      await convItem(win, "插件群").click();
      await expect(win.getByTestId("chat-title")).toContainText("插件群");
      await expect(win.getByTestId("composer")).toBeVisible();
      await expect(win.getByTestId("chat-column")).not.toContainText("卸载了插件");
    });

    expect(errors, "页面不该抛错").toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("群模板:从有两条公告的群复制出新群,第 2 步读真实公告与联系人预设、写明协作手册以后再定;新群里有那两条公告,重开应用还在", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-honest-clone-"));
  let { app, win, errors } = await launch(dataDir);
  try {
    await groupWith(win, "原群", ["小克", "小林"]);
    // 前置:给小克写一份预设(改预设的界面在工作台那一块),第 2 步要从 contacts.profile 读到它
    const contacts = (await invoke(win, "contacts.list", {})).value as { contacts: { id: string; name: string }[] };
    const ke = contacts.contacts.find((c) => c.name === "小克");
    expect(ke, "小克在后端").toBeTruthy();
    expect((await invoke(win, "contacts.update", { contactId: ke!.id, persona: "我是小克，管前端界面" })).ok).toBe(true);

    await addNotice(win, "派活先 @ 对应的人", 1);
    await addNotice(win, "周五不发版", 2);

    await test.step("工具页里有「复制团队」;第 1 步起名、两位成员都在", async () => {
      await openTab(win, "tools");
      await expect(win.getByTestId("tool-clone")).toHaveCount(1);
      await win.getByTestId("tool-clone").click();
      await expect(win.getByTestId("clone-step-1")).toContainText("小克");
      await expect(win.getByTestId("clone-step-1")).toContainText("小林");
      await win.getByTestId("clone-title").fill("原群·二期");
      await win.getByTestId("clone-next").click();
    });

    await test.step("第 2 步:群规是两条真实公告,成员预设读自后端(只读),写明协作手册以后再定", async () => {
      const step = win.getByTestId("clone-step-2");
      await expect(step).toContainText("派活先 @ 对应的人");
      await expect(step).toContainText("周五不发版");
      await expect(step).toContainText("我是小克，管前端界面", LONG);
      await expect(step).toContainText("协作手册以后再定");
      await expect(win.getByTestId("clone-local-toggle")).toHaveCount(0);
      // 两位成员的预设只读(没有勾选框);两条公告各一项、可以取消勾选
      await expect(step.locator('[data-testid^="clone-item-mem-"]')).toHaveCount(2);
      await expect(step.locator('[data-testid^="clone-item-mem-"]').getByRole("checkbox")).toHaveCount(0);
      await expect(step.locator('[data-testid^="clone-item-rule-"]').getByRole("checkbox")).toHaveCount(2);
      await shot(win, "F-CLONE-step2");
      await win.getByTestId("clone-next").click();
    });

    await test.step("第 3 步确认后创建:切到新群,新群公告页有带过去的两条", async () => {
      await expect(win.getByTestId("clone-keep")).toContainText("周五不发版");
      await win.getByTestId("clone-go").click();
      await expect(win.getByTestId("chat-title")).toContainText("原群·二期", LONG);
      await expectNotices(win, ["派活先 @ 对应的人", "周五不发版"]);
      await shot(win, "F-CLONE-new-group");
    });
    expect(errors, "页面不该抛错").toEqual([]);

    await test.step("关掉应用、用同一个数据目录重开:新群和它的两条公告还在", async () => {
      await app.close();
      ({ app, win, errors } = await launch(dataDir));
      await convItem(win, "原群·二期").click();
      await expect(win.getByTestId("chat-title")).toContainText("原群·二期", LONG);
      await expectNotices(win, ["派活先 @ 对应的人", "周五不发版"]);
    });
    expect(errors, "页面不该抛错").toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
