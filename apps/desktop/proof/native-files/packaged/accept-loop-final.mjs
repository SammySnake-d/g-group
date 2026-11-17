// 验收:最小闭环(真实模型、真实 Compute、装好的应用)。像用户一样从「应用程序」打开 g-group,只点界面:
// 接入模型 → 建联系人 → 私聊派活 → 联系人回复 → Compute 开始/进展/完成 → 交付;建群拉人 → 群里 @ 派活 → 同样推进。
// 每步截图,步骤日志与宿主落盘的文件读回。数据放在验收目录里,不碰用户自己的那份。
// 用法: GG_ACCEPT_BIN=<安装后的二进制> GG_ACCEPT_MODEL=<模型> node accept-loop-final.mjs <新的绝对证据目录>
// 可选 GG_ACCEPT_SCREENSHOT=1:完成闭环后点工具栏截图,断言后端附件卡和真实 PNG 落盘。
// 网关与令牌仍只读 ~/.claude/settings.json;失败也保留截图/数据库,不覆盖已有 userdata。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";

assert(process.argv[2] && path.isAbsolute(process.argv[2]), "需要新的绝对证据输出目录");
const out = path.resolve(process.argv[2]);
const ud = path.join(out, "userdata");
assert(!existsSync(ud), `证据目录已有 userdata,拒绝覆盖:${ud}`);
mkdirSync(out, { recursive: true });
// mkdir 不使用 recursive:也拒绝并发启动时另一个进程已占用相同数据目录。
mkdirSync(ud);
const LOG = path.join(out, "steps.log");
const step = (s) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); appendFileSync(LOG, line + "\n"); };
const BIN = process.env.GG_ACCEPT_BIN || "/Applications/g-group.app/Contents/MacOS/g-group";
assert(path.isAbsolute(BIN) && existsSync(BIN), "GG_ACCEPT_BIN 必须指向存在的绝对二进制路径");
const cc = JSON.parse(readFileSync(path.join(os.homedir(), ".claude/settings.json"), "utf8")).env;
const GATEWAY = cc.ANTHROPIC_BASE_URL;
const TOKEN = cc.ANTHROPIC_AUTH_TOKEN;
const MODEL = process.env.GG_ACCEPT_MODEL || "fnqtz/claude-sonnet-5-5";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE" && !k.startsWith("ANTHROPIC_") && !k.startsWith("GG_")));
let n = 0;
const shot = async (win, name) => { const f = path.join(out, `${String(++n).padStart(2, "0")}-${name}.png`); await win.screenshot({ path: f }); step(`截图 ${path.basename(f)}`); };
const MIN = 60_000;
const taskIds = [];
async function verifyDelivered(win, line, filename, label) {
  assert.equal(await line.getAttribute("data-state"), "done", `${label}:Compute 必须完成,失败或超时不得算通过`);
  const testId = await line.getAttribute("data-testid");
  assert(testId?.startsWith("compute-line-"), `${label}:缺少任务身份`);
  const taskId = testId.slice("compute-line-".length);
  assert(taskId && path.basename(taskId) === taskId && taskId !== "." && taskId !== "..", "非法任务身份");
  assert(!taskIds.includes(taskId), "私聊与群聊必须是不同的实际任务");
  taskIds.push(taskId);
  // trail 只挂在后端 deliveredSeq 对应的交付消息上;正文读取不包含引用块和 Compute 的状态字样。
  const trail = win.locator('[data-testid^="trail-"]').filter({ has: win.getByTestId(testId) });
  await expect(trail, `${label}:完成消息必须关联本次任务`).toHaveCount(1, { timeout: 3 * MIN });
  const row = trail.locator('xpath=ancestor::*[@data-msg][1]');
  await expect(row).toHaveAttribute("data-from", /^(?!me$).+/);
  const body = row.locator('[data-anchor] .whitespace-pre-wrap').first();
  await expect(body, `${label}:交付正文必须提及对应文件`).toContainText(filename, { timeout: 3 * MIN });
  await expect(body, `${label}:必须有完成说明`).toContainText(/已(?:经)?(?:建|创|写|完|生|保)|建好|写好|写入|完成|做好|created|written|done|completed/i, { timeout: 3 * MIN });
  step(`${label}完成消息:${(await body.textContent())?.slice(0, 400)}`);
  return taskId;
}
function verifyFile(taskId, name, expected) {
  const file = path.join(ud, "gg-data", "compute", taskId, name);
  assert(existsSync(file) && statSync(file).isFile(), `对应任务没有产出:${taskId}/${name}`);
  const actual = readFileSync(file, "utf8");
  // 按派活约定只允许文件末尾一个 LF/CRLF;空格、多行、句号或其他内容均失败。
  assert.equal(actual.replace(/\r?\n$/, ""), expected, `${name} 内容不精确匹配`);
  step(`实际文件通过:${taskId}/${name};字节数=${Buffer.byteLength(actual)};内容=${JSON.stringify(actual)}`);
}

const app = await electron.launch({ executablePath: BIN, env: { ...env, GG_USER_DATA_DIR: ud, GG_UPDATE_AUTO: "off" } });
const errors = [];
try {
  const win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(e.message));
  step(`打开 ${BIN},版本 ${await app.evaluate(({ app }) => app.getVersion())}`);

  // 1. 接入模型
  await win.getByTestId("setup-screen").waitFor({ timeout: 20_000 });
  await shot(win, "首次打开-接入模型");
  step(`claude 检测:${await win.getByTestId("setup-claude").textContent()}`);
  await win.getByTestId("setup-base-url").fill(GATEWAY);
  await win.getByTestId("setup-token").fill(TOKEN);
  await win.getByTestId("setup-model").fill(MODEL);
  await win.getByTestId("setup-save").click();
  await win.getByTestId("rail").waitFor({ timeout: 30_000 });
  await win.locator('[data-testid="backend-demo"][data-mode="connected"]').waitFor({ timeout: 30_000 });
  step(`接入模型:网关 ${new URL(GATEWAY).host},模型 ${MODEL};界面已连上后端`);
  await shot(win, "连上后端-空界面");

  // 2. 建联系人
  const addContact = async (name, role) => {
    await win.getByTestId("nav-contacts").click();
    await win.getByTestId("list").getByText("添加联系人", { exact: true }).click();
    await win.getByPlaceholder("比如：设计师").fill(name);
    if (role) await win.getByPlaceholder("比如：画界面、做配色").fill(role);
    await win.getByRole("button", { name: "添加", exact: true }).click();
    await win.getByTestId("chat").locator("header").filter({ hasText: name }).waitFor({ timeout: 30_000 });
    step(`建了联系人 ${name}`);
  };
  await addContact("小克", "写代码、整理文件");
  await shot(win, "建联系人-进入私聊");

  // 3. 私聊派活
  const fromContact = () => win.getByTestId("chat-column").locator('[data-msg]:not([data-from="me"])');
  const box = win.getByTestId("composer");
  const before = await fromContact().count();
  await box.fill("帮我在你的工作目录里新建一个 hello.txt，内容只有这一行：「你好，g-group」。不要写引号，不添加标点或空格，末尾可有一个换行。写好告诉我文件名和完成情况。");
  await box.press("Enter");
  step("私聊发出派活消息");
  await shot(win, "私聊-发出派活");
  await win.waitForFunction((b) => document.querySelectorAll('[data-testid="chat-column"] [data-msg]:not([data-from="me"])').length > b, before, { timeout: 3 * MIN });
  step(`联系人回复:${(await fromContact().last().textContent())?.slice(0, 120)}`);
  await shot(win, "私聊-联系人回复");
  const line = win.getByTestId("chat-column").locator('[data-testid^="compute-line-"]').first();
  await line.waitFor({ timeout: 3 * MIN });
  step(`Compute 开始:${(await line.textContent())?.slice(0, 120)}`);
  await shot(win, "私聊-Compute开始");
  for (let i = 0; i < 60; i++) {
    const s = await line.getAttribute("data-state");
    if (s === "done" || s === "error" || s === "failed") break;
    if (i === 3) await shot(win, "私聊-Compute进行中");
    await win.waitForTimeout(5000);
  }
  step(`Compute 状态:${await line.getAttribute("data-state")};${(await line.textContent())?.slice(0, 160)}`);
  const dmTaskId = await verifyDelivered(win, line, "hello.txt", "私聊");
  verifyFile(dmTaskId, "hello.txt", "你好，g-group");
  await shot(win, "私聊-完成与交付");
  await line.click();
  await win.getByTestId("cview-activity").click();
  await win.waitForTimeout(800);
  await shot(win, "私聊-Compute过程");
  await win.keyboard.press("Escape");

  // 4. 建群、拉人、群里派活
  await addContact("小林", "做调研");
  await addContact("小美", "写文案");
  await win.getByTestId("nav-contacts").click();
  await win.getByTestId("list").getByText("发起群聊", { exact: true }).click();
  await win.getByLabel("群名").fill("闭环验收群");
  for (const name of ["小克", "小林"]) await win.locator("label").filter({ hasText: name }).getByRole("checkbox").click();
  await win.getByRole("button", { name: /创建群聊/ }).click();
  await win.getByTestId("chat-title").filter({ hasText: "闭环验收群" }).waitFor({ timeout: 30_000 });
  step("建群:闭环验收群(我 + 小克 + 小林)");
  await win.getByTestId("chat-title").click();
  const drop = win.getByTestId("side-members-drop");
  await drop.waitFor();
  await win.getByTestId("list").locator('[data-testid^="conv-dm-"]').filter({ hasText: "小美" }).dragTo(drop);
  await drop.locator('[data-testid^="side-member-"]').filter({ hasText: "小美" }).waitFor({ timeout: 30_000 });
  step("拉人:把小美拖进群");
  await shot(win, "群-建群拉人");
  await win.keyboard.press("Escape");
  const gBefore = await fromContact().count();
  await box.fill("请在你的工作目录里新建 group.txt，内容只有这一行：「群聊闭环通过」。不要写引号，不添加标点或空格，末尾可有一个换行。写好在群里说明文件名和完成情况。 @小克");
  await box.press("Enter");
  await box.press("Enter");
  step("群里 @小克 派活");
  await win.waitForFunction((b) => document.querySelectorAll('[data-testid="chat-column"] [data-msg]:not([data-from="me"])').length > b, gBefore, { timeout: 3 * MIN });
  step(`群里回复:${(await fromContact().last().textContent())?.slice(0, 120)}`);
  const gline = win.getByTestId("chat-column").locator('[data-testid^="compute-line-"]').first();
  await gline.waitFor({ timeout: 3 * MIN });
  await shot(win, "群-Compute开始");
  for (let i = 0; i < 60; i++) {
    const s = await gline.getAttribute("data-state");
    if (s === "done" || s === "error" || s === "failed") break;
    await win.waitForTimeout(5000);
  }
  step(`群里 Compute 状态:${await gline.getAttribute("data-state")};${(await gline.textContent())?.slice(0, 160)}`);
  const groupTaskId = await verifyDelivered(win, gline, "group.txt", "群聊");
  verifyFile(groupTaskId, "group.txt", "群聊闭环通过");
  await shot(win, "群-完成与交付");

  // 5. 可选验证截图入口,走真实用户操作,不直接调用后端或注入页面状态。
  if (process.env.GG_ACCEPT_SCREENSHOT === "1") {
    const artifacts = path.join(ud, "gg-data", "attachments");
    const existing = new Set(existsSync(artifacts) ? readdirSync(artifacts) : []);
    await win.getByTestId("tool-shot").click();
    const attachment = win.getByTestId("chat-column").getByTestId(/^attachment-截图 .*\.png$/).last();
    await expect(attachment, "截图必须成为可见附件").toBeVisible({ timeout: MIN });
    const row = attachment.locator('xpath=ancestor::*[@data-msg][1]');
    await expect(row, "截图必须已由后端确认,不能停在乐观消息").toHaveAttribute("data-msg", /#\d+$/, { timeout: MIN });
    await expect(row).toHaveAttribute("data-from", "me");
    await expect.poll(() => {
      return (existsSync(artifacts) ? readdirSync(artifacts) : []).filter((f) => {
        const p = path.join(artifacts, f);
        return !existing.has(f) && statSync(p).isFile() && readFileSync(p).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      }).length;
    }, { message: "截图必须以真实 PNG 落盘", timeout: MIN }).toBeGreaterThan(0);
    step(`截图附件通过:${await attachment.textContent()};消息=${await row.getAttribute("data-msg")}`);
    await shot(win, "群-截图真实附件");
  }
  assert.deepEqual(errors, [], "页面不应发生运行时错误");
  step("页面错误:无");
  step("闭环验收通过:两个不同任务均 done、对应联系人完成消息可见、两份文件内容精确匹配");
  const mlog = path.join(ud, "logs", "main.log");
  if (existsSync(mlog)) step(`main.log:\n${readFileSync(mlog, "utf8")}`);
} catch (error) {
  step(`验收失败:${error instanceof Error ? error.message : String(error)}`);
  const win = app.windows()[0];
  if (win) await win.screenshot({ path: path.join(out, "失败现场.png") }).catch(() => {});
  throw error;
} finally {
  await app.close().catch(() => {});
  // 验收用的网关配置里有令牌:跑完删掉这份设置文件(数据库与截图留作证据)
  rmSync(path.join(ud, "gg-config.json"), { force: true });
  try { execFileSync("/usr/bin/pkill", ["-f", `${ud}`]); } catch {}
}
