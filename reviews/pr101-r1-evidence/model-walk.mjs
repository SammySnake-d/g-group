// PR #101 第 1 轮审查:打包版里「选模型」这条路实点(设置页全局默认 → 保存 → 再发私聊)。
// 用法同 p0-walk.mjs:node model-walk.mjs <二进制> <输出目录> <网关> <模型>
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(path.join(process.env.GG_DESKTOP_DIR, "package.json"));
const { _electron: electron } = require("@playwright/test");

const [bin, out, baseUrl, model] = process.argv.slice(2);
const token = process.env.GG_REVIEW_TOKEN;
const pickTo = process.env.GG_REVIEW_PICK || "";
mkdirSync(out, { recursive: true });
const ud = mkdtempSync(path.join(tmpdir(), "gg-pr101-ud-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => !["ELECTRON_RUN_AS_NODE", "GG_REVIEW_TOKEN"].includes(k) && !k.startsWith("ANTHROPIC_") && typeof v === "string"));
const result = { head: "143f72d179fa0db9edc224be9232a1aa2b0ab250", model, userData: ud, steps: [] };
let n = 0;
const save = () => writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
const app = await electron.launch({ executablePath: bin, env: { ...env, GG_USER_DATA_DIR: ud, GG_UPDATE_AUTO: "off", GG_COMPUTE: "fake" } });
const win = await app.firstWindow();
const errors = [];
win.on("pageerror", (e) => errors.push(e.message));
const body = async (k = 900) => (await win.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(-k);
const step = async (name, fn) => {
  const t0 = Date.now();
  let rec;
  try { rec = { name, ok: true, note: await fn() }; console.log("✓", name, JSON.stringify(rec.note)); }
  catch (e) { rec = { name, ok: false, error: String(e.message).slice(0, 900), text: await body().catch(() => "") }; console.log("✗", name, rec.error, "| 页面:", rec.text); }
  rec.ms = Date.now() - t0;
  rec.shot = `${String(++n).padStart(2, "0")}-${name}.png`;
  await win.screenshot({ path: path.join(out, rec.shot) }).catch(() => {});
  result.steps.push(rec); save();
};
const LONG = { timeout: 30_000 };
const column = win.getByTestId("chat-column");
const others = () => column.locator('[data-msg]:not([data-from="me"]):not([data-testid^="replying-"])');
const selInfo = (id) => win.getByTestId(id).evaluate((e) => ({ value: e.value, shown: e.selectedOptions[0]?.textContent ?? null, selectedIndex: e.selectedIndex, options: Array.from(e.options).map((o) => o.value) }));

await win.waitForLoadState("domcontentloaded");
await step("接入模型", async () => {
  await win.getByTestId("setup-screen").waitFor(LONG);
  await win.getByTestId("setup-base-url").fill(baseUrl);
  await win.getByTestId("setup-token").fill(token);
  await win.getByTestId("setup-model").fill(model);
  await win.getByTestId("setup-save").click();
  await win.waitForFunction(() => { const m = document.querySelector('[data-testid="backend-demo"]'); return m?.getAttribute("data-mode") === "connected" && m?.getAttribute("data-wire") === "live"; }, null, LONG);
  return `接入 ${model}`;
});
await step("添加联系人 小克", async () => {
  await win.getByTestId("nav-contacts").click();
  await win.getByTestId("list").getByText("添加联系人", { exact: true }).click();
  await win.getByPlaceholder("比如：设计师").fill("小克");
  await win.getByRole("button", { name: "添加", exact: true }).click();
  await win.getByTestId("chat").locator("header").filter({ hasText: "小克" }).waitFor(LONG);
});
await step("设置页的模型选择", async () => {
  await win.getByTestId("nav-settings").click();
  await win.getByTestId("model-defaults").waitFor(LONG);
  return { 说话: await selInfo("def-talk"), Compute: await selInfo("def-compute"), 接入行: (await win.getByTestId("settings-gateway").innerText()).replace(/\s+/g, " ") };
});
if (pickTo) {
  await step(`把默认说话模型改成 ${pickTo}`, async () => {
    await win.getByTestId("def-talk").selectOption(pickTo);
    await win.getByTestId("def-compute").selectOption(pickTo);
    await win.getByTestId("defaults-impact").waitFor(LONG);
    const impact = (await win.getByTestId("defaults-impact").innerText()).replace(/\s+/g, " ").slice(0, 400);
    const disabled = await win.getByTestId("defaults-save").isDisabled();
    if (disabled) throw new Error("保存按钮是灰的:" + impact);
    await win.getByTestId("defaults-save").click();
    await win.waitForTimeout(2500);
    return { 影响预览: impact, 保存后说话: await selInfo("def-talk"), 保存后页面: await body(500) };
  });
  await step("改完再发私聊", async () => {
    await win.keyboard.press("Escape"); await win.waitForTimeout(400);
    if (await win.getByTestId("scrim").count()) await win.getByTestId("scrim").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await win.getByTestId("nav-contacts").click();
    await win.getByTestId("list").getByText("添加联系人", { exact: true }).click();
    await win.getByPlaceholder("比如：设计师").fill("小新");
    result.addNote = await win.getByTestId("add-model-note").innerText().catch(() => "");
    await win.getByRole("button", { name: "添加", exact: true }).click();
    await win.getByTestId("chat").locator("header").filter({ hasText: "小新" }).waitFor(LONG);
    const box = win.getByTestId("composer");
    await box.fill("请只回复这六个字符:SW_OK3,不要做别的事。"); await box.press("Enter");
    const t0 = Date.now();
    while (Date.now() - t0 < Number(process.env.GG_REVIEW_WAIT || 240_000)) {
      const t = await others().allInnerTexts();
      if (t.length) return { 新联系人模型说明: result.addNote, 等了秒: Math.round((Date.now() - t0) / 1000), 对方给出: t.map((x) => x.replace(/\s+/g, " ").slice(0, 500)) };
      await win.waitForTimeout(1500);
    }
    throw new Error("超时:对方既没回复也没失败卡");
  });
}
result.pageErrors = errors; save();
await app.close().catch(() => {});
console.log(JSON.stringify({ ud, pageErrors: errors.length }));
