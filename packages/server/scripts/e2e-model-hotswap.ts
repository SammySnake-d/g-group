// AC-51 经宿主的真实端到端:Host + 真实 Claude Code 常驻 Compute(claudeCompute)+ 规则替身联系人脑子。
// 私聊派活(模型 A,记住暗号)→ 交付 → 用户把联系人的 Compute 改成模型 B → 用户退回「把暗号写进 code.txt」
// (B 被 harness 拒绝时第 2 轮不发出,脚本照样打印进度、消息与网关记录)
// → 宿主现场解析出 B 交给同一个 Compute,适配器在轮边界会话内换模型 → 核对:同一会话、同一进程(started 只一次)、
// code.txt 里是暗号(上下文还在)、任务账本 start=A / turn=B、网关逐请求记录的请求模型。
// 用法: node packages/server/scripts/e2e-model-hotswap.ts <模型A> <模型B>
// 网关地址与令牌只经环境变量交给 Claude Code,不打印;网关核对只摘 ~/.config/magpie/usage.jsonl 里本次会话的行的模型与状态字段。
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCompute } from "../src/compute.ts";
import { scriptedMind } from "../src/fakes.ts";
import { Host } from "../src/host.ts";

const [A, B] = process.argv.slice(2);
if (!A || !B) throw new Error("用法: e2e-model-hotswap.ts <模型A> <模型B>");
const t0 = Date.now();
const say = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const root = mkdtempSync(path.join(os.tmpdir(), "gg-e2e-hotswap-"));
type Ev = { kind: string; sessionId?: string; pid?: number; model?: string; models?: readonly string[] };
const events: Ev[] = [];
const make = claudeCompute(process.env);
const host = new Host({
  file: path.join(root, "gg.db"),
  mind: () => scriptedMind(),
  compute: (m) => {
    const a = make(m);
    const ev = a.events();
    void (async () => {
      for await (const e of ev) {
        const x = e as unknown as Ev;
        events.push(x);
        say(`compute 事件 ${JSON.stringify({ kind: x.kind, sessionId: x.sessionId, pid: x.pid, model: x.model, models: x.models })}`);
      }
    })();
    return a;
  },
  computeCwd: () => path.join(root, "work"),
  maxDeferMs: 5,
});
const wait = async (what: string, ok: () => boolean, ms = 240_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`等不到:${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
try {
  await import("node:fs").then((fs) => fs.mkdirSync(path.join(root, "work"), { recursive: true }));
  host.updateSettings({ defaultComputeModel: A, defaultEffort: "low", confirmAffected: true });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  say(`模型 A=${A} B=${B};联系人 Compute 继承全局(${host.contactView(host.contactDoc(c.id).value).computeResolved?.resolved.chain.join(" → ")})`);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我记住暗号 PLUM-7731,然后在当前目录写一个 hello.txt,内容是 ok,写好就汇报完成" });
  await wait("第 1 轮完成", () => events.some((e) => e.kind === "completed"));
  const [task] = host.listTasks({ contactId: c.id });
  if (!task) throw new Error("没有建出任务");
  await wait("交付等用户回复", () => ["T5_InReview", "T8a_Delivered"].includes(host.taskView(host.taskDoc(task.id).value).state));
  say(`第 1 轮结束,任务 ${task.id} 状态 ${host.taskView(host.taskDoc(task.id).value).state}`);
  host.updateContact(c.id, { computeModel: { mode: "explicit", model: B }, confirmAffected: true });
  say(`用户把联系人的 Compute 改成 ${B};解析链:${host.contactView(host.contactDoc(c.id).value).computeResolved?.resolved.chain.join(" → ")}`);
  host.taskDecision(task.id, "reject", "u2", "把我让你记住的暗号写进当前目录的 code.txt,只写暗号本身,写好汇报完成");
  // 第 2 轮两种结局都要看:换模型成功并完成,或 harness 拒绝新模型(宿主这一轮不发出、联系人说明原因,AC-51 ④)
  try {
    await wait("第 2 轮完成或换模型被拒", () => events.filter((e) => e.kind === "completed").length >= 2 || host.progress(task.id).some((p) => p.kind === "blocked" && p.stage === "model"));
  } catch (err) {
    say(`第 2 轮等待结束:${(err as Error).message}`);
  }
  say(`第 2 轮后任务状态 ${host.taskView(host.taskDoc(task.id).value).state}`);
  say(`进度:${JSON.stringify(host.progress(task.id).map((p) => ({ kind: p.kind, stage: p.stage, summary: p.summary })))}`);
  await host.idle();
  const view = host.taskView(host.taskDoc(task.id).value);
  const code = path.join(root, "work", "code.txt");
  const started = events.filter((e) => e.kind === "started");
  say(`started 事件数=${started.length};会话=${started.map((e) => e.sessionId).join(",")};pid=${started.map((e) => e.pid).join(",")}`);
  say(`completed 事件实际模型:${JSON.stringify(events.filter((e) => e.kind === "completed").map((e) => e.models))}`);
  say(`code.txt ${existsSync(code) ? `内容=${JSON.stringify(readFileSync(code, "utf8").trim())}` : "不存在"}`);
  say(`任务启动快照=${JSON.stringify(view.modelSnapshot)}`);
  say(`任务尝试账本=${JSON.stringify(view.modelAttempts?.map((x) => [x.seq, x.reason, x.model, x.effort]))}`);
  say(`累积厂商=${JSON.stringify(view.producerVendors)}`);
  say(`会话消息:\n${host.listMessages(dm.id, {}).messages.map((m) => `  #${m.seq} ${m.sender.kind}: ${m.text.slice(0, 160).replace(/\n/g, " ")}`).join("\n")}`);
  const sid = started[0]?.sessionId;
  const usage = path.join(os.homedir(), ".config/magpie/usage.jsonl");
  if (sid && existsSync(usage)) {
    const rows: unknown[] = [];
    for (const line of readFileSync(usage, "utf8").split("\n")) {
      if (!line.includes(sid)) continue;
      try {
        const d = JSON.parse(line) as Record<string, unknown>;
        if (d.native_session !== sid && d.session !== sid) continue;
        rows.push({ t: d.t, req: d.req, model: d.model, served: d.served, effort: d.effort, status: d.status, stop: d.stop });
      } catch {
        /* 坏行跳过 */
      }
    }
    console.log(`\n== 网关用量日志中本次会话(${sid})的请求,共 ${rows.length} 条 ==`);
    for (const r of rows) console.log(JSON.stringify(r));
  } else console.log("\n== 网关用量日志不可读或没拿到会话 id ==");
} finally {
  await host.close();
  const pid = events.find((e) => e.kind === "started")?.pid;
  const alive = (p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 40 && pid && alive(pid); i++) await new Promise((r) => setTimeout(r, 250));
  say(`宿主关闭后 Claude Code 进程 ${pid ?? "-"} ${pid && alive(pid) ? "仍在" : "已退出"};停止事件数=${events.filter((e) => e.kind === "stopped").length}`);
  rmSync(root, { recursive: true, force: true });
  say("临时目录已删");
}
process.exit(0);
