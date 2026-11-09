// 运行台账的真实运行(AC-43 ⑦⑩⑪、AC-14):真实 Claude Code Compute + 确定性联系人脑子(主题是 Compute 的卡死判定,联系人只负责转述)。
//   A 正常:网关照常,Compute 写一个文件 → 台账里联系人轮次 / Compute 会话 / Compute 轮次,活动流里有发请求与工具开始结束;
//   B 上游收下请求后既不回应也不断开:本机起一个只接受连接、从不回话的端口当网关 → 过了首字节窗口判 no_response,先停再写失败,联系人报卡点;
//   C 上游连不上:网关指向不监听的端口 → Claude Code 不停报「正在重试」、始终没有输出 → 到整轮阈值判 stream_dropped。
// 阈值用短的(首字节 20 秒、整轮 45 秒),核对周期 2 秒。网关地址与令牌只从环境变量读,不打印。主会话的子代理 α 所写。
// B、C 要用假 HOME 跑(HOME 下只放一个空的 .claude/OVERRIDE.md):本机 ~/.claude 的设置会覆盖 ANTHROPIC_BASE_URL,黑洞 / 关闭的端口就不生效。
// 用法: node packages/server/proof/run-ledger-real.mjs <工作目录> [A|B|C ...]
import { mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createComputeAdapter } from "@g-group/adapter-cc-compute";
import { scriptedMind } from "../src/fakes.ts";
import { Host } from "../src/host.ts";

const work = process.argv[2];
if (!work) throw new Error("要给工作目录");
const cases = process.argv.slice(3).length ? process.argv.slice(3) : ["A", "B", "C"];
const env = process.env;
const model = env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "claude-sonnet-4-6";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

async function runCase(name, baseUrl, token, text, until, limitMs) {
  log(`== 情形 ${name}`);
  const hostEnv = { ANTHROPIC_MODEL: model };
  if (baseUrl) hostEnv.ANTHROPIC_BASE_URL = baseUrl;
  if (token) hostEnv.ANTHROPIC_AUTH_TOKEN = token;
  const adapter = createComputeAdapter({ hostEnv });
  const acts = {};
  const host = new Host({
    file: path.join(work, `${name}.db`),
    mind: () => scriptedMind(),
    compute: () => adapter,
    computeCwd: (t) => {
      const d = path.join(work, name, t);
      mkdirSync(d, { recursive: true });
      return d;
    },
    runThresholds: { defaults: { stallMs: 45_000, firstByteMs: 20_000 } },
    runCheckMs: 2000,
    maxDeferMs: 50,
    onReport: (w, d) => {
      if (w.startsWith("compute") || w.startsWith("effect")) log(`报告 ${w} ${d instanceof Error ? d.message : ""}`);
    },
  });
  host.bus.subscribe((e) => {
    if (e.type === "run.updated") log(`run.updated ${e.run.layer} ${e.run.id} ${e.run.status} 「${e.run.text}」${e.run.reasonClass ? ` ${e.run.reasonClass}` : ""}`);
  });
  void (async () => {
    for await (const a of adapter.activity()) acts[a.kind] = (acts[a.kind] ?? 0) + 1;
  })();
  host.updateSettings({ defaultComputeModel: model });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text });
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline && !until(host)) await sleep(500);
  await sleep(3000);
  log(`活动流计数 ${JSON.stringify(acts)}`);
  for (const r of host.listRuns({}).runs) {
    log(`台账 ${r.layer} ${r.id} 父=${r.parentId ?? "-"} ${r.status} 「${r.text}」 原因=${r.reasonClass ?? "-"} 阈值=${r.thresholdMs ?? "-"}(${r.thresholdSource ?? "-"}) 最后进展=${r.lastProgressAt} 判定=${r.judgedAt ?? "-"}`);
    if (r.raw) log(`  原文:${r.raw.slice(0, 300)}`);
  }
  for (const t of host.listTasks({})) log(`任务 ${t.id} ${t.state}`);
  for (const m of host.listMessages(dm.id, {}).messages) log(`#${m.seq} ${m.sender.kind}: ${m.text.slice(0, 300)}`);
  await host.close();
}

const done = (h) => h.listTasks({}).some((t) => t.state === "T5_InReview" || t.state === "T11_Failed" || t.state === "T8_Accepted");
const failedTurn = (h) => h.listRuns({}).runs.some((r) => r.layer === "compute-turn" && r.status === "failed") && h.listMessages(h.roomsOfUser()[0].id, {}).messages.some((m) => m.text.startsWith("任务卡住了"));

if (cases.includes("A")) await runCase("A", env.ANTHROPIC_BASE_URL, env.ANTHROPIC_AUTH_TOKEN, "帮我在工作目录里写一个 hello.txt,内容是 hi from run ledger", done, 240_000);
if (cases.includes("B")) {
  const held = [];
  const hole = net.createServer((s) => { held.push(s); s.on("error", () => {}); });
  await new Promise((r) => hole.listen(0, "127.0.0.1", () => r()));
  const port = hole.address().port;
  log(`黑洞端口 127.0.0.1:${port}:接受连接、读走请求、从不回话也不断开`);
  await runCase("B", `http://127.0.0.1:${port}`, "dummy-not-a-key", "帮我查一下今天的天气", failedTurn, 120_000);
  log(`黑洞端口收到连接 ${held.length} 个`);
  for (const s of held) s.destroy();
  hole.close();
}
if (cases.includes("C")) await runCase("C", "http://127.0.0.1:9", "dummy-not-a-key", "帮我查一下今天的天气", failedTurn, 150_000);
log("结束");
process.exit(0);
