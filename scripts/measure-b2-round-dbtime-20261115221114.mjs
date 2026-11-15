// B2 latency probe: one real DM round, preserving request boundaries and SSE timings.
// Usage: GG_REVIEW_TOKEN=... node --experimental-strip-types scripts/measure-b2-round.mjs <out-dir>
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Host } from "../packages/server/src/host.ts";
import { createPiCompactor, createPiContactMind } from "../packages/adapter-pi-contact/src/index.ts";

const outDir = resolve(process.argv[2] ?? ".tmp/b2-measure");
mkdirSync(outDir, { recursive: true });
const token = process.env.GG_REVIEW_TOKEN;
const model = process.env.GG_B2_MODEL ?? "fengshao1227/deepseek-v4.1-flash";
const baseUrl = process.env.GG_B2_BASE_URL ?? "http://127.0.0.1:3425";
if (!token) throw new Error("缺 GG_REVIEW_TOKEN");

const originalFetch = globalThis.fetch;
const calls = [];
const pendingBodies = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const body = typeof init?.body === "string" ? init.body : null;
  const isModelCall = /\/v1\/messages(?:\?|$)/.test(url) && body !== null;
  if (!isModelCall) return originalFetch(input, init);
  const started = Date.now();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* request size is still retained */ }
  const systemText = typeof parsed?.system === "string" ? parsed.system : JSON.stringify(parsed?.system ?? null);
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const toolCalls = messages.flatMap((m) => Array.isArray(m?.content) ? m.content.filter((c) => c?.type === "tool_use").map((c) => c.name) : []);
  const operation = systemText.includes("你在一轮对话结束") ? "reflect" : systemText.includes("你替一位联系人整理") ? "compact" : "contact-round";
  const systemBytes = Buffer.byteLength(systemText);
  const messageBytes = Buffer.byteLength(JSON.stringify(messages));
  const rec = {
    index: calls.length + 1,
    startedAt: new Date(started).toISOString(),
    requestMs: null,
    firstByteMs: null,
    totalMs: null,
    status: null,
    operation,
    requestBytes: Buffer.byteLength(body),
    model: parsed?.model ?? null,
    maxTokens: parsed?.max_tokens ?? null,
    systemBytes,
    messageBytes,
    promptBytes: systemBytes + messageBytes,
    messageCount: messages.length,
    toolCount: Array.isArray(parsed?.tools) ? parsed.tools.length : 0,
    toolCalls,
    stopReason: null,
  };
  calls.push(rec);
  const response = await originalFetch(input, init);
  rec.requestMs = Date.now() - started;
  rec.status = response.status;
  const clone = response.clone();
  const consume = (async () => {
    const reader = clone.body?.getReader();
    if (!reader) {
      rec.firstByteMs = rec.requestMs;
      rec.totalMs = Date.now() - started;
      return;
    }
    let bytes = 0;
    let first = true;
    let text = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (first) {
        rec.firstByteMs = Date.now() - started;
        first = false;
      }
      bytes += part.value.byteLength;
      text += new TextDecoder().decode(part.value, { stream: true });
    }
    rec.totalMs = Date.now() - started;
    rec.responseBytes = bytes;
    const stop = text.match(/"stop_reason"\s*:\s*"([^"]+)"/);
    if (stop) rec.stopReason = stop[1];
  })().catch((error) => { rec.bodyError = String(error); });
  pendingBodies.push(consume);
  return response;
};

const dataDir = join(outDir, "data");
const dbPath = join(dataDir, "gg.db");
if (existsSync(dbPath)) throw new Error(`拒绝复用旧数据库：${dbPath}`);
mkdirSync(dataDir, { recursive: true });
const report = [];
const started = Date.now();
const opts = { provider: "anthropic", model, baseUrl, apiKey: token, authHeader: "bearer" };
const mind = createPiContactMind(opts);
const compactor = createPiCompactor(opts);
const host = new Host({
  file: join(dataDir, "gg.db"),
  dataDir,
  mind: () => mind,
  compactor: () => compactor,
  onReport: (what, detail) => report.push({ atMs: Date.now() - started, what, detail }),
});
const contact = host.createContact({ name: "小克", speakingModel: model });
const room = host.openDm(contact.id);
const sentAt = Date.now();
const sent = host.send({ roomId: room.id, clientActionId: "b2-measure-1", text: "请只回复这六个字符:DM_B2,不要做别的事。" });
let reply = null;
const deadline = Date.now() + Number(process.env.GG_B2_WAIT_MS ?? 420_000);
while (Date.now() < deadline) {
  const messages = host.listMessages(room.id, { limit: 100 }).messages;
  reply = messages.find((m) => m.sender.kind === "contact") ?? null;
  if (reply) break;
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
}
await host.idle().catch(() => {});
await Promise.all(pendingBodies);
const finishedAt = Date.now();
const result = {
  baseline: "45976fca3c1311451acf17c915509d724bf719f1",
  model,
  baseUrl,
  prompt: "请只回复这六个字符:DM_B2,不要做别的事。",
  sentAt: new Date(sentAt).toISOString(),
  sentEventAt: sent.at,
  replyAt: reply?.at ?? null,
  roundMs: reply ? Date.parse(reply.at) - Date.parse(sent.at) : null,
  sendToReplyMs: reply ? Date.parse(reply.at) - sentAt : null,
  observedAndIdleMs: finishedAt - sentAt,
  stateNotePresent: host.stateNote(contact.id) !== null,
  reply: reply?.text ?? null,
  modelCalls: calls,
  reports: report,
  dbPath,
};
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await host.close();
