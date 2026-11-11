// 找旧消息预取的耗时实测(T-177 G4;审查条件 G4-b:收据报 1 千、1 万条可见消息时的预取耗时)。
// 做法:先建一个只有用户的群,直接往只追加日志里写 N 条可见消息(哈希链照 domain append 算,不走发送接口,免得每条都重放整条日志);
// 再起宿主、把联系人拉进群(游标从末尾开始,不追溯处理这 N 条),发一条新消息触发一轮,读宿主自己报的 history-prefetch 诊断。
// 每个规模各跑两种时限:默认时限(看实际会不会超时),以及 60 秒(看完整做完要多久);每种连发两条新消息,第一条是冷启动,第二条走上游按正文的特征缓存。
// 同一轮里再调一次 query_history 检索计时。用法:node packages/server/proof/history-prefetch-bench.ts [N...]
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { append, emptyLog, type Log } from "@g-group/domain";
import type { RoundInput, RoundTools } from "@g-group/kernel";
import { openDb } from "../src/db.ts";
import { PREFETCH_TIMEOUT_MS } from "../src/history.ts";
import { Host } from "../src/host.ts";

const WORDS = ["部署", "端口", "会议", "周四", "上午", "预算", "测试服", "数据库", "迁移", "前端", "接口", "文档", "评审", "发布", "回滚", "缓存", "日志", "告警", "用户", "权限", "群聊", "私聊", "任务", "交付", "验收"];
let seed = 7;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const sentence = (i: number) => {
  let s = "";
  const n = 8 + Math.floor(rnd() * 20);
  for (let k = 0; k < n; k++) s += WORDS[Math.floor(rnd() * WORDS.length)]! + (rnd() < 0.3 ? "," : "");
  return `${s}${i}`;
};

interface Diag { status: string; elapsedMs: number; docs?: number; hits?: number }
async function once(n: number, timeoutMs: number) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gg-g4-bench-"));
  const file = path.join(dir, "bench.db");
  try {
    const h0 = new Host({ file, mind: () => ({ round: async () => ({ actions: [], stateNote: null }) }) });
    const c = h0.createContact({ name: "小克" });
    const g = h0.createGroup("项目群", []);
    await h0.close();
    let log: Log = emptyLog();
    const at = "2026-11-11T08:00:00.000Z";
    for (let i = 0; i < n; i++) log = append(log, { kind: "user", id: "me" }, { kind: "message", text: sentence(i) }, at);
    const db = openDb(file);
    const ins = db.store.db.prepare("INSERT INTO events (session, seq, at, sender_kind, sender_id, body, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    db.store.db.exec("BEGIN");
    for (const e of log.events) ins.run(`room:${g.id}`, e.seq, e.at, e.sender.kind, e.sender.id, JSON.stringify(e.body), e.prev, e.hash);
    db.store.db.exec("COMMIT");
    db.close();

    const diags: Diag[] = [];
    const tool: number[] = [];
    const host = new Host({
      file,
      maxDeferMs: 5,
      historyPrefetch: { timeoutMs },
      onReport: (what, detail) => {
        if (what === "history-prefetch") diags.push(detail as Diag);
      },
      mind: () => ({
        async round(_i: RoundInput, _s: AbortSignal, tools?: RoundTools) {
          const t0 = performance.now();
          await tools?.queryHistory?.({ kind: "search", query: "周四上午的会议", roomId: null, limit: null });
          tool.push(Math.round(performance.now() - t0));
          return { actions: [], stateNote: null };
        },
      }),
    });
    host.addMembers(g.id, [{ kind: "contact", id: c.id }]);
    for (const [k, q] of ["部署端口改成多少了", "测试服的数据库迁移什么时候发布"].entries()) {
      host.send({ roomId: g.id, clientActionId: `q${k}`, text: q });
      while (diags.length <= k || tool.length <= k) await new Promise((r) => setTimeout(r, 5));
      await host.idle();
    }
    await host.close();
    return { visible: n, timeoutMs, prefetch: diags.map((d) => ({ status: d.status, elapsedMs: d.elapsedMs, docs: d.docs ?? null, hits: d.hits ?? null })), searchToolMs: tool };
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const sizes = process.argv.slice(2).map(Number).filter((x) => Number.isSafeInteger(x) && x > 0);
const env = { node: process.version, cpus: os.cpus().length, cpu: os.cpus()[0]?.model ?? "?", mem: `${Math.round(os.totalmem() / 2 ** 30)}G`, loadavg: os.loadavg().map((x) => x.toFixed(2)), platform: `${os.platform()} ${os.release()}` };
console.log(JSON.stringify({ env }));
for (const n of sizes.length ? sizes : [1000, 10000]) {
  for (const t of [PREFETCH_TIMEOUT_MS, 60_000]) console.log(JSON.stringify(await once(n, t)));
}
