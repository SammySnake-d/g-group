import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOARD_SIZES,
  CONTACT_SIZES,
  LEAF_FOLD,
  aggregate,
  boardFacts,
  bucketOf,
  countFacts,
  elbowPath,
  filterFacts,
  formatClock,
  formatSpan,
  groupBoard,
  groupHints,
  layoutBoard,
  lineage,
  rangeStart,
  stallMinutes,
  type BoardFilter,
  type BoardWorld,
  type ComputeUnit,
  type SubUnit,
} from "./board.ts";

/** 本地时间:2026-11-08 为「今天」,断言和机器时区无关 */
const t = (h: number, m: number, day = 0) => new Date(2026, 10, 8 + day, h, m).getTime();
const NOW = t(23, 0);
const C = (u: Partial<ComputeUnit> & Pick<ComputeUnit, "id" | "conv" | "owner" | "state">): ComputeUnit => ({
  title: `任务 ${u.id}`, model: "Opus 5.5", upstream: "Anthropic 官方", startedAt: t(22, 0), lastProgressAt: t(22, 30), turns: 1, seq: 1, ...u,
});
const S = (s: Partial<SubUnit> & Pick<SubUnit, "id" | "parent" | "state">): SubUnit => ({
  kind: "job", title: `子任务 ${s.id}`, startedAt: t(22, 0), lastProgressAt: t(22, 10), ...s,
});

const world: BoardWorld = {
  now: NOW,
  people: { claude: { name: "Claude Code" }, codex: { name: "Codex" }, astra: { name: "Astra" }, grok: { name: "Grok" } },
  convs: [
    { id: "g-main", kind: "group", name: "模型助手群聊", members: ["claude", "codex", "astra"] },
    { id: "g-design", kind: "group", name: "前端设计讨论", members: ["grok"] },
    { id: "dm-claude", kind: "dm", name: "Claude Code", members: ["claude"] },
  ],
  computes: [
    C({ id: "c1", conv: "g-main", owner: "claude", state: "running", startedAt: t(22, 40), lastProgressAt: t(22, 59), turns: 6 }),
    C({ id: "c2", conv: "g-main", owner: "claude", state: "waiting_user", startedAt: t(22, 30), lastProgressAt: t(22, 54), turns: 4 }),
    C({ id: "c3", conv: "g-main", owner: "claude", state: "done", endedAt: t(21, 40), turns: 9 }),
    C({ id: "c4", conv: "g-main", owner: "codex", state: "failed", reason: "upstream_unavailable", upstream: "OpenAI 中转 A", endedAt: t(22, 14), turns: 5 }),
    C({ id: "c5", conv: "g-main", owner: "codex", state: "failed", reason: "upstream_unavailable", upstream: "OpenAI 中转 A", endedAt: t(22, 24), turns: 2 }),
    C({ id: "c6", conv: "g-main", owner: "astra", state: "interrupted", reason: "user_stopped", endedAt: t(21, 56), turns: 2 }),
    C({ id: "c7", conv: "dm-claude", owner: "claude", state: "running", startedAt: t(21, 56), lastProgressAt: t(22, 59), turns: 14 }),
    C({ id: "c8", conv: "g-design", owner: "grok", state: "done", endedAt: t(17, 20, -1), turns: 2 }),
    C({ id: "c9", conv: "dm-claude", owner: "claude", state: "done", startedAt: t(9, 0, -10), lastProgressAt: t(9, 30, -10), endedAt: t(9, 30, -10), turns: 1 }),
    C({ id: "lost", conv: "nowhere", owner: "claude", state: "running" }),
  ],
  subs: [
    S({ id: "s1", parent: "c1", kind: "subagent", state: "running", startedAt: t(22, 50) }),
    S({ id: "s2", parent: "c1", state: "done", startedAt: t(22, 52) }),
    S({ id: "s3", parent: "c1", kind: "subchat", state: "running", startedAt: t(22, 45) }),
    S({ id: "s10", parent: "c7", state: "running", startedAt: t(22, 41) }),
    S({ id: "s11", parent: "c7", state: "running", startedAt: t(22, 55) }),
    S({ id: "s12", parent: "c7", state: "failed", startedAt: t(22, 37) }),
    S({ id: "s13", parent: "c7", state: "done", startedAt: t(22, 30) }),
    S({ id: "s14", parent: "c7", state: "done", startedAt: t(22, 20) }),
    S({ id: "s15", parent: "c7", state: "done", startedAt: t(22, 10) }),
    S({ id: "s16", parent: "c7", state: "done", startedAt: t(22, 5), title: "回读远端 HEAD" }),
    S({ id: "s17", parent: "c7", state: "done", startedAt: t(22, 1) }),
  ],
};
const filter = (p: Partial<BoardFilter> = {}): BoardFilter => ({ groupBy: "room", bucket: "all", range: "all", query: "", ...p });
const ids = (xs: readonly { unit: { id: string } }[]) => xs.map((x) => x.unit.id);
const none = () => false;
const facts = boardFacts(world);

test("状态分组:等你 / 在跑(含排队)/ 失败(含成孤儿、非人为中断)/ 已停止(你停的)/ 完成", () => {
  assert.equal(bucketOf({ state: "waiting_user" }), "wait");
  assert.equal(bucketOf({ state: "queued" }), "run");
  assert.equal(bucketOf({ state: "running" }), "run");
  assert.equal(bucketOf({ state: "orphaned" }), "failed");
  assert.equal(bucketOf({ state: "interrupted", reason: "harness_crashed" }), "failed");
  assert.equal(bucketOf({ state: "interrupted", reason: "user_stopped" }), "stopped");
  assert.equal(bucketOf({ state: "done" }), "done");
});

test("时间文案:用时按分 / 小时,时刻分今天、昨天、更早", () => {
  assert.equal(formatSpan(20_000), "不到 1 分");
  assert.equal(formatSpan(12 * 60_000), "12 分");
  assert.equal(formatSpan(60 * 60_000), "1 小时");
  assert.equal(formatSpan(125 * 60_000), "2 小时 5 分");
  assert.equal(formatClock(t(9, 5), NOW), "09:05");
  assert.equal(formatClock(t(21, 40, -1), NOW), "昨天 21:40");
  assert.equal(formatClock(t(16, 2, -3), NOW), "11-5 16:02");
});

test("快卡住:在跑且超过阈值一半没进展才提示,完成的不提示", () => {
  assert.equal(stallMinutes({ state: "running", lastProgressAt: NOW - 8 * 60_000 }, NOW), 8);
  assert.equal(stallMinutes({ state: "running", lastProgressAt: NOW - 7 * 60_000 }, NOW), null);
  assert.equal(stallMinutes({ state: "running", lastProgressAt: NOW - 8 * 60_000 }, NOW, 20), null);
  assert.equal(stallMinutes({ state: "running", lastProgressAt: NOW - 10 * 60_000 }, NOW, 20), 10);
  assert.equal(stallMinutes({ state: "done", lastProgressAt: NOW - 60 * 60_000 }, NOW), null);
});

test("台账 → 事实:找不到对话的丢弃;子任务在跑的在前、同状态新的在前;最近活动取结束时刻", () => {
  assert.equal(facts.length, 9);
  assert.ok(!ids(facts).includes("lost"));
  const c1 = facts.find((x) => x.unit.id === "c1")!;
  assert.deepEqual(c1.subs.map((s) => s.id), ["s1", "s3", "s2"]);
  assert.equal(c1.lastAt, t(22, 59));
  assert.equal(facts.find((x) => x.unit.id === "c4")!.lastAt, t(22, 14));
  const c7 = facts.find((x) => x.unit.id === "c7")!;
  assert.deepEqual(c7.subs.slice(0, 3).map((s) => s.id), ["s11", "s10", "s12"]);
});

test("时间范围:今天只留今天有动静的,在跑和等你的永远在;7 天、30 天按本地零点算", () => {
  assert.equal(rangeStart("today", NOW), t(0, 0));
  assert.equal(rangeStart("7d", NOW), t(0, 0, -6));
  assert.equal(rangeStart("all", NOW), null);
  assert.deepEqual(ids(filterFacts(facts, filter({ range: "today" }), world)).sort(), ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
  assert.ok(ids(filterFacts(facts, filter({ range: "7d" }), world)).includes("c8"));
  assert.ok(!ids(filterFacts(facts, filter({ range: "7d" }), world)).includes("c9"));
  assert.ok(ids(filterFacts(facts, filter({ range: "30d" }), world)).includes("c9"));
  const old = (id: string, state: ComputeUnit["state"]) => C({ id, conv: "g-main", owner: "claude", state, startedAt: t(9, 0, -12), lastProgressAt: t(9, 0, -12) });
  const stale = boardFacts({ ...world, computes: [old("run", "running"), old("ask", "waiting_user"), old("bad", "failed")] });
  assert.deepEqual(ids(filterFacts(stale, filter({ range: "today" }), world)), ["run", "ask"]);
});

test("搜索:不分大小写,命中标题、上游、联系人名、对话名、子任务标题", () => {
  assert.deepEqual(ids(filterFacts(facts, filter({ query: "openai" }), world)), ["c4", "c5"]);
  assert.deepEqual(ids(filterFacts(facts, filter({ query: "回读" }), world)), ["c7"]);
  assert.deepEqual(ids(filterFacts(facts, filter({ query: "Astra" }), world)), ["c6"]);
  assert.deepEqual(ids(filterFacts(facts, filter({ query: " 前端 " }), world)), ["c8"]);
  assert.equal(filterFacts(facts, filter({ query: "没有这个词" }), world).length, 0);
});

test("顶部统计:按状态计数、总轮数、在跑的子任务(子对话不算)", () => {
  const c = countFacts(facts);
  assert.deepEqual({ ...c }, { all: 9, wait: 1, run: 2, failed: 2, stopped: 1, done: 3, turns: 45, subsRunning: 3 });
  assert.deepEqual(aggregate(facts.filter((x) => x.conv.id === "g-main")), { all: 6, run: 1, wait: 1, failed: 2 });
});

test("群级提示:同群同上游同原因失败 ≥2 个才合成一条;都是同一人才带 owner;私聊不出", () => {
  assert.deepEqual(groupHints(facts), [{ conv: "g-main", owner: "codex", reason: "upstream_unavailable", upstream: "OpenAI 中转 A", count: 2 }]);
  const mixed = facts.map((x) => (x.unit.id === "c5" ? { ...x, unit: { ...x.unit, owner: "astra" } } : x));
  const [h] = groupHints(mixed);
  assert.equal(h?.count, 2);
  assert.ok(h && !("owner" in h));
  const inDm = facts.map((x) => (x.unit.id === "c4" || x.unit.id === "c5" ? { ...x, conv: world.convs[2]! } : x));
  assert.deepEqual(groupHints(inDm), []);
  assert.deepEqual(groupHints(facts.filter((x) => x.unit.id !== "c5")), []);
});

test("按对话分组:最急的对话在上;群里按联系人分、私聊一个叶子;叶子里等你 → 在跑 → 失败 → 完成", () => {
  const roots = groupBoard(facts, "room", none, groupHints(facts));
  assert.deepEqual(roots.map((r) => r.key), ["r:g-main", "r:dm-claude", "r:g-design"]);
  const main = roots[0]!;
  assert.deepEqual(main.leaves.map((l) => l.person), ["claude", "codex", "astra"]);
  assert.deepEqual(ids(main.leaves[0]!.facts), ["c2", "c1", "c3"]);
  assert.deepEqual(ids(main.leaves[1]!.facts), ["c5", "c4"]);
  assert.equal(main.hints.length, 1);
  const dm = roots[1]!;
  assert.equal(dm.leaves.length, 1);
  assert.equal(dm.leaves[0]!.person, "claude");
  assert.deepEqual(dm.hints, []);
});

test("按联系人分组:每人一个根,叶子 key 用人", () => {
  const roots = groupBoard(facts, "contact", none, []);
  assert.equal(roots[0]!.key, "p:claude");
  assert.deepEqual(roots.map((r) => r.person).sort(), ["astra", "claude", "codex", "grok"]);
  assert.ok(roots.every((r) => r.leaves.length === 1 && r.leaves[0]!.key === r.key && r.conv === undefined));
});

test(`一个人超过 ${LEAF_FOLD} 个 Compute 折叠,展开后全显示`, () => {
  const many: BoardWorld = { ...world, computes: Array.from({ length: 10 }, (_, i) => C({ id: `m${i}`, conv: "dm-claude", owner: "claude", state: "done", endedAt: t(20, i) })), subs: [] };
  const fs = boardFacts(many);
  const folded = groupBoard(fs, "room", none, [])[0]!.leaves[0]!;
  assert.equal(folded.facts.length, LEAF_FOLD);
  assert.equal(folded.hidden, 2);
  assert.equal(folded.overflow, true);
  assert.equal(folded.facts[0]!.unit.id, "m9");
  const open = groupBoard(fs, "room", (k) => k === "cp:r:dm-claude", [])[0]!.leaves[0]!;
  assert.equal(open.facts.length, 10);
  assert.equal(open.hidden, 0);
  const L = layoutBoard(groupBoard(fs, "room", none, []), 1280, none);
  assert.deepEqual(L.more.map((m) => [m.key, m.n, m.unfold]), [["cp:r:dm-claude", 2, true]]);
});

test("自适应布局(宽):四列齐全,列位置照 mirasim 常量,卡片按子任务行数撑高", () => {
  const S0 = BOARD_SIZES, C0 = CONTACT_SIZES;
  const roots = groupBoard(facts, "room", none, groupHints(facts));
  const L = layoutBoard(roots, 1280, none);
  assert.equal(L.insideColumn, true);
  assert.equal(L.columns.root, S0.padX);
  assert.equal(L.columns.contact, S0.padX + S0.pW + C0.g0);
  assert.equal(L.columns.cards, 516);
  assert.equal(L.columns.cardsW, 1280 - 40 - 196 - 240 - 60 - 44 - 236);
  assert.equal(L.columns.inside, 516 + 464 + 44);
  assert.equal(L.width, 1280);
  const y = (id: string) => L.cards.find((c) => c.fact.unit.id === id)!.box.y;
  // c2 无子任务占 68;c1 三个子任务 3×26+2×4=86 > 68,撑高;c3 接在后面
  assert.equal(y("c2"), S0.padY);
  assert.equal(y("c1"), 18 + 68 + 10);
  assert.equal(y("c3"), 96 + 86 + 10);
  // 节点对齐到第一张卡片的中线
  assert.equal(L.roots[0]!.box.y, 18 + 34 - 26);
  assert.equal(L.contacts[0]!.box.y, 26);
  // 下一位联系人在上一位最后一张卡下面再空 contactGap
  assert.equal(y("c5"), 192 + 68 + 10 - 10 + 18);
  assert.equal(L.contacts[1]!.box.y, y("c5") + 34 - 26);
  // 群级提示挂在群节点下面
  assert.deepEqual(L.hints.map((h) => h.box.y), [18 + 34 + 26 + 6]);
  assert.deepEqual(L.inside.filter((i) => i.owner === "c1").map((i) => i.item.id), ["s1", "s3", "s2"]);
  assert.ok(L.height > y("c3"));
  // 渲染 / Tab 顺序:根 → 群级提示 → 联系人 → 它的卡片 → 卡片的子任务,再到下一位联系人
  assert.deepEqual(L.order.slice(0, 9), ["r:g-main", "h:r:g-main:0", "c:g-main:claude", "s:c2", "s:c1", "i:c1:s1", "i:c1:s3", "i:c1:s2", "s:c3"]);
  assert.equal(L.order[9], "c:g-main:codex");
  assert.equal(new Set(L.order).size, L.roots.length + L.hints.length + L.contacts.length + L.cards.length + L.inside.length + L.more.length);
});

test("自适应布局(窄):放不下就收掉子任务列、不出横向滚动;再窄 Compute 列保底 300", () => {
  const roots = groupBoard(facts, "room", none, []);
  const L = layoutBoard(roots, 900, none);
  assert.equal(L.insideColumn, false);
  assert.equal(L.columns.inside, null);
  assert.equal(L.inside.length, 0);
  assert.equal(L.columns.cardsW, 900 - 40 - 196 - 240 - 60);
  assert.equal(L.width, 900);
  assert.equal(L.cards.find((c) => c.fact.unit.id === "c3")!.box.y, 96 + 68 + 10);
  const tight = layoutBoard(roots, 700, none);
  assert.equal(tight.columns.cardsW, 300);
  assert.equal(tight.width, 516 + 300 + 20);
  // 恰好够宽的临界点
  assert.equal(layoutBoard(roots, 1116, none).insideColumn, true);
  assert.equal(layoutBoard(roots, 1115, none).insideColumn, false);
});

test("按联系人布局:没有联系人列,Compute 列紧跟左列", () => {
  const L = layoutBoard(groupBoard(facts, "contact", none, []), 1280, none);
  assert.equal(L.columns.contact, null);
  assert.equal(L.contacts.length, 0);
  assert.equal(L.columns.cards, 20 + 196 + 60);
});

test("子任务超过 6 个:前 6 个 +「还有 N 个」;展开后全显示 +「收起」;搜索命中的被折叠项露出来", () => {
  const roots = groupBoard(facts, "room", none, []);
  const folded = layoutBoard(roots, 1280, none);
  const of = (L: ReturnType<typeof layoutBoard>) => L.inside.filter((i) => i.owner === "c7");
  assert.equal(of(folded).length, BOARD_SIZES.insideMax);
  const more = folded.more.find((m) => m.key === "in:c7")!;
  assert.equal(more.n, 2);
  assert.equal(more.unfold, true);
  assert.equal(more.box.y, of(folded)[5]!.box.y + 26 + 4);
  assert.ok(folded.links.some((k) => k.to === "m:in:c7" && k.more === true && k.group === "idle"));

  const open = layoutBoard(roots, 1280, (k) => k === "in:c7");
  assert.equal(of(open).length, 8);
  const fold = open.more.find((m) => m.key === "in:c7")!;
  assert.equal(fold.unfold, false);
  assert.equal(fold.from, of(open)[0]!.box.y);

  const pinned = layoutBoard(roots, 1280, none, (s) => s.title.includes("回读"));
  assert.ok(of(pinned).some((i) => i.item.id === "s16"));
  assert.equal(pinned.more.find((m) => m.key === "in:c7")!.n, 1);
});

test("连线:同一高度画直线,否则带圆角(≤8,且不超过高差一半)的直角折线", () => {
  assert.equal(elbowPath(0, 10, 30, 60, 10.5), "M 0 10 H 60");
  assert.equal(elbowPath(0, 0, 30, 60, 40), "M 0 0 H 22 Q 30 0 30 8 V 32 Q 30 40 38 40 H 60");
  assert.equal(elbowPath(0, 40, 30, 60, 34), "M 0 40 H 27 Q 30 40 30 37 V 37 Q 30 34 33 34 H 60");
});

test("悬停血缘:从一项往上往下走,整条链亮;兄弟分支不亮;没悬停是 null", () => {
  const L = layoutBoard(groupBoard(facts, "room", none, []), 1280, none);
  assert.equal(lineage(L.links, null), null);
  const lit = lineage(L.links, "i:c1:s1")!;
  for (const id of ["i:c1:s1", "s:c1", "c:g-main:claude", "r:g-main", "s:c1>i:c1:s1", "c:g-main:claude>s:c1", "r:g-main>c:g-main:claude"]) assert.ok(lit.has(id), id);
  for (const id of ["s:c2", "i:c1:s2", "c:g-main:codex", "r:dm-claude"]) assert.ok(!lit.has(id), id);
  const fromRoot = lineage(L.links, "r:g-main")!;
  for (const id of ["c:g-main:codex", "s:c4", "s:c5", "i:c1:s2"]) assert.ok(fromRoot.has(id), id);
  assert.ok(!fromRoot.has("s:c7"));
});
