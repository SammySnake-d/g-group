// AC-36 失败轮次 A×B 双维容错的宿主接线(用确定性替身驱动,真实上游另见 proof):
//   联系人一轮:F1 首次 502 静默恢复 0 出卡、耗尽只出 1 张原位卡、F8 unknown 有界 1 次、F2 403 0 次重试且同 Key 全群 1 张群级卡、
//   F10 共享熔断暂停后台重试并半开探测恢复、A27-05 跳过不吞 m_new / 重试带上 m_new / 连点与过期卡被拒、显式换模、F5 失败期间新消息、
//   F4 中途杀宿主重启重跑且 action_id 不重复、F12 毒丸第 2 次熔断与成功清零;
//   Compute:同一实例 resume 续跑不从头 spawn、F3 统一重试权、永久故障出卡与[重试]/[不重试了]、F13 半途换模累积集合、
//   F7 用户停止不是失败、F6 终态通知丢失从磁盘补领不重跑、窗口 ② 续跑提示带工作区现状、副作用不明不自动重发。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { ComputeEvent } from "@g-group/adapter-cc-compute";
import type { ContactView } from "@g-group/api-contract";
import { apply as applyTask, type TaskEvent } from "@g-group/domain";
import type { ContactMind, RoundInput } from "@g-group/kernel";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host, type HostOptions } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-retry-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `r${++fileNo}.db`);
const FAST = { retry: { baseDelayMs: 5, maxDelayMs: 20, jitter: 0, maxAutoRetries: 2 }, breaker: { memberThreshold: 2, cooldownMs: 40 }, random: () => 0, maxDeferMs: 5 } as const;
// 每条测试结束(含断言失败)都关掉本条建的宿主与 Compute 替身,不留计时器与后台轮次
const opened: { close(): unknown }[] = [];
afterEach(async () => {
  for (const x of opened.splice(0).reverse()) {
    try {
      await x.close();
    } catch {
      /* 已经关过 */
    }
  }
});
/** 建宿主:被测类显式传入(断言据此追溯到被测源码),本条测试结束自动关闭。 */
const mk = (H: typeof Host, o: Partial<HostOptions> & Pick<HostOptions, "mind">, f = file()) => {
  const h = new H({ file: f, ...FAST, ...o });
  opened.push(h);
  return h;
};
const fake = (o: Parameters<typeof scriptedCompute>[0] = {}) => {
  const c = scriptedCompute(o);
  opened.push(c);
  return c;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等不到:${what}`);
    await sleep(5);
  }
}
const msgs = (h: Host, roomId: string) => h.listMessages(roomId, {}).messages;
const texts = (h: Host, roomId: string) => msgs(h, roomId).map((m) => `${m.sender.kind}:${m.text}`);
const failureCards = (h: Host, roomId: string) => msgs(h, roomId).filter((m) => m.card?.kind === "failure");
function retryEvents(h: Host, scope: "contact" | "task" = "contact") {
  const list: string[] = [];
  h.bus.subscribe((e) => {
    if (e.type === "retry.updated" && e.scope === scope) list.push(`${e.state}:${e.attempt}/${e.limit}`);
  });
  return list;
}
const MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet", vendor: "anthropic", harnesses: ["claude-code" as const] },
  { id: "gpt-5", label: "GPT-5", vendor: "openai", harnesses: ["claude-code" as const] },
];
const hangUntilAbort = (signal: AbortSignal) =>
  new Promise<never>((_r, rej) => {
    if (signal.aborted) rej(new Error("aborted"));
    signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
  });
const userMsgs = (i: RoundInput) => i.fresh.filter((f) => f.kind === "message" && f.sender.kind === "user");

/** 按剧本失败的脑子:fail(第几次调用, 输入) 给出要抛的错误,null 就正常回复「收到 N 条」(N = 本轮用户消息数)。 */
function flakyMind(fail: (call: number, input: RoundInput) => Error | null) {
  let calls = 0;
  const seen: RoundInput[] = [];
  const mind: ContactMind = {
    async round(input) {
      calls++;
      seen.push(input);
      const e = fail(calls, input);
      if (e) throw e;
      const users = userMsgs(input);
      if (!users.length) return { actions: [], stateNote: null };
      return { actions: [{ kind: "reply", roomId: users[0]!.roomId, text: `收到 ${users.length} 条`, replyToSeq: null }], stateNote: null };
    },
  };
  return { mind, calls: () => calls, seen };
}
/** 群里每位联系人一个计数;down() 给出错误就整个上游不可用。只回复用户消息,联系人之间不互相接话。 */
function groupMind(down: () => Error | null) {
  const calls = new Map<string, number>();
  const factory = (c: ContactView): ContactMind => ({
    async round(input) {
      calls.set(c.id, (calls.get(c.id) ?? 0) + 1);
      const e = down();
      if (e) throw e;
      const users = userMsgs(input);
      if (!users.length) return { actions: [], stateNote: null };
      return { actions: [{ kind: "reply", roomId: users[0]!.roomId, text: `${c.name} 收到`, replyToSeq: null }], stateNote: null };
    },
  });
  return { factory, calls };
}
function group(host: Host, names: string[]) {
  const cs = names.map((name) => host.createContact({ name }));
  const room = host.createGroup("项目群", cs.map((c) => ({ kind: "contact" as const, id: c.id }))).id;
  return { cs, room };
}

// ======================= 联系人一轮 =======================
test("F1 首次 502 静默恢复:联系人一轮 502 后退避重试成功,0 张失败卡,回复只发 1 次,自动重试不换模型", async () => {
  const f = flakyMind((n) => (n === 1 ? new Error("API Error: 502 Bad Gateway") : null));
  const host = mk(Host, { mind: () => f.mind });
  const ev = retryEvents(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  host.send({ roomId: dm, clientActionId: "u1", text: "你好" });
  await until(() => texts(host, dm).length === 2, "回复");
  await host.idle();
  assert.equal(f.calls(), 2);
  assert.deepEqual(texts(host, dm), ["user:你好", "contact:收到 1 条"]);
  assert.equal(failureCards(host, dm).length, 0);
  assert.deepEqual(ev, ["retrying:1/2", "cleared:0/0"], "状态行先显示重连中 1/2,恢复后清掉");
  assert.deepEqual(f.seen.map((i) => i.contact.speakingModel), ["claude-sonnet-4-6", "claude-sonnet-4-6"]);
  await host.close();
});

test("F1 连续 502 耗尽自动重试上限:原位只出 1 张人话失败卡,原文折叠在详情,按钮是重试本轮/跳过本轮/换模型重试", async () => {
  const f = flakyMind(() => new Error("API Error: 502 Bad Gateway"));
  const host = mk(Host, { mind: () => f.mind });
  host.updateSettings({ models: MODELS });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  host.send({ roomId: dm, clientActionId: "u1", text: "你好" });
  await until(() => failureCards(host, dm).length === 1, "失败卡");
  await sleep(80);
  assert.equal(f.calls(), 3, "1 次 + 自动重试 2 次,出卡后不再重试");
  assert.deepEqual(f.seen.map((i) => i.contact.speakingModel), ["claude-sonnet-4-6", "claude-sonnet-4-6", "claude-sonnet-4-6"], "配了备用模型,自动重试也不悄悄换");
  const cards = failureCards(host, dm);
  assert.equal(cards.length, 1);
  const card = cards[0]!.card!;
  assert.equal(card.title, "小克 这一轮没回成:上游不可用");
  assert.match(card.body, /^已自动重试 2 次仍然失败。/);
  assert.match(card.body, /原文:\nAPI Error: 502 Bad Gateway/);
  assert.deepEqual(card.actions.map((a) => [a.actionId, a.label]), [["retry", "重试本轮"], ["skip", "跳过本轮"], ["switch-model:gpt-5", "换成 GPT-5 重试"]]);
  assert.deepEqual([cards[0]!.sender.kind, cards[0]!.sender.id, card.state], ["contact", c.id, "open"]);
  assert.equal(host.roomView(dm).pendingForUser, 1);
  await host.close();
});

test("F8 认不出的错误(unknown×B0):有界重试 1 次即出卡,卡上写未识别并保留原文", async () => {
  const f = flakyMind(() => new Error("奇怪的状况 xyz-42"));
  const host = mk(Host, { mind: () => f.mind });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  host.send({ roomId: dm, clientActionId: "u1", text: "你好" });
  await until(() => failureCards(host, dm).length === 1, "失败卡");
  await sleep(60);
  assert.equal(f.calls(), 2);
  const card = failureCards(host, dm)[0]!.card!;
  assert.equal(card.title, "小克 这一轮没回成:未识别的失败");
  assert.match(card.body, /已自动重试 1 次仍然失败[\s\S]*奇怪的状况 xyz-42/);
  await host.close();
});

test("F2 403 配额耗尽:0 次自动重试;共用同一 Key 的 3 个联系人全群只出 1 张群级卡,冷却过后也不自动探测;修好后点重试三人都续跑", async () => {
  let down: Error | null = new Error("403 Insufficient user quota");
  const g = groupMind(() => down);
  const host = mk(Host, { mind: g.factory });
  const { cs, room } = group(host, ["A", "B", "C"]);
  host.send({ roomId: room, clientActionId: "g1", text: "大家看一下", mentions: cs.map((c) => ({ id: c.id, source: "manual" as const })) });
  await until(() => failureCards(host, room).length === 1, "群级卡");
  await sleep(160);
  for (const c of cs) assert.ok((g.calls.get(c.id) ?? 0) <= 1, `${c.name} 最多调 1 次模型(0 次自动重试)`);
  const cards = failureCards(host, room);
  assert.equal(cards.length, 1, "全群只出 1 张");
  const card = cards[0]!;
  assert.match(card.card!.title, /^鉴权或额度问题:共用这个上游的/);
  assert.match(card.card!.body, /不会自动重试/);
  assert.match(card.card!.body, /403 Insufficient user quota/);
  assert.deepEqual(card.card!.actions.map((x) => x.actionId), ["retry", "skip"]);
  down = null;
  host.cardAct({ roomId: room, seq: card.seq, cardId: card.card!.cardId, actionId: "retry", clientActionId: "g2" });
  await until(() => ["A", "B", "C"].every((n) => texts(host, room).includes(`contact:${n} 收到`)), "三位都回复");
  for (const n of ["A", "B", "C"]) assert.equal(texts(host, room).filter((t) => t === `contact:${n} 收到`).length, 1);
  assert.throws(() => host.cardAct({ roomId: room, seq: card.seq, cardId: card.card!.cardId, actionId: "retry", clientActionId: "g3" }), /已经处理过|已过期/);
  await host.idle();
  await host.close();
});

test("F10 3 个联系人共用同一上游连续 502:共享熔断暂停后台重试,全群只出 1 张群级卡;半开探测恢复后三人都续跑,自动恢复抢先后点卡被拒", async () => {
  let down: Error | null = new Error("API Error: 502 Bad Gateway");
  const g = groupMind(() => down);
  const host = mk(Host, { mind: g.factory, retry: { baseDelayMs: 20, maxDelayMs: 20, jitter: 0, maxAutoRetries: 2 }, breaker: { memberThreshold: 2, cooldownMs: 250 } });
  const { cs, room } = group(host, ["A", "B", "C"]);
  host.send({ roomId: room, clientActionId: "g1", text: "大家看一下", mentions: cs.map((c) => ({ id: c.id, source: "manual" as const })) });
  await until(() => failureCards(host, room).length === 1, "群级卡");
  const card = failureCards(host, room)[0]!;
  assert.match(card.card!.title, /^上游不可用:共用这个上游的 \d 位成员先暂停$/);
  assert.match(card.card!.body, /过一会儿会自动探测一次/);
  await sleep(80);
  for (const c of cs) assert.equal(g.calls.get(c.id), 1, `熔断打开期间 ${c.name} 的后台重试被暂停`);
  down = null;
  await until(() => ["A", "B", "C"].every((n) => texts(host, room).includes(`contact:${n} 收到`)), "半开探测恢复后三位都回复");
  await host.idle();
  assert.equal(failureCards(host, room).length, 1, "恢复过程中没有再出卡");
  for (const n of ["A", "B", "C"]) assert.equal(texts(host, room).filter((t) => t === `contact:${n} 收到`).length, 1);
  assert.equal(msgs(host, room).find((m) => m.seq === card.seq)!.card!.state, "expired", "自动恢复后群级卡作废");
  assert.throws(() => host.cardAct({ roomId: room, seq: card.seq, cardId: card.card!.cardId, actionId: "retry", clientActionId: "g9" }), /已经处理过|已过期/);
  await host.close();
});

test("F10 半开探测恢复后,被暂停、没有别的消息叫醒的成员也接着处理(两个私聊共用同一上游)", async () => {
  let down: Error | null = new Error("API Error: 502 Bad Gateway");
  const g = groupMind(() => down);
  const host = mk(Host, { mind: g.factory, breaker: { memberThreshold: 2, cooldownMs: 60 } });
  const a = host.createContact({ name: "A" });
  const b = host.createContact({ name: "B" });
  const dmA = host.openDm(a.id).id;
  const dmB = host.openDm(b.id).id;
  host.send({ roomId: dmA, clientActionId: "a1", text: "在吗" });
  host.send({ roomId: dmB, clientActionId: "b1", text: "在吗" });
  await until(() => failureCards(host, dmA).length + failureCards(host, dmB).length === 1, "1 张群级卡");
  down = null;
  await until(() => texts(host, dmA).includes("contact:A 收到") && texts(host, dmB).includes("contact:B 收到"), "两位都接着处理");
  await host.idle();
  assert.equal(failureCards(host, dmA).length + failureCards(host, dmB).length, 1, "恢复过程中没有再出卡");
  await host.close();
});

test("A27-05 [跳过本轮]只跳过失败批次:失败期间新到的 m_new 不被吞掉,下一轮正常处理", async () => {
  const f = flakyMind((n) => (n === 1 ? new Error("cyber_policy: flagged by safeguards") : null));
  const host = mk(Host, { mind: () => f.mind });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  const m1 = host.send({ roomId: dm, clientActionId: "u1", text: "帮我看看这个报错" });
  await until(() => failureCards(host, dm).length === 1, "失败卡");
  const mNew = host.send({ roomId: dm, clientActionId: "u2", text: "对了,顺便看一下日志" });
  await sleep(60);
  assert.equal(f.calls(), 1, "出卡后停在原位:新消息不触发自动重试,也不被接走");
  const card = failureCards(host, dm)[0]!;
  assert.match(card.card!.body, /^这类错误自动重试也不会好,没有自动重试。/);
  host.cardAct({ roomId: dm, seq: card.seq, cardId: card.card!.cardId, actionId: "skip", clientActionId: "k1" });
  await until(() => f.calls() === 2, "下一轮");
  await host.idle();
  const seqs = f.seen[1]!.fresh.flatMap((x) => (x.kind === "message" ? [x.seq] : []));
  assert.ok(seqs.includes(mNew.seq), "m_new 在下一轮正常处理");
  assert.ok(!seqs.includes(m1.seq), "失败批次被跳过");
  assert.equal(texts(host, dm).at(-1), "contact:收到 2 条", "m_new 与「跳过本轮」那条决定一起处理");
  assert.equal(failureCards(host, dm)[0]!.card!.state, "done");
  await host.close();
});

test("A27-05 [重试本轮]连同失败期间新到的消息一起重跑;再失败出新卡,点旧卡被拒;连点只生效一次", async () => {
  const f = flakyMind((n) => (n <= 2 ? new Error("cyber_policy: flagged by safeguards") : null));
  const host = mk(Host, { mind: () => f.mind });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  const m1 = host.send({ roomId: dm, clientActionId: "u1", text: "第一件事" });
  await until(() => failureCards(host, dm).length === 1, "第 1 张卡");
  const mNew = host.send({ roomId: dm, clientActionId: "u2", text: "第二件事" });
  const card1 = failureCards(host, dm)[0]!;
  host.cardAct({ roomId: dm, seq: card1.seq, cardId: card1.card!.cardId, actionId: "retry", clientActionId: "r1" });
  await until(() => failureCards(host, dm).length === 2, "再失败出第 2 张卡");
  assert.throws(() => host.cardAct({ roomId: dm, seq: card1.seq, cardId: card1.card!.cardId, actionId: "retry", clientActionId: "r2" }), /已经处理过|已过期/);
  const card2 = failureCards(host, dm)[1]!;
  host.cardAct({ roomId: dm, seq: card2.seq, cardId: card2.card!.cardId, actionId: "retry", clientActionId: "r3" });
  assert.throws(() => host.cardAct({ roomId: dm, seq: card2.seq, cardId: card2.card!.cardId, actionId: "retry", clientActionId: "r4" }), /已经处理过/);
  await until(() => f.calls() === 3, "第 3 次");
  await host.idle();
  const seqs = f.seen[2]!.fresh.flatMap((x) => (x.kind === "message" ? [x.seq] : []));
  assert.ok(seqs.includes(m1.seq) && seqs.includes(mNew.seq), "重试本轮带上失败批次和失败期间的新消息");
  assert.equal(texts(host, dm).filter((t) => t.startsWith("contact:收到")).length, 1, "只回复 1 次");
  await host.close();
});

test("[换模型重试]只有用户显式选了才换:这一批用选中的模型重跑,之后的新消息仍用原模型;清单外的模型被拒", async () => {
  const f = flakyMind((n) => (n === 1 ? new Error("cyber_policy: flagged by safeguards") : null));
  const host = mk(Host, { mind: () => f.mind });
  host.updateSettings({ models: MODELS });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  host.send({ roomId: dm, clientActionId: "u1", text: "你好" });
  await until(() => failureCards(host, dm).length === 1, "失败卡");
  const card = failureCards(host, dm)[0]!;
  assert.throws(() => host.cardAct({ roomId: dm, seq: card.seq, cardId: card.card!.cardId, actionId: "switch-model:not-listed", clientActionId: "x" }), /卡片没有动作/);
  host.cardAct({ roomId: dm, seq: card.seq, cardId: card.card!.cardId, actionId: "switch-model:gpt-5", clientActionId: "s1" });
  await until(() => f.calls() === 2, "换模重跑");
  await host.idle();
  host.send({ roomId: dm, clientActionId: "u2", text: "再问一句" });
  await until(() => f.calls() === 3, "下一轮");
  await host.idle();
  assert.deepEqual(f.seen.map((i) => i.contact.speakingModel), ["claude-sonnet-4-6", "gpt-5", "claude-sonnet-4-6"]);
  assert.equal(host.contactDoc(c.id).value.speakingModel, "claude-sonnet-4-6", "联系人的配置没被改");
  await host.close();
});

test("F5 失败期间用户发新消息:退避等待中来的新消息提前触发重跑,两条一起处理,不丢不重", async () => {
  const f = flakyMind((n) => (n === 1 ? new Error("API Error: 502 Bad Gateway") : null));
  const host = mk(Host, { mind: () => f.mind, retry: { baseDelayMs: 10000, maxDelayMs: 10000, jitter: 0, maxAutoRetries: 2 } });
  const ev = retryEvents(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  host.send({ roomId: dm, clientActionId: "u1", text: "第一句" });
  await until(() => ev.includes("retrying:1/2"), "进入退避");
  host.send({ roomId: dm, clientActionId: "u2", text: "第二句" });
  await until(() => texts(host, dm).length === 3, "回复");
  await host.idle();
  assert.equal(f.calls(), 2);
  assert.deepEqual(texts(host, dm), ["user:第一句", "user:第二句", "contact:收到 2 条"]);
  await host.close();
});

test("F4 执行中途杀宿主再重启:未提交轮次自动重跑,已入库的 action_id 不重复出现;已提交的不再重跑", async () => {
  const f = file();
  let h1Calls = 0;
  const h1 = mk(Host, { mind: () => ({ round: async (_i, signal) => { h1Calls++; return hangUntilAbort(signal); } }) }, f);
  const c = h1.createContact({ name: "小克" });
  const dm = h1.openDm(c.id).id;
  h1.send({ roomId: dm, clientActionId: "p1", text: "你好" });
  await until(() => h1Calls === 1, "宿主 1 在处理");
  // 宿主 1 中途退出(不再理会它),宿主 2 在同一份数据上启动
  const f2 = flakyMind(() => null);
  const h2 = mk(Host, { mind: () => f2.mind }, f);
  await until(() => texts(h2, dm).length === 2, "重启后自动重跑");
  await h2.idle();
  assert.deepEqual(texts(h2, dm), ["user:你好", "contact:收到 1 条"]);
  await h2.close();
  const f3 = flakyMind(() => null);
  const h3 = mk(Host, { mind: () => f3.mind }, f);
  await sleep(40);
  await h3.idle();
  assert.equal(f3.calls(), 0, "已提交的轮次不再重跑");
  assert.deepEqual(texts(h3, dm), ["user:你好", "contact:收到 1 条"], "没有重复消息");
  await h3.close();
  await h1.close();
});

test("F12 同一毒丸输入让宿主连续退出:第 1 次重启自动续跑,第 2 次熔断 CrashLoopBlocked 出卡;新成功轮次清零计数", async () => {
  const f = file();
  const n = { h1: 0, h2: 0, h3: 0, h4: 0 };
  let healthy = false;
  const hang = (k: keyof typeof n): ContactMind => ({
    round: async (i, signal) => {
      n[k]++;
      if (k === "h3" && healthy) return { actions: [{ kind: "reply", roomId: i.fresh[0]!.roomId, text: `收到 ${userMsgs(i).length} 条`, replyToSeq: null }], stateNote: null };
      return hangUntilAbort(signal);
    },
  });
  const h1 = mk(Host, { mind: () => hang("h1") }, f);
  const c = h1.createContact({ name: "小克" });
  const dm = h1.openDm(c.id).id;
  h1.send({ roomId: dm, clientActionId: "p1", text: "毒丸" });
  await until(() => n.h1 === 1, "宿主 1 在处理");
  const h2 = mk(Host, { mind: () => hang("h2") }, f);
  await until(() => n.h2 === 1, "第 1 次启动回收:自动续跑");
  const h3 = mk(Host, { mind: () => hang("h3") }, f);
  await sleep(60);
  assert.equal(n.h3, 0, "第 2 次:熔断,不再自启续跑");
  const cards = failureCards(h3, dm);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.card!.title, "小克 这一轮没回成:处理这批消息时宿主连续退出");
  assert.match(cards[0]!.card!.body, /crash_recovery_count=2/);
  healthy = true;
  h3.cardAct({ roomId: dm, seq: cards[0]!.seq, cardId: cards[0]!.card!.cardId, actionId: "retry", clientActionId: "p2" });
  await until(() => texts(h3, dm).includes("contact:收到 2 条"), "用户点重试后正常处理");
  await h3.idle();
  // 成功轮次清掉在途标记与计数:没有新输入时再重启,不会把已提交的那一批当成又一次崩溃
  const h4 = mk(Host, { mind: () => hang("h4") }, f);
  await sleep(40);
  assert.equal(n.h4, 0);
  assert.equal(failureCards(h4, dm).length, 1, "没有再出崩溃循环卡");
  // 换一批输入再让宿主退出,重启后仍算第 1 次(自动续跑)
  healthy = false;
  h3.send({ roomId: dm, clientActionId: "p3", text: "毒丸 2" });
  await until(() => n.h3 === 2, "宿主 3 在处理新输入");
  const h5 = mk(Host, { mind: () => hang("h4") }, f);
  await until(() => n.h4 === 1, "计数清零后又是第 1 次:自动续跑");
  assert.equal(failureCards(h5, dm).length, 1, "没有再出崩溃循环卡");
  for (const h of [h5, h4, h3, h2, h1]) await h.close();
});

// ======================= Compute =======================
/** 不带 computeId 的语义事件(按种类分别去掉,保留各自字段)。 */
type Ev = ComputeEvent extends infer E ? (E extends unknown ? Omit<E, "computeId"> : never) : never;
const CRASH_SCRIPT = {
  script: (): Ev[] => [
    { kind: "started", sessionId: "s1", resumed: false },
    { kind: "milestone", stage: "写文件", summary: "写了一半" },
    { kind: "failed", reason: "进程以 1 退出:error_during_execution", code: 1, signal: null, violations: [] },
  ],
  resumeScript: (): Ev[] => [
    { kind: "started", sessionId: "s1", resumed: true },
    { kind: "milestone", stage: "写文件", summary: "写完了" },
    { kind: "completed", result: "hello.txt 写好了" },
  ],
};
const crashThenFinish = () => fake(CRASH_SCRIPT);

test("Compute 执行器中途崩溃(可自愈):对同一实例 resume 续跑(同一 CLI 会话),不从头 spawn,任务不进 T11,不打断联系人", async () => {
  const compute = crashThenFinish();
  const host = mk(Host, { mind: () => scriptedMind(), compute: () => compute.adapter });
  const ev = retryEvents(host, "task");
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  host.send({ roomId: dm, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await until(() => host.listTasks({})[0]?.state === "T5_InReview", "续跑后交付");
  await host.idle();
  assert.equal(compute.spawned.length, 1, "没有从头 spawn");
  assert.equal(compute.resumed.length, 1);
  assert.equal(compute.resumed[0]!.computeId, compute.spawned[0]!.computeId, "续的是同一个实例");
  assert.equal(compute.turns[0]!.turn?.model, "claude-sonnet-4-6", "续跑这一轮照样把生效模型交给适配器,自动续跑不换模型");
  assert.match(compute.resumed[0]!.text, /第 1 次自动续跑/);
  assert.match(compute.resumed[0]!.text, /已经确认做完的步骤不要重做/);
  assert.equal(failureCards(host, dm).length, 0);
  assert.ok(!texts(host, dm).some((t) => t.includes("任务没做成")), "静默续跑期间不打断联系人");
  assert.deepEqual(ev, ["retrying:1/2", "cleared:0/0"]);
  compute.close();
  await host.close();
});

test("窗口 ② 对账(A27-03 底座):续跑提示带上工作区 git status,已写入的文件不让模型再追加一遍", async () => {
  const ws = mkdtempSync(path.join(dir, "ws-"));
  // 剥掉 GIT_* 环境:在 git 钩子里跑测试时 GIT_DIR 指向本仓库,不剥会把 init 落到本仓库上
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  execFileSync("git", ["init", "-q", ws], { env });
  writeFileSync(path.join(ws, "hello.txt"), "NEUTRAL_FIXTURE\n");
  const compute = crashThenFinish();
  const host = mk(Host, { mind: () => scriptedMind(), compute: () => compute.adapter, computeCwd: () => ws });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  host.send({ roomId: dm, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await until(() => compute.resumed.length === 1, "续跑");
  assert.match(compute.resumed[0]!.text, /工作区现状\(git status,共 1 项\):\n\?\? hello\.txt/);
  assert.match(compute.resumed[0]!.text, /已经写进去的改动不要再追加一遍/);
  await until(() => host.listTasks({})[0]?.state === "T5_InReview", "交付");
  assert.equal(failureCards(host, dm).length, 0, "续跑成功,没有出卡");
  compute.close();
  await host.close();
});

test("F3 统一重试权:Compute 的 CLI 已按 CLAUDE_CODE_MAX_RETRIES 重试过上游错误,宿主不再叠加续跑,直接出 1 张卡", async () => {
  const compute = fake({
    script: () => [{ kind: "started", sessionId: "s1", resumed: false }, { kind: "failed", reason: "API Error: 502 Bad Gateway", code: 1, signal: null, violations: [] }],
  });
  const host = mk(Host, { mind: () => scriptedMind(), compute: () => compute.adapter, computeHarnessRetries: 2 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  host.send({ roomId: dm, clientActionId: "u1", text: "帮我跑一下测试" });
  await until(() => failureCards(host, dm).length === 1, "失败卡");
  await sleep(60);
  assert.equal(compute.resumed.length, 0, "宿主 0 次续跑");
  const card = failureCards(host, dm)[0]!.card!;
  assert.equal(card.title, "任务「跑一下测试」执行中断:上游不可用");
  assert.match(card.body, /^已自动重试 2 次仍然失败。/);
  assert.deepEqual(card.actions.map((a) => a.actionId), ["retry", "give-up"]);
  assert.equal(host.listTasks({})[0]?.state, "T3_Running", "出卡时任务还没判失败,等用户选");
  compute.close();
  await host.close();
});

test("F3 被信号结束的执行器崩溃(不是 CLI 里的上游错误)不算 CLI 重试过:宿主照常在同一会话续跑", async () => {
  const compute = fake({
    script: () => [
      { kind: "started", sessionId: "s1", resumed: false },
      { kind: "milestone", stage: "写文件", summary: "写了一半" },
      { kind: "failed", reason: "进程被信号 SIGKILL 结束", code: null, signal: "SIGKILL", violations: [] },
    ],
    resumeScript: () => [{ kind: "completed", result: "写完了" }],
  });
  const host = mk(Host, { mind: () => scriptedMind(), compute: () => compute.adapter, computeHarnessRetries: 2 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  host.send({ roomId: dm, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await until(() => host.listTasks({})[0]?.state === "T5_InReview", "续跑后交付");
  assert.equal(compute.resumed.length, 1);
  assert.equal(failureCards(host, dm).length, 0);
  compute.close();
  await host.close();
});

test("Compute 永久故障(平台拒绝):0 次自动续跑、原位出卡;[重试]走同一会话 resume,再失败出新卡;[不重试了]才进 T11 并告诉联系人", async () => {
  const compute = fake({
    script: () => [{ kind: "started", sessionId: "s1", resumed: false }, { kind: "failed", reason: "cyber_policy: flagged by safeguards", code: 1, signal: null, violations: [] }],
    resumeScript: () => [{ kind: "failed", reason: "cyber_policy: flagged by safeguards", code: 1, signal: null, violations: [] }],
  });
  const host = mk(Host, { mind: () => scriptedMind(), compute: () => compute.adapter });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  host.send({ roomId: dm, clientActionId: "u1", text: "帮我查一下漏洞" });
  await until(() => failureCards(host, dm).length === 1, "第 1 张卡");
  await sleep(40);
  assert.equal(compute.resumed.length, 0, "0 次自动续跑");
  const card1 = failureCards(host, dm)[0]!;
  host.cardAct({ roomId: dm, seq: card1.seq, cardId: card1.card!.cardId, actionId: "retry", clientActionId: "r1" });
  await until(() => failureCards(host, dm).length === 2, "再失败出第 2 张卡");
  assert.deepEqual(compute.resumed.map((r) => r.computeId), [compute.spawned[0]!.computeId]);
  assert.match(compute.resumed[0]!.text, /^用户点了重试/);
  assert.throws(() => host.cardAct({ roomId: dm, seq: card1.seq, cardId: card1.card!.cardId, actionId: "give-up", clientActionId: "r2" }), /已经处理过|已过期/);
  const card2 = failureCards(host, dm)[1]!;
  host.cardAct({ roomId: dm, seq: card2.seq, cardId: card2.card!.cardId, actionId: "give-up", clientActionId: "r3" });
  await until(() => host.listTasks({})[0]?.state === "T11_Failed", "任务记失败");
  await until(() => texts(host, dm).some((t) => t.startsWith("contact:任务没做成:失败:平台拒绝")), "联系人如实告诉用户");
  assert.equal(compute.spawned.length, 1);
  compute.close();
  await host.close();
});

test("F13 半途换模:[换模型重试]选了厂商 B 才换,累积生产集合变成 {A, B},T5 审查同时拒绝 A、B 与 unknown,只放第三家", async () => {
  const compute = fake({
    script: () => [
      { kind: "started", sessionId: "s1", resumed: false },
      { kind: "milestone", stage: "分析", summary: "做了一半" },
      { kind: "failed", reason: "cyber_policy: flagged by safeguards", code: 1, signal: null, violations: [] },
    ],
    resumeScript: () => [{ kind: "completed", result: "做完了" }],
  });
  const host = mk(Host, { mind: () => scriptedMind(), compute: () => compute.adapter });
  host.updateSettings({ models: MODELS });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  host.send({ roomId: dm, clientActionId: "u1", text: "帮我做个分析" });
  await until(() => failureCards(host, dm).length === 1, "失败卡");
  const card = failureCards(host, dm)[0]!;
  assert.deepEqual(card.card!.actions.map((a) => a.actionId), ["retry", "give-up", "switch-model:gpt-5"]);
  host.cardAct({ roomId: dm, seq: card.seq, cardId: card.card!.cardId, actionId: "switch-model:gpt-5", clientActionId: "s1" });
  await until(() => host.listTasks({})[0]?.state === "T5_InReview", "换模后交付");
  assert.match(compute.resumed[0]!.text, /^用户选了换成 gpt-5 重试这一轮/);
  assert.equal(compute.turns[0]!.turn?.model, "gpt-5", "这一轮把用户选的模型交给适配器,在同一会话里换");
  const task = host.taskDoc(host.listTasks({})[0]!.id).value.task;
  assert.deepEqual([...task.producerModels], ["claude-sonnet-4-6", "gpt-5"]);
  const review = (reviewerModel: string): TaskEvent => ({ kind: "Review", reviewerId: "审查人", reviewerModel, round: task.reviewRound, commit: task.reviewedCommit!, constraintVer: task.constraintVer, verdict: "approve" });
  assert.equal(applyTask(task, review("claude-opus-4-1")).ok, false, "A(anthropic)被拒");
  assert.equal(applyTask(task, review("gpt-5.1")).ok, false, "B(openai)被拒");
  assert.equal(applyTask(task, review("mystery-model-x")).ok, false, "unknown 被拒");
  const third = applyTask(task, review("gemini-2.5-pro"));
  assert.ok(third.ok && third.task.reviewGate === "compliant", "第三家厂商放行");
  compute.close();
  await host.close();
});

test("F7 用户主动停止不是失败:Compute 失败后等续跑期间用户停掉任务,不再续跑、不出失败卡,任务落 T10 而不是 T11", async () => {
  // 与真实适配器一样:这一轮已经失败退出的实例,stop 会被拒(没有在运行的进程),不会再报「已停止」
  const compute = fake({ ...CRASH_SCRIPT, refuseStopAfterExit: true });
  const host = mk(Host, { mind: () => scriptedMind(), compute: () => compute.adapter, retry: { baseDelayMs: 10000, maxDelayMs: 10000, jitter: 0, maxAutoRetries: 2 } });
  const ev = retryEvents(host, "task");
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  host.send({ roomId: dm, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await until(() => ev.includes("retrying:1/2"), "等续跑");
  const t = host.listTasks({})[0]!;
  host.stopTask(t.id, "me");
  await sleep(60);
  await host.idle();
  assert.equal(host.listTasks({})[0]?.state, "T10_Cancelled");
  assert.equal(compute.resumed.length, 0, "不再续跑");
  assert.equal(failureCards(host, dm).length, 0, "不出失败卡");
  compute.close();
  await host.close();
});

test("F7 原位失败卡开着时用户停掉任务:卡作废不能再点,在途失败清掉,任务落 T10;之后不续跑、不再出卡", async () => {
  const compute = fake({ ...CRASH_SCRIPT, refuseStopAfterExit: true });
  const host = mk(Host, { mind: () => scriptedMind(), compute: () => compute.adapter, retry: { baseDelayMs: 5, maxDelayMs: 5, jitter: 0, maxAutoRetries: 0 } });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  host.send({ roomId: dm, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await until(() => failureCards(host, dm).length === 1, "自动重试取 0 次,失败当场出原位卡");
  const card = failureCards(host, dm)[0]!;
  assert.equal(card.card!.state, "open");
  const t = host.listTasks({})[0]!;
  host.stopTask(t.id, "me");
  await sleep(60);
  await host.idle();
  assert.equal(host.listTasks({})[0]?.state, "T10_Cancelled");
  assert.equal(failureCards(host, dm)[0]!.card!.state, "expired", "停掉任务后失败卡作废");
  assert.throws(() => host.cardAct({ roomId: dm, seq: card.seq, cardId: card.card!.cardId, actionId: "retry", clientActionId: "late" }), /已经处理过|已过期/);
  assert.equal(compute.resumed.length, 0, "点不了重试,也不续跑");
  assert.equal(failureCards(host, dm).length, 1, "不再出新卡");
});

test("F6 Compute 终态通知丢失(ack 前宿主退出):重启后从磁盘待领取表补领结果交给联系人,不重跑 Compute,不需要人类再发言", async () => {
  const f = file();
  const compute1 = fake();
  const base = scriptedMind();
  let hung = 0;
  const h1 = mk(Host, {
    mind: () => ({
      round: async (i, signal) => {
        if (i.fresh.some((x) => x.kind === "compute" && x.signal === "completed")) {
          hung++;
          return hangUntilAbort(signal);
        }
        return base.round(i, signal);
      },
    }),
    compute: () => compute1.adapter,
  }, f);
  const c = h1.createContact({ name: "小克" });
  const dm = h1.openDm(c.id).id;
  h1.send({ roomId: dm, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await until(() => hung === 1, "终态到了,宿主 1 还没领走就退出");
  const compute2 = fake();
  const h2 = mk(Host, { mind: () => scriptedMind(), compute: () => compute2.adapter }, f);
  await until(() => h2.listTasks({})[0]?.state === "T5_InReview", "重启后补领并交付");
  await h2.idle();
  assert.equal(compute1.spawned.length, 1);
  assert.equal(compute2.spawned.length, 0, "没有重跑 Compute");
  assert.equal(failureCards(h2, dm).length, 0);
  assert.equal(texts(h2, dm).filter((t) => t.startsWith("contact:做完了")).length, 1, "只交付 1 次");
  compute2.close();
  compute1.close();
  await h2.close();
  await h1.close();
});

test("F9 副作用不明(unknown 且已有进展,UnknownEffect→B2):0 次自动续跑,出卡写明为免重复没有自动重发", async () => {
  const compute = fake({
    script: () => [
      { kind: "started", sessionId: "s1", resumed: false },
      { kind: "milestone", stage: "发通知", summary: "正在发" },
      { kind: "failed", reason: "奇怪的状况 xyz-42", code: 1, signal: null, violations: [] },
    ],
  });
  const host = mk(Host, { mind: () => scriptedMind(), compute: () => compute.adapter });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id).id;
  host.send({ roomId: dm, clientActionId: "u1", text: "帮我发个通知" });
  await until(() => failureCards(host, dm).length === 1, "失败卡");
  await sleep(40);
  assert.equal(compute.resumed.length, 0);
  assert.match(failureCards(host, dm)[0]!.card!.body, /^不确定这一轮已经做了哪些外部动作,为免重复,没有自动重发。/);
  compute.close();
  await host.close();
});
