// 真实运行(feat/tests-search;AC-46 回执、AC-31 ⑤ 终态回收、U32 全局搜群与联系人):真实联系人脑子(pi,真模型)+ 真实 SQLite,真实服务层入口。
// 场景:群里发一条消息(先不看回执)→ 等联系人接走 → 回执从未读变已读,且读到时间 = 接走时刻;
//       群里再派一件必然失败的任务(failSpawn)→ 联系人把末次汇报发出来后,它的承诺由机器失效回收;
//       最后用 search.rooms 按联系人名与群名各搜一次(全局搜群与联系人,AC-25 的 search.messages 不在本片)。
// 网关地址、令牌与模型只经环境变量(ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_SONNET_MODEL),不落盘、不打印。
// 用法:node packages/server/proof/tests-search-real.ts <数据目录>
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type ServerEvent, checkResult } from "@g-group/api-contract";
import { startServer } from "../src/start.ts";

const root = path.resolve(process.argv[2] ?? "/tmp/gg-tests-search-real");
mkdirSync(root, { recursive: true });
const started = await startServer({ dataDir: root, mind: "pi", onReport: (what, detail) => console.log(`[宿主] ${what} ${JSON.stringify(detail).slice(0, 300)}`) });
const svc = started.service;
const host = started.host;
host.bus.subscribe((e: ServerEvent) => {
  if (e.type === "message.appended") console.log(`  #${e.message.seq} ${e.message.sender.kind === "user" ? "我" : e.message.sender.id}: ${e.message.text.slice(0, 200)}`);
  if (e.type === "commitment.updated") console.log(`  [承诺] ${e.commitment.id} → ${e.commitment.status}`);
});

async function call<T>(method: string, params: unknown): Promise<T> {
  const r = await svc.handle(method as never, params);
  if (!r.ok) throw new Error(`${method}:${r.error.code} ${r.error.message}`);
  const checked = checkResult(method as never, r.value);
  if (!checked.ok) throw new Error(`${method} 结果不合合同`);
  return r.value as T;
}
const settle = async (ms: number) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 500));
  }
};
const cid = (await call<{ id: string }>("contacts.create", { name: "小克", clientActionId: "c1" })).id;
const g = await call<{ id: string }>("rooms.createGroup", { clientActionId: "g1", title: "回执验收群", members: [{ kind: "contact", id: cid }] });

// ① 群里发一条消息:先看回执(还没接走 → 未读),再等联系人接走(→ 已读,读到时间 = 接走时刻)
const sent = await call<{ seq: number }>("messages.send", { roomId: g.id, clientActionId: "u1", text: "有进度的话汇报到群里 @我看看" });
const beforeTakeOver = await call<{ read: { member: { id: string } }[]; unread: { member: { id: string } }[] }>("messages.receipts", { roomId: g.id, seq: sent.seq });
console.log(`发出去立刻看回执:已读 ${beforeTakeOver.read.length} 人 / 未读 ${beforeTakeOver.unread.length} 人`);
await settle(180_000);
const afterTakeOver = await call<{ read: { member: { id: string }; at: string }[]; unread: unknown[] }>("messages.receipts", { roomId: g.id, seq: sent.seq });
console.log(`联系人接走后回执:已读 ${afterTakeOver.read.length} 人 / 未读 ${afterTakeOver.unread.length} 人;读到时间 ${afterTakeOver.read[0]?.at ?? "(无)"}`);

// ② 派一件活,等它交付后由用户取消(T10):承诺不该在取消那一刻就没了(末次汇报还没发),
//    负责人下一条汇报发出后由机器失效回收(AC-31 ⑤:绑定任务进终态 + 末次汇报已发出)
await call("messages.send", { roomId: g.id, clientActionId: "u2", text: "帮我编译这个项目", mentions: [{ id: cid, source: "manual" }] });
await settle(120_000);
const tasks = await call<{ tasks: { id: string; title: string; state: string }[] }>("tasks.list", { roomId: g.id });
console.log(`任务:${tasks.tasks.map((t) => `${t.title}=${t.state}`).join(", ") || "(没有)"}`);
const live = tasks.tasks.find((t) => !["T8_Accepted", "T10_Cancelled", "T11_Failed"].includes(t.state));
if (live) {
  await call("tasks.cancel", { taskId: live.id, clientActionId: "c2" });
  await settle(30_000);
  const afterCancel = await call<{ tasks: { id: string; state: string }[] }>("tasks.list", { roomId: g.id });
  const ks1 = await call<{ commitments: { text: string; status: string }[] }>("commitments.list", { contactId: cid, roomId: g.id });
  console.log(`取消后:任务=${afterCancel.tasks.find((t) => t.id === live.id)?.state};承诺=${ks1.commitments.map((k) => `「${k.text}」=${k.status}`).join(", ") || "(没有)"}`);
  // 负责人在这个群里回一句(末次汇报):机器应当在同一次落盘里把终态任务的承诺失效回收
  await call("messages.send", { roomId: g.id, clientActionId: "u3", text: `@小克 那件事不做了,收到回我一声`, mentions: [{ id: cid, source: "manual" }] });
  await settle(180_000);
  const ks2 = await call<{ commitments: { text: string; status: string }[] }>("commitments.list", { contactId: cid, roomId: g.id });
  console.log(`末次汇报之后:承诺=${ks2.commitments.map((k) => `「${k.text}」=${k.status}`).join(", ") || "(没有)"}`);
}

// ③ 全局搜联系人和群(U32)
const byName = await call<{ rooms: { roomId: string; kind: string; title: string; matchedIn: string; matchedName: string | null }[] }>("search.rooms", { query: "小克" });
console.log(`search.rooms("小克"):${byName.rooms.map((r) => `${r.roomId}/${r.kind}/${r.title}/${r.matchedIn}${r.matchedName ? `:${r.matchedName}` : ""}`).join(" | ") || "(无)"}`);
const byTitle = await call<{ rooms: { roomId: string; title: string; matchedIn: string }[] }>("search.rooms", { query: "回执验收" });
console.log(`search.rooms("回执验收"):${byTitle.rooms.map((r) => `${r.roomId}/${r.title}/${r.matchedIn}`).join(" | ") || "(无)"}`);

await host.close();
console.log("收尾:残留进程 0");
