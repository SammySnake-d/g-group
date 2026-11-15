// PR #101 第 1 轮审查:用打包版(被审头 143f72d1 自打包)把 P0 链从头实点一遍。
// 用法:node p0-walk.mjs <二进制> <输出目录> <网关> <模型>   令牌从 GG_REVIEW_TOKEN 读,不落盘不打印。
// 数据目录是临时的,不碰用户数据;联系人脑子是真模型(不设 GG_MIND),Compute 用替身(本轮不审 Compute)。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(path.join(process.env.GG_DESKTOP_DIR, "package.json"));
const { _electron: electron } = require("@playwright/test");

const [bin, out, baseUrl, model] = process.argv.slice(2);
const token = process.env.GG_REVIEW_TOKEN;
mkdirSync(out, { recursive: true });
const ud = process.env.GG_REVIEW_UD || mkdtempSync(path.join(tmpdir(), "gg-pr101-ud-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => !["ELECTRON_RUN_AS_NODE", "GG_REVIEW_TOKEN"].includes(k) && !k.startsWith("ANTHROPIC_") && typeof v === "string"));
const result = { head: "143f72d179fa0db9edc224be9232a1aa2b0ab250", model, baseUrl, userData: ud, steps: [] };
let n = 0;
const save = () => writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
const app = await electron.launch({ executablePath: bin, env: { ...env, GG_USER_DATA_DIR: ud, GG_UPDATE_AUTO: "off", GG_COMPUTE: "fake" } });
const win = await app.firstWindow();
const errors = [];
win.on("pageerror", (e) => errors.push(e.message));
const shot = async (name) => { const f = `${String(++n).padStart(2, "0")}-${name}.png`; await win.screenshot({ path: path.join(out, f) }).catch(() => {}); return f; };
const ids = () => win.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid")))).slice(0, 150));
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    const note = await fn();
    result.steps.push({ name, ok: true, ms: Date.now() - t0, note: note ?? null, shot: await shot(name) });
    console.log("✓", name, note ?? "");
  } catch (e) {
    result.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 1200), shot: await shot(`${name}-失败`), ids: await ids().catch(() => []), text: await win.evaluate(() => document.body.innerText.slice(0, 1500)).catch(() => "") });
    console.log("✗", name, String(e.message).slice(0, 400));
  }
  save();
};
const LONG = { timeout: 30_000 };
const column = win.getByTestId("chat-column");
const replies = () => column.locator('[data-msg]:not([data-from="me"]):not([data-msg$="~c"]):not([data-testid^="replying-"])');
const waitReply = async (marker, ms = Number(process.env.GG_REVIEW_WAIT || 150_000)) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const all = await replies().allInnerTexts();
    const hit = all.find((t) => t.includes(marker));
    if (hit) return `真实回复(${Math.round((Date.now() - t0) / 1000)}s):${hit.replace(/\s+/g, " ").slice(0, 160)}`;
    await win.waitForTimeout(1500);
  }
  const all = await replies().allInnerTexts();
  throw new Error(`等 ${ms / 1000}s 没等到含 ${marker} 的回复;对方消息:${JSON.stringify(all.map((t) => t.replace(/\s+/g, " ").slice(0, 200)))};页面:${(await win.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(-600)}`);
};

await win.waitForLoadState("domcontentloaded");
await step("首次打开", async () => {
  const info = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged }));
  if (!info.packaged) throw new Error("不是打包版");
  await win.getByTestId("setup-screen").waitFor(LONG);
  const v = { url: await win.getByTestId("setup-base-url").inputValue(), model: await win.getByTestId("setup-model").inputValue(), modelPlaceholder: await win.getByTestId("setup-model").getAttribute("placeholder"), modelTag: await win.getByTestId("setup-model").evaluate((e) => e.tagName) };
  return `打包版 ${info.version};接入页初值 ${JSON.stringify(v)}`;
});
if (process.env.GG_REVIEW_BAD_MODEL) {
  await step("填一个不存在的模型", async () => {
    await win.getByTestId("setup-base-url").fill(baseUrl);
    await win.getByTestId("setup-token").fill(token);
    await win.getByTestId("setup-model").fill(process.env.GG_REVIEW_BAD_MODEL);
    await win.getByTestId("setup-save").click();
    await win.getByTestId("backend-demo").waitFor({ state: "attached", timeout: 30_000 });
    return `保存后直接进了主界面(没有校验模型能不能用);错误提示=${await win.getByTestId("setup-error").count()}`;
  });
} else {
  await step("配 API 选模型", async () => {
    await win.getByTestId("setup-base-url").fill(baseUrl);
    await win.getByTestId("setup-token").fill(token);
    await win.getByTestId("setup-model").fill(model);
    await win.getByTestId("setup-save").click();
    const mark = win.getByTestId("backend-demo");
    await mark.waitFor({ state: "attached", timeout: 30_000 });
    await win.waitForFunction(() => { const m = document.querySelector('[data-testid="backend-demo"]'); return m?.getAttribute("data-mode") === "connected" && m?.getAttribute("data-wire") === "live"; }, null, LONG);
    return "保存后宿主 connected / live";
  });
}
const addContact = async (name) => {
  await win.getByTestId("nav-contacts").click();
  await win.getByTestId("list").getByText("添加联系人", { exact: true }).click();
  await win.getByPlaceholder("比如：设计师").fill(name);
  const note = await win.getByTestId("add-model-note").innerText().catch(() => "(无模型说明)");
  await win.getByRole("button", { name: "添加", exact: true }).click();
  await win.getByTestId("chat").locator("header").filter({ hasText: name }).waitFor(LONG);
  return note;
};
await step("添加联系人 小克", async () => `添加页模型说明:${await addContact("小克")}`);
const send = async (text) => { const box = win.getByTestId("composer"); await box.fill(text); await box.press("Enter"); };
await step("私聊收到真实回复", async () => { await send(process.env.GG_REVIEW_DM || "请只回复这六个字符:DM_OK1,不要做别的事。"); return await waitReply(process.env.GG_REVIEW_DM_MARK || "DM_OK1"); });
if (!process.env.GG_REVIEW_BAD_MODEL) {
  await step("添加联系人 小林", async () => `添加页模型说明:${await addContact("小林")}`);
  await step("建群", async () => {
    await win.getByTestId("nav-contacts").click();
    await win.getByTestId("list").getByText("发起群聊", { exact: true }).click();
    await win.getByLabel("群名").fill("审查群");
    for (const who of ["小克", "小林"]) await win.locator("label").filter({ hasText: who }).getByRole("checkbox").click();
    await win.getByRole("button", { name: "创建群聊（3 人）" }).click();
    await win.getByTestId("chat-title").filter({ hasText: "审查群" }).waitFor(LONG);
    return await win.getByTestId("chat").locator("header").innerText().then((t) => t.replace(/\s+/g, " ").slice(0, 80));
  });
  await step("群聊 @ 收到真实回复", async () => {
    const box = win.getByTestId("composer");
    await box.fill("请只回复这八个字符:GRP_OK_2,不要做别的事。 @小林");
    await box.press("Enter");
    if ((await box.inputValue()).trim()) await box.press("Enter");
    const r = await waitReply("GRP_OK_2");
    const from = await replies().filter({ hasText: "GRP_OK_2" }).first().getAttribute("data-from");
    const others = (await replies().allInnerTexts()).length;
    return `${r};回复方 data-from=${from};群里对方消息共 ${others} 条`;
  });
  await step("粘贴图片", async () => {
    const png = path.join(out, "clip-source.png");
    await win.screenshot({ path: png, clip: { x: 0, y: 0, width: 320, height: 200 } });
    await app.evaluate(({ clipboard, nativeImage }, p) => clipboard.writeImage(nativeImage.createFromPath(p)), png);
    const box = win.getByTestId("composer");
    await box.click();
    const before = await column.locator('[data-testid^="attachment-"]').count();
    await box.press("Meta+V");
    await win.waitForFunction((b) => document.querySelectorAll('[data-testid="chat-column"] [data-testid^="attachment-"]').length > b, before, { timeout: 20_000 });
    const a = column.locator('[data-testid^="attachment-"]').last();
    return `粘贴后出现附件 ${await a.getAttribute("data-testid")};disabled=${await a.isDisabled()};title=${await a.getAttribute("title")};里面有缩略图 img=${await a.locator("img").count()};输入框上方有待发预览=${await win.getByTestId("composer-box").locator("img").count()}`;
  });
  await step("点开预览", async () => {
    const a = column.locator('[data-testid^="attachment-"]').last();
    await win.waitForFunction(() => { const l = document.querySelectorAll('[data-testid="chat-column"] [data-testid^="attachment-"]'); const e = l[l.length - 1]; return e && !e.disabled; }, null, { timeout: 20_000 });
    await a.click();
    const pv = win.getByTestId("file-preview");
    await pv.waitFor(LONG);
    const img = pv.locator("img").first();
    await img.waitFor(LONG);
    const dim = await img.evaluate((e) => ({ w: e.naturalWidth, h: e.naturalHeight, complete: e.complete }));
    const stillChat = await win.getByTestId("chat-column").isVisible().catch(() => false);
    return `预览出图 ${JSON.stringify(dim)};点开后聊天栏还在=${stillChat}(否=被带去了文件区整页)`;
  });
}
result.pageErrors = errors;
save();
if (process.env.GG_REVIEW_KEEP) { console.log("KEEP", ud); await win.waitForTimeout(Number(process.env.GG_REVIEW_KEEP)); }
await app.close().catch(() => {});
console.log(JSON.stringify({ passed: result.steps.filter((s) => s.ok).length, total: result.steps.length, pageErrors: errors.length }));
process.exit(result.steps.every((s) => s.ok) ? 0 : 1);
