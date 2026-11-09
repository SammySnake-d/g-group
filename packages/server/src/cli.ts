#!/usr/bin/env node
// gg:P0 闭环的命令行驱动器(技术栈文档阶段一「先用 CLI/测试驱动跑通」)。
//   node packages/server/src/cli.ts dm --db ./gg.db --name 小克 "帮我在 /tmp/gg-demo 写 hello.txt"
//   node packages/server/src/cli.ts log --db ./gg.db [roomId]
//   node packages/server/src/cli.ts group --db ./gg.db --members 小克,小研 --to 小克 "@小克 帮我在你的工作目录写 group.txt"
// 选项:--mind fake|pi(默认 fake 规则脑子;pi 需要 @g-group/adapter-pi-contact 与模型网关环境变量)
//       --compute fake|claude(默认 fake;claude 起真实 Claude Code CLI)  --cwd 目录(Compute 工作目录)  --timeout 秒
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createComputeAdapter } from "@g-group/adapter-cc-compute";
import type { ContactView } from "@g-group/api-contract";
import type { ContactCompactor, ContactMind } from "@g-group/kernel";
import { ensureGroup, sendAndWait, senderAudit } from "./drive.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string", default: "./gg.db" },
    name: { type: "string", default: "小克" },
    mind: { type: "string", default: "fake" },
    compute: { type: "string", default: "fake" },
    cwd: { type: "string" },
    timeout: { type: "string", default: "600" },
    model: { type: "string" },
    members: { type: "string", default: "小克,小研" },
    to: { type: "string" },
    title: { type: "string", default: "项目群" },
    /** 第一轮收尾后再以用户身份发的一条(如对交付回复「通过」或修改意见),发完再等收尾。 */
    reply: { type: "string" },
  },
});
const [cmd, ...rest] = positionals;

async function makeMind(kind: string): Promise<{ mind: (c: ContactView) => ContactMind; compactor?: (c: ContactView) => ContactCompactor }> {
  if (kind === "fake") return { mind: () => scriptedMind() };
  if (kind === "pi") {
    // 字面量动态 import:按需加载 pi 依赖,G-LAYER 也能核对依赖方向
    const mod = (await import("@g-group/adapter-pi-contact")) as unknown as { createPiContactMind(o: Record<string, unknown>): ContactMind; createPiCompactor(o: Record<string, unknown>): ContactCompactor };
    const bearer = process.env.ANTHROPIC_AUTH_TOKEN;
    const apiKey = bearer ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("--mind pi 需要 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY");
    const opts = (model: string) => ({ provider: "anthropic", model, baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com", apiKey, authHeader: bearer ? "bearer" : "x-api-key" });
    const cache = new Map<string, ContactMind>();
    const compactors = new Map<string, ContactCompactor>();
    return {
      mind: (c) => {
        let m = cache.get(c.speakingModel);
        if (!m) {
          m = mod.createPiContactMind(opts(c.speakingModel));
          cache.set(c.speakingModel, m);
        }
        return m;
      },
      // 状态笔记压缩:同一说话模型的独立调用(AC-32 ③)
      compactor: (c) => {
        let k = compactors.get(c.speakingModel);
        if (!k) {
          k = mod.createPiCompactor(opts(c.speakingModel));
          compactors.set(c.speakingModel, k);
        }
        return k;
      },
    };
  }
  throw new Error(`未知 --mind ${kind}`);
}
function makeCompute(kind: string) {
  if (kind === "fake") {
    const c = scriptedCompute({ stepMs: 50 });
    return { factory: () => c.adapter, close: () => c.close() };
  }
  if (kind === "claude") {
    const pass = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];
    return {
      factory: (model: string) => {
        const hostEnv: Record<string, string> = { ANTHROPIC_MODEL: model };
        for (const k of pass) if (process.env[k]) hostEnv[k] = process.env[k]!;
        return createComputeAdapter({ hostEnv });
      },
      close: () => {},
    };
  }
  throw new Error(`未知 --compute ${kind}`);
}

function print(host: Host, roomId: string) {
  for (const m of host.listMessages(roomId, { limit: 500 }).messages) {
    const who = m.sender.kind === "user" ? "我" : (host.listContacts().find((c) => c.id === m.sender.id)?.name ?? m.sender.id);
    const card = m.card ? `  [卡片:${m.card.kind}/${m.card.state} ${m.card.actions.map((a) => a.label).join("|")}]` : "";
    const at = m.mentions.length ? `  [@${m.mentions.map((x) => (x.id === host.userId ? "我" : (host.listContacts().find((c) => c.id === x.id)?.name ?? x.id))).join(" @")}]` : "";
    console.log(`#${m.seq} ${who}: ${m.text}${card}${at}`);
  }
  for (const t of host.listTasks({ roomId })) {
    console.log(`任务 ${t.id} [${t.state}] ${t.title} 审查门=${t.reviewGate} 进度=${t.recentProgress.map((p) => p.kind).join(">")} Compute=${t.computeRuns.map((r) => r.computeId).join(",")}`);
  }
}

/** 群聊派活:建(或复用)群 → 用户 @ 一位联系人派活 → 等收尾 → 打印群记录与 AC-03 发言者核对。 */
async function runGroup(host: Host, model: string | undefined) {
  const names = values.members.split(",").map((s) => s.trim()).filter(Boolean);
  const { room, contacts } = ensureGroup(host, values.title, names);
  if (model) for (const c of contacts) if (c.speakingModel !== model) host.updateContact(c.id, { speakingModel: model });
  const text = rest.join(" ").trim();
  if (!text) throw new Error("缺消息正文");
  const nameOf = (id: string) => host.listContacts().find((c) => c.id === id)?.name ?? id;
  host.bus.subscribe((e) => {
    if (e.type === "message.appended" && e.message.roomId === room.id && e.message.sender.kind !== "user") console.log(`  → [${e.message.sender.kind}] ${nameOf(e.message.sender.id)}: ${e.message.text}`);
    if (e.type === "compute.progress") console.log(`  · Compute ${e.progress.kind}${e.progress.stage ? `(${e.progress.stage})` : ""}: ${e.progress.summary.slice(0, 200)}`);
  });
  console.log(`群 ${room.id}「${room.title}」成员: ${room.members.map((m) => (m.kind === "user" ? "我" : nameOf(m.id))).join("、")}`);
  const run = await sendAndWait(host, room.id, text, { ...(values.to ? { mention: values.to } : {}), timeoutMs: Number(values.timeout) * 1000 });
  if (run.timedOut) console.error("超时,仍有任务在执行");
  if (values.reply) {
    console.log(`  ← 我: ${values.reply}`);
    const next = await sendAndWait(host, room.id, values.reply, { ...(values.to ? { mention: values.to } : {}), timeoutMs: Number(values.timeout) * 1000 });
    if (next.timedOut) console.error("超时,仍有任务在执行");
  }
  console.log("—— 群记录 ——");
  print(host, room.id);
  const audit = senderAudit(host, room.id);
  console.log(`—— AC-03 发言者核对:${audit.ok ? "通过" : "失败"},共 ${audit.checked} 条,发言者种类 ${[...new Set(run.transcript.map((m) => m.sender.kind))].join("/")} ——`);
  for (const o of audit.offenders) console.log(`  ✗ #${o.seq} ${o.sender.kind}:${o.sender.id} ${o.reason}`);
}

async function main() {
  if (cmd !== "dm" && cmd !== "log" && cmd !== "group") {
    console.log("用法: cli.ts dm|log|group --db 文件 [--name 联系人] [--members 甲,乙 --to 甲] [--mind fake|pi] [--compute fake|claude] [--cwd 目录] \"消息\"");
    process.exit(2);
  }
  const compute = makeCompute(values.compute);
  const cwdRoot = values.cwd ? path.resolve(values.cwd) : undefined;
  const host = new Host({
    file: path.resolve(values.db),
    ...(await makeMind(values.mind)),
    compute: compute.factory,
    ...(cwdRoot
      ? {
          computeCwd: (t: string) => {
            mkdirSync(path.join(cwdRoot, t), { recursive: true });
            return path.join(cwdRoot, t);
          },
        }
      : {}),
    maxDeferMs: 200,
    onReport: (what, detail) => console.error(`[宿主] ${what}`, typeof detail === "object" ? JSON.stringify(detail) : detail),
  });
  try {
    const model = values.model ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    if (model) host.updateSettings({ defaultComputeModel: model, defaultSpeakingModel: model, confirmAffected: true });
    if (cmd === "group") return await runGroup(host, model);
    let contact = host.listContacts().find((c) => c.name === values.name);
    contact ??= host.createContact({ name: values.name });
    const room = host.openDm(contact.id);
    if (cmd === "log") return print(host, rest[0] ?? room.id);
    const text = rest.join(" ").trim();
    if (!text) throw new Error("缺消息正文");
    host.bus.subscribe((e) => {
      if (e.type === "message.appended" && e.message.sender.kind === "contact") console.log(`  → ${values.name}: ${e.message.text}`);
      if (e.type === "compute.progress") console.log(`  · Compute ${e.progress.kind}${e.progress.stage ? `(${e.progress.stage})` : ""}: ${e.progress.summary.slice(0, 200)}`);
    });
    const first = await sendAndWait(host, room.id, text, { timeoutMs: Number(values.timeout) * 1000 });
    if (first.timedOut) console.error("超时,仍有任务在执行");
    if (values.reply) {
      console.log(`  ← 我: ${values.reply}`);
      const second = await sendAndWait(host, room.id, values.reply, { timeoutMs: Number(values.timeout) * 1000 });
      if (second.timedOut) console.error("超时,仍有任务在执行");
    }
    console.log("—— 会话 ——");
    print(host, room.id);
  } finally {
    compute.close();
    await host.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
