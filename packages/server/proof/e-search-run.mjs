// AC-25 / AC-08 真实运行:经服务层入口 createService(Host).handle(与桌面端 IPC 同一入口)在真实 SQLite 文件上
// 发消息 → search.messages → messages.list({ aroundSeq }) 跳转 → 撤回 → 再搜 + 直接查索引表 → 删索引表重开宿主重建 → 再搜。
// 联系人用确定性规则脑子(fakes.ts 的 scriptedMind),本流程不涉及模型。
// 用法: node packages/server/proof/e-search-run.mjs > packages/server/proof/e-search-run.txt
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scriptedMind } from "../src/fakes.ts";
import { Host } from "../src/host.ts";
import { createService } from "../src/service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-e-search-run-"));
const db = path.join(dir, "gg.db");
const show = (label, v) => console.log(`\n### ${label}\n${JSON.stringify(v, null, 2)}`);
async function call(svc, method, params) {
  const r = await svc.handle(method, params);
  show(`${method} ${JSON.stringify(params)}`, r);
  if (!r.ok) throw new Error(`${method} 失败`);
  return r.value;
}
async function quiet(host) {
  for (let i = 0; i < 100; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 10));
    if (!host.loop.busy()) return;
  }
}
try {
  console.log(`# AC-25 基础搜索真实运行 ${new Date().toISOString()} node ${process.version}\n数据库 ${db}`);
  let host = new Host({ file: db, dataDir: dir, mind: () => scriptedMind(), maxDeferMs: 5 });
  let svc = createService(host);
  const c = await call(svc, "contacts.create", { clientActionId: "c1", name: "小克" });
  const g = await call(svc, "rooms.createGroup", { clientActionId: "g1", title: "登录组", members: [{ kind: "contact", id: c.id }] });
  const dm = await call(svc, "rooms.openDm", { contactId: c.id });
  const a = await call(svc, "messages.send", { roomId: g.id, clientActionId: "m1", text: "登录接口限流阈值先定 200 QPS" });
  await call(svc, "messages.send", { roomId: g.id, clientActionId: "m2", text: "限流再压测一轮", threadRootSeq: a.seq });
  const secret = await call(svc, "messages.send", { roomId: g.id, clientActionId: "m3", text: "限流开关口令 NEUTRAL_FIXTURE_NO_CREDENTIALS" });
  const f = path.join(dir, "压测报告-1108.md");
  writeFileSync(f, "# NEUTRAL_FIXTURE_NO_CREDENTIALS");
  const att = await call(svc, "attachments.add", { path: f });
  await call(svc, "messages.send", { roomId: dm.id, clientActionId: "m4", text: "报告在附件里", attachments: [att.ref] });
  await quiet(host);
  const hits = await call(svc, "search.messages", { query: "限流" });
  await call(svc, "search.messages", { query: "压测报告" });
  const first = hits.hits.at(-1);
  await call(svc, "messages.list", { roomId: first.roomId, aroundSeq: first.seq, limit: 3 });
  await call(svc, "messages.retract", { roomId: g.id, seq: secret.seq });
  await call(svc, "search.messages", { query: "NEUTRAL_FIXTURE" });
  const rows = host.db.store.db.prepare("SELECT count(*) AS n FROM gg_search WHERE text LIKE '%NEUTRAL_FIXTURE%' OR att LIKE '%NEUTRAL_FIXTURE%'").get();
  show("索引表里含撤回原文的行数", rows);
  const before = await call(svc, "search.messages", { query: "限流" });
  await quiet(host);
  await host.close();

  const raw = new DatabaseSync(db);
  raw.exec("DROP TABLE gg_search");
  raw.close();
  console.log("\n### 已删除派生索引表 gg_search,重开宿主");
  host = new Host({ file: db, dataDir: dir, mind: () => scriptedMind(), maxDeferMs: 5 });
  svc = createService(host);
  const after = await call(svc, "search.messages", { query: "限流" });
  show("重建前后「限流」结果一致", JSON.stringify(before) === JSON.stringify(after));
  await call(svc, "search.messages", { query: "NEUTRAL_FIXTURE" });
  await quiet(host);
  await host.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
