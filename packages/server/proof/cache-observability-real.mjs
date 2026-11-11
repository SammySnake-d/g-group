// 真实运行一次(手动跑,不在测试 glob 内):startServer(mind=pi) 连本机真实网关,同一联系人在同一群连发 5 轮短消息,
// 打印 gg_usage 的每一行与 usage.cacheStats(按线路 × 联系人 × 群;再按种类拆开)。网关回的数字原样记,是拆账口径就如实标出来。
//   node packages/server/proof/cache-observability-real.mjs > packages/server/proof/cache-observability-real.txt
// 网关地址与令牌只从环境变量读(ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY、ANTHROPIC_DEFAULT_SONNET_MODEL),输出里打码。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureGroup, sendAndWait } from "../src/drive.ts";
import { createService, startServer } from "../src/index.ts";

const baseUrl = process.env.ANTHROPIC_BASE_URL;
const token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
if (!baseUrl || !token || !model) {
  console.error("缺环境变量:ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY、ANTHROPIC_DEFAULT_SONNET_MODEL");
  process.exit(2);
}
const pathPart = new URL(baseUrl).pathname;
const redact = (s) => {
  let out = String(s).split(token).join("[令牌已隐去]").split(baseUrl).join("[网关地址已隐去]");
  if (pathPart.length > 1) out = out.split(pathPart).join("[网关路径已隐去]");
  return out;
};
const dir = mkdtempSync(path.join(tmpdir(), "gg-cache-real-"));
const reports = [];
const s = await startServer({ dataDir: dir, mind: "pi", compute: "fake", onReport: (what, detail) => reports.push({ what, detail }) });
const started = Date.now();
try {
  const { room, contacts } = ensureGroup(s.host, "缓存实测群", ["小后"]);
  const c = contacts[0];
  s.host.updateContact(c.id, { persona: "说话简短。只做用户明确要的事,不派活、不开 Compute。" });
  console.log(`# ${new Date().toISOString()} startServer(mind=pi,compute=fake)经本机网关;模型 ${model};线路取 服务商|主机名|模型,不含网关路径`);
  console.log("# 命令: node packages/server/proof/cache-observability-real.mjs;同一联系人「小后」在同一群连发 5 轮短消息,轮与轮之间不等待(都在 5 分钟 TTL 内)");
  for (let i = 1; i <= 5; i++) {
    const t0 = Date.now();
    const r = await sendAndWait(s.host, room.id, `第${i}轮:只回我「收到${i}」,别的什么都不做`, { mention: "小后", timeoutMs: 180_000 });
    const reply = r.transcript.filter((m) => m.seq > r.sent.seq && m.sender.kind === "contact").map((m) => m.text).join(" / ");
    console.log(`# 第 ${i} 轮 #${r.sent.seq} 用时 ${Date.now() - t0} ms${r.timedOut ? "(超时)" : ""};联系人回:${redact(reply) || "(没有回话)"}`);
  }
  console.log("\n## gg_usage 原始行(at、种类、轮次、轮次内请求序号、input / cache_read / cache_write / output、断点数、前缀哈希前 12 位、线路、会话)");
  for (const r of s.host.usage.rows()) {
    console.log(redact(`${r.at} ${r.kind.padEnd(7)} ${r.roundId.split(":")[1] ?? r.roundId} req${r.request} in=${r.input} read=${r.cacheRead} write=${r.cacheWrite} out=${r.output} bp=${r.breakpoints} prefix=${r.prefixHash.slice(0, 12)} line=${r.line} rooms=${r.roomIds.join(",")}`));
  }
  const svc = createService(s.host);
  for (const q of [{ by: ["line", "contact", "room"] }, { by: ["line", "contact", "room", "kind"] }, { by: ["line", "kind"], kinds: ["round"] }]) {
    const r = await svc.handle("usage.cacheStats", q);
    console.log(`\n## usage.cacheStats ${JSON.stringify(q)}`);
    console.log(redact(JSON.stringify(r.ok ? r.value : r.error, null, 1)));
  }
  const other = reports.filter((x) => x.what !== "recall");
  console.log(`\n## 宿主报告(去掉 recall)共 ${other.length} 条`);
  for (const x of other) console.log(x.what, redact(JSON.stringify(x.detail ?? null)).slice(0, 300));
  console.log(`\n# 总用时 ${Date.now() - started} ms`);
} finally {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
}
