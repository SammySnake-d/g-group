// 转发选中消息与显式关联(feat/forward-link;需求 U24/U25/U100、US2、D04 第 1 节、D06 第 3 节第 2 条、D28.6;验收 AC-20、AC-57 转发入口的后端)。
// 用确定性替身驱动,真实 SQLite:
//   转发 —— 目标会话追加一条「转发的聊天记录」(原文快照,发送人是用户);不授予目标会话的联系人读原会话的权限(邻居读不到,
//            顺着副本或原序号回读、read_linked 都读不到);非成员被拒;副本里的「同意」不放行(AC-20);副本里的 @ 与命令不进元数据(R-10);
//            原消息撤回后副本标「来源已撤回」、正文仍在(候选)。
//   关联(静态,候选)—— 圈定关联那一刻的上界,联系人用只读 read_linked 在上界内按需读,上界之后读不到;不每轮注入、第 1 块前缀不变;
//            非成员被拒;解除后读不到。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ComputeEvent } from "@g-group/adapter-cc-compute";
import type { MessageView, RoomView, ServerEvent, TaskView } from "@g-group/api-contract";
import type { ContactMind, Inbound, InboundMessage, MindAction, RoundInput, RoundTools } from "@g-group/kernel";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-fwdlink-"));
let fileNo = 0;
const file = () => path.join(dir, `f${++fileNo}.db`);
// 每个用例建的宿主都登记在这里:断言失败时用例提前结束,宿主也照样关掉,进程不被遗留的定时器挂住
const hosts: Host[] = [];
const open = (o: ConstructorParameters<typeof Host>[0]) => {
  const h = new Host(o);
  hosts.push(h);
  return h;
};
after(async () => {
  for (const h of hosts.splice(0)) await h.close();
  rmSync(dir, { recursive: true, force: true });
});

async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 300; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if ((!compute || compute.drained()) && !host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 10));
      if (!host.loop.busy() && (!compute || compute.drained())) return;
    }
  }
  throw new Error("宿主没有安静下来");
}

interface Seen { contactId: string; request: RoundInput["request"]; fresh: readonly Inbound[] }
/** 联系人替身:记下每一轮实际收到的五块与结构化新输入;act 可在本轮内调只读查询口并给出动作。 */
function probe(seen: Seen[], act?: (me: string, i: RoundInput, tools: RoundTools | undefined) => Promise<MindAction[]> | MindAction[]) {
  return (): ContactMind => ({
    async round(i: RoundInput, _s: AbortSignal, tools?: RoundTools) {
      seen.push({ contactId: i.contact.id, request: i.request, fresh: i.fresh });
      return { actions: (await act?.(i.contact.id, i, tools)) ?? [], stateNote: null };
    },
  });
}
const textOf = (s: Seen) => s.request.blocks.map((b) => b.text).join("\n");
const freshMsg = (s: Seen, roomId: string, seq: number) => s.fresh.find((f): f is InboundMessage => f.kind === "message" && f.roomId === roomId && f.seq === seq);
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

type Svc = ReturnType<typeof createService>;
/** 经服务层(按 @g-group/api-contract 校验参数与结果)调用:同时核对新方法与新字段符合合同。 */
async function call<T>(svc: Svc, method: string, params: unknown): Promise<T> {
  const r = await svc.handle(method as never, params);
  if (!r.ok) throw Object.assign(new Error(`${method}:${r.error.code} ${r.error.message}`), { code: r.error.code });
  return r.value as T;
}
async function failCode(svc: Svc, method: string, params: unknown): Promise<string> {
  const r = await svc.handle(method as never, params);
  assert.equal(r.ok, false, `${method} 应失败`);
  return r.ok ? "" : r.error.code;
}
const msgsOf = (host: Host, roomId: string) => host.listMessages(roomId, { limit: 500 }).messages;
const LINK = (roomId: string, linkedRoomId: string | null, o: { query?: string; beforeSeq?: number; limit?: number } = {}) => ({ roomId, linkedRoomId, query: o.query ?? null, beforeSeq: o.beforeSeq ?? null, limit: o.limit ?? null });

test("转发:目标会话追加一条「转发的聊天记录」,是选中几条的原文快照(原会话标题、原发言者、原时间),发送人是用户;同一 clientActionId 重发不重复;原文之后再改不影响副本,副本不能编辑", async () => {
  const seen: Seen[] = [];
  // 小克在私聊里收到「请回:xxx」就回 xxx(造一条联系人发的消息)
  const host = open({
    file: file(), maxDeferMs: 5,
    mind: probe(seen, (_me, i) => i.fresh.flatMap((f): MindAction[] => (f.kind === "message" && f.sender.kind === "user" && f.text.startsWith("请回:") ? [{ kind: "reply", roomId: f.roomId, text: f.text.slice(3), replyToSeq: null }] : []))),
  });
  const svc = createService(host);
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小研" });
  const dm = host.openDm(a.id);
  const g = host.createGroup("项目群", [{ kind: "contact", id: b.id }]);
  host.send({ roomId: dm.id, clientActionId: "n1", text: "邻居一 NEIGHBOR_ONE" });
  host.send({ roomId: dm.id, clientActionId: "ask", text: "请回:KEEP_REPLY 周五前交" });
  await settle(host);
  const u = host.send({ roomId: dm.id, clientActionId: "k2", text: "KEEP_USER 我这边负责测试" });
  host.send({ roomId: dm.id, clientActionId: "n2", text: "邻居二 NEIGHBOR_TWO" });
  await settle(host);
  const src = msgsOf(host, dm.id);
  const r = src.find((m) => m.sender.kind === "contact")!;
  assert.equal(r.text, "KEEP_REPLY 周五前交", "替身回了一条");

  const fwd = await call<MessageView>(svc, "messages.forward", { fromRoomId: dm.id, seqs: [u.seq, r.seq, u.seq], toRoomId: g.id, note: "看看这两条", clientActionId: "fw1" });
  assert.equal(fwd.roomId, g.id);
  assert.deepEqual(fwd.sender, { kind: "user", id: host.userId }, "发送人是转发的用户");
  assert.deepEqual(fwd.forwarded, {
    fromRoomId: dm.id,
    fromTitle: "小克",
    fromKind: "dm",
    note: "看看这两条",
    items: [
      { seq: r.seq, sender: { kind: "contact", id: a.id }, senderName: "小克", at: r.at, text: "KEEP_REPLY 周五前交", sourceRetracted: false },
      { seq: u.seq, sender: { kind: "user", id: host.userId }, senderName: "我", at: u.at, text: "KEEP_USER 我这边负责测试", sourceRetracted: false },
    ],
  }, "按原序号排、去重,每条带原发言者与原时间");
  assert.deepEqual(fwd.mentions, []);
  assert.deepEqual(fwd.quotedSeqs, []);
  assert.equal(fwd.replyToSeq, null);
  assert.equal(fwd.command, null);
  assert.match(fwd.text, /看看这两条/);
  assert.match(fwd.text, /KEEP_REPLY 周五前交/);
  assert.match(fwd.text, /KEEP_USER 我这边负责测试/);
  assert.doesNotMatch(JSON.stringify(fwd), /NEIGHBOR/, "没选中的邻居不进副本");

  const again = await call<MessageView>(svc, "messages.forward", { fromRoomId: dm.id, seqs: [u.seq, r.seq], toRoomId: g.id, note: "看看这两条", clientActionId: "fw1" });
  assert.equal(again.seq, fwd.seq, "同一动作号重发返回原消息");
  assert.equal(msgsOf(host, g.id).length, 1, "不重复入库");

  host.editMessage(dm.id, u.seq, "KEEP_USER 改过的 EDITED_LATER");
  const copy = msgsOf(host, g.id).find((m) => m.seq === fwd.seq)!;
  assert.equal(copy.forwarded?.items[1]?.text, "KEEP_USER 我这边负责测试", "副本是转发那一刻的快照,不跟着原文改");
  assert.doesNotMatch(JSON.stringify(copy), /EDITED_LATER/);
  assert.throws(() => host.editMessage(g.id, fwd.seq, "改副本"), (e: unknown) => (e as { code?: string }).code === "conflict", "副本不能编辑");
  await host.close();
});

test("转发不授予原会话读取:目标会话的联系人只看到副本;没选中的邻居不进它的任何一块,顺着原序号、副本回读或 read_linked 都读不到原会话", async () => {
  const seen: Seen[] = [];
  const got: { ran: boolean; quoteDm: string | null; quoteCopy: string | null; linked: string | null } = { ran: false, quoteDm: "未调用", quoteCopy: "未调用", linked: "未调用" };
  let dmId = "";
  let neighbor = 0;
  let copySeq = 0;
  const host = new Host({
    file: file(), maxDeferMs: 5,
    mind: probe(seen, async (_me, i, tools) => {
      const m = i.fresh.find((f): f is InboundMessage => f.kind === "message" && f.text === "查一下");
      if (m && tools) {
        got.ran = true;
        got.quoteDm = (await tools.readQuoteParent?.(dmId, neighbor)) ?? null;
        got.quoteCopy = (await tools.readQuoteParent?.(m.roomId, copySeq)) ?? null;
        got.linked = (await tools.readLinked?.(LINK(m.roomId, dmId))) ?? null;
      }
      return [];
    }),
  });
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小研" });
  const dm = host.openDm(a.id);
  dmId = dm.id;
  const g = host.createGroup("项目群", [{ kind: "contact", id: b.id }]);
  host.send({ roomId: dm.id, clientActionId: "n1", text: "邻居一 NEIGHBOR_ONE" });
  const k1 = host.send({ roomId: dm.id, clientActionId: "k1", text: "KEEP_ONE 选中的一条" });
  const n2 = host.send({ roomId: dm.id, clientActionId: "n2", text: "邻居二 NEIGHBOR_TWO" });
  const k2 = host.send({ roomId: dm.id, clientActionId: "k2", text: "KEEP_TWO 选中的另一条" });
  host.send({ roomId: dm.id, clientActionId: "n3", text: "邻居三 NEIGHBOR_THREE" });
  neighbor = n2.seq;
  await settle(host);
  const fwd = host.forwardMessages({ fromRoomId: dm.id, seqs: [k1.seq, k2.seq], toRoomId: g.id, clientActionId: "fw" });
  copySeq = fwd.seq;
  await settle(host);
  host.send({ roomId: g.id, clientActionId: "ask", text: "查一下" });
  await settle(host);
  host.send({ roomId: g.id, clientActionId: "q", text: "按这条办", quotedSeqs: [fwd.seq] });
  await settle(host);

  const mine = seen.filter((s) => s.contactId === b.id);
  assert.ok(mine.length >= 3, "小研收到了副本、提问与引用三轮");
  const withCopy = mine.find((s) => freshMsg(s, g.id, fwd.seq))!;
  assert.ok(withCopy, "副本作为新消息送到目标会话的联系人");
  const b4 = withCopy.request.blocks[3]!.text;
  assert.match(b4, /转发的聊天记录/);
  assert.match(b4, /私聊「小克」/);
  assert.match(b4, /KEEP_ONE 选中的一条/);
  assert.match(b4, /KEEP_TWO 选中的另一条/);
  assert.ok(!b4.includes(dm.id), "副本不给原会话的 id,不留回读的门");
  for (const s of mine) assert.doesNotMatch(textOf(s), /NEIGHBOR/, "原会话没选中的邻居不进任何一块");
  assert.equal(got.ran, true);
  assert.equal(got.quoteDm, null, "原会话不是它的会话,按原序号读不到");
  assert.match(got.quoteCopy ?? "", /没有引用上一级/, "副本没有指回原会话的引用");
  assert.doesNotMatch(got.quoteCopy ?? "", /NEIGHBOR/);
  assert.equal(got.linked, null, "转发不等于关联,read_linked 读不到原会话");
  const quoted = mine.at(-1)!;
  assert.match(quoted.request.blocks[4]!.text, /KEEP_ONE 选中的一条/, "引用回读读到的是副本");
  assert.doesNotMatch(textOf(quoted), /NEIGHBOR/);
  for (const m of msgsOf(host, g.id)) assert.doesNotMatch(JSON.stringify(m), /NEIGHBOR/);
  await host.close();
});

test("非成员转发被拒:用户不在来源或目标会话时 forbidden、什么都不追加;选中的不是来源会话里的消息 not_found,已撤回的 conflict,一条没选 invalid_params", async () => {
  const host = open({ file: file(), maxDeferMs: 5, mind: probe([]) });
  const svc = createService(host);
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小研" });
  const dm = host.openDm(a.id);
  const g = host.createGroup("项目群", [{ kind: "contact", id: b.id }]);
  const other = host.createGroup("别的群", [{ kind: "contact", id: b.id }]);
  const o1 = host.send({ roomId: other.id, clientActionId: "o1", text: "别的群里的一句" });
  host.removeMember(other.id, { kind: "user", id: host.userId });
  const m = host.send({ roomId: dm.id, clientActionId: "m", text: "私聊里的一句" });
  const gone = host.send({ roomId: dm.id, clientActionId: "x", text: "撤回的一句" });
  host.retractMessage(dm.id, gone.seq);
  await settle(host);
  const before = { g: msgsOf(host, g.id).length, other: msgsOf(host, other.id).length };
  assert.equal(await failCode(svc, "messages.forward", { fromRoomId: other.id, seqs: [o1.seq], toRoomId: g.id, clientActionId: "f1" }), "forbidden", "不在来源会话");
  assert.equal(await failCode(svc, "messages.forward", { fromRoomId: dm.id, seqs: [m.seq], toRoomId: other.id, clientActionId: "f2" }), "forbidden", "不在目标会话");
  assert.equal(await failCode(svc, "messages.forward", { fromRoomId: dm.id, seqs: [m.seq + 50], toRoomId: g.id, clientActionId: "f3" }), "not_found");
  assert.equal(await failCode(svc, "messages.forward", { fromRoomId: dm.id, seqs: [m.seq, gone.seq], toRoomId: g.id, clientActionId: "f4" }), "conflict");
  assert.equal(await failCode(svc, "messages.forward", { fromRoomId: dm.id, seqs: [], toRoomId: g.id, clientActionId: "f5" }), "invalid_params");
  assert.deepEqual({ g: msgsOf(host, g.id).length, other: msgsOf(host, other.id).length }, before, "被拒的转发什么都不追加");
  await host.close();
});

type Ev = ComputeEvent extends infer E ? (E extends ComputeEvent ? Omit<E, "computeId"> : never) : never;
test("AC-20 转发里的「同意」不放行:群里等授权时把私聊里一句「同意」转发进群,授权仍待定、任务停在 T4b、Compute 不续接也不写盘;本人随后直接说「同意」才放行", async () => {
  const out = path.join(mkdtempSync(path.join(dir, "ws-")), "app.ts");
  let writes = 0;
  const compute = scriptedCompute({
    script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "blocked", needs: "要改 app.ts 加导出函数", summary: "读完了,准备改 app.ts" }],
    resumeScript: (_id, _turn, _text, tools): Ev[] => {
      if (!tools?.includes("Write")) return [{ kind: "blocked", needs: "还是需要写 app.ts", summary: "没有写权限" }];
      writes++;
      writeFileSync(out, `export const hello = ${writes};\n`);
      return [{ kind: "completed", result: "app.ts 已加导出" }];
    },
  });
  const mind = (): ContactMind => ({
    async round(i) {
      const actions: MindAction[] = [];
      for (const f of i.fresh) {
        if (f.kind === "message" && f.sender.kind === "user" && f.mentions.includes(i.contact.id) && f.text.includes("帮我")) actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: "加导出", task: "给 app.ts 加个导出" });
      }
      return { actions, stateNote: null };
    },
  });
  const host = open({ file: file(), mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const old = host.send({ roomId: dm.id, clientActionId: "old", text: "同意" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  host.updateRoom(g.id, { rules: "改代码前先问我" });
  host.send({ roomId: g.id, clientActionId: "u1", text: "@小克 帮我给 app.ts 加个导出", mentions: [{ id: c.id, source: "manual" }] });
  await settle(host, compute);
  const task = async () => (await call<{ tasks: TaskView[] }>(svc, "tasks.list", { roomId: g.id })).tasks[0]!;
  assert.equal((await task()).state, "T4b_BlockedOnHuman", "先停下等授权");
  assert.equal((await task()).authorizations?.[0]?.state, "pending");

  const fwd = await call<MessageView>(svc, "messages.forward", { fromRoomId: dm.id, seqs: [old.seq], toRoomId: g.id, clientActionId: "fw" });
  await settle(host, compute);
  assert.equal(fwd.forwarded?.items[0]?.text, "同意", "转发进来的正是一句「同意」");
  const t1 = await task();
  assert.equal(t1.state, "T4b_BlockedOnHuman", "转发里的同意不放行");
  assert.equal(t1.authorizations?.[0]?.state, "pending");
  assert.equal(t1.authorizations?.[0]?.decidedSeq, null);
  assert.equal(compute.resumed.length, 0, "Compute 没被续接");
  assert.equal(writes, 0);
  assert.equal(existsSync(out), false, "没授权不写盘");

  const yes = host.send({ roomId: g.id, clientActionId: "yes", text: "同意" });
  await settle(host, compute);
  const t2 = await task();
  assert.equal(t2.authorizations?.[0]?.state, "granted", "本人直接说同意才放行");
  assert.equal(t2.authorizations?.[0]?.decidedSeq, yes.seq);
  assert.equal(compute.resumed.length, 1);
  assert.equal(writes, 1);
  await host.close();
});

test("转发里的 @ 与命令不进副本的元数据(R-10):副本 mentions 为空、command 为 null、不建定时;被 @ 的联系人收到的副本里也没有 @", async () => {
  const seen: Seen[] = [];
  const host = open({ file: file(), maxDeferMs: 5, mind: probe(seen) });
  const svc = createService(host);
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小研" });
  const g1 = host.createGroup("一群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  const g2 = host.createGroup("二群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  const dm = host.openDm(a.id);
  const at = host.send({ roomId: g1.id, clientActionId: "at", text: "@小研 把发布脚本跑一下", mentions: [{ id: b.id, source: "manual" }] });
  const cmd = host.send({ roomId: dm.id, clientActionId: "cmd", text: "/remind 0 8 * * * 写日报", command: { name: "remind", args: { cron: "0 8 * * *", what: "写日报" } } });
  await settle(host);
  assert.deepEqual(at.mentions.map((m) => m.id), [b.id], "原消息确实 @ 了小研");
  assert.notEqual(cmd.command, null, "原消息确实带命令");
  const schedules = host.scheduler.list({}).length;
  assert.equal(schedules, 1, "原命令建了一个定时");

  const f1 = await call<MessageView>(svc, "messages.forward", { fromRoomId: g1.id, seqs: [at.seq], toRoomId: g2.id, clientActionId: "f1" });
  const f2 = await call<MessageView>(svc, "messages.forward", { fromRoomId: dm.id, seqs: [cmd.seq], toRoomId: g2.id, clientActionId: "f2" });
  await settle(host);
  assert.deepEqual(f1.mentions, [], "副本里的 @ 不是新的 @");
  assert.equal(f1.command, null);
  assert.equal(f2.command, null, "副本里的命令不是新的命令");
  assert.deepEqual(f2.mentions, []);
  assert.equal(host.scheduler.list({}).length, schedules, "转发命令不建定时");
  const toB = seen.filter((s) => s.contactId === b.id).map((s) => freshMsg(s, g2.id, f1.seq)).find(Boolean);
  assert.ok(toB, "副本送到了小研");
  assert.deepEqual(toB.mentions, [], "小研收到的副本没有 @ 它");
  assert.equal(toB.command, null);
  const toA = seen.filter((s) => s.contactId === a.id).map((s) => freshMsg(s, g2.id, f2.seq)).find(Boolean);
  assert.ok(toA);
  assert.equal(toA.command, null, "小克收到的副本不带命令");
  await host.close();
});

test("原消息撤回后副本不删(候选):副本标「来源已撤回」、正文仍在,推一条副本的 message.updated;撤回在副本送达前就发生也照标;联系人之后引用副本时看到的也标来源已撤回", async () => {
  const seen: Seen[] = [];
  const host = new Host({ file: file(), maxDeferMs: 5, mind: probe(seen) });
  hosts.push(host);
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小研" });
  const dm = host.openDm(a.id);
  const g = host.createGroup("项目群", [{ kind: "contact", id: b.id }]);
  const x = host.send({ roomId: dm.id, clientActionId: "x", text: "KEEP_GONE 后来撤回的一条" });
  const y = host.send({ roomId: dm.id, clientActionId: "y", text: "KEEP_STAY 留着的一条" });
  await settle(host);
  const fwd = host.forwardMessages({ fromRoomId: dm.id, seqs: [x.seq, y.seq], toRoomId: g.id, clientActionId: "fw" });
  // 撤回发生在副本送达目标会话的联系人之前(联系人还没跑轮):副本第一次到达时就已经标出来源已撤回
  const events: ServerEvent[] = [];
  const off = host.bus.subscribe((e) => events.push(e));
  host.retractMessage(dm.id, x.seq);
  off();
  await settle(host);
  const arrived = seen.filter((s) => s.contactId === b.id).find((s) => freshMsg(s, g.id, fwd.seq))!;
  assert.ok(arrived, "副本作为新消息送到目标会话");
  assert.ok(arrived.request.blocks[3]!.text.includes("KEEP_GONE 后来撤回的一条(来源已撤回)"), "第一次送达就标出来源已撤回,正文仍在");
  const copy = msgsOf(host, g.id).find((m) => m.seq === fwd.seq)!;
  assert.equal(copy.retracted, false, "副本本身没被撤回");
  assert.deepEqual(copy.forwarded?.items.map((i) => [i.text, i.sourceRetracted]), [["KEEP_GONE 后来撤回的一条", true], ["KEEP_STAY 留着的一条", false]]);
  assert.ok(copy.text.includes("KEEP_GONE 后来撤回的一条(来源已撤回)"), "副本正文仍在并标出来源已撤回");
  const upd = events.find((e) => e.type === "message.updated" && e.message.roomId === g.id && e.message.seq === fwd.seq);
  assert.ok(upd && upd.type === "message.updated", "副本也推一次更新,界面能立刻标出来");
  assert.equal(upd.message.forwarded?.items[0]?.sourceRetracted, true);
  assert.equal(msgsOf(host, dm.id).find((m) => m.seq === x.seq)?.text, "", "原消息照常撤回");

  host.send({ roomId: g.id, clientActionId: "q", text: "按这条办", quotedSeqs: [fwd.seq] });
  await settle(host);
  const last = seen.filter((s) => s.contactId === b.id).at(-1)!;
  const b5 = last.request.blocks[4]!.text;
  assert.ok(b5.includes("KEEP_GONE 后来撤回的一条(来源已撤回)"), "联系人看到的副本标出来源已撤回,正文仍在");
  assert.ok(b5.includes("KEEP_STAY 留着的一条"));
  assert.ok(!b5.includes("KEEP_STAY 留着的一条(来源已撤回)"), "没撤回的不标");
  await host.close();
});

test("关联(静态,候选):联系人用 read_linked 只读得到关联那一刻上界以内的记录,上界之后的新消息读不到;按词过滤、往前翻页与条数;上界内撤回的只给占位;只能从本轮新消息所在的会话读", async () => {
  const seen: Seen[] = [];
  const got: Record<string, string | null> = {};
  let dmId = "";
  let otherId = "";
  let d2Seq = 0;
  const host = open({
    file: file(), maxDeferMs: 5,
    mind: probe(seen, async (_me, i, tools) => {
      const m = i.fresh.find((f): f is InboundMessage => f.kind === "message" && f.text === "查私聊");
      if (m && tools?.readLinked) {
        got.list = await tools.readLinked(LINK(m.roomId, null));
        got.all = await tools.readLinked(LINK(m.roomId, dmId));
        got.query = await tools.readLinked(LINK(m.roomId, dmId, { query: "12 月" }));
        got.late = await tools.readLinked(LINK(m.roomId, dmId, { query: "LATE" }));
        got.page = await tools.readLinked(LINK(m.roomId, dmId, { beforeSeq: d2Seq }));
        got.one = await tools.readLinked(LINK(m.roomId, dmId, { limit: 1 }));
        got.other = await tools.readLinked(LINK(otherId, dmId));
      }
      return [];
    }),
  });
  const svc = createService(host);
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小研" });
  const dm = host.openDm(a.id);
  dmId = dm.id;
  const g = host.createGroup("项目群", [{ kind: "contact", id: b.id }]);
  const other = host.openDm(b.id);
  otherId = other.id;
  const d1 = host.send({ roomId: dm.id, clientActionId: "d1", text: "我们约定 12 月 3 日交付 DATE_IN_DM" });
  const d2 = host.send({ roomId: dm.id, clientActionId: "d2", text: "另一条 OTHER_IN_DM" });
  const d3 = host.send({ roomId: dm.id, clientActionId: "d3", text: "撤回前的话 GONE_IN_DM" });
  d2Seq = d2.seq;
  await settle(host);
  const upto = host.lastSeq(dm.id);
  const view = await call<RoomView>(svc, "rooms.link", { roomId: g.id, linkedRoomId: dm.id, clientActionId: "l1" });
  assert.equal(view.id, g.id);
  assert.deepEqual(view.linkedRooms?.map(({ linkedAt: _t, ...x }) => x), [{ roomId: dm.id, kind: "dm", title: "小克", uptoSeq: upto }], "圈定关联那一刻的上界");
  await call<RoomView>(svc, "rooms.link", { roomId: other.id, linkedRoomId: dm.id, clientActionId: "l2" });
  host.send({ roomId: dm.id, clientActionId: "late", text: "上界之后才说的 LATE_FACT" });
  host.retractMessage(dm.id, d3.seq);
  await settle(host);
  host.send({ roomId: g.id, clientActionId: "ask", text: "查私聊" });
  await settle(host);

  assert.match(got.list ?? "", new RegExp(`${dm.id} · 私聊「小克」· 上界 #${upto}`), "不给 linkedRoomId 就列出本会话的关联");
  assert.match(got.all ?? "", /DATE_IN_DM/);
  assert.match(got.all ?? "", /OTHER_IN_DM/);
  assert.doesNotMatch(got.all ?? "", /LATE_FACT/, "上界之后的新消息不在关联范围");
  assert.doesNotMatch(got.all ?? "", /GONE_IN_DM/, "上界内撤回的不给原文");
  assert.match(got.all ?? "", new RegExp(`#${d3.seq} · [^\\n]*已撤回`), "撤回的只给占位");
  assert.match(got.query ?? "", /DATE_IN_DM/);
  assert.doesNotMatch(got.query ?? "", /OTHER_IN_DM/, "按词过滤");
  assert.doesNotMatch(got.late ?? "", /上界之后才说/, "按词也查不到上界之后的");
  assert.match(got.page ?? "", new RegExp(`#${d1.seq} · `));
  assert.doesNotMatch(got.page ?? "", /OTHER_IN_DM/, "beforeSeq 往前翻页");
  assert.doesNotMatch(got.one ?? "", /DATE_IN_DM|OTHER_IN_DM/, "limit 只取最近的几条");
  assert.match(got.one ?? "", /beforeSeq/, "放不下的告诉它怎么往前读");
  assert.equal(got.other, null, "不是本轮新消息所在的会话,读不到");
  for (const s of seen.filter((x) => x.contactId === b.id)) assert.doesNotMatch(textOf(s), /DATE_IN_DM/, "关联不每轮注入");
  await host.close();
});

test("关联生效与解除都不改第 1 块前缀:关联前、关联后、解除后联系人的第 1 块逐字相同,任何一块都没有被关联会话的内容", async () => {
  const seen: Seen[] = [];
  const host = new Host({ file: file(), maxDeferMs: 5, mind: probe(seen) });
  hosts.push(host);
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小研" });
  const dm = host.openDm(a.id);
  const g = host.createGroup("项目群", [{ kind: "contact", id: b.id }]);
  host.send({ roomId: dm.id, clientActionId: "d1", text: "我们约定 12 月 3 日交付 DATE_IN_DM" });
  await settle(host);
  const firstOf = () => seen.filter((s) => s.contactId === b.id).at(-1)!.request.blocks[0]!.text;
  host.send({ roomId: g.id, clientActionId: "s0", text: "第一句" });
  await settle(host);
  const h0 = sha(firstOf());
  assert.equal(host.linkRooms({ roomId: g.id, linkedRoomId: dm.id, clientActionId: "l1" }).linkedRooms?.length, 1, "关联已生效");
  host.send({ roomId: g.id, clientActionId: "s1", text: "第二句" });
  await settle(host);
  const h1 = sha(firstOf());
  assert.equal(host.unlinkRooms({ roomId: g.id, linkedRoomId: dm.id, clientActionId: "u1" }).linkedRooms, undefined, "已解除");
  host.send({ roomId: g.id, clientActionId: "s2", text: "第三句" });
  await settle(host);
  const h2 = sha(firstOf());
  assert.equal(seen.filter((s) => s.contactId === b.id).length, 3);
  assert.equal(h1, h0, "关联后前缀不变");
  assert.equal(h2, h0, "解除后前缀不变");
  for (const s of seen.filter((x) => x.contactId === b.id)) assert.doesNotMatch(textOf(s), /DATE_IN_DM/);
  await host.close();
});

test("解除关联后 read_linked 读不到、列表里也没有;同一动作号重放不改上界,换动作号再关联把上界刷新到此刻;已转发的副本不受影响", async () => {
  const seen: Seen[] = [];
  const got: (string | null)[] = [];
  let dmId = "";
  const host = open({
    file: file(), maxDeferMs: 5,
    mind: probe(seen, async (_me, i, tools) => {
      const m = i.fresh.find((f): f is InboundMessage => f.kind === "message" && f.text.startsWith("查"));
      if (m && tools?.readLinked) {
        got.push(await tools.readLinked(LINK(m.roomId, dmId)));
        got.push(await tools.readLinked(LINK(m.roomId, null)));
      }
      return [];
    }),
  });
  const svc = createService(host);
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小研" });
  const dm = host.openDm(a.id);
  dmId = dm.id;
  const g = host.createGroup("项目群", [{ kind: "contact", id: b.id }]);
  const d1 = host.send({ roomId: dm.id, clientActionId: "d1", text: "第一版约定 FIRST_DEAL" });
  await settle(host);
  const fwd = host.forwardMessages({ fromRoomId: dm.id, seqs: [d1.seq], toRoomId: g.id, clientActionId: "fw" });
  await call<RoomView>(svc, "rooms.link", { roomId: g.id, linkedRoomId: dm.id, clientActionId: "l1" });
  const off = await call<RoomView>(svc, "rooms.unlink", { roomId: g.id, linkedRoomId: dm.id, clientActionId: "u1" });
  assert.equal(off.linkedRooms, undefined, "解除后视图里没有关联");
  host.send({ roomId: g.id, clientActionId: "a1", text: "查一" });
  await settle(host);
  assert.equal(got[0], null, "解除后读不到");
  assert.match(got[1] ?? "", /没有关联/);
  assert.equal(msgsOf(host, g.id).find((m) => m.seq === fwd.seq)?.forwarded?.items[0]?.text, "第一版约定 FIRST_DEAL", "已转发的副本不受解除影响");
  assert.deepEqual((await call<RoomView>(svc, "rooms.unlink", { roomId: g.id, linkedRoomId: dm.id, clientActionId: "u2" })).linkedRooms, undefined, "没关联再解除也成功");

  const v1 = await call<RoomView>(svc, "rooms.link", { roomId: g.id, linkedRoomId: dm.id, clientActionId: "l2" });
  const first = v1.linkedRooms?.[0]?.uptoSeq;
  host.send({ roomId: dm.id, clientActionId: "d2", text: "第二版约定 SECOND_DEAL" });
  await settle(host);
  const replay = await call<RoomView>(svc, "rooms.link", { roomId: g.id, linkedRoomId: dm.id, clientActionId: "l2" });
  assert.equal(replay.linkedRooms?.[0]?.uptoSeq, first, "同一动作号重放不改上界");
  host.send({ roomId: g.id, clientActionId: "a2", text: "查二" });
  await settle(host);
  assert.match(got[2] ?? "", /FIRST_DEAL/);
  assert.doesNotMatch(got[2] ?? "", /SECOND_DEAL/);
  const v2 = await call<RoomView>(svc, "rooms.link", { roomId: g.id, linkedRoomId: dm.id, clientActionId: "l3" });
  assert.equal(v2.linkedRooms?.length, 1, "再关联不重复");
  assert.equal(v2.linkedRooms?.[0]?.uptoSeq, host.lastSeq(dm.id), "换动作号再关联:上界刷新到此刻");
  host.send({ roomId: g.id, clientActionId: "a3", text: "查三" });
  await settle(host);
  assert.match(got[4] ?? "", /SECOND_DEAL/);
  await host.close();
});

test("非成员关联被拒:用户不在任一边 forbidden、关联到自己 invalid_params;关联后用户离开被关联的群,read_linked 就读不到", async () => {
  const got: (string | null)[] = [];
  let linkedId = "";
  const host = open({
    file: file(), maxDeferMs: 5,
    mind: probe([], async (_me, i, tools) => {
      const m = i.fresh.find((f): f is InboundMessage => f.kind === "message" && f.text === "查");
      if (m && tools?.readLinked) got.push(await tools.readLinked(LINK(m.roomId, linkedId)));
      return [];
    }),
  });
  const svc = createService(host);
  const b = host.createContact({ name: "小研" });
  const c = host.createContact({ name: "小前" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: b.id }]);
  const outside = host.createGroup("不在的群", [{ kind: "contact", id: c.id }]);
  host.send({ roomId: outside.id, clientActionId: "o", text: "不在的群里的话 OUTSIDE_TEXT" });
  host.removeMember(outside.id, { kind: "user", id: host.userId });
  assert.equal(await failCode(svc, "rooms.link", { roomId: g.id, linkedRoomId: outside.id, clientActionId: "l1" }), "forbidden", "被关联的一边用户不在");
  assert.equal(await failCode(svc, "rooms.link", { roomId: outside.id, linkedRoomId: g.id, clientActionId: "l2" }), "forbidden", "关联到的一边用户不在");
  assert.equal(await failCode(svc, "rooms.link", { roomId: g.id, linkedRoomId: g.id, clientActionId: "l3" }), "invalid_params");
  assert.equal((await call<RoomView>(svc, "rooms.get", { roomId: g.id })).linkedRooms, undefined, "被拒的关联什么都没留下");

  const side = host.createGroup("旁边的群", [{ kind: "contact", id: c.id }]);
  linkedId = side.id;
  host.send({ roomId: side.id, clientActionId: "s", text: "旁边群的话 SIDE_TEXT" });
  await settle(host);
  await call<RoomView>(svc, "rooms.link", { roomId: g.id, linkedRoomId: side.id, clientActionId: "l4" });
  host.send({ roomId: g.id, clientActionId: "q1", text: "查" });
  await settle(host);
  assert.match(got[0] ?? "", /SIDE_TEXT/, "两边都在时读得到");
  host.removeMember(side.id, { kind: "user", id: host.userId });
  host.send({ roomId: g.id, clientActionId: "q2", text: "查" });
  await settle(host);
  assert.equal(got[1], null, "用户离开被关联的群后读不到");
  await host.close();
});
