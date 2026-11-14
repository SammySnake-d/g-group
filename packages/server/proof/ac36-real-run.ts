// AC-36 真实运行(不是替身):真实 pi 联系人脑子经网关调真实模型、真实 Claude Code Compute。
// 故障在传输层注入(联系人脑子的 fetch 包一层;Compute 的 CLI 指向本机一个只回 502 的假上游),宿主照常处理:
//   场景 1 F1:联系人第 1 次请求拿到 HTTP 502,宿主静默退避后重试,真实模型回复,0 张失败卡;
//   场景 2 F2:联系人请求一律 403 Insufficient user quota,0 次自动重试、出 1 张卡,冷却过后也不自动探测;恢复上游后点[重试]真实回复;
//   场景 3 F3:真实 Claude Code 的上游一直 502,CLI 自己按 CLAUDE_CODE_MAX_RETRIES 重试后失败,宿主不再叠加续跑,原位出 1 张卡。
//   (CLI 的上游地址用 --settings 的 env 指定:用户 settings.json 里的 env 会盖过进程环境变量,只设环境变量注入不进去)
// 用法: node packages/server/proof/ac36-real-run.ts <工作目录>(需要 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_SONNET_MODEL)
// 密钥只从环境变量读,不打印、不落盘。
import http from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createComputeAdapter } from "@g-group/adapter-cc-compute";
import { createPiContactMind } from "@g-group/adapter-pi-contact";
import type { ServerEvent } from "@g-group/api-contract";
import { Host } from "../src/host.ts";

const work = path.resolve(process.argv[2] ?? "/tmp/gg-ac36-real");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const base = process.env.ANTHROPIC_BASE_URL;
const token = process.env.ANTHROPIC_AUTH_TOKEN;
const model = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
if (!base || !token || !model) throw new Error("缺 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_SONNET_MODEL");
const log = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 180000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等不到:${what}`);
    await sleep(200);
  }
}

/** 包一层真实 fetch:按当前模式先注入故障,再交给真实网关;记下每次请求。 */
let mode: "pass" | "502-once" | "403" = "pass";
const requests: string[] = [];
const faulty: typeof globalThis.fetch = async (input, init) => {
  if (mode === "502-once") {
    mode = "pass";
    requests.push("注入 502");
    return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "stream disconnected before completion: EOF (502: you can retry your request)" } }), { status: 502, headers: { "content-type": "application/json" } });
  }
  if (mode === "403") {
    requests.push("注入 403");
    return new Response(JSON.stringify({ type: "error", error: { type: "permission_error", message: "403 Insufficient user quota" } }), { status: 403, headers: { "content-type": "application/json" } });
  }
  requests.push("真实网关");
  return globalThis.fetch(input, init);
};
const mind = createPiContactMind({ provider: "anthropic", model, baseUrl: base, apiKey: token, authHeader: "bearer", fetch: faulty });

/** 场景 3 的假上游:一律 502,记下 CLI 打来的请求数。 */
let upstreamHits = 0;
const fake = http.createServer((req, res) => {
  upstreamHits++;
  req.resume();
  res.writeHead(502, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Bad Gateway" } }));
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
const fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
const CLI_RETRIES = 3;

const host = new Host({
  file: path.join(work, "gg.db"),
  mind: () => mind,
  compute: (m) => {
    const env = { ANTHROPIC_BASE_URL: fakeUrl, ANTHROPIC_AUTH_TOKEN: "placeholder-not-a-key", CLAUDE_CODE_MAX_RETRIES: String(CLI_RETRIES) };
    return createComputeAdapter({ runner: { command: "claude", args: ["--settings", JSON.stringify({ env })] }, hostEnv: { ANTHROPIC_MODEL: m, ...env } });
  },
  computeHarnessRetries: CLI_RETRIES,
  computeCwd: (t) => {
    const d = path.join(work, "compute", t);
    mkdirSync(d, { recursive: true });
    return d;
  },
  retry: { baseDelayMs: 1000, maxDelayMs: 8000, maxAutoRetries: CLI_RETRIES },
  breaker: { memberThreshold: 2, cooldownMs: 3000 },
});
host.updateSettings({ defaultSpeakingModel: model, defaultComputeModel: model });
const events: string[] = [];
host.bus.subscribe((e: ServerEvent) => {
  if (e.type === "retry.updated") events.push(`${e.scope}:${e.state}:${e.attempt}/${e.limit}:${e.label}`);
});
const nameOf = (s: { kind: string; id: string }) => (s.kind === "user" ? "我" : host.listContacts().find((c) => c.id === s.id)?.name ?? s.id);
const show = (roomId: string) =>
  host.listMessages(roomId, {}).messages.map((m) => `#${m.seq} ${nameOf(m.sender)}: ${m.text.replace(/\n/g, " ").slice(0, 160)}${m.card ? `  [卡片:${m.card.kind}/${m.card.state} ${m.card.actions.map((a) => a.label).join("|")}]` : ""}`);
const cards = (roomId: string) => host.listMessages(roomId, {}).messages.filter((m) => m.card?.kind === "failure");

try {
  const c = host.createContact({ name: "小克", speakingModel: model });
  // ---- 场景 1
  log(`== 场景 1 F1:首次 502 静默恢复(模型 ${model})`);
  const dm1 = host.openDm(c.id).id;
  mode = "502-once";
  host.send({ roomId: dm1, clientActionId: "s1", text: "你好,用一句话说说你是谁。不需要派活。" });
  await until(() => host.listMessages(dm1, {}).messages.some((m) => m.sender.kind === "contact"), "真实回复");
  await host.idle();
  for (const l of show(dm1)) log(l);
  log(`联系人脑子的请求:${JSON.stringify(requests)}`);
  log(`失败卡:${cards(dm1).length} 张;状态行事件:${JSON.stringify(events)}`);

  // ---- 场景 2
  log("== 场景 2 F2:403 配额耗尽 0 次自动重试,冷却过后也不自动探测;恢复后点[重试]");
  requests.length = 0;
  events.length = 0;
  const c2 = host.createContact({ name: "小二", speakingModel: model });
  const dm2 = host.openDm(c2.id).id;
  mode = "403";
  host.send({ roomId: dm2, clientActionId: "s2", text: "帮我想一个项目名字。不需要派活。" });
  await until(() => cards(dm2).length === 1, "失败卡");
  await sleep(4500);
  log(`冷却(3 秒)过后联系人脑子的请求:${JSON.stringify(requests)}(0 次自动重试)`);
  const card = cards(dm2)[0]!;
  mode = "pass";
  host.cardAct({ roomId: dm2, seq: card.seq, cardId: card.card!.cardId, actionId: "retry", clientActionId: "s3" });
  await until(() => host.listMessages(dm2, {}).messages.filter((m) => m.sender.kind === "contact" && !m.card).length >= 1, "点重试后真实回复");
  await host.idle();
  for (const l of show(dm2)) log(l);
  log(`联系人脑子的请求:${JSON.stringify(requests)}`);
  log(`状态行事件:${JSON.stringify(events)}`);

  // ---- 场景 3
  log(`== 场景 3 F3:真实 Claude Code 的上游一直 502(CLI 自己重试 ${CLI_RETRIES} 次),宿主不叠加续跑`);
  events.length = 0;
  const dm3 = dm1;
  host.send({ roomId: dm3, clientActionId: "s4", text: "请派一个 Compute 在它的工作目录里写 hello.txt,内容 hi。" });
  await until(() => cards(dm3).length === 1, "Compute 失败卡", 600000);
  await sleep(3000);
  for (const l of show(dm3)) log(l);
  const t = host.listTasks({ roomId: dm3 })[0];
  log(`任务 ${t?.id} 状态 ${t?.state};Compute 运行 ${JSON.stringify(t?.computeRuns.map((r) => r.status))}`);
  log(`假上游收到 CLI 的请求 ${upstreamHits} 次;宿主事件:${JSON.stringify(events)}`);
  log(`失败卡正文:${cards(dm3)[0]!.card!.body.replace(/\n/g, " | ").slice(0, 600)}`);
} finally {
  await host.close();
  fake.close();
}
