// 联系人动作补齐(feat/contact-actions),来自真实启动跑用户故事的实测缺口(stories/REPORT.md 第 2 节):
//   ① 认领已有任务(U14、§8.4 US1):群里 tasks.create 建的 T1 任务,联系人用 claim_task 认领;同一任务先落盘的拿到,后来的被拒并知道原因;
//   ② 被拒动作回告(AC-31 状态一致):宿主判下的拒绝,下一轮第 5 块逐条给出「动作 → 被拒原因」,给过不重复,第 1 块不变(AC-39 ①);
//   ③ reply 带 @:mentions 校验是会话成员后写进消息,与用户发消息的 @ 同一形状,被 @ 的联系人照现有规则收到;
//   ④ 一次用户纠错只升一版(AC-15/AC-45):US7、US10 实测同一轮 verdict(revise) 与带 sourceSeq 的 forward 指向同一条消息,版本 0→2。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ContactMind, MindAction, RoundInput } from "@g-group/kernel";
import { all } from "./db.ts";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-contact-actions-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `a${++fileNo}.db`);

/** 等宿主安静下来;每次等待与总时长都有上限,宿主停不下来(例如轮次反复重跑)时按名字失败,而不是挂到测试超时 */
async function settle(host: Host, compute: { drained(): boolean }) {
  const deadline = Date.now() + 30_000;
  for (let i = 0; i < 400 && Date.now() < deadline; i++) {
    await Promise.race([host.idle(), new Promise((r) => setTimeout(r, 250))]);
    await new Promise((r) => setTimeout(r, 5));
    if (compute.drained() && !host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 10));
      if (!host.loop.busy()) return;
    }
  }
  throw new Error("宿主没有安静下来");
}
const rejections = (host: Host) =>
  all<{ kind: string; error: string }>(host.db, "SELECT kind, error FROM gg_effects WHERE status = 'rejected' ORDER BY created_at, action_id").map((r) => ({ kind: r.kind, error: r.error }));
const block = (input: RoundInput, n: number) => input.request.blocks.find((b) => b.block === n)!.text;
const count = (s: string, sub: string) => s.split(sub).length - 1;

/** 剧本脑子:每位联系人一份计划(由测试在运行中改),Compute 完成就交付;每轮输入按联系人记下 */
type Plan = (input: RoundInput) => MindAction[];
function actors() {
  const plans = new Map<string, Plan>();
  const seen = new Map<string, RoundInput[]>();
  const mind = (): ContactMind => ({
    async round(input) {
      const me = input.contact.id;
      seen.set(me, [...(seen.get(me) ?? []), input]);
      const actions = [...(plans.get(me)?.(input) ?? [])];
      for (const f of input.fresh) if (f.kind === "compute" && f.signal === "completed") actions.push({ kind: "deliver", taskId: f.taskId, text: `做完了:${f.summary}` });
      return { actions, stateNote: null };
    },
  });
  return { plans, seen, mind };
}
/** 本轮第 4 块里有没有用户这条原文 */
const userSaid = (input: RoundInput, text: string) => input.fresh.some((f) => f.kind === "message" && f.sender.kind === "user" && f.text === text);

test("群里 3 个面板任务:两位联系人各认领一个成功,第 5 块列出可认领的任务;认领后各起一个 Compute 并交付,第三个仍是 T1 没人负责", async () => {
  const compute = scriptedCompute();
  const a = actors();
  const host = new Host({ file: file(), mind: a.mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const ke = host.createContact({ name: "小克" });
  const yan = host.createContact({ name: "小研" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: ke.id }, { kind: "contact", id: yan.id }]);
  const [t1, t2, t3] = ["写 alpha.md", "写 beta.md", "写 gamma.md"].map((title, i) => host.createTask({ clientActionId: `t${i}`, roomId: g.id, title }));
  await settle(host, compute);
  assert.deepEqual([t1, t2, t3].map((t) => host.taskViewById(t!.id).state), ["T1_Open", "T1_Open", "T1_Open"]);
  a.plans.set(ke.id, (input) => (userSaid(input, "各自认领一个做掉") ? [{ kind: "claim", taskId: t1!.id }] : []));
  a.plans.set(yan.id, (input) => (userSaid(input, "各自认领一个做掉") ? [{ kind: "claim", taskId: t2!.id }] : []));
  host.send({ roomId: g.id, clientActionId: "u1", text: "各自认领一个做掉" });
  await settle(host, compute);
  const asked = a.seen.get(ke.id)!.find((x) => userSaid(x, "各自认领一个做掉"))!;
  for (const t of [t1!, t2!, t3!]) assert.ok(block(asked, 5).includes(`${t.id} [T1_Open] ${t.title}(会话 ${g.id} #${t.sourceSeq},没人负责)`), `第 5 块列出可认领的 ${t.title}`);
  assert.equal(count(block(asked, 1), t1!.id), 0, "可认领的任务不进第 1 块");
  const after1 = host.taskViewById(t1!.id);
  const after2 = host.taskViewById(t2!.id);
  assert.deepEqual([after1.ownerContactId, after1.state], [ke.id, "T5_InReview"], "小克认领 alpha,Compute 跑完已交付");
  assert.deepEqual([after2.ownerContactId, after2.state], [yan.id, "T5_InReview"], "小研认领 beta,Compute 跑完已交付");
  assert.deepEqual([host.taskViewById(t3!.id).state, host.taskViewById(t3!.id).ownerContactId], ["T1_Open", null]);
  assert.deepEqual(compute.spawned.map((s) => (s.brief as { task: string }).task).sort(), ["写 alpha.md", "写 beta.md"], "按任务说明各起一个 Compute");
  const said = host.listMessages(g.id, {}).messages.filter((m) => m.sender.kind === "contact" && m.text.startsWith("认领了任务"));
  assert.deepEqual(said.map((m) => [m.sender.id, m.text, m.replyToSeq]).sort(), [[ke.id, "认领了任务:写 alpha.md", t1!.sourceSeq], [yan.id, "认领了任务:写 beta.md", t2!.sourceSeq]].sort());
  assert.deepEqual(rejections(host), []);
  compute.close();
  await host.close();
});

test("US1 原样:对面板任务那条消息 dispatch 被拒「这条消息已经建过任务」,下一轮第 5 块同时看到被拒原因与可认领的任务,改用 claim_task 认领成功", async () => {
  const compute = scriptedCompute();
  const a = actors();
  const host = new Host({ file: file(), mind: a.mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const ke = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: ke.id }]);
  let t: ReturnType<Host["createTask"]> | null = null;
  a.plans.set(ke.id, (input) => {
    const card = input.fresh.find((f) => f.kind === "message" && f.sender.kind === "user" && f.text === "新建任务:写 alpha.md");
    if (card && card.kind === "message") return [{ kind: "dispatch", roomId: g.id, sourceSeq: card.seq, title: "写 alpha", task: "写 alpha.md" }];
    if (t && block(input, 5).includes("被拒:这条消息已经建过任务")) return [{ kind: "claim", taskId: t.id }];
    return [];
  });
  t = host.createTask({ clientActionId: "t0", roomId: g.id, title: "写 alpha.md" });
  await settle(host, compute);
  assert.deepEqual(rejections(host), [{ kind: "dispatch", error: "这条消息已经建过任务" }]);
  host.send({ roomId: g.id, clientActionId: "u1", text: "面板上有任务,自己认领" });
  await settle(host, compute);
  const next = a.seen.get(ke.id)!.find((x) => userSaid(x, "面板上有任务,自己认领"))!;
  assert.equal(count(block(next, 5), `dispatch_compute(roomId=${g.id}, sourceSeq=${t.sourceSeq}, title=「写 alpha」) → 被拒:这条消息已经建过任务`), 1);
  assert.ok(block(next, 5).includes(`可认领的任务 ${t.id}`), "同一块里给了可认领的任务 id");
  const v = host.taskViewById(t.id);
  assert.deepEqual([v.ownerContactId, v.state], [ke.id, "T5_InReview"], "改用 claim_task 认领、Compute 跑完交付");
  assert.equal(host.listTasks({ roomId: g.id }).length, 1, "没有另建重复任务");
  compute.close();
  await host.close();
});

test("两位联系人同时认领同一个任务:只成功一个、只起一个 Compute,另一个被拒并收到原因(下一轮第 5 块)", async () => {
  const compute2 = scriptedCompute();
  const a = actors();
  // 两人都在看到 T1 之后才提交:两轮都开始了再一起返回,提交先后由宿主决定
  let arrived = 0;
  let release: () => void = () => {};
  const both = new Promise<void>((r) => (release = r));
  const mind = (): ContactMind => ({
    async round(input, signal) {
      if (userSaid(input, "谁来做 gamma")) {
        if (++arrived === 2) release();
        await both;
      }
      return a.mind().round(input, signal);
    },
  });
  const host2 = new Host({ file: file(), mind, compute: () => compute2.adapter, maxDeferMs: 5 });
  const ke = host2.createContact({ name: "小克" });
  const yan = host2.createContact({ name: "小研" });
  const g = host2.createGroup("项目群", [{ kind: "contact", id: ke.id }, { kind: "contact", id: yan.id }]);
  const t = host2.createTask({ clientActionId: "t0", roomId: g.id, title: "写 gamma.md" });
  await settle(host2, compute2);
  const race: Plan = (input) => (userSaid(input, "谁来做 gamma") ? [{ kind: "claim", taskId: t.id }] : []);
  a.plans.set(ke.id, race);
  a.plans.set(yan.id, race);
  host2.send({ roomId: g.id, clientActionId: "u1", text: "谁来做 gamma" });
  await settle(host2, compute2);
  assert.equal(arrived, 2, "两人的这一轮都在任何一方提交之前开始");
  const view = host2.taskViewById(t.id);
  assert.ok(view.ownerContactId === ke.id || view.ownerContactId === yan.id, "恰好一位拿到");
  const winner = view.ownerContactId!;
  const loser = winner === ke.id ? yan.id : ke.id;
  assert.equal(compute2.spawned.length, 1, "只起了一个 Compute");
  const rej = rejections(host2);
  assert.equal(rej.length, 1);
  assert.equal(rej[0]!.kind, "claim");
  assert.match(rej[0]!.error, new RegExp(`^任务 ${t.id} 已由联系人 ${winner} 认领\\((T2_Claimed|T3_Running)\\)$`));
  assert.ok(block(a.seen.get(loser)!.find((x) => userSaid(x, "谁来做 gamma"))!, 5).includes(`${t.id} [T1_Open]`), "两人提交前看到的都是还没人负责");
  // 没抢到的人下一轮(赢家的「认领了任务」消息就会唤醒它)在第 5 块看到被拒的认领与原因,之后不再重复
  a.plans.set(loser, () => []);
  host2.send({ roomId: g.id, clientActionId: "u2", text: "进度如何" });
  await settle(host2, compute2);
  const mine = a.seen.get(loser)!;
  const at = mine.findIndex((x) => userSaid(x, "谁来做 gamma"));
  const line = `claim_task(taskId=${t.id}) → 被拒:${rej[0]!.error}`;
  assert.ok(mine.length >= at + 2, "没抢到的人之后还有轮次");
  assert.equal(count(block(mine[at + 1]!, 5), line), 1, "被拒原因原样回告,紧接的下一轮出现一次");
  assert.ok(!block(mine[at + 1]!, 5).includes(`可认领的任务 ${t.id}`), "已被认领的任务不再列为可认领");
  assert.deepEqual(mine.slice(at + 2).map((x) => count(block(x, 5), line)), mine.slice(at + 2).map(() => 0), "之后的轮次不再重复");
  compute2.close();
  await host2.close();
});

test("认领应失败的输入:不在这个会话的联系人、已有人负责、已取消、没有这个任务——一律被拒、原因准确,负责人与 Compute 都不变", async () => {
  const compute = scriptedCompute();
  const a = actors();
  const host = new Host({ file: file(), mind: a.mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const ke = host.createContact({ name: "小克" });
  const yan = host.createContact({ name: "小研" });
  const out = host.createContact({ name: "外人" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: ke.id }, { kind: "contact", id: yan.id }]);
  const owned = host.createTask({ clientActionId: "t0", roomId: g.id, title: "写 a.md", ownerContactId: yan.id });
  const open = host.createTask({ clientActionId: "t1", roomId: g.id, title: "写 b.md" });
  const gone = host.createTask({ clientActionId: "t2", roomId: g.id, title: "写 c.md" });
  host.taskDecision(gone.id, "cancel", "x1");
  await settle(host, compute);
  const spawnedBefore = compute.spawned.length;
  // 外人不在群里:在自己的私聊里收到消息,提出认领群里的任务
  const dm = host.openDm(out.id);
  a.plans.set(out.id, (input) => (userSaid(input, "去认领") ? [{ kind: "claim", taskId: open.id }] : []));
  a.plans.set(ke.id, (input) => (userSaid(input, "再认领几个") ? [{ kind: "claim", taskId: owned.id }, { kind: "claim", taskId: gone.id }, { kind: "claim", taskId: "t-none" }] : []));
  host.send({ roomId: dm.id, clientActionId: "u1", text: "去认领" });
  host.send({ roomId: g.id, clientActionId: "u2", text: "再认领几个" });
  await settle(host, compute);
  assert.deepEqual(
    rejections(host).map((r) => r.error).sort(),
    [`任务 ${open.id} 不在你所在的会话里`, `任务 ${owned.id} 已由联系人 ${yan.id} 认领(T5_InReview)`, `任务 ${gone.id} 在 T10_Cancelled,不能认领`, "没有任务 t-none"].sort(),
  );
  assert.deepEqual([host.taskViewById(open.id).state, host.taskViewById(open.id).ownerContactId], ["T1_Open", null], "外人没认领到");
  assert.equal(host.taskViewById(owned.id).ownerContactId, yan.id, "负责人不变");
  assert.equal(host.taskViewById(gone.id).state, "T10_Cancelled");
  assert.equal(compute.spawned.length, spawnedBefore, "没有多起 Compute");
  const outRound = a.seen.get(out.id)!.find((x) => userSaid(x, "去认领"))!;
  assert.ok(!block(outRound, 5).includes(open.id), "外人的第 5 块不列别的会话的任务");
  compute.close();
  await host.close();
});

test("被拒的动作下一轮在第 5 块出现一次、原因准确,提交成功之后不再重复;第 1 块逐字不变(AC-39 ①)", async () => {
  const compute = scriptedCompute();
  const a = actors();
  const host = new Host({ file: file(), mind: a.mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const ke = host.createContact({ name: "小克" });
  const stranger = host.createContact({ name: "外人" });
  const dm = host.openDm(ke.id);
  a.plans.set(ke.id, (input) =>
    userSaid(input, "第一句")
      ? [
          { kind: "claim", taskId: "t-none" },
          { kind: "reply", roomId: dm.id, text: "叫外人来看", replyToSeq: null, mentions: [stranger.id] },
          { kind: "reply", roomId: dm.id, text: "收到", replyToSeq: null },
        ]
      : [{ kind: "reply", roomId: dm.id, text: "好", replyToSeq: null }],
  );
  for (const [i, text] of ["第一句", "第二句", "第三句"].entries()) {
    host.send({ roomId: dm.id, clientActionId: `u${i}`, text });
    await settle(host, compute);
  }
  const rounds = ["第一句", "第二句", "第三句"].map((t) => a.seen.get(ke.id)!.find((x) => userSaid(x, t))!);
  const lines = [`claim_task(taskId=t-none) → 被拒:没有任务 t-none`, `reply(roomId=${dm.id}, mentions=${stranger.id}, text=「叫外人来看」) → 被拒:@ 的 ${stranger.id} 不是会话 ${dm.id} 的成员`];
  assert.deepEqual(rejections(host).map((r) => r.error), ["没有任务 t-none", `@ 的 ${stranger.id} 不是会话 ${dm.id} 的成员`], "原因与宿主判下的一致");
  for (const l of lines) {
    assert.equal(count(block(rounds[0]!, 5), l), 0, "被拒之前那一轮没有");
    assert.equal(count(block(rounds[1]!, 5), l), 1, "下一轮恰好出现一次");
    assert.equal(count(block(rounds[2]!, 5), l), 0, "给过之后不再重复");
  }
  assert.ok(block(rounds[1]!, 5).indexOf(lines[0]!) < block(rounds[1]!, 5).indexOf(lines[1]!), "按发生顺序列出");
  assert.equal(block(rounds[1]!, 1), block(rounds[0]!, 1), "第 1 块前缀不因回告改变");
  assert.equal(block(rounds[2]!, 1), block(rounds[0]!, 1));
  compute.close();
  await host.close();
});

test("带着回告的那一轮被放弃(发送前来了更新的用户消息):回告不算给过,重跑的那一轮照样带上", async () => {
  const compute = scriptedCompute();
  let hold: Promise<void> | null = null;
  let letGo: () => void = () => {};
  let held = 0;
  const a = actors();
  const mind = (): ContactMind => ({
    async round(input, signal) {
      if (hold && userSaid(input, "第二句") && held++ === 0) await hold;
      return a.mind().round(input, signal);
    },
  });
  const host = new Host({ file: file(), mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const ke = host.createContact({ name: "小克" });
  const dm = host.openDm(ke.id);
  a.plans.set(ke.id, (input) => (userSaid(input, "第一句") ? [{ kind: "claim", taskId: "t-none" }] : [{ kind: "reply", roomId: dm.id, text: "好", replyToSeq: null }]));
  host.send({ roomId: dm.id, clientActionId: "u0", text: "第一句" });
  await settle(host, compute);
  hold = new Promise<void>((r) => (letGo = r));
  host.send({ roomId: dm.id, clientActionId: "u1", text: "第二句" });
  for (let i = 0; i < 200 && held === 0; i++) await new Promise((r) => setTimeout(r, 5));
  host.send({ roomId: dm.id, clientActionId: "u2", text: "插一句" });
  letGo();
  await settle(host, compute);
  host.send({ roomId: dm.id, clientActionId: "u3", text: "第三句" });
  await settle(host, compute);
  const line = "claim_task(taskId=t-none) → 被拒:没有任务 t-none";
  const withSecond = a.seen.get(ke.id)!.filter((x) => userSaid(x, "第二句"));
  assert.ok(withSecond.length >= 2, "带「第二句」的那一轮被放弃后重跑了");
  assert.deepEqual(withSecond.map((x) => count(block(x, 5), line)), withSecond.map(() => 1), "放弃的那一轮和重跑的那一轮都带着回告");
  const third = a.seen.get(ke.id)!.find((x) => userSaid(x, "第三句"))!;
  assert.equal(count(block(third, 5), line), 0, "重跑那一轮提交之后不再重复");
  compute.close();
  await host.close();
});

test("reply 带 mentions:写进消息 mentions(与用户发消息的 @ 同一形状),被 @ 的联系人照现有规则收到并看到 @ 它;非成员被拒、消息不发", async () => {
  const compute = scriptedCompute();
  const a = actors();
  const host = new Host({ file: file(), mind: a.mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const ke = host.createContact({ name: "小克" });
  const yan = host.createContact({ name: "小研" });
  const out = host.createContact({ name: "外人" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: ke.id }, { kind: "contact", id: yan.id }]);
  a.plans.set(ke.id, (input) => {
    if (userSaid(input, "叫小研看一下")) return [{ kind: "reply", roomId: g.id, text: "小研看一下,看完告诉我们", replyToSeq: null, mentions: [yan.id, host.userId, yan.id] }];
    if (userSaid(input, "叫外人看一下")) return [{ kind: "reply", roomId: g.id, text: "外人看一下", replyToSeq: null, mentions: [out.id] }];
    return [];
  });
  host.send({ roomId: g.id, clientActionId: "u1", text: "叫小研看一下", mentions: [{ id: ke.id, source: "manual" }] });
  await settle(host, compute);
  const sent = host.listMessages(g.id, {}).messages.find((m) => m.sender.kind === "contact" && m.sender.id === ke.id)!;
  assert.equal(sent.text, "小研看一下,看完告诉我们");
  assert.deepEqual(sent.mentions, [{ id: yan.id, source: "manual" }, { id: host.userId, source: "manual" }], "去重后写进 mentions,形状同用户 @");
  const forYan = a.seen.get(yan.id)!.flatMap((x) => x.fresh).find((f) => f.kind === "message" && f.seq === sent.seq);
  assert.ok(forYan && forYan.kind === "message", "小研收到了这条");
  assert.deepEqual(forYan.mentions, [yan.id, host.userId], "第 4 块里看得到 @ 了它");
  const before = host.listMessages(g.id, {}).messages.length;
  host.send({ roomId: g.id, clientActionId: "u2", text: "叫外人看一下", mentions: [{ id: ke.id, source: "manual" }] });
  await settle(host, compute);
  assert.equal(host.listMessages(g.id, {}).messages.length, before + 1, "只多了用户那条,@ 非成员的回复没发出去");
  assert.deepEqual(rejections(host), [{ kind: "reply", error: `@ 的 ${out.id} 不是会话 ${g.id} 的成员` }]);
  compute.close();
  await host.close();
});

/** 交付后用户回一句修改:脑子同一轮既 verdict(revise) 又 forward 带 sourceSeq,顺序由 order 定(US7、US10 实测的组合);返回改完后的任务视图 */
async function reviseOnce(host: Host, compute: ReturnType<typeof scriptedCompute>, a: ReturnType<typeof actors>, order: "verdict-first" | "forward-first") {
  const ke = host.createContact({ name: "小克" });
  const dm = host.openDm(ke.id);
  a.plans.set(ke.id, (input) => {
    const out: MindAction[] = [];
    for (const f of input.fresh) {
      if (f.kind !== "message" || f.sender.kind !== "user") continue;
      if (f.text === "帮我写 notes.md") out.push({ kind: "dispatch", roomId: dm.id, sourceSeq: f.seq, title: "写 notes.md", task: "写 notes.md,3 条建议" });
      if (f.text.startsWith("改一下")) {
        const t = host.listTasks({ roomId: dm.id })[0]!;
        const verdict: MindAction = { kind: "verdict", taskId: t.id, sourceSeq: f.seq, verdict: "revise", feedback: "再加第 4 条" };
        const forward: MindAction = { kind: "forward", taskId: t.id, text: "请在 notes.md 末尾加第 4 条,讲首行长度", sourceSeq: f.seq };
        out.push(...(order === "verdict-first" ? [verdict, forward] : [forward, verdict]));
      }
    }
    return out;
  });
  host.send({ roomId: dm.id, clientActionId: "u0", text: "帮我写 notes.md" });
  await settle(host, compute);
  const [t] = host.listTasks({ roomId: dm.id });
  assert.deepEqual([t!.state, t!.constraintVersion], ["T5_InReview", 0], "第一次交付后等用户回复");
  host.send({ roomId: dm.id, clientActionId: "u2", text: "改一下:再加第 4 条,讲提交信息首行长度" });
  await settle(host, compute);
  return host.taskViewById(t!.id);
}

test("一次用户纠错 → constraint_ver 恰好 +1:同一轮 verdict(revise) 在前、forward 带同一条 sourceSeq 在后(复现 US7/US10 的 0→2)", async () => {
  const compute = scriptedCompute({ onResume: () => [{ kind: "completed", result: "改好了:4 条" }] });
  const a = actors();
  const host = new Host({ file: file(), mind: a.mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const v = await reviseOnce(host, compute, a, "verdict-first");
  assert.equal(v.constraintVersion, 1, "一次纠错只升一版");
  assert.equal(compute.resumed.length, 1, "原 Compute 只续接一次");
  assert.ok(compute.resumed[0]!.text.includes("用户退回:再加第 4 条"), "退回意见送到了");
  assert.ok(compute.resumed[0]!.text.includes("请在 notes.md 末尾加第 4 条,讲首行长度"), "forward 的原文并进同一次续接");
  assert.equal(v.state, "T5_InReview", "按新版本返工后再次交付");
  assert.deepEqual(rejections(host), []);
  compute.close();
  await host.close();
});

test("一次用户纠错 → constraint_ver 恰好 +1:forward 带 sourceSeq 在前、verdict(revise) 同一条在后,退回意见并进同一次续接、不被拒", async () => {
  const compute = scriptedCompute({ onResume: () => [{ kind: "completed", result: "改好了:4 条" }] });
  const a = actors();
  const host = new Host({ file: file(), mind: a.mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const v = await reviseOnce(host, compute, a, "forward-first");
  assert.equal(v.constraintVersion, 1, "一次纠错只升一版");
  assert.equal(compute.resumed.length, 1, "原 Compute 只续接一次");
  assert.ok(compute.resumed[0]!.text.includes("请在 notes.md 末尾加第 4 条,讲首行长度"));
  assert.ok(compute.resumed[0]!.text.includes("用户退回:再加第 4 条"));
  assert.deepEqual(rejections(host), []);
  compute.close();
  await host.close();
});
