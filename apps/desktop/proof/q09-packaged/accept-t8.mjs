// 验收:交付进 T8a 待确认、沉默不通过、本人回复「通过」才到 T8(需求文档 §8.1 已定 1;验收文档 AC-28 / AC-56)。
// 从 ../native-files/packaged/accept-loop-final.mjs 复制扩展(那份是已归档证据的一部分,不改)。像用户一样只点界面:
//   接入模型 → 建联系人 → 私聊派活 → Compute 完成 → 交付消息 → [库里 T8a + 界面「等你确认」+ 快照] → 沉默 ≥30 秒仍 T8a
//   → 私聊直接回「通过」→ [库里 T8_Accepted / badge=accepted / reviewGate=waived-by-user + 界面「你已验收」];
//   建群拉人(我 + 小克 + 小林,再拖进小美;同一模型、没有跨厂商审查人)→ 群里 @小克 派活 → 同样推进,群里回复那条交付消息说「通过」。
// 任务状态以 SQLite 只读连接(SQLITE_OPEN_READONLY,等同 file:…?mode=ro)读 userdata/gg-data/gg.db 的 docs 表 task:<id>;
// 交付那一刻用 sqlite backup 拷 t8a-snapshot-<dm|group>.db,收尾再拷 final.db,交给 check-t8a.py 独立复核。
//
// 用法(真实安装副本,真实模型):
//   GG_ACCEPT_BIN=<安装副本里的 g-group.app/Contents/MacOS/g-group> GG_ACCEPT_MODEL=workbuddy-ai/deepseek-v4.1-flash-sg \
//     node apps/desktop/proof/q09-packaged/accept-t8.mjs <新的绝对证据目录>
//   网关与令牌只从 ~/.claude/settings.json 读:不打印、不落盘(跑完删 gg-config.json)、不进截图(接入屏只在填写前截图)。
// 替身调定位(不算验收证据):先在 apps/desktop 构建 dist/ 与 dist-electron/,再
//   GG_ACCEPT_FAKE=1 [GG_ACCEPT_KEEP_GOING=1] node apps/desktop/proof/q09-packaged/accept-t8.mjs <新的绝对目录>
//   起开发版 Electron(GG_BACKEND=server、GG_MIND=fake、GG_COMPUTE=fake);同时给 GG_ACCEPT_BIN 就改起那份安装副本(同样替身脑子/Compute,
//   跳过接入模型屏)。替身不写文件,文件内容断言记为跳过;
//   替身脑子不会把「通过」转成验收结论,所以 T8 那几条在替身下必红。KEEP_GOING 只许替身用:断言失败记下来接着走,最后仍非零退出。
// 任何断言失败或超时:非零退出,保留截图、steps.log、userdata 与 result.json,不删除。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

const FAKE = process.env.GG_ACCEPT_FAKE === "1";
const KEEP_GOING = process.env.GG_ACCEPT_KEEP_GOING === "1";
assert(!KEEP_GOING || FAKE, "GG_ACCEPT_KEEP_GOING 只许在替身(GG_ACCEPT_FAKE=1)下用");
const appDir = path.resolve(import.meta.dirname, "../..");
const CHECKER = path.join(import.meta.dirname, "check-t8a.py");
const BIN = process.env.GG_ACCEPT_BIN || null;
if (!FAKE || BIN) {
  assert(BIN && path.isAbsolute(BIN) && existsSync(BIN), "GG_ACCEPT_BIN 必须指向存在的绝对二进制路径(安装副本)");
  assert(!path.resolve(BIN).startsWith("/Applications/"), "GG_ACCEPT_BIN 要指向 install-copy.sh 装出的副本,不用 /Applications 下的旧版");
} else {
  for (const f of ["dist/index.html", "dist-electron/main.cjs"]) assert(existsSync(path.join(appDir, f)), `替身要先构建 apps/desktop/${f}`);
}
const ASAR = BIN ? path.resolve(path.dirname(BIN), "../Resources/app.asar") : null;
// 真实模式才读令牌;只留在内存里交给界面,不写日志
const cc = FAKE ? {} : JSON.parse(readFileSync(path.join(os.homedir(), ".claude/settings.json"), "utf8")).env;
const GATEWAY = cc.ANTHROPIC_BASE_URL;
const TOKEN = cc.ANTHROPIC_AUTH_TOKEN;
if (!FAKE) assert(GATEWAY && TOKEN, "~/.claude/settings.json 的 env 里缺网关或令牌");
const MODEL = process.env.GG_ACCEPT_MODEL || "workbuddy-ai/deepseek-v4.1-flash-sg";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE" && !k.startsWith("ANTHROPIC_") && !k.startsWith("GG_")));
const MIN = 60_000;
/** 沉默阴性:交付进 T8a 之后至少等这么久不说话,再读一次库 */
const SILENCE_MS = 30_000;
const DB = path.join(ud, "gg-data", "gg.db");

let n = 0;
const shot = async (win, name) => { const f = path.join(out, `${String(++n).padStart(2, "0")}-${name}.png`); await win.screenshot({ path: f }); step(`截图 ${path.basename(f)}`); return path.basename(f); };

// ---- 具名断言:每条记 pass/fail;默认第一条失败就停(非零退出),替身 KEEP_GOING 时记下接着走 ----
const assertions = [];
class Stop extends Error {}
async function check(name, fn) {
  const at = new Date().toISOString();
  try {
    const detail = (await fn()) ?? "";
    assertions.push({ name, pass: true, detail: String(detail).slice(0, 2000), at });
    step(`断言通过 ${name}${detail ? `:${detail}` : ""}`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assertions.push({ name, pass: false, detail: msg.slice(0, 2000), at });
    step(`断言失败 ${name}:${msg}`);
    if (!KEEP_GOING) throw new Stop(`${name}:${msg}`);
    return false;
  }
}
const skip = (name, why) => { assertions.push({ name, pass: null, detail: `跳过:${why}`, at: new Date().toISOString() }); step(`断言跳过 ${name}:${why}`); };

// ---- 只读读库:SQLITE_OPEN_READONLY,不写库、不建表;WAL 下与宿主并发读 ----
async function withDb(fn) {
  for (let i = 0; ; i++) {
    let db;
    try {
      db = new DatabaseSync(DB, { readOnly: true });
      return fn(db);
    } catch (e) {
      if (i >= 5 || !/locked|busy/i.test(String(e))) throw e;
    } finally {
      db?.close();
    }
    await sleep(300);
  }
}
const readTask = (taskId) => withDb((db) => {
  const row = db.prepare("SELECT ver, value FROM docs WHERE key = ?").get(`task:${taskId}`);
  if (!row) throw new Error(`库里没有 task:${taskId}`);
  const doc = JSON.parse(row.value);
  const reviews = Number(db.prepare("SELECT count(*) AS n FROM gg_reviews WHERE task_id = ?").get(taskId).n);
  const t = doc.task;
  return { ver: row.ver, state: t.state, reviewGate: t.reviewGate, badge: t.badge, deliveredSeq: doc.deliveredSeq ?? null, sourceSeq: doc.sourceSeq, roomId: doc.roomId, requester: t.requester, owner: t.owner, approval: t.approval ?? null, delivery: t.delivery ?? null, reviews };
});
const fmt = (t) => `state=${t.state} reviewGate=${t.reviewGate} badge=${t.badge} deliveredSeq=${t.deliveredSeq} sourceSeq=${t.sourceSeq} reviews=${t.reviews} ver=${t.ver}`;
/** sqlite backup 拷一份一致快照(源库只读打开) */
async function snapshotDb(name) {
  const dest = path.join(out, name);
  assert(!existsSync(dest), `快照已存在,不覆盖:${dest}`);
  const src = new DatabaseSync(DB, { readOnly: true });
  try { await backup(src, dest); } finally { src.close(); }
  const side = ["-wal", "-shm", "-journal"].filter((s) => existsSync(dest + s));
  const sha = sha256(dest);
  step(`快照 ${name}:sha256=${sha}${side.length ? `;旁文件 ${side.join(",")}` : ""}`);
  return { path: dest, sha256: sha, bytes: statSync(dest).size };
}
/** 等任务离开交付途中的过渡态;到 T8a(或明显别的终点)就停,最多 ms */
async function pollTask(taskId, done, ms) {
  const t0 = Date.now();
  let t = await readTask(taskId);
  while (!done(t) && Date.now() - t0 < ms) { await sleep(1000); t = await readTask(taskId); }
  return { t, waitedMs: Date.now() - t0 };
}

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
  return { taskId, row, msgId: await row.getAttribute("data-msg") };
}
function verifyFile(taskId, name, expected) {
  const file = path.join(ud, "gg-data", "compute", taskId, name);
  assert(existsSync(file) && statSync(file).isFile(), `对应任务没有产出:${taskId}/${name}`);
  const actual = readFileSync(file, "utf8");
  // 按派活约定只允许文件末尾一个 LF/CRLF;空格、多行、句号或其他内容均失败。
  assert.equal(actual.replace(/\r?\n$/, ""), expected, `${name} 内容不精确匹配`);
  return `${taskId}/${name};字节数=${Buffer.byteLength(actual)};内容=${JSON.stringify(actual)}`;
}

const result = {
  runner: "apps/desktop/proof/q09-packaged/accept-t8.mjs",
  mode: FAKE ? "fake" : "real",
  note: FAKE ? `替身(GG_MIND=fake / GG_COMPUTE=fake,${BIN ? "安装副本" : "开发版 Electron"}):只为调界面定位与判红,不算验收证据` : "真实安装副本 + 真实模型",
  startedAt: new Date().toISOString(),
  bin: BIN,
  appAsar: ASAR,
  appAsarSha256: ASAR && existsSync(ASAR) ? sha256(ASAR) : null,
  model: FAKE ? null : MODEL,
  appVersion: null,
  tasks: {},
  snapshots: {},
  finalDb: null,
  checker: null,
  pageErrors: { count: 0, messages: [] },
  secrets: null,
  failure: null,
};

const fakeEnv = FAKE ? { GG_MIND: "fake", GG_COMPUTE: "fake" } : {};
const launchOpts = BIN
  ? { executablePath: BIN, env: { ...env, ...fakeEnv, GG_USER_DATA_DIR: ud, GG_UPDATE_AUTO: "off" } }
  : { args: [appDir], cwd: appDir, env: { ...env, ...fakeEnv, GG_BACKEND: "server", GG_USER_DATA_DIR: ud, GG_UPDATE_AUTO: "off" } };
const app = await electron.launch(launchOpts);
const errors = [];
let exitCode = 0;
try {
  const win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(e.message));
  result.appVersion = await app.evaluate(({ app }) => app.getVersion());
  step(`打开 ${BIN ?? `开发版 Electron(${appDir})`}${FAKE ? "(替身脑子与 Compute)" : ""},版本 ${result.appVersion}${ASAR ? `;app.asar sha256=${result.appAsarSha256}` : ""}`);

  // 1. 接入模型(替身不需要)
  if (!FAKE) {
    await win.getByTestId("setup-screen").waitFor({ timeout: 20_000 });
    await shot(win, "首次打开-接入模型");
    step(`claude 检测:${await win.getByTestId("setup-claude").textContent()}`);
    // 令牌框必须是密码遮罩;填写后不截这一屏(网关地址也不进截图)
    await check("setup.token_input_masked", async () => { await expect(win.getByTestId("setup-token")).toHaveAttribute("type", "password"); return "type=password"; });
    await win.getByTestId("setup-base-url").fill(GATEWAY);
    await win.getByTestId("setup-token").fill(TOKEN);
    await win.getByTestId("setup-model").fill(MODEL);
    await win.getByTestId("setup-save").click();
    await win.getByTestId("rail").waitFor({ timeout: 30_000 });
  }
  await win.locator('[data-testid="backend-demo"][data-mode="connected"]').waitFor({ timeout: 30_000 });
  step(FAKE ? "替身后端已连上" : `接入模型:网关与令牌来自 ~/.claude/settings.json(不记录),模型 ${MODEL};界面已连上后端`);
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
  const column = () => win.getByTestId("chat-column");
  const fromContact = () => column().locator('[data-msg]:not([data-from="me"])');
  /** 后端已确认(data-msg 带 #seq)的我发的消息 */
  const mineConfirmed = () => column().locator('[data-from="me"][data-msg*="#"]');
  const uiLine = (taskId) => column().getByTestId(`compute-line-${taskId}`).first();
  const box = win.getByTestId("composer");

  /** 一件派出去的活:等 Compute 跑完 → 交付 → 文件 → T8a(库 + 界面 + 快照)→ 沉默 → 本人「通过」→ T8 */
  async function deliverAndAccept(k, label, line, filename, expected, sendPass, uiPending, uiAccepted) {
    await line.waitFor({ timeout: 3 * MIN });
    step(`${label} Compute 开始:${(await line.textContent())?.slice(0, 120)}`);
    await shot(win, `${label}-Compute开始`);
    for (let i = 0; i < 60; i++) {
      const s = await line.getAttribute("data-state");
      if (s === "done" || s === "error" || s === "failed") break;
      await win.waitForTimeout(5000);
    }
    step(`${label} Compute 状态:${await line.getAttribute("data-state")};${(await line.textContent())?.slice(0, 160)}`);
    let d;
    await check(`${k}.delivered_message`, async () => { d = await verifyDelivered(win, line, filename, label); return `taskId=${d.taskId} 交付消息=${d.msgId}`; });
    if (!d) throw new Error(`${label}:没有拿到交付消息,后面的状态断言无从做起`);
    const taskId = d.taskId;
    result.tasks[k] = { taskId, deliveryMsg: d.msgId };
    if (FAKE) skip(`${k}.file_exact`, "替身 Compute 不写文件");
    else await check(`${k}.file_exact`, async () => verifyFile(taskId, filename, expected));

    // 交付后立即:库里 T8a_Delivered、reviewGate=none、deliveredSeq 非空。只给交付途中的过渡态(T5 提审 / T7 发交付)最多 20 秒,
    // 等了多久如实记进快照;20 秒后仍停在 T5 就是「没有审查人却卡在审查」的缺陷(修复前的旧行为)
    const { t: t8a, waitedMs } = await pollTask(taskId, (t) => !["T5_InReview", "T7_Delivering"].includes(t.state), 20_000);
    const t8aAt = Date.now();
    step(`${label}交付后库里(等了 ${waitedMs}ms):${fmt(t8a)}`);
    // 不论对错先拷快照:绿是 T8a 证据,红是停在别处的证据
    const snap = await snapshotDb(`t8a-snapshot-${k}.db`);
    result.snapshots[k] = { ...snap, taskId, observed: t8a, observedAfterDeliveryMs: waitedMs };
    await check(`${k}.db_state_T8a_Delivered`, async () => { assert.equal(t8a.state, "T8a_Delivered", `交付后任务在 ${t8a.state},不是 T8a 待确认`); return fmt(t8a); });
    await check(`${k}.db_reviewGate_none`, async () => { assert.equal(t8a.reviewGate, "none"); return `reviewGate=${t8a.reviewGate}`; });
    await check(`${k}.db_badge_none`, async () => { assert.equal(t8a.badge, "none"); return `badge=${t8a.badge}`; });
    await check(`${k}.db_deliveredSeq_set`, async () => {
      assert(Number.isInteger(t8a.deliveredSeq) && t8a.deliveredSeq > t8a.sourceSeq, `deliveredSeq=${t8a.deliveredSeq} sourceSeq=${t8a.sourceSeq}`);
      assert.equal(d.msgId, `${t8a.roomId}#${t8a.deliveredSeq}`, "界面上的交付消息就是库里 deliveredSeq 那条");
      return `deliveredSeq=${t8a.deliveredSeq} = 界面交付消息 ${d.msgId}`;
    });
    await check(`${k}.db_no_reviewer`, async () => { assert.equal(t8a.reviews, 0, "这件任务有审查记录"); return "gg_reviews 里没有这件任务"; });
    await check(`${k}.ui_pending_confirm`, async () => { await uiPending(taskId); return (await uiLine(taskId).textContent())?.slice(0, 160); });
    await shot(win, `${label}-交付待确认`);

    // 沉默阴性:不说话至少 30 秒,仍是 T8a、没有自动通过
    const rest = SILENCE_MS - (Date.now() - t8aAt);
    if (rest > 0) await win.waitForTimeout(rest);
    const silent = await readTask(taskId);
    const silentMs = Date.now() - t8aAt;
    await check(`${k}.silence_still_T8a`, async () => {
      assert(silentMs >= SILENCE_MS, `只沉默了 ${silentMs}ms`);
      assert.equal(silent.state, "T8a_Delivered", `沉默 ${Math.round(silentMs / 1000)} 秒后任务在 ${silent.state}`);
      assert.equal(silent.badge, "none", "沉默不该带验收标记");
      return `沉默 ${Math.round(silentMs / 1000)} 秒后 ${fmt(silent)}`;
    });
    await check(`${k}.silence_ui_still_pending`, async () => { await uiPending(taskId); return "界面仍是等你确认"; });

    // 本人验收:普通回复「通过」
    const before = await mineConfirmed().count();
    await sendPass(d);
    let passMsg = null;
    await check(`${k}.user_pass_sent`, async () => {
      await expect(mineConfirmed(), "「通过」必须由后端确认落库").toHaveCount(before + 1, { timeout: MIN });
      const row = mineConfirmed().last();
      await expect(row).toContainText("通过");
      passMsg = await row.getAttribute("data-msg");
      const seq = Number(passMsg.split("#").pop());
      assert(seq > t8a.deliveredSeq, `「通过」(#${seq})必须在交付(#${t8a.deliveredSeq})之后`);
      return `本人消息 ${passMsg}`;
    });
    result.tasks[k].passMsg = passMsg;
    const { t: fin, waitedMs: accWait } = await pollTask(taskId, (t) => !["T8a_Delivered", "T5_InReview", "T7_Delivering"].includes(t.state), FAKE ? 45_000 : 5 * MIN);
    step(`${label}本人通过后库里(等了 ${Math.round(accWait / 1000)} 秒):${fmt(fin)};approval=${JSON.stringify(fin.approval)}`);
    result.tasks[k].final = fin;
    await check(`${k}.db_state_T8_Accepted`, async () => { assert.equal(fin.state, "T8_Accepted", `本人回复通过后任务在 ${fin.state}`); return fmt(fin); });
    await check(`${k}.db_badge_accepted`, async () => { assert.equal(fin.badge, "accepted"); return `badge=${fin.badge}`; });
    await check(`${k}.db_reviewGate_waived_by_user`, async () => { assert.equal(fin.reviewGate, "waived-by-user", "没有审查人时本人通过要如实记为 waived-by-user"); return `reviewGate=${fin.reviewGate} approval=${JSON.stringify(fin.approval)}`; });
    await check(`${k}.ui_accepted`, async () => { await uiAccepted(taskId); return (await uiLine(taskId).textContent())?.slice(0, 160); });
    await shot(win, `${label}-本人通过-已验收`);
    return taskId;
  }

  await addContact("小克", "写代码、整理文件");
  await shot(win, "建联系人-进入私聊");

  // 3. 私聊派活 → 交付 → T8a → 沉默 → 直接回「通过」
  const before = await fromContact().count();
  await box.fill("帮我在你的工作目录里新建一个 hello.txt，内容只有这一行：「你好，g-group」。不要写引号，不添加标点或空格，末尾可有一个换行。写好告诉我文件名和完成情况。");
  await box.press("Enter");
  step("私聊发出派活消息");
  await shot(win, "私聊-发出派活");
  await win.waitForFunction((b) => document.querySelectorAll('[data-testid="chat-column"] [data-msg]:not([data-from="me"])').length > b, before, { timeout: 3 * MIN });
  step(`联系人回复:${(await fromContact().last().textContent())?.slice(0, 120)}`);
  const dmTaskId = await deliverAndAccept(
    "dm", "私聊", column().locator('[data-testid^="compute-line-"]').first(), "hello.txt", "你好，g-group",
    async () => { await box.fill("通过"); await box.press("Enter"); step("私聊直接回复「通过」"); },
    async (id) => { await expect(uiLine(id)).toContainText("等你确认", { timeout: 30_000 }); },
    async (id) => { await expect(uiLine(id)).toContainText("你已验收", { timeout: 30_000 }); },
  );

  // 4. 建群、拉人、群里派活(同一模型的三位联系人,没有跨厂商审查人)
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
  await box.press("Enter"); // 选人菜单开着:回车选中小克
  await box.press("Enter");
  step("群里 @小克 派活");
  await win.waitForFunction((b) => document.querySelectorAll('[data-testid="chat-column"] [data-msg]:not([data-from="me"])').length > b, gBefore, { timeout: 3 * MIN });
  step(`群里回复:${(await fromContact().last().textContent())?.slice(0, 120)}`);
  const strip = win.getByTestId("strip-list");
  const groupTaskId = await deliverAndAccept(
    "group", "群", column().locator('[data-testid^="compute-line-"]').first(), "group.txt", "群聊闭环通过",
    async (d) => {
      // 群里回复那条交付消息:悬停 → 回复(引用并 @ 作者),输入框自动带上「@小克 」,再补「通过」
      const row = column().locator(`[data-msg="${d.msgId}"]`).first();
      await row.hover();
      await win.getByTestId(`reply-${d.msgId}`).click();
      await expect(box).toHaveValue(/^@小克 /);
      await box.press("End");
      await box.pressSequentially("通过");
      await expect(box).toHaveValue("@小克 通过");
      await box.press("Enter");
      step(`群里回复交付消息 ${d.msgId}:「@小克 通过」`);
    },
    async (id) => { await expect(uiLine(id)).toContainText("等你确认", { timeout: 30_000 }); await expect(strip).toContainText("待验收", { timeout: 30_000 }); },
    async (id) => { await expect(uiLine(id)).toContainText("你已验收", { timeout: 30_000 }); await expect(strip).toContainText("1/1", { timeout: 30_000 }); await expect(strip).not.toContainText("待验收"); },
  );
  // 群里的「通过」确实是回复那条交付消息(库里 reply_to = deliveredSeq)
  await check("group.pass_replies_to_delivery", async () => {
    const pm = result.tasks.group?.passMsg;
    assert(pm, "没有本人「通过」消息");
    const [room, seq] = [pm.slice(0, pm.lastIndexOf("#")), Number(pm.split("#").pop())];
    const snapT = result.snapshots.group.observed;
    const r = await withDb((db) => db.prepare("SELECT reply_to FROM gg_msg WHERE room_id = ? AND seq = ?").get(room, seq));
    assert.equal(r?.reply_to, snapT.deliveredSeq, `「通过」的 reply_to=${r?.reply_to},交付 seq=${snapT.deliveredSeq}`);
    return `${pm} reply_to=#${r.reply_to}`;
  });
  step(`两件任务:私聊 ${dmTaskId},群 ${groupTaskId}`);

  // 5. 收尾:拷最终库,交给 check-t8a.py 独立复核(快照钉住各自任务,最终库要求全部 T8)
  const fin = await snapshotDb("final.db");
  result.finalDb = fin;
  await check("checker.check_t8a_py", async () => {
    const args = ["-I", CHECKER, "--snapshot", `${result.snapshots.dm.path}=${dmTaskId}`, "--snapshot", `${result.snapshots.group.path}=${groupTaskId}`, "--final", fin.path];
    let text, code = 0;
    try { text = execFileSync("python3", args, { cwd: os.tmpdir(), encoding: "utf8" }); } catch (e) { text = e.stdout ?? ""; code = e.status ?? -1; }
    writeFileSync(path.join(out, "check-t8a.json"), text);
    const r = JSON.parse(text || "{}");
    result.checker = { exitCode: code, pass: !!r.pass, failed: r.failed ?? null, output: "check-t8a.json" };
    assert.equal(code, 0, `check-t8a.py 退出码 ${code}:${(r.failed ?? []).join(" | ")}`);
    return "快照 T8a、最终 T8 均通过";
  });

  result.pageErrors = { count: errors.length, messages: errors.slice(0, 20) };
  await check("page.no_runtime_errors", async () => { assert.deepEqual(errors, [], "页面不应发生运行时错误"); return "页面错误 0"; });
} catch (error) {
  exitCode = 1;
  const msg = error instanceof Error ? error.message : String(error);
  result.failure = msg.slice(0, 4000);
  step(`验收失败:${msg}`);
  const win = app.windows()[0];
  if (win) await win.screenshot({ path: path.join(out, "失败现场.png") }).catch(() => {});
} finally {
  result.pageErrors = { count: errors.length, messages: errors.slice(0, 20) };
  await app.close().catch(() => {});
  // 验收用的网关配置里有令牌:跑完删掉这份设置文件(数据库与截图留作证据)
  rmSync(path.join(ud, "gg-config.json"), { force: true });
  try { execFileSync("/usr/bin/pkill", ["-f", `${ud}`]); } catch {}
  // 令牌不得留在证据目录里(只报文件名,不打印值);网关地址出现只记提示
  if (!FAKE) {
    const hits = { token: [], gateway: [] };
    const needles = { token: Buffer.from(TOKEN), gateway: Buffer.from(GATEWAY) };
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && statSync(p).size < 200 * 1024 * 1024) {
          const b = readFileSync(p);
          for (const k of Object.keys(needles)) if (b.includes(needles[k])) hits[k].push(path.relative(out, p));
        }
      }
    };
    try { walk(out); } catch (e) { hits.error = String(e); }
    result.secrets = { tokenFoundIn: hits.token, gatewayFoundIn: hits.gateway, error: hits.error ?? null };
    const ok = !hits.token.length && !hits.error;
    assertions.push({ name: "secrets.token_absent_from_evidence", pass: ok, detail: ok ? "证据目录里没有令牌" : `令牌出现在:${hits.token.join(", ")}${hits.error ? `;扫描出错 ${hits.error}` : ""}`, at: new Date().toISOString() });
    step(ok ? "断言通过 secrets.token_absent_from_evidence" : `断言失败 secrets.token_absent_from_evidence:${hits.token.join(", ")}`);
    if (hits.gateway.length) step(`提示:网关地址出现在 ${hits.gateway.join(", ")}(不算失败,如实记录)`);
    if (!ok) exitCode = 1;
  }
  if (assertions.some((a) => a.pass === false)) exitCode = 1;
  result.endedAt = new Date().toISOString();
  result.assertions = assertions;
  result.pass = exitCode === 0 && assertions.every((a) => a.pass !== false);
  writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  step(`result.json 已写:pass=${result.pass};断言 ${assertions.filter((a) => a.pass).length} 过 / ${assertions.filter((a) => a.pass === false).length} 红 / ${assertions.filter((a) => a.pass === null).length} 跳过`);
}
process.exit(exitCode);
