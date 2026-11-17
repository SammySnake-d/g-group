// 用打好的安装包(不是开发版)自测:群里两位联系人同时在回,「在想」不被挤占、已有消息不重刷、列表不跳。
// 用法:node proof/preview-1/selftest-replying.mjs <g-group 二进制> <截图目录>
// 后端是包里自带的真实宿主;联系人脑子与 Compute 用规则替身(GG_MIND=fake / GG_COMPUTE=fake),每轮想 8 秒。数据目录是临时的,不碰用户数据。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const [bin, shots] = process.argv.slice(2);
if (!bin || !shots) { console.error("用法:selftest-replying.mjs <二进制> <截图目录>"); process.exit(2); }
mkdirSync(shots, { recursive: true });
const ud = mkdtempSync(path.join(tmpdir(), "gg-preview-ud-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k !== "ELECTRON_RUN_AS_NODE" && typeof v === "string"));
const LONG = { timeout: 30_000 };
const steps = [];
const ok = (s) => { steps.push(s); console.log("✓", s); };

const app = await electron.launch({ executablePath: bin, env: { ...env, GG_USER_DATA_DIR: ud, GG_UPDATE_AUTO: "off", GG_MIND: "fake", GG_COMPUTE: "fake", GG_MIND_DELAY_MS: "8000" } });
let code = 0;
try {
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForLoadState("domcontentloaded");
  const info = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged }));
  if (!info.packaged) throw new Error("这不是打包版");
  ok(`打包版 ${info.version} 启动`);
  const mark = win.getByTestId("backend-demo");
  await expect(mark).toHaveAttribute("data-mode", "connected", LONG);
  await expect(mark).toHaveAttribute("data-wire", "live", LONG);
  ok("连上包里自带的真实后端");

  const addContact = async (name) => {
    await win.getByTestId("nav-contacts").click();
    await win.getByTestId("list").getByText("添加联系人", { exact: true }).click();
    await win.getByPlaceholder("比如：设计师").fill(name);
    await win.getByRole("button", { name: "添加", exact: true }).click();
    await expect(win.getByTestId("chat").locator("header")).toContainText(name, LONG);
  };
  for (const n of ["小克", "小林"]) await addContact(n);
  await win.getByTestId("nav-contacts").click();
  await win.getByTestId("list").getByText("发起群聊", { exact: true }).click();
  await win.getByLabel("群名").fill("同时回");
  for (const n of ["小克", "小林"]) await win.locator("label").filter({ hasText: n }).getByRole("checkbox").click();
  await win.getByRole("button", { name: "创建群聊（3 人）" }).click();
  await expect(win.getByTestId("chat-title")).toContainText("同时回", LONG);
  ok("建了两位联系人和一个群");

  const say = async (text, at) => {
    const box = win.getByTestId("composer");
    await box.fill(`${text} @${at}`);
    await box.press("Enter");
    await expect(box).toHaveValue(`${text} @${at} `);
    await box.press("Enter");
  };
  const column = win.getByTestId("chat-column");
  const said = (text) => column.locator('[data-msg]:not([data-from="me"]):not([data-msg$="~c"]):not([data-testid^="replying-"])').filter({ hasText: text });
  const all = win.getByTestId("typing").locator('[data-testid^="replying-"]:not([data-testid^="replying-phase-"])');
  const card = (name) => all.filter({ has: win.getByText(name, { exact: true }) });
  const ke = card("小克"), lin = card("小林");

  await say("帮我慢慢整理资料", "小克");
  await expect(said("好的,我安排 Compute 去")).toHaveCount(1, LONG);
  await expect(async () => { expect(await ke.count()).toBe(1); expect(await all.count()).toBe(1); }).toPass({ timeout: 90_000 });
  ok("小克在想(只有它一张卡)");
  const marked = await win.evaluate(() => {
    const col = document.querySelector('[data-testid="chat-column"]');
    const nodes = Array.from(col.querySelectorAll("[data-msg]"));
    nodes.forEach((el, i) => { el.dataset.mark = el.matches('[data-testid^="replying-"]') ? "ke" : `m${i}`; });
    window.__gone = [];
    new MutationObserver((recs) => { for (const r of recs) for (const n of Array.from(r.removedNodes)) { if (!(n instanceof HTMLElement)) continue; for (const h of [n, ...Array.from(n.querySelectorAll("[data-mark]"))]) if (h.dataset.mark) window.__gone.push(h.dataset.mark); } }).observe(col, { childList: true, subtree: true });
    return nodes.length;
  });

  await say("你好", "小林");
  await expect(lin).toHaveCount(1, LONG);
  await expect(ke).toHaveCount(1);
  await expect(ke).toHaveAttribute("data-mark", "ke");
  await expect(all).toHaveCount(2);
  await expect(all.first()).toHaveAttribute("data-mark", "ke");
  await win.screenshot({ path: path.join(shots, "packaged-replying-two.png") });
  ok("小林也开始想:两张卡并存,小克那张没被挤掉、还是原来那个节点、排在上面");

  await expect(said("收到:你好 @小林")).toHaveCount(1, LONG);
  await expect(lin).toHaveCount(0);
  await expect(ke).toHaveCount(1);
  await expect(ke).toHaveAttribute("data-mark", "ke");
  await expect(ke).toContainText("在想");
  await expect(column.locator('[data-msg][data-mark^="m"]')).toHaveCount(marked - 1);
  expect(await win.evaluate(() => window.__gone)).toEqual([]);
  ok(`小林回完:只收掉它自己那张;小克还在想;原有 ${marked - 1} 条消息一条没被重新挂载`);
  const scroller = win.locator('[data-scroll="chat"]');
  await expect.poll(async () => scroller.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)), { timeout: 5000 }).toBeLessThanOrEqual(2);
  await expect(ke).toBeInViewport();
  await win.screenshot({ path: path.join(shots, "packaged-replying-one-left.png") });
  ok("列表仍贴着底,小克那张卡在最下面看得见");

  await expect(said("进度:")).toHaveCount(1, LONG);
  await expect(all).toHaveCount(0, LONG);
  ok("小克随后照常回完,它的卡才收掉");
  expect(errors).toEqual([]);
  ok("页面没有抛错");
  console.log(`\n通过 ${steps.length} 步`);
} catch (e) {
  code = 1;
  console.error("✗ 失败:", e.message);
} finally {
  await app.close().catch(() => {});
  rmSync(ud, { recursive: true, force: true });
}
process.exit(code);
