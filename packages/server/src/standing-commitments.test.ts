// 联系人自设定时与常驻承诺(U20「联系人可设自己的定时唤醒,群聊私聊都支持」、U80「每 N 条消息」触发、D04.2-1 常驻承诺、
// AC-35① 控制指令生效、AC-20 外部材料与转发不产生授权;D02 窄接口的工具形态是候选)。
// 联系人只能经 schedule-set / schedule-pause / schedule-remove 动作管「自己在本会话」的定时,依据是本轮里用户本人的直接消息;
// 联系人设的定时同时是承诺账本里的一条常驻承诺,两边互相引用,撤销/删除时一起停。运行记录等这一轮联系人结束才写结果。
// 测试用脚本脑子直接给出动作(不连模型);到点相关的用例注入时钟与计时器。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { InboundMessage, InboundSchedule, MindAction, RoundInput, RoundTools, TimerApi } from "@g-group/kernel";
import { Host, type HostOptions } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-standing-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `s${++n}.db`);
const opened: Host[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

type Brain = (input: RoundInput) => MindAction[];
/** 宿主 + 每位联系人一个可替换的脚本脑子;记下每轮输入、本轮查询口与宿主的报告(被拒动作的原因在 action-rejected 里)。被测类显式传入 */
function rig(H: typeof Host, extra: Partial<HostOptions> = {}) {
  const brains = new Map<string, Brain>();
  const seen = new Map<string, RoundInput[]>();
  const tools = new Map<string, RoundTools | undefined>();
  const reports: { what: string; detail: unknown }[] = [];
  const host = new H({
    file: file(),
    maxDeferMs: 5,
    onReport: (what, detail) => reports.push({ what, detail }),
    mind: (c) => ({
      async round(input, _signal, t) {
        seen.set(c.id, [...(seen.get(c.id) ?? []), input]);
        tools.set(c.id, t);
        return { actions: (brains.get(c.id) ?? (() => []))(input), stateNote: null };
      },
    }),
    ...extra,
  });
  opened.push(host);
  const rejected = () => reports.filter((r) => r.what === "action-rejected").map((r) => r.detail as { contactId: string; action: MindAction; reason: string });
  return { host, brains, seen, tools, rejected, svc: createService(host) };
}
const msgs = (i: RoundInput) => i.fresh.filter((f): f is InboundMessage => f.kind === "message");
const wakes = (rounds: readonly RoundInput[] | undefined) => (rounds ?? []).flatMap((i) => i.fresh.filter((f): f is InboundSchedule => f.kind === "schedule"));
const at = (k: { id: string }) => [{ id: k.id, source: "manual" as const }];
const block = (i: RoundInput, no: 1 | 2 | 5) => i.request.blocks.find((b) => b.block === no)!.text;
/** 第 5 块里列给联系人的自己的定时 id(sch-… / trg-…) */
const idsIn = (i: RoundInput) => [...new Set([...block(i, 5).matchAll(/\b((?:sch|trg)-[A-Za-z0-9]+-[A-Za-z0-9]+)/g)].map((m) => m[1]!))];
const cron = (m: InboundMessage, c: string, tz: string | null, text: string, scheduleId: string | null = null): MindAction => ({ kind: "schedule-set", roomId: m.roomId, sourceSeq: m.seq, text, trigger: { kind: "cron", cron: c, tz }, scheduleId });

/** 注入的时钟与计时器:advanceTo 依次触发到期的计时器(定时、台账核对),每次之后等宿主空闲 */
function clock(startIso: string) {
  let now = Date.parse(startIso);
  const pending = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const timers: TimerApi = {
    set(fn, ms) {
      pending.set(++id, { at: now + ms, fn });
      return id;
    },
    clear(h) {
      pending.delete(h as number);
    },
  };
  const advanceTo = async (iso: string, host: Host) => {
    const target = Date.parse(iso);
    for (;;) {
      const due = [...pending].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = Math.max(now, due[1].at);
      pending.delete(due[0]);
      due[1].fn();
      await host.idle();
    }
    now = target;
    await host.idle();
  };
  return { timers, clockMs: () => now, advanceTo, step: (host: Host, ms = 1000) => advanceTo(new Date(now + ms).toISOString(), host) };
}

test("联系人 schedule-set:用户本人在群里 @ 它要每天 8 点总结 → 建出归它、只在本会话的定时;没给时区按用户设置的时区补成显式时区;同时登记一条常驻承诺,两边互相引用,下一轮账本与第 5 块看得到", async () => {
  const { host, brains, seen, tools } = rig(Host);
  host.updateSettings({ timezone: "Europe/Berlin" });
  const k = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: k.id }]);
  brains.set(k.id, (i) =>
    msgs(i).flatMap((m): MindAction[] => {
      if (m.text.includes("每天早上 8 点")) return [cron(m, "0 8 * * *", null, "把群里前一天的讨论总结发群里")];
      if (m.text.includes("纽约时间")) return [cron(m, "0 9 * * 1", "America/New_York", "提醒周会")];
      return [];
    }),
  );
  const src = host.send({ roomId: g.id, clientActionId: "u1", text: "@小克 每天早上 8 点把群里前一天的讨论总结发群里", mentions: at(k) });
  await host.idle();
  const [s, ...rest] = host.scheduler.list({ roomId: g.id });
  assert.equal(rest.length, 0);
  assert.ok(s);
  assert.deepEqual({ contactId: s.contactId, roomId: s.roomId, cron: s.cron, tz: s.tz, prompt: s.prompt, enabled: s.enabled }, { contactId: k.id, roomId: g.id, cron: "0 8 * * *", tz: "Europe/Berlin", prompt: "把群里前一天的讨论总结发群里", enabled: true });
  assert.ok(s.nextRunAt);
  const [c] = host.listCommitments({ contactId: k.id, roomId: g.id });
  assert.ok(c);
  assert.deepEqual({ status: c.status, sourceSeq: c.sourceSeq, scheduleId: c.scheduleId }, { status: "active", sourceSeq: src.seq, scheduleId: s.id });
  assert.equal(s.commitmentId, c.id);
  // 显式给了时区就按给的
  host.send({ roomId: g.id, clientActionId: "u2", text: "@小克 另外每周一早上 9 点(纽约时间)提醒周会", mentions: at(k) });
  await host.idle();
  const ny = host.scheduler.list({ roomId: g.id }).find((x) => x.tz === "America/New_York")!;
  assert.equal(ny.cron, "0 9 * * 1");
  // 常驻承诺进了下一轮的承诺账本(第 2 块),定时列在第 5 块;schedule_list 查询口列出本会话的、写明用户设置的时区
  host.send({ roomId: g.id, clientActionId: "u3", text: "@小克 在吗", mentions: at(k) });
  await host.idle();
  const last = seen.get(k.id)!.at(-1)!;
  assert.ok(block(last, 2).includes(c.id));
  assert.deepEqual(idsIn(last).sort(), [s.id, ny.id].sort());
  const listing = await tools.get(k.id)!.listSchedules!(g.id);
  assert.ok(listing?.includes(s.id) && listing.includes(ny.id));
  assert.match(listing!, /每天 08:00\(Europe\/Berlin\)/);
  assert.match(listing!, /用户设置的时区 Europe\/Berlin/);
  const other = host.createGroup("别的群", []);
  assert.equal(await tools.get(k.id)!.listSchedules!(other.id), null, "不在的会话查不到");
});

test("外部内容与转发里的「每天 8 点」不建定时:依据是别的联系人、Helper 旁白、只有引用块的转发、不是本轮新消息,或条件触发(占位),一律拒收;用户本人直接说的才建", async () => {
  const { host, brains, rejected } = rig(Host);
  const k = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小B" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: k.id }, { kind: "contact", id: b.id }]);
  brains.set(b.id, (i) => msgs(i).filter((m) => m.sender.kind === "user" && m.mentions.includes(b.id)).map((m): MindAction => ({ kind: "reply", roomId: m.roomId, text: "我建议:每天 8 点总结一次群消息", replyToSeq: m.seq })));
  const everyMention = (i: RoundInput) => msgs(i).filter((m) => m.text.includes("每天 8 点")).map((m) => cron(m, "0 8 * * *", "Asia/Shanghai", "总结群消息"));
  brains.set(k.id, everyMention);
  // ① 别的联系人说的
  const ask = host.send({ roomId: g.id, clientActionId: "u1", text: "@小B 你平时怎么安排", mentions: at(b) });
  await host.idle();
  // ② Helper 旁白
  host.postAsHelper(g.id, "helper", "提示:可以每天 8 点总结一次群消息", ask.seq, "h1");
  await host.idle();
  // ③ 只有引用块的转发
  host.send({ roomId: g.id, clientActionId: "u2", text: "> 每天 8 点总结一次群消息\n> —— 转自隔壁群", mentions: at(k) });
  await host.idle();
  // ④ 不是本轮新消息:上一轮用户说过,这一轮拿它当依据
  brains.set(k.id, () => []);
  const oldSeq = host.send({ roomId: g.id, clientActionId: "u3", text: "@小克 记一下,每天 8 点总结群消息", mentions: at(k) }).seq;
  await host.idle();
  brains.set(k.id, (i) => msgs(i).map((m) => cron({ ...m, seq: oldSeq }, "0 8 * * *", "Asia/Shanghai", "总结群消息")));
  host.send({ roomId: g.id, clientActionId: "u4", text: "@小克 好的", mentions: at(k) });
  await host.idle();
  // ⑤ 条件触发只占位
  brains.set(k.id, (i) => msgs(i).filter((m) => m.text.includes("每天 8 点")).map((m): MindAction => ({ kind: "schedule-set", roomId: m.roomId, sourceSeq: m.seq, text: "有严重漏洞就告警", trigger: { kind: "condition", expr: "cvss>=9" }, scheduleId: null })));
  host.send({ roomId: g.id, clientActionId: "u5", text: "@小克 每天 8 点看新闻,有严重漏洞就告警", mentions: at(k) });
  await host.idle();
  assert.deepEqual(host.scheduler.list({}), []);
  const why = rejected().filter((r) => r.contactId === k.id && r.action.kind === "schedule-set").map((r) => r.reason);
  assert.equal(why.length, 5, why.join(" | "));
  assert.match(why[0]!, /不是用户本人/);
  assert.match(why[1]!, /不是用户本人/);
  assert.match(why[2]!, /只有引用/);
  assert.match(why[3]!, /不是本轮新消息/);
  assert.match(why[4]!, /条件触发/);
  // 对照:用户本人直接说的才建,且只建这一条
  brains.set(k.id, everyMention);
  const ok = host.send({ roomId: g.id, clientActionId: "u6", text: "@小克 那就每天 8 点总结群消息吧", mentions: at(k) });
  await host.idle();
  const list = host.scheduler.list({});
  assert.equal(list.length, 1);
  assert.equal(host.listCommitments({ contactId: k.id }).find((x) => x.scheduleId === list[0]!.id)?.sourceSeq, ok.seq);
});

test("控制指令生效:改成 9 点、停掉、恢复、删除都落到定时上(停掉后到点不触发);删除后常驻承诺一起了结,再动已删的定时被拒", async () => {
  const c = clock("2026-11-09T07:00:00+08:00");
  const { host, brains, seen, rejected } = rig(Host, { timers: c.timers, clockMs: c.clockMs });
  const k = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: k.id }]);
  let stale = "";
  brains.set(k.id, (i) =>
    msgs(i).flatMap((m): MindAction[] => {
      const id = idsIn(i)[0] ?? "";
      if (m.text.includes("每天早上 8 点")) return [cron(m, "0 8 * * *", "Asia/Shanghai", "总结群消息")];
      if (m.text.includes("改成 9 点") || m.text.includes("恢复")) return [cron(m, "0 9 * * *", "Asia/Shanghai", "总结群消息", id)];
      if (m.text.includes("停掉")) return [{ kind: "schedule-pause", roomId: m.roomId, sourceSeq: m.seq, scheduleId: id }];
      if (m.text.includes("删掉")) {
        stale = id;
        return [{ kind: "schedule-remove", roomId: m.roomId, sourceSeq: m.seq, scheduleId: id }];
      }
      if (m.text.includes("再停一次")) return [{ kind: "schedule-pause", roomId: m.roomId, sourceSeq: m.seq, scheduleId: stale }];
      return [];
    }),
  );
  const say = async (cid: string, text: string) => {
    host.send({ roomId: g.id, clientActionId: cid, text: `@小克 ${text}`, mentions: at(k) });
    await c.step(host);
  };
  const only = () => {
    const l = host.scheduler.list({});
    assert.equal(l.length, 1);
    return l[0]!;
  };
  await say("u1", "每天早上 8 点总结群消息");
  const s0 = only();
  assert.equal(s0.nextRunAt, "2026-11-09T00:00:00.000Z");
  await say("u2", "改成 9 点");
  assert.deepEqual({ id: only().id, cron: only().cron, next: only().nextRunAt }, { id: s0.id, cron: "0 9 * * *", next: "2026-11-09T01:00:00.000Z" });
  await c.advanceTo("2026-11-09T08:30:00+08:00", host);
  assert.equal(wakes(seen.get(k.id)).length, 0, "8 点不再触发");
  await say("u3", "停掉");
  assert.deepEqual({ enabled: only().enabled, next: only().nextRunAt }, { enabled: false, next: null });
  await c.advanceTo("2026-11-09T09:30:00+08:00", host);
  assert.equal(wakes(seen.get(k.id)).length, 0, "停掉后 9 点也不触发");
  await say("u4", "恢复");
  assert.deepEqual({ enabled: only().enabled, next: only().nextRunAt }, { enabled: true, next: "2026-11-10T01:00:00.000Z" });
  await c.advanceTo("2026-11-10T09:00:30+08:00", host);
  assert.equal(wakes(seen.get(k.id)).length, 1, "恢复后第二天 9 点触发一次");
  await say("u5", "删掉");
  assert.deepEqual(host.scheduler.list({}), []);
  assert.equal(host.listCommitments({ contactId: k.id })[0]?.status, "revoked");
  await say("u6", "再停一次");
  const last = rejected().filter((r) => r.action.kind === "schedule-pause").at(-1);
  assert.equal(last?.reason, `没有这条定时 ${stale}`);
});

test("不能动别人的定时:别的联系人的定时、自己在别的会话里的定时,设/停/删一律拒收;自己在本会话的照常生效", async () => {
  const { host, brains, rejected } = rig(Host);
  const k = host.createContact({ name: "小克" });
  const a = host.createContact({ name: "小A" });
  const g1 = host.createGroup("一群", [{ kind: "contact", id: k.id }, { kind: "contact", id: a.id }]);
  const g2 = host.createGroup("二群", [{ kind: "contact", id: k.id }]);
  const others = host.scheduler.create({ contactId: a.id, roomId: g1.id, title: "小A 的早报", cron: "0 8 * * *", tz: "UTC", prompt: "早报" });
  let targets: string[] = [];
  brains.set(k.id, (i) =>
    msgs(i).flatMap((m): MindAction[] => {
      if (m.text.includes("二群的早报")) return [cron(m, "0 8 * * *", "UTC", "二群早报")];
      if (!m.text.includes("动一下")) return [];
      return targets.flatMap((id): MindAction[] => [
        { kind: "schedule-pause", roomId: m.roomId, sourceSeq: m.seq, scheduleId: id },
        cron(m, "0 10 * * *", "UTC", "改掉", id),
        { kind: "schedule-remove", roomId: m.roomId, sourceSeq: m.seq, scheduleId: id },
      ]);
    }),
  );
  host.send({ roomId: g2.id, clientActionId: "u1", text: "@小克 二群的早报每天 8 点发", mentions: at(k) });
  await host.idle();
  const mine = host.scheduler.list({ roomId: g2.id })[0]!;
  assert.equal(mine.contactId, k.id);
  targets = [others.id, mine.id];
  host.send({ roomId: g1.id, clientActionId: "u2", text: "@小克 把这些定时动一下", mentions: at(k) });
  await host.idle();
  const why = rejected().filter((r) => r.contactId === k.id).map((r) => `${(r.action as { scheduleId: string }).scheduleId}:${r.reason}`);
  assert.deepEqual(why, [
    `${others.id}:不是你的定时`,
    `${others.id}:不是你的定时`,
    `${others.id}:不是你的定时`,
    `${mine.id}:这条定时不在本会话,只能管本会话里的`,
    `${mine.id}:这条定时不在本会话,只能管本会话里的`,
    `${mine.id}:这条定时不在本会话,只能管本会话里的`,
  ]);
  const after1 = host.scheduler.list({});
  assert.deepEqual(after1.map((s) => [s.id, s.enabled, s.cron]).sort(), [[others.id, true, "0 8 * * *"], [mine.id, true, "0 8 * * *"]].sort());
  // 对照:在二群里停自己的,生效
  brains.set(k.id, (i) => msgs(i).filter((m) => m.text.includes("停掉")).map((m): MindAction => ({ kind: "schedule-pause", roomId: m.roomId, sourceSeq: m.seq, scheduleId: mine.id })));
  host.send({ roomId: g2.id, clientActionId: "u3", text: "@小克 停掉", mentions: at(k) });
  await host.idle();
  assert.equal(host.scheduler.list({ roomId: g2.id })[0]!.enabled, false);
  assert.equal(host.scheduler.list({ roomId: g1.id })[0]!.enabled, true);
});

test("每 N 条消息:第 N 条用户/联系人消息到达时恰好触发一次;宿主生成的卡片与 Helper 旁白不计数;撤销常驻承诺后不再触发", async () => {
  const { host, brains, seen, svc } = rig(Host);
  const k = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: k.id }]);
  brains.set(k.id, (i) => [
    ...msgs(i).filter((m) => m.text.includes("每 3 条")).map((m): MindAction => ({ kind: "schedule-set", roomId: m.roomId, sourceSeq: m.seq, text: "总结这一段", trigger: { kind: "every_n_messages", n: 3 }, scheduleId: null })),
    ...i.fresh.filter((f): f is InboundSchedule => f.kind === "schedule").map((f): MindAction => ({ kind: "reply", roomId: f.roomId, text: "这一段的总结:……", replyToSeq: null })),
  ]);
  const src = host.send({ roomId: g.id, clientActionId: "u0", text: "@小克 每 3 条消息总结一次", mentions: at(k) });
  await host.idle();
  assert.deepEqual(host.scheduler.list({}), [], "每 N 条不是 cron 定时");
  const [c] = host.listCommitments({ contactId: k.id, roomId: g.id });
  assert.equal(c?.sourceSeq, src.seq);
  assert.equal(c?.status, "active");
  const plain = async (cid: string) => {
    host.send({ roomId: g.id, clientActionId: cid, text: `NEUTRAL_FIXTURE 闲聊 ${cid}` });
    await host.idle();
  };
  await plain("m1");
  host.postAsHelper(g.id, "helper", "NEUTRAL_FIXTURE Helper 旁白", src.seq, "h1");
  await host.idle();
  host.createTask({ clientActionId: "t1", roomId: g.id, title: "NEUTRAL_FIXTURE 一张任务卡" });
  await host.idle();
  await plain("m2");
  assert.equal(wakes(seen.get(k.id)).length, 0, "卡片、Helper 旁白不计数:只到第 2 条");
  await plain("m3");
  const w = wakes(seen.get(k.id));
  assert.equal(w.length, 1, "第 3 条到达恰好触发一次");
  assert.equal(w[0]!.roomId, g.id);
  assert.match(w[0]!.prompt, /3 条/);
  assert.match(w[0]!.prompt, /总结这一段/);
  await plain("m4");
  assert.equal(wakes(seen.get(k.id)).length, 1);
  const r = await svc.handle("commitments.revoke", { commitmentId: c!.id, clientActionId: "rv1" });
  assert.ok(r.ok);
  for (const cid of ["m5", "m6", "m7", "m8", "m9"]) await plain(cid);
  assert.equal(wakes(seen.get(k.id)).length, 1, "撤销后不再触发");
});

test("schedules.create 按 clientActionId 幂等:同一请求重投只建一条并返回同一条;同号换了内容被拒", async () => {
  const { host, svc } = rig(Host);
  const k = host.createContact({ name: "小秘" });
  const dm = host.openDm(k.id);
  const req = { clientActionId: "c-1", contactId: k.id, roomId: dm.id, title: "早报", cron: "0 8 * * *", tz: "Asia/Shanghai", prompt: "总结" };
  const a = await svc.handle("schedules.create", req);
  const b = await svc.handle("schedules.create", req);
  assert.ok(a.ok && b.ok);
  assert.equal((b.value as { id: string }).id, (a.value as { id: string }).id);
  assert.equal(host.scheduler.list({}).length, 1);
  const c = await svc.handle("schedules.create", { ...req, cron: "0 9 * * *" });
  assert.equal(!c.ok && c.error.code, "conflict");
  assert.equal(host.scheduler.list({}).length, 1);
  const d = await svc.handle("schedules.create", { ...req, clientActionId: "c-2" });
  assert.ok(d.ok);
  assert.equal(host.scheduler.list({}).length, 2);
});

test("运行记录写实:到点投递时记 running,这一轮结束才记——有发言记 ok 并回填 messageSeq(群聊到点产出)、跑了没发言记 silent、这一轮失败出卡记 failed 带原因", async () => {
  const { host, brains, svc } = rig(Host, { retry: { maxAutoRetries: 0, baseDelayMs: 5, maxDelayMs: 5, jitter: 0 } });
  const k = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: k.id }]);
  brains.set(k.id, (i) =>
    i.fresh.flatMap((f): MindAction[] => {
      if (f.kind !== "schedule") return [];
      if (f.prompt === "会失败") throw new Error("API Error: 502 Bad Gateway");
      return f.prompt === "发早报" ? [{ kind: "reply", roomId: f.roomId, text: "早报:昨天群里讨论了发版时间", replyToSeq: null }] : [];
    }),
  );
  const mk = (title: string, prompt: string) => host.scheduler.create({ contactId: k.id, roomId: g.id, title, cron: "0 8 * * *", tz: "Asia/Shanghai", prompt });
  const okS = mk("早报", "发早报");
  const silentS = mk("看看", "静默");
  const failS = mk("坏的", "会失败");
  const fired = host.scheduler.runNow(okS.id);
  assert.deepEqual(fired.lastRun && { status: fired.lastRun.status, messageSeq: fired.lastRun.messageSeq }, { status: "running", messageSeq: null });
  await host.idle();
  const out = host.listMessages(g.id, {}).messages.find((m) => m.sender.kind === "contact" && m.text.startsWith("早报:"))!;
  assert.ok(out);
  assert.deepEqual(host.scheduler.history(okS.id, 5).map((r) => ({ status: r.status, messageSeq: r.messageSeq })), [{ status: "ok", messageSeq: out.seq }]);
  assert.equal(host.scheduler.list({ roomId: g.id }).find((s) => s.id === okS.id)?.lastRun?.messageSeq, out.seq);
  host.scheduler.runNow(silentS.id);
  await host.idle();
  assert.deepEqual(host.scheduler.history(silentS.id, 5).map((r) => ({ status: r.status, messageSeq: r.messageSeq })), [{ status: "silent", messageSeq: null }]);
  const viaApi = await svc.handle("schedules.history", { scheduleId: silentS.id });
  assert.ok(viaApi.ok);
  assert.equal((viaApi.value as { runs: { status: string }[] }).runs[0]?.status, "silent");
  host.scheduler.runNow(failS.id);
  await host.idle();
  const [bad] = host.scheduler.history(failS.id, 5);
  assert.equal(bad?.status, "failed");
  assert.equal(bad?.messageSeq, null);
  assert.ok(bad?.error && bad.error.length > 0, "失败带原因");
  assert.ok(host.listMessages(g.id, {}).messages.some((m) => m.card?.kind === "failure"));
});

test("唤醒时对齐最新群规:联系人自设的定时到点那一轮,第 1 块是当前生效的群公告;改了公告后下次唤醒读到新版本、不再有旧版本", async () => {
  const c = clock("2026-11-09T07:00:00+08:00");
  const { host, brains, seen } = rig(Host, { timers: c.timers, clockMs: c.clockMs });
  const k = host.createContact({ name: "小秘" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: k.id }]);
  brains.set(k.id, (i) => [
    ...msgs(i).filter((m) => m.text.includes("每天 8 点")).map((m) => cron(m, "0 8 * * *", "Asia/Shanghai", "按群公告的格式发日报")),
    ...i.fresh.filter((f): f is InboundSchedule => f.kind === "schedule").map((f): MindAction => ({ kind: "reply", roomId: f.roomId, text: "日报", replyToSeq: null })),
  ]);
  const ann = host.announcements.add(g.id, "NEUTRAL_FIXTURE 日报格式:三行", "a1");
  host.send({ roomId: g.id, clientActionId: "u1", text: "@小秘 每天 8 点按群公告的格式发日报", mentions: at(k) });
  await c.step(host);
  assert.equal(host.scheduler.list({ roomId: g.id }).length, 1);
  await c.advanceTo("2026-11-09T08:00:30+08:00", host);
  const first = (seen.get(k.id) ?? []).filter((i) => i.fresh.some((f) => f.kind === "schedule"));
  assert.equal(first.length, 1);
  assert.match(block(first[0]!, 1), /日报格式:三行/);
  host.announcements.update(ann.id, "NEUTRAL_FIXTURE 日报格式:五行,带链接");
  await c.advanceTo("2026-11-10T08:00:30+08:00", host);
  const both = (seen.get(k.id) ?? []).filter((i) => i.fresh.some((f) => f.kind === "schedule"));
  assert.equal(both.length, 2);
  assert.match(block(both[1]!, 1), /日报格式:五行,带链接/);
  assert.doesNotMatch(block(both[1]!, 1), /日报格式:三行/);
});

test("常驻承诺与定时一起停:用户撤销承诺,对应定时停用、到点不触发;用户在界面删掉定时,对应承诺一起了结", async () => {
  const c = clock("2026-11-09T07:00:00+08:00");
  const { host, brains, seen, svc } = rig(Host, { timers: c.timers, clockMs: c.clockMs });
  const k = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: k.id }]);
  brains.set(k.id, (i) => msgs(i).flatMap((m): MindAction[] => (m.text.includes("早报") ? [cron(m, "0 8 * * *", "Asia/Shanghai", "早报")] : m.text.includes("晚报") ? [cron(m, "0 20 * * *", "Asia/Shanghai", "晚报")] : [])));
  host.send({ roomId: g.id, clientActionId: "u1", text: "@小克 每天发早报", mentions: at(k) });
  await c.step(host);
  host.send({ roomId: g.id, clientActionId: "u2", text: "@小克 每天发晚报", mentions: at(k) });
  await c.step(host);
  const [morning, evening] = ["早报", "晚报"].map((t) => host.scheduler.list({ roomId: g.id }).find((s) => s.prompt === t)!);
  assert.ok(morning?.commitmentId && evening?.commitmentId);
  const r = await svc.handle("commitments.revoke", { commitmentId: morning.commitmentId, clientActionId: "rv" });
  assert.ok(r.ok);
  assert.equal(host.scheduler.list({}).find((s) => s.id === morning.id)?.enabled, false);
  await c.advanceTo("2026-11-09T08:30:00+08:00", host);
  assert.equal(wakes(seen.get(k.id)).length, 0, "撤销后的早报不触发");
  const del = await svc.handle("schedules.remove", { scheduleId: evening.id });
  assert.ok(del.ok);
  assert.equal(host.listCommitments({ contactId: k.id }).find((x) => x.id === evening.commitmentId)?.status, "revoked");
  assert.equal(host.listCommitments({ contactId: k.id }).find((x) => x.id === morning.commitmentId)?.status, "revoked");
});
