// 真实运行证据(U33):联系人接 openai-chat 协议,在本机 magpie 网关上跑通一次「群里派活 → 联系人回话」。
// 用法(端点与密钥只从环境变量读,不落盘不打印):
//   ANTHROPIC_BASE_URL=http://127.0.0.1:3425 ANTHROPIC_AUTH_TOKEN=magpie \
//   ANTHROPIC_DEFAULT_SONNET_MODEL=workbuddy-ai/hy4free \
//   node packages/server/proof/pi-protocols-real-run.mjs
// 走的是产品路径:startServer({ mind: "pi", api: "openai-chat" })(baseUrl 不带路径,适配器按协议补 /v1),
// Compute 用剧本替身(本片验的是模型协议,不是 Compute);判据是群里真的出现了联系人说的话。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureGroup, sendAndWait } from "../src/drive.ts";
import { startServer } from "../src/start.ts";

const env = process.env;
const model = env.ANTHROPIC_DEFAULT_SONNET_MODEL;
if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN || !model) {
  console.error("缺环境变量:需要 ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN、ANTHROPIC_DEFAULT_SONNET_MODEL");
  process.exit(2);
}

const dir = mkdtempSync(path.join(tmpdir(), "gg-pi-protocols-"));
const s = await startServer({ dataDir: dir, mind: "pi", api: "openai-chat", compute: "fake", env });
try {
  console.log(`协议 openai-chat · 模型 ${model} · startServer({ mind: "pi", api: "openai-chat" })`);
  const { room, contacts } = ensureGroup(s.host, "协议冒烟群", ["小克"]);
  for (const c of contacts) if (c.speakingModel !== model) s.host.updateContact(c.id, { speakingModel: model });
  console.log(`群 ${room.id}「${room.title}」成员:${room.members.length} 人`);
  s.host.bus.subscribe((e) => {
    if (e.type === "message.appended" && e.message.sender.kind !== "user") console.log(`  → [${e.message.sender.kind}] ${e.message.text}`);
  });
  const run = await sendAndWait(s.host, room.id, "小克,用 reply 工具在群里回一句「收到,我先看一下」;你只能通过工具发言。", { mention: "小克", timeoutMs: 240_000 });
  console.log(`收尾超时:${run.timedOut}`);
  // 第二幕:真的派一件要动手的活,看它是不是经 dispatch_compute 工具开了任务(本片验协议,Compute 是剧本替身——
  // 替身不会真的收尾,所以这一幕的「收尾超时」是预期的,判据只看任务有没有被开出来)
  const run2 = await sendAndWait(s.host, room.id, "小克,帮我在你的工作目录写一个 hello.txt,内容 hi;你没有 shell 和文件工具,用 dispatch_compute 开 Compute 去做。", { mention: "小克", timeoutMs: 120_000 });
  console.log(`第二幕收尾超时:${run2.timedOut}`);
  console.log("—— 群记录 ——");
  const messages = s.host.listMessages(room.id, { limit: 200 }).messages;
  for (const m of messages) console.log(`#${m.seq} ${m.sender.kind}:${m.sender.id} ${m.text}`);
  const said = messages.filter((m) => m.sender.kind === "contact" && m.text.trim() !== "");
  const tasks = s.host.listTasks({ roomId: room.id });
  for (const t of tasks) console.log(`任务 ${t.id} [${t.state}] ${t.title} Compute=${t.computeRuns.map((r) => r.computeId).join(",")}`);
  console.log(`判定:联系人回话 ${said.length} 条 → ${said.length >= 2 ? "通过" : "未通过"};派活开出任务 ${tasks.length} 个 → ${tasks.length > 0 ? "通过" : "未通过"}`);
  process.exitCode = said.length >= 2 && tasks.length > 0 ? 0 : 1;
} finally {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
}
