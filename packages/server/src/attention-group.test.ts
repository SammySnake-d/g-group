// AC-31 扫一眼(Attention Loop):① 唯一入口不前置过滤——群里已经有别人主答、用户也没 @ 任何人,在途的每位联系人
// 仍旧在自己的注意循环里收到这条广播并推进自己的 processed_seq;④ 发送前撤销竞态——旁观者 B 的汇报还没发出时用户先发
// 控制消息,宿主在真正上屏前检出并放弃这一轮(旧汇报不上屏、承诺不登记),重跑时把控制消息一起处理;
// ⑤ 承诺终态自动回收——任务进 T10/T11 且负责人末次汇报发出后由机器失效回收,之后派新任务不被旧承诺污染。
// 单人串行、有界攒批与 action_id 去重在 kernel 的注意循环测试与 host.test.ts 里。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ContactMind, InboundMessage, RoundInput } from "@g-group/kernel";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-attn-group-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `a${++n}.db`);
const silent = (): ContactMind => ({ round: async () => ({ actions: [], stateNote: null }) });
const msgSeqs = (input: RoundInput) => input.fresh.filter((f): f is InboundMessage => f.kind === "message").map((f) => f.seq);
async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 200; i++) {
    await host.loop.idle();
    await new Promise((r) => setTimeout(r, 5));
    if ((!compute || compute.drained()) && !host.loop.busy()) return;
  }
  throw new Error("宿主没有安静下来");
}
async function until(what: () => boolean, why: string) {
  for (let i = 0; i < 200; i++) {
    if (what()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等到超时:${why}`);
}

test("AC-31 ① 群里已有他人主答时,在途的其余联系人仍处理无 @ 广播(不前置过滤,各自推进游标)", async () => {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  const seen: Record<string, number[]> = {};
  const mind = () =>
    scriptedMind({
      onRound: (i) => {
        seen[i.contact.id] = [...(seen[i.contact.id] ?? []), ...msgSeqs(i)];
      },
    });
  const host = new Host({ file: file(), mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const a = host.createContact({ name: "A" });
  const b = host.createContact({ name: "B" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  host.send({ roomId: g.id, clientActionId: "d1", text: "帮我跑一下测试", mentions: [{ id: a.id, source: "manual" }] });
  host.send({ roomId: g.id, clientActionId: "d2", text: "帮我整理一下会议记录", mentions: [{ id: b.id, source: "manual" }] });
  await settle(host, compute);
  assert.deepEqual(host.listTasks({ roomId: g.id }).map((t) => t.ownerContactId).sort(), [a.id, b.id].sort(), "A、B 各自在途");
  // 群里已经有主答、用户不 @ 任何人说一句:两位在途联系人各自都要收到并推进自己的游标
  const bcast = host.send({ roomId: g.id, clientActionId: "b1", text: "有进度的话汇报到群里 @我来看" });
  await settle(host, compute);
  assert.ok(seen[a.id]?.includes(bcast.seq), "在途的 A 收到了广播");
  assert.ok(seen[b.id]?.includes(bcast.seq), "在途的 B 也收到了广播(没有因为已有主答被前置过滤)");
  assert.deepEqual(host.listTasks({ roomId: g.id }).map((t) => t.state), ["T3_Running", "T3_Running"], "广播不改任务状态");
  assert.deepEqual(
    [a.id, b.id].map((id) => host.receipts(g.id, bcast.seq).read.some((x) => x.member.id === id)),
    [true, true],
    "两位都接走并各自推进了游标",
  );
  compute.close();
  await host.close();
});

test("AC-31 ④ 旁观者 B 的旧汇报在发送前被用户控制消息拦下:旧草稿不上屏、承诺不登记,重跑时控制消息一起处理", async () => {
  let host: Host | null = null;
  let gid = "";
  let bId = "";
  let controlSeq = 0;
  const seen: number[][] = [];
  const bMind = (): ContactMind => ({
    async round(input) {
      const seqs = msgSeqs(input);
      seen.push(seqs);
      if (seen.length === 1) {
        // 汇报还在本轮草稿里、还没上屏:用户先发了控制消息(发送前撤销竞态)
        controlSeq = host!.send({ roomId: gid, clientActionId: "ctl", text: "不用汇报了" }).seq;
      }
      return {
        actions: [
          { kind: "commit" as const, roomId: gid, sourceSeq: seqs[0]!, text: "有进度的话汇报到群里", taskId: null },
          { kind: "reply" as const, roomId: gid, text: seen.length === 1 ? `旧汇报:看到 ${seqs.join(",")} 条` : `重跑后:看到 ${seqs.join(",")} 条`, replyToSeq: null },
        ],
        stateNote: null,
      };
    },
  });
  const h = new Host({ file: file(), mind: (c) => (c.id === bId ? bMind() : silent()), maxDeferMs: 5 });
  host = h;
  const a = h.createContact({ name: "A" });
  const b = h.createContact({ name: "B" });
  bId = b.id;
  const g = h.createGroup("项目群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  gid = g.id;
  const bcast = h.send({ roomId: g.id, clientActionId: "b1", text: "有进度的话汇报到群里 @我来看" });
  await settle(h);
  assert.deepEqual(seen, [[bcast.seq], [bcast.seq, controlSeq]], "先跑一轮(草稿被拦),重跑时控制消息一起进来");
  const fromB = h.listMessages(g.id, {}).messages.filter((m) => m.sender.kind === "contact" && m.sender.id === b.id).map((m) => m.text);
  assert.deepEqual(fromB, [`重跑后:看到 ${bcast.seq},${controlSeq} 条`], "旧汇报一条都没上屏");
  assert.deepEqual(
    h.listCommitments({ contactId: b.id, roomId: g.id }).map((k) => k.text),
    ["有进度的话汇报到群里"],
    "被拦下的那一轮里的承诺不登记,重跑时只登记一次",
  );
  assert.equal(h.receipts(g.id, controlSeq).read.some((x) => x.member.id === b.id), true, "旁观者没有跳过用户控制消息就推游标");
  await h.close();
});

test("AC-31 ⑤ 用户取消(T10)后承诺不在取消那一刻消失,等负责人的末次汇报发出才失效回收", async () => {
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "c1", text: "帮我编译项目" });
  await settle(host, compute);
  const t = host.listTasks({})[0]!;
  assert.deepEqual(
    host.listCommitments({ contactId: c.id }).map((k) => [k.text, k.status]),
    [["编译项目", "active"]],
    "任务还在跑,承诺照旧活着",
  );
  host.taskDecision(t.id, "cancel", "c2");
  await until(() => host.listTasks({})[0]?.state === "T10_Cancelled", "停 Compute 确认后落 T10");
  // 取消那一刻还没有末次汇报(联系人这一轮什么都没说):承诺不该在这里就消失
  const mid = host.listCommitments({ contactId: c.id });
  assert.deepEqual(mid.map((k) => [k.text, k.status]), [["编译项目", "active"]], "取消后到负责人发话前,承诺仍是 active");
  // 负责人在这个会话里发了下一条话(末次汇报):机器在同一次落盘里把终态任务的承诺失效回收
  host.send({ roomId: dm.id, clientActionId: "c3", text: "顺便说一句,周末的安排回头再说" });
  await settle(host, compute);
  assert.deepEqual(
    host.listCommitments({ contactId: c.id }).map((k) => [k.text, k.status]),
    [["编译项目", "revoked"]],
    "末次汇报发出后由机器失效回收",
  );
  compute.close();
  await host.close();
});

test("AC-31 ⑤ 任务进终态且末次汇报发出后机器自动失效回收承诺;之后派新任务不被旧承诺污染", async () => {
  const compute = scriptedCompute({ failSpawn: "claude 不在 PATH" });
  const blocks: string[] = [];
  const mind = () => scriptedMind({ onRound: (i) => blocks.push(i.request.blocks.find((b) => b.block === 2)!.text) });
  const host = new Host({ file: file(), mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "a1", text: "帮我编译项目" });
  await settle(host, compute);
  assert.equal(host.listTasks({})[0]?.state, "T11_Failed");
  assert.deepEqual(
    host.listCommitments({ contactId: c.id }).map((k) => [k.text, k.status]),
    [["编译项目", "revoked"]],
    "终态 + 末次汇报发出 → 机器自动失效回收(没等用户点验收)",
  );
  // 再派新任务:旧承诺已回收,不再进第 2 块
  const before = blocks.length;
  host.send({ roomId: dm.id, clientActionId: "a2", text: "帮我写报告" });
  await settle(host, compute);
  const later = blocks.slice(before);
  assert.ok(later.some((b) => b.includes("写报告")), "新任务自己的承诺进了第 2 块");
  assert.ok(later.every((b) => !b.includes("编译项目")), "旧任务已终态回收,不再污染新任务的上下文");
  compute.close();
  await host.close();
});
