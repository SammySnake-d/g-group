// PR #101 第 1 轮审查:群里 @ 指定的那位到底回不回(等到两位的回合都结束或超时)。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(path.join(process.env.GG_DESKTOP_DIR, "package.json"));
const { _electron: electron } = require("@playwright/test");
const [bin, out, baseUrl, model] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const ud = mkdtempSync(path.join(tmpdir(), "gg-pr101-ud-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => !["ELECTRON_RUN_AS_NODE", "GG_REVIEW_TOKEN"].includes(k) && !k.startsWith("ANTHROPIC_") && typeof v === "string"));
const app = await electron.launch({ executablePath: bin, env: { ...env, GG_USER_DATA_DIR: ud, GG_UPDATE_AUTO: "off", GG_COMPUTE: "fake" } });
const win = await app.firstWindow();
const LONG = { timeout: 30_000 };
await win.getByTestId("setup-screen").waitFor(LONG);
await win.getByTestId("setup-base-url").fill(baseUrl);
await win.getByTestId("setup-token").fill(process.env.GG_REVIEW_TOKEN);
await win.getByTestId("setup-model").fill(model);
await win.getByTestId("setup-save").click();
await win.waitForFunction(() => document.querySelector('[data-testid="backend-demo"]')?.getAttribute("data-wire") === "live", null, LONG);
await win.waitForTimeout(2500); // 保存后 150ms 窗口会重载一次,等它过去
await win.waitForFunction(() => document.querySelector('[data-testid="backend-demo"]')?.getAttribute("data-wire") === "live", null, LONG);
for (const name of ["小克", "小林"]) {
  await win.getByTestId("nav-contacts").click();
  await win.getByTestId("list").getByText("添加联系人", { exact: true }).click();
  await win.getByPlaceholder("比如：设计师").fill(name);
  await win.getByRole("button", { name: "添加", exact: true }).click();
  await win.getByTestId("chat").locator("header").filter({ hasText: name }).waitFor(LONG);
}
await win.getByTestId("nav-contacts").click();
await win.getByTestId("list").getByText("发起群聊", { exact: true }).click();
await win.getByLabel("群名").fill("审查群");
for (const who of ["小克", "小林"]) await win.locator("label").filter({ hasText: who }).getByRole("checkbox").click();
await win.getByRole("button", { name: "创建群聊（3 人）" }).click();
await win.getByTestId("chat-title").filter({ hasText: "审查群" }).waitFor(LONG);
const box = win.getByTestId("composer");
await box.fill("请只回复这八个字符:GRP_OK_2,不要做别的事。 @小林"); await box.press("Enter");
if ((await box.inputValue()).trim()) await box.press("Enter");
const t0 = Date.now(); const log = [];
const col = win.getByTestId("chat-column");
let last = "";
while (Date.now() - t0 < 480_000) {
  const cards = await win.locator('[data-testid="typing"] [data-testid^="replying-"]:not([data-testid^="replying-phase-"])').allInnerTexts().catch(() => []);
  const msgs = await col.locator('[data-msg]:not([data-from="me"]):not([data-testid^="replying-"])').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 80)));
  const cur = JSON.stringify({ 在回: cards.map((c) => c.replace(/\s+/g, " ").slice(0, 40)), 已回: msgs });
  if (cur !== last) { log.push({ t: Math.round((Date.now() - t0) / 1000), ...JSON.parse(cur) }); last = cur; console.log(log[log.length - 1].t, cur); }
  if (!cards.length && msgs.length && Date.now() - t0 > 20_000) break;
  await win.waitForTimeout(2000);
}
await win.screenshot({ path: path.join(out, "group-final.png") });
writeFileSync(path.join(out, "result.json"), JSON.stringify({ model, userData: ud, log }, null, 2));
await app.close().catch(() => {});
