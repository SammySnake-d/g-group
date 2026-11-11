// 聊天主界面补全时补的后端(按原型做全,连真实后端):全部经服务层(按合同校验参数与结果)调用。
// - 转发(U25、AC-20):收件会话只看到选中的几条快照,不获得源会话读取权;转发里的「同意」不算本人授权,任务仍等本人。
// - 删除 / 清空(U23):只在你这边看不到——消息列表、搜索、会话预览都不给;日志与联系人的上下文不动;删除可撤销。
// - 置顶(D28.4):只是你找回用的导航,RoomView.pinnedSeqs 为准,重开宿主还在。
// - 已读位置(AC-46):RoomView.memberReads 给出每位成员读到哪,重启后旧消息的回执靠它画。
// - 按内容上传附件:拿不到本地路径时用 base64 上传,同一内容只存一份,随消息发出。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ComputeEvent } from "@g-group/adapter-cc-compute";
import type { MessageView, RoomView, ServerEvent, TaskView } from "@g-group/api-contract";
import type { ContactMind, Inbound, MindAction, RoundInput } from "@g-group/kernel";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-parity-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `p${++n}.db`);
type Svc = ReturnType<typeof createService>;

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
/** 经服务层调用;失败时把错误码和原因写进断言信息(看得出是「没有这个方法」还是行为不对) */
async function call<T>(svc: Svc, method: string, params: unknown): Promise<T> {
  const r = await svc.handle(method as never, params);
  assert.ok(r.ok, `${method} 应当成功,实际:${r.ok ? "" : `${r.error.code} ${r.error.message}`}`);
  return r.value as T;
}
const listOf = async (svc: Svc, roomId: string) => (await call<{ messages: MessageView[] }>(svc, "messages.list", { roomId, limit: 500 })).messages;

test("转发:收件会话只看到选中几条的快照,看不到源会话其他消息;转发里的「同意」不算本人授权,任务仍停在等本人", async () => {
  type Ev = ComputeEvent extends infer E ? (E extends ComputeEvent ? Omit<E, "computeId"> : never) : never;
  const compute = scriptedCompute({
    script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "blocked", needs: "要改 app.ts", summary: "读完了,准备改 app.ts" }],
    resumeScript: (): Ev[] => [{ kind: "completed", result: "改好了" }],
  });
  const inputs: Inbound[] = [];
  const mind: ContactMind = {
    async round(input: RoundInput) {
      const actions: MindAction[] = [];
      for (const f of input.fresh) {
        inputs.push(f);
        if (f.kind === "message" && f.sender.kind === "user") {
          const m = /^帮我(.+)$/.exec(f.text.trim());
          if (m) actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: m[1]!.slice(0, 40), task: m[1]! });
        }
      }
      return { actions, stateNote: null };
    },
  };
  const host = new Host({ file: file(), mind: () => mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小林" });
  const work = host.openDm(a.id);
  host.updateRoom(work.id, { rules: "改代码前先问我" });
  const other = host.openDm(b.id);
  host.send({ roomId: other.id, clientActionId: "o1", text: "这是私下聊的,别外传" });
  const yes = host.send({ roomId: other.id, clientActionId: "o2", text: "同意" });
  host.send({ roomId: work.id, clientActionId: "w1", text: "帮我给 app.ts 加个导出" });
  await settle(host, compute);
  const [t0] = (await call<{ tasks: TaskView[] }>(svc, "tasks.list", { roomId: work.id })).tasks;
  assert.equal(t0!.state, "T4b_BlockedOnHuman", "先停下来等本人同意");

  const fwd = await call<MessageView>(svc, "messages.forward", { clientActionId: "f1", fromRoomId: other.id, seqs: [yes.seq], toRoomId: work.id });
  assert.equal(fwd.sender.kind, "user");
  assert.deepEqual(fwd.forward?.items.map((x) => [x.seq, x.text, x.senderName]), [[yes.seq, "同意", "你"]]);
  assert.equal(fwd.forward?.fromTitle, other.title);
  assert.deepEqual(fwd.mentions, [], "转发不带 @,不按它派活");
  // 同一 clientActionId 重发不重复入库
  const again = await call<MessageView>(svc, "messages.forward", { clientActionId: "f1", fromRoomId: other.id, seqs: [yes.seq], toRoomId: work.id });
  assert.equal(again.seq, fwd.seq);
  await settle(host, compute);

  const [t1] = (await call<{ tasks: TaskView[] }>(svc, "tasks.list", { roomId: work.id })).tasks;
  assert.equal(t1!.state, "T4b_BlockedOnHuman", "转发里的「同意」不放行");
  assert.equal(compute.resumed.length, 0);
  assert.equal(t1!.authorizations?.[0]?.state, "pending");
  // 收件会话里只有这几条的快照:源会话那句「别外传」不在任何一条消息里
  const seen = await listOf(svc, work.id);
  assert.ok(!seen.some((m) => m.text.includes("别外传") || m.forward?.items.some((x) => x.text.includes("别外传"))));
  const got = inputs.find((f) => f.kind === "message" && f.seq === fwd.seq);
  assert.ok(got && got.kind === "message" && got.text.startsWith("[转发]"), "联系人收到的是标明转发的那一条");
  // 撤回的不能转发;不在的会话不能转发
  host.retractMessage(other.id, yes.seq);
  const bad = await svc.handle("messages.forward", { clientActionId: "f2", fromRoomId: other.id, seqs: [yes.seq], toRoomId: work.id });
  assert.equal(!bad.ok && bad.error.code, "conflict");
  await host.close();
});

test("删除只在你这边:列表、搜索、会话预览都不再给;联系人上下文不动;可以放回;清空后只显示之后的新消息", async () => {
  const host = new Host({ file: file(), mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const m1 = host.send({ roomId: dm.id, clientActionId: "a", text: "第一句 苹果" });
  await settle(host);
  const m2 = host.send({ roomId: dm.id, clientActionId: "b", text: "第二句 香蕉" });
  await settle(host);
  const events: ServerEvent[] = [];
  svc.subscribe((e) => events.push(e));

  const r = await call<{ changed: number }>(svc, "messages.hide", { roomId: dm.id, seqs: [m2.seq] });
  assert.equal(r.changed, 1);
  assert.ok(!(await listOf(svc, dm.id)).some((m) => m.seq === m2.seq), "删掉的那条不再列出");
  assert.ok((await listOf(svc, dm.id)).some((m) => m.seq === m1.seq));
  const hits = await call<{ hits: { seq: number }[] }>(svc, "search.messages", { query: "香蕉" });
  assert.deepEqual(hits.hits, [], "删掉的搜不到");
  assert.ok(host.projected(dm.id).some((m) => m.seq === m2.seq && m.text === "第二句 香蕉"), "日志与联系人那边不动");
  assert.ok(events.some((e) => e.type === "room.updated" && e.room.id === dm.id), "推 room.updated");

  const back = await call<{ changed: number }>(svc, "messages.hide", { roomId: dm.id, seqs: [m2.seq], hidden: false });
  assert.equal(back.changed, 1);
  assert.ok((await listOf(svc, dm.id)).some((m) => m.seq === m2.seq), "撤销后放回来");
  assert.equal((await call<{ hits: unknown[] }>(svc, "search.messages", { query: "香蕉" })).hits.length, 1);

  const cleared = await call<{ clearedUpto: number }>(svc, "rooms.clearHistory", { roomId: dm.id });
  assert.equal(cleared.clearedUpto, host.lastSeq(dm.id));
  assert.deepEqual(await listOf(svc, dm.id), [], "清空后这边一条不剩");
  assert.equal((await call<RoomView>(svc, "rooms.get", { roomId: dm.id })).lastMessagePreview, null);
  host.send({ roomId: dm.id, clientActionId: "c", text: "清空之后的新话" });
  await settle(host);
  const after_ = await listOf(svc, dm.id);
  assert.ok(after_.some((m) => m.text === "清空之后的新话"), "之后的新消息照常显示");
  assert.ok(!after_.some((m) => m.seq <= cleared.clearedUpto));
  assert.ok(host.projected(dm.id).some((m) => m.seq === m1.seq), "联系人的上下文不受影响");
  await host.close();
});

test("置顶:只是你的导航,RoomView.pinnedSeqs 为准;取消置顶移出;重开宿主还在", async () => {
  const f = file();
  const host = new Host({ file: f, mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  const a = host.send({ roomId: g.id, clientActionId: "a", text: "上线时间定在周五" });
  const b = host.send({ roomId: g.id, clientActionId: "b", text: "接口文档在 docs/api.md" });
  await settle(host);
  const r1 = await call<RoomView>(svc, "messages.pin", { roomId: g.id, seq: a.seq, on: true });
  assert.deepEqual(r1.pinnedSeqs, [a.seq]);
  const r2 = await call<RoomView>(svc, "messages.pin", { roomId: g.id, seq: b.seq, on: true });
  assert.deepEqual(r2.pinnedSeqs, [a.seq, b.seq]);
  const r3 = await call<RoomView>(svc, "messages.pin", { roomId: g.id, seq: a.seq, on: false });
  assert.deepEqual(r3.pinnedSeqs, [b.seq]);
  assert.equal(r3.rules, "", "置顶不改群规");
  await host.close();
  const again = new Host({ file: f, mind: () => scriptedMind(), maxDeferMs: 5 });
  assert.deepEqual((await call<RoomView>(createService(again), "rooms.get", { roomId: g.id })).pinnedSeqs, [b.seq]);
  await again.close();
});

test("已读位置:联系人接走即已读,RoomView.memberReads 列出每位成员读到哪;重开宿主照样读得到", async () => {
  const f = file();
  const host = new Host({ file: f, mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const m = host.send({ roomId: dm.id, clientActionId: "a", text: "你好" });
  await settle(host);
  const reads = (await call<RoomView>(svc, "rooms.get", { roomId: dm.id })).memberReads ?? [];
  const contact = reads.find((x) => x.member.kind === "contact" && x.member.id === c.id);
  assert.ok(contact && contact.readSeq >= m.seq, `联系人读到了 #${m.seq},实际 ${JSON.stringify(reads)}`);
  await host.close();
  const again = new Host({ file: f, mind: () => scriptedMind(), maxDeferMs: 5 });
  const after_ = (await call<{ rooms: RoomView[] }>(createService(again), "rooms.list", {})).rooms.find((r) => r.id === dm.id)!;
  assert.ok((after_.memberReads ?? []).some((x) => x.member.id === c.id && x.readSeq >= m.seq), "重启后还在");
  await again.close();
});

test("按内容上传附件:base64 存一份、同内容同 ref,随消息发出;空文件名被拒", async () => {
  const host = new Host({ file: file(), dataDir: path.join(dir, "data-up"), mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const base64 = Buffer.from("# 需求补充\n").toString("base64");
  const a1 = await call<{ ref: string; name: string; mime: string; bytes: number }>(svc, "attachments.upload", { name: "需求补充.md", base64 });
  const a2 = await call<{ ref: string }>(svc, "attachments.upload", { name: "需求补充.md", base64 });
  assert.equal(a1.ref, a2.ref);
  assert.deepEqual([a1.name, a1.mime, a1.bytes], ["需求补充.md", "text/markdown", Buffer.byteLength("# 需求补充\n")]);
  const sent = await call<MessageView>(svc, "messages.send", { roomId: dm.id, clientActionId: "x", text: "", attachments: [a1.ref] });
  assert.deepEqual(sent.attachments.map((x) => x.name), ["需求补充.md"]);
  const bad = await svc.handle("attachments.upload", { name: "../", base64 });
  assert.equal(!bad.ok && bad.error.code, "invalid_params");
  // 同一份文件按路径加也是同一个 ref
  const p = path.join(dir, "需求补充.md");
  writeFileSync(p, "# 需求补充\n");
  assert.equal(host.addAttachment(p).ref, a1.ref);
  await settle(host);
  await host.close();
});
