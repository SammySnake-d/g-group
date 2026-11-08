#!/usr/bin/env node
// gg:P0 闭环的命令行驱动器(技术栈文档阶段一「先用 CLI/测试驱动跑通」)。
//   node packages/server/src/cli.ts dm --db ./gg.db --name 小克 "帮我在 /tmp/gg-demo 写 hello.txt"
//   node packages/server/src/cli.ts log --db ./gg.db [roomId]
// 选项:--mind fake|pi(默认 fake 规则脑子;pi 需要 @g-group/adapter-pi-contact 与模型网关环境变量)
//       --compute fake|claude(默认 fake;claude 起真实 Claude Code CLI)  --cwd 目录(Compute 工作目录)  --timeout 秒
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createComputeAdapter } from "@g-group/adapter-cc-compute";
import type { ContactView } from "@g-group/api-contract";
import type { ContactMind } from "@g-group/kernel";
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
  },
});
const [cmd, ...rest] = positionals;

async function makeMind(kind: string): Promise<(c: ContactView) => ContactMind> {
  if (kind === "fake") return () => scriptedMind();
  if (kind === "pi") {
    const spec = "@g-group/adapter-pi-contact";
    const mod = (await import(spec)) as { createPiContactMind(o: Record<string, unknown>): ContactMind };
    const bearer = process.env.ANTHROPIC_AUTH_TOKEN;
    const apiKey = bearer ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("--mind pi 需要 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY");
    const cache = new Map<string, ContactMind>();
    return (c) => {
      let m = cache.get(c.speakingModel);
      if (!m) {
        m = mod.createPiContactMind({ provider: "anthropic", model: c.speakingModel, baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com", apiKey, authHeader: bearer ? "bearer" : "x-api-key" });
        cache.set(c.speakingModel, m);
      }
      return m;
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
    console.log(`#${m.seq} ${who}: ${m.text}${card}`);
  }
  for (const t of host.listTasks({ roomId })) {
    console.log(`任务 ${t.id} [${t.state}] ${t.title} 审查门=${t.reviewGate} 进度=${t.recentProgress.map((p) => p.kind).join(">")}`);
  }
}

async function main() {
  if (cmd !== "dm" && cmd !== "log") {
    console.log("用法: cli.ts dm|log --db 文件 [--name 联系人] [--mind fake|pi] [--compute fake|claude] [--cwd 目录] \"消息\"");
    process.exit(2);
  }
  const compute = makeCompute(values.compute);
  const cwdRoot = values.cwd ? path.resolve(values.cwd) : undefined;
  const host = new Host({
    file: path.resolve(values.db),
    mind: await makeMind(values.mind),
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
    if (model) host.updateSettings({ defaultComputeModel: model, defaultSpeakingModel: model });
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
    host.send({ roomId: room.id, clientActionId: `cli-${Date.now()}`, text });
    const deadline = Date.now() + Number(values.timeout) * 1000;
    // 等到联系人空闲、任务不在执行中
    for (;;) {
      await host.idle();
      await new Promise((r) => setTimeout(r, 500));
      const running = host.listTasks({ roomId: room.id }).some((t) => ["T1_Open", "T2_Claimed", "T3_Running"].includes(t.state));
      if (!running && !host.loop.busy()) break;
      if (Date.now() > deadline) {
        console.error("超时,仍有任务在执行");
        break;
      }
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
