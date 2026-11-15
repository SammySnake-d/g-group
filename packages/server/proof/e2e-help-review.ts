// 真实跨层运行(AC-44 + AC-26/28):真实 pi 联系人脑子 + 真实 Claude Code Compute,在本机起一个中性的「订单后台」夹具,
// 登录时要求只有人能提供的短信验证码 → Compute 应截图(下载挑战图)报 blocked 停下 → 任务进 T4b、联系人 @用户 发提问卡;
// 驱动脚本扮演用户,从夹具里读出「发到手机的」验证码,用 tasks.answer 回答 → Compute 续接登录、导出 orders.csv → 联系人交付
// → 跨厂商审查联系人(Compute 模型默认 workbuddy-ai/deepseek-v4.1-flash-sg,厂商 deepseek;GG_REVIEW_MODEL 可换)起只读审查 Compute → 审过进 T8a → 用户确认 → T8。
// 用法(网关地址与令牌只经环境变量传入,不落盘):
//   node packages/server/proof/e2e-help-review.ts /tmp/gg-e2e-help   > packages/server/proof/e2e-help-review.txt
// 需要 ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN(或 ANTHROPIC_API_KEY)、ANTHROPIC_DEFAULT_SONNET_MODEL;本机要有 claude CLI。
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { createComputeAdapter } from "@g-group/adapter-cc-compute";
import type { ContactView } from "@g-group/api-contract";
import type { ContactMind } from "@g-group/kernel";
import { Host } from "../src/host.ts";
import { createService } from "../src/service.ts";

const root = path.resolve(process.argv[2] ?? "/tmp/gg-e2e-help");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const SPEAK = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
// glm/glm-5.3-flash 在网关上的密钥 2026-11-09 已停用(permission_error「密钥已停用」),默认改用 DeepSeek
const REVIEW_MODEL = process.env.GG_REVIEW_MODEL ?? "workbuddy-ai/deepseek-v4.1-flash-sg";
const token = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
if (!SPEAK || !token || !process.env.ANTHROPIC_BASE_URL) throw new Error("需要 ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 与 ANTHROPIC_DEFAULT_SONNET_MODEL");
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);

// ---------- 夹具:中性的订单后台 ----------
/** 生成一张 160×48 的灰底条纹 PNG(挑战图;内容中性,不含验证码)。 */
function png(): Buffer {
  const w = 160, h = 48;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const v = (x + y) % 16 < 8 ? 200 : 150;
      raw.set([v, v, 220], y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const crcT = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (b: Buffer) => {
    let c = -1;
    for (const x of b) c = crcT[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const smsCode = String(randomInt(100000, 999999));
const sessionToken = `sess-${randomInt(1e9)}`;
const audit: string[] = [];
let answeredAt = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://x");
    const form = new URLSearchParams(body);
    const json = (code: number, v: unknown) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(v));
    };
    const line = `${req.method} ${url.pathname}${form.has("sms_code") ? ` sms_code=${form.get("sms_code") === smsCode ? "对" : "错"}` : ""}`;
    audit.push(`${answeredAt ? "回答后" : "回答前"} ${line}`);
    if (req.method === "GET" && url.pathname === "/") return json(200, { app: "订单后台(测试夹具)", login: "POST /login,表单字段 user、pass;需要时再带 sms_code", orders: "GET /orders?token=..." });
    if (req.method === "GET" && url.pathname === "/challenge.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(png());
    }
    if (req.method === "POST" && url.pathname === "/login") {
      if (form.get("user") !== "demo-user" || form.get("pass") !== "demo-pass") return json(401, { error: "账号或密码不对" });
      if (!form.has("sms_code")) return json(403, { error: "需要短信验证码", detail: "验证码已发到管理员手机,只能由人提供,不能自动获取;挑战页截图在 /challenge.png。拿到后带 sms_code 重新 POST /login。" });
      if (form.get("sms_code") !== smsCode) return json(403, { error: "短信验证码不对" });
      return json(200, { token: sessionToken });
    }
    if (req.method === "GET" && url.pathname === "/orders") {
      if (url.searchParams.get("token") !== sessionToken) return json(401, { error: "未登录" });
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
      return res.end("order_id,item,qty\nA-1001,键盘,2\nA-1002,显示器,1\nA-1003,鼠标,3\n");
    }
    json(404, { error: "没有这个地址" });
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
log(`夹具订单后台 http://127.0.0.1:${port}(短信验证码只在夹具里,驱动脚本扮演用户读出)`);

// ---------- 宿主:真实 pi 脑子 + 真实 Claude Code ----------
const pi = (await import("@g-group/adapter-pi-contact")) as unknown as { createPiContactMind(o: Record<string, unknown>): ContactMind };
const minds = new Map<string, ContactMind>();
const mind = (c: ContactView) => {
  let m = minds.get(c.speakingModel);
  if (!m) {
    m = pi.createPiContactMind({ provider: "anthropic", model: c.speakingModel, baseUrl: process.env.ANTHROPIC_BASE_URL, apiKey: token, authHeader: process.env.ANTHROPIC_AUTH_TOKEN ? "bearer" : "x-api-key" });
    minds.set(c.speakingModel, m);
  }
  return m;
};
const pass = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];
const work = path.join(root, "work");
const host = new Host({
  file: path.join(root, "gg.db"),
  mind,
  compute: (model) => {
    const hostEnv: Record<string, string> = { ANTHROPIC_MODEL: model };
    for (const k of pass) if (process.env[k]) hostEnv[k] = process.env[k]!;
    return createComputeAdapter({ hostEnv });
  },
  computeCwd: (t) => {
    mkdirSync(path.join(work, t), { recursive: true });
    return path.join(work, t);
  },
  maxDeferMs: 300,
  onReport: (what, detail) => log(`[宿主报告] ${what} ${JSON.stringify(detail).slice(0, 300)}`),
});
const svc = createService(host);
host.updateSettings({ defaultSpeakingModel: SPEAK, defaultComputeModel: SPEAK });
const owner = host.createContact({ name: "小克", persona: "做事利落,说话简短" });
const reviewer = host.createContact({ name: "小审", computeModel: { mode: "explicit", model: REVIEW_MODEL } });
log(`联系人 小克:说话/Compute 模型 ${SPEAK};小审:Compute 模型 ${REVIEW_MODEL}(审查人)`);
const dm = host.openDm(owner.id);
host.bus.subscribe((e) => {
  if (e.type === "message.appended") {
    const m = e.message;
    const who = m.sender.kind === "user" ? "我" : (host.listContacts().find((c) => c.id === m.sender.id)?.name ?? m.sender.id);
    log(`#${m.seq} ${who}: ${m.text.slice(0, 400)}${m.card ? `  [卡片 ${m.card.kind}/${m.card.state}:${m.card.actions.map((a) => a.label).join("|")}]` : ""}${m.attachments.length ? `  [附件 ${m.attachments.map((a) => `${a.name} ${a.mime} ${a.bytes}B`).join(", ")}]` : ""}`);
  }
  if (e.type === "compute.progress") log(`  · Compute ${e.progress.computeId.slice(0, 12)} ${e.progress.kind}${e.progress.stage ? `(${e.progress.stage})` : ""}: ${e.progress.summary.slice(0, 300)}`);
});

const until = async (what: string, cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等「${what}」超时`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};
const task = () => host.listTasks({ roomId: dm.id })[0];
let exit = 0;
try {
  host.send({ roomId: dm.id, clientActionId: "e2e-1", text: `帮我登录 http://127.0.0.1:${port} 的订单后台(账号 demo-user,密码 demo-pass),把订单导出成你工作目录里的 orders.csv,做完告诉我` });
  await until("任务进 T4b", () => task()?.state === "T4b_BlockedOnHuman" || ["T10_Cancelled", "T11_Failed", "T5_InReview"].includes(task()?.state ?? ""), 10 * 60_000);
  const t1 = task()!;
  log(`任务 ${t1.id} 状态 ${t1.state};待回答问题 ${JSON.stringify(t1.pendingQuestion)}`);
  if (t1.state !== "T4b_BlockedOnHuman") throw new Error(`没有停在 T4b,而是 ${t1.state}`);
  log(`回答前夹具收到的请求:${audit.join(" / ")}`);
  answeredAt = Date.now();
  const r = await svc.handle("tasks.answer", { taskId: t1.id, qId: t1.pendingQuestion!.qId, clientActionId: "e2e-answer", answer: `短信验证码是 ${smsCode}` });
  log(`tasks.answer → ${r.ok ? `ok,任务 ${(r.value as { state: string }).state}` : `失败 ${r.error.code} ${r.error.message}`}`);
  // 审完:进了 T8a 或终态;或停在 T5 且最近一次审查没做成(交给提出者豁免)。打回(rejected)后会返工再送审,继续等
  const settled = () => {
    const t = task();
    if (!t) return false;
    if (["T8a_Delivered", "T10_Cancelled", "T11_Failed"].includes(t.state)) return true;
    const last = (t.reviews ?? []).at(-1);
    return t.state === "T5_InReview" && !!last && !["running", "rejected"].includes(last.status);
  };
  await until("交付并审完", settled, 30 * 60_000);
  const t2 = task()!;
  log(`任务状态 ${t2.state} 审查门 ${t2.reviewGate} 审查记录 ${JSON.stringify(t2.reviews)}`);
  if (t2.state === "T8a_Delivered") {
    const a = await svc.handle("tasks.accept", { taskId: t2.id, clientActionId: "e2e-accept" });
    log(`tasks.accept → ${a.ok ? `ok,任务 ${(a.value as { state: string }).state} 审查门 ${(a.value as { reviewGate: string }).reviewGate}` : `失败 ${a.error.code} ${a.error.message}`}`);
  }
  await host.idle();
  const csv = path.join(work, t2.id, "orders.csv");
  log(`orders.csv ${existsSync(csv) ? `内容:\n${readFileSync(csv, "utf8")}` : "不存在"}`);
  log(`夹具收到的全部请求:${audit.join(" / ")}`);
  const before = audit.filter((x) => x.startsWith("回答前") && x.includes("sms_code")).length;
  log(`回答前带 sms_code 的登录尝试次数:${before}(Compute 自己猜/反复提交验证码会大于 0)`);
} catch (e) {
  exit = 1;
  log(`运行失败:${e instanceof Error ? e.message : String(e)}`);
} finally {
  const ft = task();
  if (ft) log(`最终任务 ${ft.id} [${ft.state}] 审查门=${ft.reviewGate} 进度=${ft.recentProgress.map((p) => p.kind).join(">")}`);
  log("—— 会话全文 ——");
  for (const m of host.listMessages(dm.id, { limit: 500 }).messages) {
    const who = m.sender.kind === "user" ? "我" : (host.listContacts().find((c) => c.id === m.sender.id)?.name ?? m.sender.id);
    console.log(`#${m.seq} ${who}(${m.sender.kind}): ${m.text}${m.card ? `  [卡片 ${m.card.kind}/${m.card.state}]` : ""}${m.attachments.length ? `  [附件 ${m.attachments.map((a) => a.name).join(",")}]` : ""}`);
  }
  await host.close();
  server.close();
  log(`结束,退出码 ${exit};审查人 ${reviewer.name} id ${reviewer.id}`);
  process.exit(exit);
}
