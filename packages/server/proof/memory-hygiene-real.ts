// 本片(记忆与笔记的撤回/回退清洗 + 记忆对外接口)的真实运行证据:不用测试的进程内夹具,分两个真实的 node 进程走真实入口。
//   进程 1(写):生产组装(Host + createService,真实 SQLite 文件、真实 md 目录、真实 service 路由)把记忆写下来,
//     再撤回来源消息、对一条未撤回的做 memory.revoke,把磁盘状态留给进程 2;
//   进程 2(核对):新进程启动时按启动核对从 md 重建索引,打印 memory.list / contacts.profile 读到的东西、
//     下一轮第 1 与第 5 块里还有什么、gg_memory 行数与 md 文件数、md 真源与索引里各自还留不留下那条正文。
//   联系人动作由脚本替身给出(不连模型):本片考的是宿主对撤回/回退的机械处理,不考模型会不会选对关系。
// 场景取自 deliverable 的真实故事 US3:凭据内容进了联系人的记忆与状态笔记,撤回原消息之后它还进不进上下文。
// 测试隔离用中性内容(NEUTRAL_FIXTURE_NO_CREDENTIALS),不读、不打印任何真实凭据。
// 用法: node packages/server/proof/memory-hygiene-real.ts <数据目录> write|verify
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ApiResult, MethodName } from "@g-group/api-contract";
import type { MindAction, RoundInput } from "@g-group/kernel";
import { all } from "../src/db.ts";
import { Host } from "../src/host.ts";
import { createService } from "../src/service.ts";

const dataDir = process.argv[2];
const mode = process.argv[3];
if (!dataDir || (mode !== "write" && mode !== "verify")) throw new Error("用法: memory-hygiene-real.ts <数据目录> write|verify");
mkdirSync(dataDir, { recursive: true });

const SECRET = "NEUTRAL_FIXTURE_NO_CREDENTIALS";
const requests: RoundInput["request"][] = [];
const lastLines = () =>
  requests.at(-1)?.blocks.map((b) => `${b.block}:${b.text.replace(/\s+/g, " ").slice(0, 260)}`).join("\n    ") ?? "(没有请求)";

/** 脚本替身:用户说「记:…」就记住,并给状态笔记;不连模型。 */
function mind() {
  return {
    async round(i: RoundInput) {
      requests.push(i.request);
      const m = [...i.fresh].reverse().find((f) => f.kind === "message");
      const actions: MindAction[] = [];
      if (m?.kind === "message" && m.text.startsWith("记:")) {
        const body = m.text.slice(2);
        actions.push({
          kind: "remember", roomId: m.roomId, sourceSeq: m.seq, title: body.slice(0, 8), text: body,
          anchors: body.startsWith("以后所有") ? ["global"] : [`room:${m.roomId}`], quote: body.startsWith("以后所有") ? body : null, relation: null, target: null,
        });
      }
      return { actions, stateNote: `在做:${m?.kind === "message" ? m.text : "等待"};下一步:按新消息继续` };
    },
  };
}
async function settle(host: Host) {
  for (let i = 0; i < 400; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (!host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 5));
      if (!host.loop.busy()) return;
    }
  }
  throw new Error("宿主没有安静下来");
}
const say = async (host: Host, roomId: string, k: string, text: string) => {
  const m = host.send({ roomId, clientActionId: k, text });
  await settle(host);
  return m.seq;
};
const value = <T>(r: ApiResult<MethodName>, what: string): T => {
  if (!r.ok) throw new Error(`${what} 失败:${r.error.code} ${r.error.message}`);
  return r.value as T;
};

const host = new Host({ file: path.join(dataDir, "gg.db"), dataDir, mind, maxDeferMs: 5 });
const svc = createService(host);
const rows = <T = Record<string, unknown>>(sql: string, ...p: (string | number)[]): T[] => (p.length ? all<T>(host.db, sql, ...p) : all<T>(host.db, sql));
const indexRows = (contactId: string) => Number(rows<{ n: number }>("SELECT count(*) AS n FROM gg_memory WHERE contact_id = ?", contactId)[0]!.n);
const mdFiles = (contactId: string) => readdirSync(path.join(dataDir, "memory", contactId)).filter((f) => f.endsWith(".md"));
type ListOut = { memories: { id: string; body: string; scope: string; status: string; state: string; effective: boolean }[] };

if (mode === "write") {
  const c = host.createContact({ name: "小克", speakingModel: "scripted" });
  const dm = host.openDm(c.id);
  await say(host, dm.id, "1", "记:以后所有回复都先给结论");
  await say(host, dm.id, "2", `记:VPS 配置里写的是 ${SECRET}`);
  await say(host, dm.id, "3", "记:周报每周五发给小王");
  const list = value<ListOut>(await svc.handle("memory.list", { contactId: c.id }), "memory.list");
  const byBody = new Map(list.memories.map((v) => [v.body, v]));
  console.log(`进程 1 写:联系人 ${c.id} 会话 ${dm.id}`);
  console.log(`  写入后:索引 ${indexRows(c.id)} 行、md ${mdFiles(c.id).length} 个;memory.list ${list.memories.length} 条`);
  for (const v of list.memories) console.log(`    ${v.id} ${v.scope}/${v.status}/${v.state} effective=${v.effective} 「${v.body}」`);

  const weekly = byBody.get("周报每周五发给小王")!;
  const rv = value<{ status: string; version: number }>(await svc.handle("memory.revoke", { contactId: c.id, memoryId: weekly.id, clientActionId: "rv" }), "memory.revoke");
  console.log(`  memory.revoke「周报」:${rv.status} v${rv.version};md 文件还在:${mdFiles(c.id).includes(`${weekly.id}.md`)};索引行还在:${Number(rows<{ n: number }>("SELECT count(*) AS n FROM gg_memory WHERE contact_id = ? AND id = ?", c.id, weekly.id)[0]!.n) === 1}`);

  host.retractMessage(dm.id, 2);
  await settle(host);
  console.log(`  撤回 #2(带凭据那句)之后的落盘状态笔记:${host.stateNote(c.id)}`);
  const after = value<ListOut>(await svc.handle("memory.list", { contactId: c.id }), "memory.list");
  const secretEntry = after.memories.find((v) => v.body.includes(SECRET))!;
  console.log(`  撤回后「${secretEntry.id}」:state=${secretEntry.state} effective=${secretEntry.effective}`);
  const prof = value<{ memory: { longTerm: { prefix: { count: number }; anchored: { count: number }; sourceRetracted: number; inactive: number } } }>(
    await svc.handle("contacts.profile", { contactId: c.id }),
    "contacts.profile",
  );
  console.log(`  资料页长期记忆:前缀 ${prof.memory.longTerm.prefix.count}、锚点 ${prof.memory.longTerm.anchored.count}、来源已撤回 ${prof.memory.longTerm.sourceRetracted}、已失效 ${prof.memory.longTerm.inactive}`);
  const contSeq = await say(host, dm.id, "4", "继续");
  console.log(`  撤回后下一轮请求(${requests.length} 次)最后一块:\n    ${lastLines()}`);
  console.log(`  这一轮里还有那条凭据原文吗:${new RegExp(SECRET).test(requests.at(-1)!.blocks.map((b) => b.text).join("\n"))}`);
  // U29(候选做法):私聊工作记忆 = 该联系人的状态笔记,rewind 撤下范围的原文按撤回的办法清掉,长期记忆不动
  const memBefore = value<ListOut>(await svc.handle("memory.list", { contactId: c.id }), "memory.list");
  await say(host, dm.id, "5", "记:周六订去杭州的高铁");
  const noteBefore = host.stateNote(c.id) ?? "";
  const rew = host.rewind({ roomId: dm.id, toSeq: contSeq, clientActionId: "rw" });
  console.log(`  rewind 到 #${contSeq}:撤下 ${JSON.stringify(rew.messages.map((m) => m.seq))}`);
  console.log(`  回退前状态笔记:${noteBefore}`);
  console.log(`  回退事务里就清掉后的状态笔记:${host.stateNote(c.id)}`);
  const memAfter = value<ListOut>(await svc.handle("memory.list", { contactId: c.id }), "memory.list");
  const keep = (ms: ListOut["memories"]) => ms.filter((v) => memBefore.memories.some((b) => b.id === v.id)).map((v) => `${v.id}=${v.body}`).join(" ");
  console.log(`  长期记忆条数 ${memBefore.memories.length} → ${memAfter.memories.length};回退前已有的条目逐条不变:${keep(memAfter.memories) === memBefore.memories.map((v) => `${v.id}=${v.body}`).join(" ")}`);
  console.log(`  回退不回滚长期记忆(U29):撤下的 #6 写出的那条仍在:${memAfter.memories.some((v) => v.body === "周六订去杭州的高铁")}`);
  await say(host, dm.id, "6", "继续");
  const b3 = requests.at(-1)!.blocks.find((b) => b.block === 3)!.text;
  console.log(`  回退后下一轮第 3 块:${b3.replace(/\s+/g, " ").slice(0, 200)}`);
  console.log(`  第 3 块含撤下原文吗:${b3.includes("周六订去杭州的高铁")}`);

  await host.close();
  console.log(`进程 1 结束,数据留在 ${dataDir}`);
  process.exit(0);
}

const c = host.listContacts()[0]!;
const md = mdFiles(c.id);
console.log(`进程 2 核对:联系人 ${c.id};md ${md.length} 个、启动核对后索引 ${indexRows(c.id)} 行,一致:${md.length === indexRows(c.id)}`);
const list = value<ListOut>(await svc.handle("memory.list", { contactId: c.id }), "memory.list");
console.log("  memory.list:");
for (const v of list.memories) console.log(`    ${v.id} ${v.scope}/${v.status}/${v.state} effective=${v.effective} 「${v.body}」`);
const secretEntry = list.memories.find((v) => v.body.includes(SECRET))!;
const prof = value<{ memory: { stateNote: { text: string } | null; longTerm: { prefix: { count: number }; anchored: { count: number }; sourceRetracted: number; inactive: number } } }>(
  await svc.handle("contacts.profile", { contactId: c.id }),
  "contacts.profile",
);
console.log(`  contacts.profile:长期记忆 前缀 ${prof.memory.longTerm.prefix.count}、锚点 ${prof.memory.longTerm.anchored.count}、来源已撤回 ${prof.memory.longTerm.sourceRetracted}、已失效 ${prof.memory.longTerm.inactive}`);
console.log(`  contacts.profile 状态笔记:${prof.memory.stateNote?.text}`);
const dm = host.openDm(c.id);
await say(host, dm.id, "q", "问");
const blocks = requests.at(-1)!.blocks.map((b) => b.text).join("\n");
console.log(`  重启后下一轮第 1 块含那条凭据原文:${blocks.split("第2块")[0]!.includes(SECRET)};整轮含它:${blocks.includes(SECRET)};含已撤销的「周报每周五发给小王」:${blocks.includes("周报每周五发给小王")}`);
console.log(`  md 真源里还留着那条正文(用户可查、不回到联系人上下文):${md.some((f) => readFileSync(path.join(dataDir, "memory", c.id, f), "utf8").includes(SECRET))}`);
console.log(`  gg_memory 索引里还留着那条正文:${rows<{ json: string }>("SELECT json FROM gg_memory WHERE contact_id = ?", c.id).some((r) => r.json.includes(SECRET))}`);
host.db.store.db.prepare("DELETE FROM gg_memory").run();
console.log(`  手工清空索引后 memory.rebuild:${JSON.stringify(value<{ contacts: unknown }>(await svc.handle("memory.rebuild", { contactId: c.id }), "memory.rebuild").contacts)};重建后条目与重建前一致:${JSON.stringify(value<ListOut>(await svc.handle("memory.list", { contactId: c.id }), "memory.list")) === JSON.stringify(list)}`);
void secretEntry;
await host.close();
console.log("进程 2 结束");
