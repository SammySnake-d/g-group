// 真实运行(AC-17/19/20 授权闭环):真实 Claude Code Compute + 规则替身联系人(scriptedMind),真实 SQLite。
// 私聊群规「改代码前先问我」→ 派活 → Compute 首轮只有只读工具、报 blocked → 任务 T4b、联系人提问 →
// 用户直接回复「同意」(不点卡)→ 宿主续接并换上写工具 → Compute 写文件 → 交付。前后各核一次文件是否存在。
// 用法: node packages/server/proof/real-auth-run.ts <工作目录>   (模型经 ANTHROPIC_DEFAULT_SONNET_MODEL,网关地址与令牌只经环境变量)
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createComputeAdapter } from "@g-group/adapter-cc-compute";
import { scriptedMind } from "../src/fakes.ts";
import { Host } from "../src/host.ts";

const root = path.resolve(process.argv[2] ?? "/tmp/gg-a-real");
mkdirSync(root, { recursive: true });
const model = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "claude-sonnet-4-6";
const hostEnv: Record<string, string> = { ANTHROPIC_MODEL: model };
for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) if (process.env[k]) hostEnv[k] = process.env[k]!;
const host = new Host({
  file: path.join(root, "gg.db"),
  mind: () => scriptedMind(),
  // 原样转给真实适配器,只把每次派发/续接实际给的工具清单打出来(证据)
  compute: () => {
    const a = createComputeAdapter({ hostEnv });
    return {
      ...a,
      events: () => a.events(),
      spawn: (brief, o) => {
        const b = brief as { tools: string[]; rules: string[] };
        console.log(`# 派发 Compute:tools=${JSON.stringify(b.tools)} rules=${JSON.stringify(b.rules)}`);
        return a.spawn(brief, o);
      },
      resume: (id, text, turn, o) => {
        console.log(`# 续接 Compute ${id}:tools=${JSON.stringify(o?.tools)} 说明=${JSON.stringify(text.slice(0, 120))}`);
        return a.resume(id, text, turn, o);
      },
    };
  },
  computeCwd: (t) => {
    mkdirSync(path.join(root, "work", t), { recursive: true });
    return path.join(root, "work", t);
  },
  maxDeferMs: 200,
  onReport: (what, detail) => console.log(`[宿主] ${what} ${typeof detail === "object" ? JSON.stringify(detail).slice(0, 400) : detail}`),
});
host.updateSettings({ defaultComputeModel: model, defaultSpeakingModel: model });
host.bus.subscribe((e) => {
  if (e.type === "message.appended") console.log(`  #${e.message.seq} ${e.message.sender.kind === "user" ? "我" : "小克"}: ${e.message.text.slice(0, 300)}${e.message.card ? `  [卡片:${e.message.card.kind}]` : ""}`);
  if (e.type === "compute.progress") console.log(`  · Compute ${e.progress.kind}: ${e.progress.summary.slice(0, 200)}`);
});
const until = async (cond: () => boolean, ms: number, what: string) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`等「${what}」超时`);
    await host.idle();
    await new Promise((r) => setTimeout(r, 500));
  }
};
const c = host.createContact({ name: "小克" });
const dm = host.openDm(c.id);
host.updateRoom(dm.id, { rules: "改代码前先问我" });
console.log(`# ${new Date().toISOString()} 模型 ${model};群规「改代码前先问我」`);
host.send({ roomId: dm.id, clientActionId: "real-1", text: "帮我在当前工作目录写一个 hello.txt,内容是 hi after consent" });
const task = () => host.listTasks({ roomId: dm.id })[0];
await until(() => !!task() && ["T4b_BlockedOnHuman", "T5_InReview", "T10_Cancelled", "T11_Failed"].includes(task()!.state), 300_000, "受阻或结束");
const t1 = task()!;
const file = path.join(root, "work", t1.id, "hello.txt");
console.log(`# 首轮后:任务 ${t1.id} [${t1.state}] 版本 v${t1.constraintVersion};授权=${JSON.stringify(t1.authorizations)};hello.txt 存在=${existsSync(file)}`);
if (t1.state !== "T4b_BlockedOnHuman") throw new Error("首轮没有停在等授权");
host.send({ roomId: dm.id, clientActionId: "real-2", text: "同意" });
await until(() => ["T5_InReview", "T10_Cancelled", "T11_Failed"].includes(task()!.state) || (task()!.state === "T4b_BlockedOnHuman" && task()!.authorizations!.length > 1), 480_000, "授权后完成");
const t2 = task()!;
console.log(`# 授权后:任务 [${t2.state}] 授权=${JSON.stringify(t2.authorizations)}`);
console.log(`# hello.txt 存在=${existsSync(file)} 内容=${existsSync(file) ? JSON.stringify(readFileSync(file, "utf8")) : "-"}`);
console.log("—— 会话 ——");
for (const m of host.listMessages(dm.id, { limit: 100 }).messages) console.log(`#${m.seq} ${m.sender.kind === "user" ? "我" : "小克"}: ${m.text.slice(0, 400)}${m.card ? `  [卡片:${m.card.kind}/${m.card.state}]` : ""}`);
await host.close();
