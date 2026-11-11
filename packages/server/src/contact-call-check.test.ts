// 片 CA2(feat/contact-call-check),来自 PR #76(contact-actions)回报的未完成项 1、2:
//   ① @everyone(US1 §8.4「群输入框发 @everyone」、U14):reply 加 everyone,宿主核对发送者是该会话成员后展开成全体成员
//      (含用户、不含发送者自己、不含 Helper),与逐个 mentions 取并集写进消息 mentions(与用户发消息的 @ 同一形状);
//      它不是「被 @ 才接活」的特权,只是把所有人列进 mentions。
//   ② 当场校验(AC-31 状态一致):宿主给 pi 运行时一个只读的 checkAction,工具执行时先调它;能提前判定的不合规当场拒
//      (不登记该动作、原因立刻作为工具结果回到模型),轮末 commitRound 的校验保留为兜底。
//   ③ 同一轮里模型随后调 reply 宣称「一件当场被拒的事已经做了」:轮末不发出这条 reply,并记进被拒动作回告(下一轮第 5 块)。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ActionCheck, ContactMind, MindAction, RoundInput, RoundTools } from "@g-group/kernel";
import { replyMentionIds, unfulfilledClaim } from "./contact-actions.ts";
import { all } from "./db.ts";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-contact-call-check-"));
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
const userSaid = (input: RoundInput, text: string) => input.fresh.some((f) => f.kind === "message" && f.sender.kind === "user" && f.text === text);

/** 剧本脑子:每位联系人一份计划(由测试在运行中改),Compute 完成就交付;每轮输入记下 */
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

test("reply 的 @ 名单:@everyone 展开含用户与全部联系人、不含发送者自己与 Helper;不开启时只给逐个点名的", () => {
  const members = [
    { kind: "user", id: "me" },
    { kind: "contact", id: "c-ke" },
    { kind: "contact", id: "c-yan" },
    { kind: "helper", id: "helper" },
  ];
  assert.deepEqual(replyMentionIds(undefined, true, members, "c-ke"), ["me", "c-yan"], "全体成员:含用户,不含发送者自己,也不含 Helper");
  assert.deepEqual(replyMentionIds(["c-yan"], true, members, "c-ke"), ["c-yan", "me", "c-yan"], "逐个点名的在前,展开的全员补在后");
  assert.deepEqual(replyMentionIds(undefined, false, members, "c-ke"), [], "不开 @everyone 就一个人也不 @");
  assert.deepEqual(replyMentionIds(["me"], false, members, "c-ke"), ["me"], "不开 @everyone 时逐个点名的原样");
});

test("reply 带 @everyone:消息 mentions 是会话全体成员(含用户、不含发送者与 Helper),与逐个 @ 并用时同一人只列一次", async () => {
  const compute = scriptedCompute();
  const a = actors();
  const host = new Host({ file: file(), mind: a.mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const ke = host.createContact({ name: "小克" });
  const yan = host.createContact({ name: "小研" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: ke.id }, { kind: "contact", id: yan.id }]);
  a.plans.set(ke.id, (input) => {
    if (userSaid(input, "叫上所有人")) return [{ kind: "reply", roomId: g.id, text: "大家一起看", replyToSeq: null, everyone: true }];
    if (userSaid(input, "叫上所有人,顺便点小研")) return [{ kind: "reply", roomId: g.id, text: "小研也一起", replyToSeq: null, mentions: [yan.id, host.userId], everyone: true }];
    return [];
  });
  host.send({ roomId: g.id, clientActionId: "u1", text: "叫上所有人", mentions: [{ id: ke.id, source: "manual" }] });
  await settle(host, compute);
  const first = host.listMessages(g.id, {}).messages.find((m) => m.text === "大家一起看")!;
  assert.deepEqual(first.mentions.map((x) => x.id), [yan.id, host.userId], "全体成员:含用户、不含发送者小克自己、不含 Helper");
  assert.equal(first.mentions.every((x) => x.source === "manual"), true, "形状与用户发消息的 @ 一致");
  const forYan = a.seen.get(yan.id)!.flatMap((x) => x.fresh).find((f) => f.kind === "message" && f.seq === first.seq);
  assert.ok(forYan && forYan.kind === "message" && forYan.mentions.includes(yan.id), "@everyone 里的联系人照现有规则收到并看到 @ 了它");
  // 逐个 @ 与 @everyone 并用:取并集,同一个人只列一次(小研既被点名又在全体里,用户只在全体里)
  host.send({ roomId: g.id, clientActionId: "u2", text: "叫上所有人,顺便点小研", mentions: [{ id: ke.id, source: "manual" }] });
  await settle(host, compute);
  const second = host.listMessages(g.id, {}).messages.find((m) => m.text === "小研也一起")!;
  assert.deepEqual(second.mentions.map((x) => x.id), [yan.id, host.userId], "并集去重后同一人只列一次");
  compute.close();
  await host.close();
});

test("@everyone 的发送者不在这个会话里:当场校验就拒,轮末也拒,消息不发(展开只在本人在的会话里生效)", async () => {
  const compute = scriptedCompute();
  const a = actors();
  const checks: (ActionCheck | null)[] = [];
  const mind = (): ContactMind => ({
    async round(input, _signal, tools: RoundTools | undefined) {
      a.seen.set(input.contact.id, [...(a.seen.get(input.contact.id) ?? []), input]);
      const actions = [...(a.plans.get(input.contact.id)?.(input) ?? [])];
      for (const x of actions) checks.push(tools?.checkAction ? await tools.checkAction(x) : null);
      return { actions, stateNote: null };
    },
  });
  const host = new Host({ file: file(), mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const ke = host.createContact({ name: "小克" });
  const yan = host.createContact({ name: "小研" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: ke.id }, { kind: "contact", id: yan.id }]);
  const other = host.createGroup("别的群", [{ kind: "contact", id: yan.id }]);
  a.plans.set(ke.id, (input) => (userSaid(input, "去别的群喊一声") ? [{ kind: "reply", roomId: other.id, text: "大家都看一下", replyToSeq: null, everyone: true }] : []));
  const before = host.listMessages(other.id, {}).messages.length;
  host.send({ roomId: g.id, clientActionId: "u1", text: "去别的群喊一声", mentions: [{ id: ke.id, source: "manual" }] });
  await settle(host, compute);
  assert.deepEqual(checks, [{ ok: false, reason: "不在这个会话里" }], "当场校验口就说不行,原因准确");
  assert.equal(host.listMessages(other.id, {}).messages.length, before, "小克不在这个会话里,@everyone 的这句话没发出去");
  assert.deepEqual(rejections(host), [{ kind: "reply", error: "不在这个会话里" }], "轮末校验照样兜住");
  compute.close();
  await host.close();
});

test("当场校验五类各一条:越权会话、任务不归属、seq 不在本轮、认领冲突、mentions 非成员——逐条当场拒且原因与轮末一致", async () => {
  const compute = scriptedCompute();
  const a = actors();
  const results: { kind: string; check: ActionCheck | null }[] = [];
  const mind = (): ContactMind => ({
    async round(input, _signal, tools: RoundTools | undefined) {
      const me = input.contact.id;
      a.seen.set(me, [...(a.seen.get(me) ?? []), input]);
      const actions = [...(a.plans.get(me)?.(input) ?? [])];
      if (userSaid(input, "校验看看")) {
        for (const x of actions) results.push({ kind: x.kind, check: tools?.checkAction ? await tools.checkAction(x) : null });
        return { actions: [], stateNote: null };
      }
      return { actions, stateNote: null };
    },
  });
  const host = new Host({ file: file(), mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const ke = host.createContact({ name: "小克" });
  const yan = host.createContact({ name: "小研" });
  const out = host.createContact({ name: "外人" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: ke.id }, { kind: "contact", id: yan.id }]);
  const other = host.createGroup("别的群", [{ kind: "contact", id: yan.id }]);
  const owned = host.createTask({ clientActionId: "t0", roomId: g.id, title: "写 a.md", ownerContactId: yan.id });
  await settle(host, compute);
  const state = host.taskViewById(owned.id).state;
  a.plans.set(ke.id, (input) =>
    userSaid(input, "校验看看")
      ? [
          { kind: "reply", roomId: other.id, text: "大家都看一下", replyToSeq: null, everyone: true },
          { kind: "forward", taskId: owned.id, text: "继续" },
          { kind: "commit", roomId: g.id, sourceSeq: 9999, text: "我来", taskId: null },
          { kind: "claim", taskId: owned.id },
          { kind: "reply", roomId: g.id, text: "外人看一下", replyToSeq: null, mentions: [out.id] },
        ]
      : [],
  );
  host.send({ roomId: g.id, clientActionId: "u1", text: "校验看看" });
  await settle(host, compute);
  assert.deepEqual(
    results,
    [
      { kind: "reply", check: { ok: false, reason: "不在这个会话里" } },
      { kind: "forward", check: { ok: false, reason: "不是你的任务" } },
      { kind: "commit", check: { ok: false, reason: `来源 ${g.id} #9999 不是本轮新消息` } },
      { kind: "claim", check: { ok: false, reason: `任务 ${owned.id} 已由联系人 ${yan.id} 认领(${state})` } },
      { kind: "reply", check: { ok: false, reason: `@ 的 ${out.id} 不是会话 ${g.id} 的成员` } },
    ],
    "五类各自当场拒;认领冲突的判据与轮末 claimRefusal 是同一条",
  );
  assert.deepEqual(rejections(host), [], "当场就拦下了,没走到轮末的拒绝(被拒动作一个都没登记:gg_effects 无记录)");
  assert.equal(host.taskViewById(owned.id).ownerContactId, yan.id, "负责人没变");
  compute.close();
  await host.close();
});

test("同一轮里模型先调会被拒的认领、又在 reply 里宣称已认领:认领不落盘,这句 reply 也不发出,并记进回告(下一轮第 5 块)", async () => {
  const compute = scriptedCompute();
  const a = actors();
  const g = { id: "" };
  let refused = "";
  const mind = (): ContactMind => ({
    async round(input, _signal, tools: RoundTools | undefined) {
      const me = input.contact.id;
      a.seen.set(me, [...(a.seen.get(me) ?? []), input]);
      if (me !== ke.id || !userSaid(input, "你认领一个")) return { actions: [], stateNote: null };
      const taken = host.listTasks({ roomId: g.id }).find((x) => x.ownerContactId === yan.id)!;
      const attempted: MindAction = { kind: "claim", taskId: taken.id };
      const r = tools?.checkAction ? await tools.checkAction(attempted) : null;
      if (!r || r.ok) return { actions: [attempted], stateNote: null };
      refused = r.reason;
      return { actions: [{ kind: "reply", roomId: g.id, text: `我认领了 ${taken.id},已经在做了`, replyToSeq: null }], stateNote: null, inRoundRefusals: [{ action: attempted, reason: r.reason }] };
    },
  });
  const host = new Host({ file: file(), mind, compute: () => compute.adapter, maxDeferMs: 5 });
  const ke = host.createContact({ name: "小克" });
  const yan = host.createContact({ name: "小研" });
  const group = host.createGroup("项目群", [{ kind: "contact", id: ke.id }, { kind: "contact", id: yan.id }]);
  g.id = group.id;
  const taken = host.createTask({ clientActionId: "t0", roomId: group.id, title: "写 a.md", ownerContactId: yan.id });
  await settle(host, compute);
  host.send({ roomId: group.id, clientActionId: "u1", text: "你认领一个" });
  await settle(host, compute);
  assert.equal(host.listMessages(group.id, {}).messages.some((m) => m.text.includes("我认领了")), false, "宣称已认领的那句话没有发出去");
  assert.equal(host.taskViewById(taken.id).ownerContactId, yan.id, "负责人没变,小克没认领到");
  assert.deepEqual(rejections(host).filter((r) => r.kind === "claim"), [], "被当场拒的 claim 不落盘(gg_effects 里没有 claim 记录)");
  assert.match(refused, /^任务 .+ 已由联系人 .+ 认领\((T\d+_[A-Za-z]+)\)$/, "当场拒的原因来自 claimRefusal");
  const rej = rejections(host);
  assert.equal(rej.length, 1, "只记了被拦下的那句 reply 一条拒绝");
  assert.equal(rej[0]!.error, `这一轮里对 ${taken.id} 的动作被当场拒了(${refused});这句话宣称它已完成,没有发出`, "回告带上对象与当场拒的原因");
  host.send({ roomId: group.id, clientActionId: "u2", text: "进度如何" });
  await settle(host, compute);
  const next = a.seen.get(ke.id)!.find((x) => userSaid(x, "进度如何"))!;
  assert.equal(count(block(next, 5), `对 ${taken.id} 的动作被当场拒了`), 1, "下一轮第 5 块恰好给一次,它就能改口");
  compute.close();
  await host.close();
});

test("轮末兜底仍生效:两人的当场校验都说可以(提交时才知道谁先),后提交的照样在轮末被拒并回告", async () => {
  const compute2 = scriptedCompute();
  const a = actors();
  const ported: (string | null)[] = [];
  const g = { id: "" };
  let arrived = 0;
  let release: () => void = () => {};
  const both = new Promise<void>((r) => (release = r));
  const mind = (): ContactMind => ({
    async round(input, _signal, tools: RoundTools | undefined) {
      const me = input.contact.id;
      a.seen.set(me, [...(a.seen.get(me) ?? []), input]);
      if (!userSaid(input, "谁来做 gamma")) return { actions: [], stateNote: null };
      const t = host.listTasks({ roomId: g.id })[0]!;
      const check = tools?.checkAction ? await tools.checkAction({ kind: "claim", taskId: t.id }) : null;
      ported.push(check === null ? null : check.ok ? "ok" : check.reason);
      if (++arrived === 2) release();
      await both;
      return { actions: [{ kind: "claim", taskId: t.id }], stateNote: null };
    },
  });
  const host = new Host({ file: file(), mind, compute: () => compute2.adapter, maxDeferMs: 5 });
  const ke = host.createContact({ name: "小克" });
  const yan = host.createContact({ name: "小研" });
  const group = host.createGroup("项目群", [{ kind: "contact", id: ke.id }, { kind: "contact", id: yan.id }]);
  g.id = group.id;
  const t = host.createTask({ clientActionId: "t0", roomId: group.id, title: "写 gamma.md" });
  await settle(host, compute2);
  host.send({ roomId: group.id, clientActionId: "u1", text: "谁来做 gamma" });
  await settle(host, compute2);
  assert.deepEqual(ported, ["ok", "ok"], "当场校验只看提交前的状态:两人看到的都是还没人负责,都说可以");
  const view = host.taskViewById(t.id);
  const winner = view.ownerContactId!;
  const loser = winner === ke.id ? yan.id : ke.id;
  assert.equal(compute2.spawned.length, 1, "只起了一个 Compute");
  const rej = rejections(host);
  assert.equal(rej.length, 1, "轮末只拒了后提交的那一个");
  assert.equal(rej[0]!.kind, "claim");
  assert.match(rej[0]!.error, new RegExp(`^任务 ${t.id} 已由联系人 ${winner} 认领\\((T2_Claimed|T3_Running)\\)$`));
  a.plans.set(loser, () => []);
  host.send({ roomId: group.id, clientActionId: "u2", text: "进度如何" });
  await settle(host, compute2);
  const mine = a.seen.get(loser)!;
  const at = mine.findIndex((x) => userSaid(x, "谁来做 gamma"));
  assert.ok(mine.length >= at + 2, "没抢到的人之后还有轮次");
  assert.equal(count(block(mine[at + 1]!, 5), `claim_task(taskId=${t.id}) → 被拒:${rej[0]!.error}`), 1, "轮末的拒绝照旧回告");
  compute2.close();
  await host.close();
});

test("未落实声明的判据:reply 正文里出现被当场拒动作所指对象的 id 才算;不是 reply、或本轮没有被拒动作都不算", () => {
  const refused = { action: { kind: "claim", taskId: "t-9" } as MindAction, reason: "任务 t-9 在 T1_Open,不能认领" };
  const reply = (text: string): MindAction => ({ kind: "reply", roomId: "g1", text, replyToSeq: null });
  assert.deepEqual(unfulfilledClaim(reply("我认领了 t-9"), [refused]), { token: "t-9", reason: "任务 t-9 在 T1_Open,不能认领" });
  assert.equal(unfulfilledClaim(reply("我认领了一个任务,马上开始"), [refused]), null, "没点到那个对象就不算宣称它已完成");
  // 边界(取最小实现,见 PR 的未完成项):判据只认「正文里出现了被拒动作所指对象的 id」这一条可核对的字符串事实,
  // 不看这句话是宣称做了还是说没做到——说「t-9 我没认领到」同样会被拦,模型下一轮拿到回告后换个说法即可。
  assert.deepEqual(unfulfilledClaim(reply("t-9 我没认领到"), [refused]), { token: "t-9", reason: "任务 t-9 在 T1_Open,不能认领" });
  assert.equal(unfulfilledClaim({ kind: "deliver", taskId: "t-9", text: "t-9 做完了" }, [refused]), null, "只有 reply 会被当宣称");
  assert.equal(unfulfilledClaim(reply("我认领了 t-9"), []), null, "本轮没有当场被拒的动作就没什么可拦");
});
