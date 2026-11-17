import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { shot } from "./shots";

// 群聊里两位联系人同时在回(用户 DM 3401:一位显示在想,另一位回完就把它挤掉,像消息消失了一样)。
// 连真实后端(GG_BACKEND=server)、规则替身脑子每轮想 8 秒、桌面替身 Compute;只点界面、只读界面。
// 两位的结束时刻靠宿主自己的机制错开,不调 window.gg:
//   小克接了慢活 → 约 20 秒后 Compute 报第 1 步 → 小克开始想(里程碑只叫醒负责人,这一轮只有它在想);
//   这时你 @小林 说一句 → 小林也开始想;小克这一轮到点时宿主发现有更新的用户消息,放弃这轮结果重想(AC-31 ④,不推空闲);
//   于是小林先回完,小克还在想——这一刻小克那张卡和已有的消息都得原样留着。
const appDir = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0] !== "ELECTRON_RUN_AS_NODE" && typeof e[1] === "string"));
const LONG = { timeout: 30_000 };
const THINK_MS = 8000;

async function launch(dataDir: string): Promise<{ app: ElectronApplication; win: Page; errors: string[] }> {
  const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...env, GG_BACKEND: "server", GG_DATA_DIR: dataDir, GG_MIND: "fake", GG_COMPUTE: "fake", GG_MIND_DELAY_MS: String(THINK_MS) } });
  const win = await app.firstWindow();
  const errors: string[] = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  const mark = win.getByTestId("backend-demo");
  await expect(mark).toHaveAttribute("data-mode", "connected", LONG);
  await expect(mark).toHaveAttribute("data-wire", "live", LONG);
  return { app, win, errors };
}

async function addContact(win: Page, name: string) {
  await win.getByTestId("nav-contacts").click();
  await win.getByTestId("list").getByText("添加联系人", { exact: true }).click();
  await win.getByPlaceholder("比如：设计师").fill(name);
  await win.getByRole("button", { name: "添加", exact: true }).click();
  await expect(win.getByTestId("chat").locator("header")).toContainText(name, LONG);
}

async function groupWith(win: Page, title: string, names: string[]) {
  for (const n of names) await addContact(win, n);
  await win.getByTestId("nav-contacts").click();
  await win.getByTestId("list").getByText("发起群聊", { exact: true }).click();
  await win.getByLabel("群名").fill(title);
  for (const n of names) await win.locator("label").filter({ hasText: n }).getByRole("checkbox").click();
  await win.getByRole("button", { name: `创建群聊（${names.length + 1} 人）` }).click();
  await expect(win.getByTestId("chat-title")).toContainText(title, LONG);
}

/** 在群里 @ 某人说一句(选人菜单开着时回车选中) */
async function say(win: Page, text: string, at: string) {
  const box = win.getByTestId("composer");
  await box.fill(`${text} @${at}`);
  await box.press("Enter");
  await expect(box).toHaveValue(`${text} @${at} `);
  await box.press("Enter");
}

const column = (win: Page) => win.getByTestId("chat-column");
const rows = (win: Page) => column(win).locator("[data-msg]");
/** 联系人说的那几条里含这句的(不算你发的,不算正在回复卡,不算 Compute 那一行) */
const said = (win: Page, text: string): Locator => column(win).locator('[data-msg]:not([data-from="me"]):not([data-msg$="~c"]):not([data-testid^="replying-"])').filter({ hasText: text });
const allReplying = (win: Page): Locator => win.getByTestId("typing").locator('[data-testid^="replying-"]:not([data-testid^="replying-phase-"])');
/** 某位联系人的「正在回复」卡:按卡头上的名字认(整段文字正好是名字),不认卡里引用的那句——那句里可能 @ 了别人 */
const replying = (win: Page, name: string): Locator => allReplying(win).filter({ has: win.getByText(name, { exact: true }) });

test("群里两位联系人同时在回:各有一张正在回复卡;一位回完,另一位的卡和已有消息原样留着,列表不重刷不跳", async () => {
  test.setTimeout(240_000);
  const dataDir = mkdtempSync(path.join(tmpdir(), "gg-replying-"));
  const { app, win, errors } = await launch(dataDir);
  try {
    await groupWith(win, "同时回", ["小克", "小林"]);
    await say(win, "帮我慢慢整理资料", "小克");
    await expect(said(win, "好的,我安排 Compute 去")).toHaveCount(1, LONG);
    // 头一阵两位都在看这句(小林没被 @,看完没话说);等这一阵过去,Compute 报第 1 步时只叫醒小克——这一刻只有它一张卡
    const ke = replying(win, "小克");
    const lin = replying(win, "小林");
    await expect(async () => {
      expect(await ke.count()).toBe(1);
      expect(await allReplying(win).count()).toBe(1);
    }).toPass({ timeout: 90_000 });
    // 给现有的每条消息和小克那张卡做记号:节点被换掉(重新挂载)记号就没了;再盯着有没有带记号的节点被从页面上拿掉
    const marked = await win.evaluate(() => {
      const col = document.querySelector('[data-testid="chat-column"]')!;
      const nodes = Array.from(col.querySelectorAll<HTMLElement>("[data-msg]"));
      nodes.forEach((el, i) => { el.dataset.mark = el.matches('[data-testid^="replying-"]') ? "ke" : `m${i}`; });
      const gone: string[] = [];
      (window as unknown as { __gone: string[] }).__gone = gone;
      new MutationObserver((recs) => {
        for (const r of recs) for (const n of Array.from(r.removedNodes)) {
          if (!(n instanceof HTMLElement)) continue;
          for (const h of [n, ...Array.from(n.querySelectorAll<HTMLElement>("[data-mark]"))]) if (h.dataset.mark) gone.push(h.dataset.mark);
        }
      }).observe(col, { childList: true, subtree: true });
      return nodes.length;
    });
    expect(marked).toBeGreaterThanOrEqual(3);
    await expect(ke).toHaveAttribute("data-mark", "ke");

    // 你 @小林 说一句:小林也开始想。两张卡同时在,先开始的小克在上
    await say(win, "你好", "小林");
    await expect(lin).toHaveCount(1, LONG);
    await expect(ke, "小林开始想时,小克那张卡不该被挤掉").toHaveCount(1);
    await expect(ke).toHaveAttribute("data-mark", "ke");
    await expect(allReplying(win)).toHaveCount(2);
    await expect(allReplying(win).first()).toHaveAttribute("data-mark", "ke");
    await expect(ke).toContainText("在想");
    await expect(lin).toContainText("在想");
    await shot(win, "replying-two");

    // 小林先回完:它的卡收掉、回复出现;小克还在想,它那张卡还是原来那个节点,排在最下面
    await expect(said(win, "收到:你好 @小林")).toHaveCount(1, LONG);
    await expect(lin).toHaveCount(0);
    await expect(ke, "小林回完时,还在想的小克那张卡不该消失").toHaveCount(1);
    await expect(ke).toHaveAttribute("data-mark", "ke");
    await expect(ke).toContainText("在想");
    await expect(allReplying(win)).toHaveCount(1);
    // 已有的消息一条没少、没被换掉;整个过程里没有带记号的节点被拿掉过
    await expect(column(win).locator('[data-msg][data-mark^="m"]')).toHaveCount(marked - 1);
    expect(await win.evaluate(() => (window as unknown as { __gone: string[] }).__gone), "已有消息和还在想的那张卡不该被重新挂载").toEqual([]);
    // 列表还贴着底,小克那张卡在最下面看得见(没有被推走,也没有跳开)
    const scroller = win.locator('[data-scroll="chat"]');
    await expect.poll(async () => scroller.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)), { timeout: 5000 }).toBeLessThanOrEqual(2);
    await expect(ke).toBeInViewport();
    expect(await rows(win).last().getAttribute("data-mark")).toBe("ke");
    await shot(win, "replying-one-left");

    // 小克随后照常回完,它的卡才收掉
    await expect(said(win, "进度:")).toHaveCount(1, LONG);
    expect(errors, "页面不该抛错").toEqual([]);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
