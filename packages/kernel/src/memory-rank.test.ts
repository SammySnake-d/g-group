// T-177 G3-a / G3-01:记忆读取的全文分量换成检索接缝(上游 acp-kernel hybrid)后的合成规则。
//   全文分量只取名次,映射到旧「字面重合个数」所在的整数区间;同分按 id;硬筛在检索之前;
//   AC-42 现有夹具(审查人从 Astra 改为 Codex,g-group#1531)换分量前后展开结果相同。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type MemoryEntry, memoryTextRanks, parseMemory, selectMemories, serializeMemory } from "./memory.ts";

const T0 = "2026-11-05T10:00:00.000Z";
const NOW = "2026-11-09T10:00:00.000Z";
const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "m-astra",
  version: 1,
  status: "active",
  title: "审查交给谁",
  body: "PR 审查交给 Astra。",
  anchors: ["room:g-group", "tool:review"],
  validFrom: null,
  validTo: null,
  source: { roomId: "g-group", seq: 1000, userQuote: true },
  supersedes: [],
  supersededBy: null,
  refines: [],
  conflictsWith: [],
  derivedFrom: [],
  evidence: [],
  uses: [],
  createdAt: T0,
  updatedAt: T0,
  ...over,
});
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);
const pick = (r: { expanded: MemoryEntry[]; listed: { id: string; title: string }[] }) => [ids(r.expanded), r.listed.map((x) => [x.id, x.title])];

// AC-42 读取夹具(packages/kernel/src/memory.test.ts 的「读取排序与断崖截断」),本轮文字「帮我安排审查」
const REVIEW = [
  entry({ id: "r1", title: "审查人", anchors: ["room:g-group", "tool:review"], body: "审查交给 Codex" }),
  entry({ id: "r2", title: "审查格式", anchors: ["room:g-group", "tool:review"], body: "审查报告写进 reviews 目录" }),
  entry({ id: "r3", title: "审查格式副本", anchors: ["room:g-group", "tool:review"], body: "审查报告写进  reviews 目录" }),
  entry({ id: "x1", title: "午饭", anchors: ["room:g-group"], body: "周五一起吃饭" }),
  entry({ id: "x2", title: "天气", anchors: ["room:g-group"], body: "最近下雨" }),
];
// 一个稀有词(部署)只出现在一条里,常见词(审查)出现在三条里;旧的二字计数对「部署审查」给四条都记 1 分
const RARE = [
  entry({ id: "e1", title: "审查流程", anchors: ["room:g"], body: "审查前先看 PR 描述" }),
  entry({ id: "e2", title: "部署", anchors: ["room:g"], body: "部署前先跑测试" }),
  entry({ id: "e3", title: "审查人", anchors: ["room:g"], body: "审查交给 Codex" }),
  entry({ id: "e4", title: "审查格式", anchors: ["room:g"], body: "审查报告写进 reviews 目录" }),
];

test("G3-a1 全文分量只用名次:命中按检索分数分档,是 0 起、步长 1 的整数,同分同值,未命中为 0", () => {
  const twin = entry({ id: "r1b", title: "审查人", anchors: ["room:g-group"], body: "审查交给 Codex" });
  const r = memoryTextRanks([...REVIEW, twin], "帮我安排审查");
  assert.deepEqual(Object.fromEntries(r), { r1: 3, r1b: 3, r2: 2, r3: 1, x1: 0, x2: 0 });
  for (const v of r.values()) assert.equal(Number.isInteger(v) && v >= 0, true, "分量是非负整数,不是检索的小数分");
  assert.deepEqual(Object.fromEntries(memoryTextRanks(REVIEW, "   ")), { r1: 0, r2: 0, r3: 0, x1: 0, x2: 0 }, "空文字全为 0");
  assert.deepEqual(memoryTextRanks([], "帮我安排审查").size, 0);
});

test("G3-a2 名次封顶在旧字面重合个数的上界内:档数多于本轮文字的字面单位时,最高档也不超过上界", () => {
  // 「部署审查」只有 3 个字面单位(部署、署审、审查),四条命中分四档:最高档记 3,往下 2、1,再往下压在 1
  assert.deepEqual(Object.fromEntries(memoryTextRanks(RARE, "部署审查")), { e2: 3, e3: 2, e1: 1, e4: 1 });
  // 「审查」只有 1 个字面单位:命中的不论分几档都记 1
  const one = memoryTextRanks(RARE, "审查");
  assert.deepEqual(Object.fromEntries(one), { e1: 1, e2: 0, e3: 1, e4: 1 });
  assert.equal(Math.max(...one.values()) <= 1, true);
});

test("G3-a3 稀有词优先:同锚点下与本轮文字共有稀有词的条目排在只共有常见词的条目前面", () => {
  const r = selectMemories(RARE, { anchors: ["room:g"], text: "部署审查", now: NOW });
  assert.equal(r.expanded[0]?.id, "e2", "「部署」只在 e2 里出现,排第一");
  assert.deepEqual([...ids(r.expanded), ...ids(r.listed)], ["e2", "e3", "e1", "e4"]);
});

test("G3-a4 并列顺序稳定:同分按 id 排,与传入顺序无关;md 序列化再解析(重建索引)前后展开结果相同", () => {
  const same = [
    entry({ id: "m-b", anchors: ["room:g"], title: "审查", body: "审查交给 Codex" }),
    entry({ id: "m-a", anchors: ["room:g"], title: "审查", body: "审查交给 Codex" }),
    entry({ id: "m-c", anchors: ["room:g"], title: "午饭", body: "周五一起吃饭" }),
  ];
  const ctx = { anchors: ["room:g"], text: "审查谁来做", now: NOW };
  const a = selectMemories(same, ctx);
  assert.deepEqual(pick(a), [["m-a"], [["m-b", "审查"], ["m-c", "午饭"]]]);
  assert.deepEqual(pick(selectMemories([...same].reverse(), ctx)), pick(a), "换传入顺序结果不变");
  const rebuilt = [...same, ...REVIEW].map((e) => { const p = parseMemory(serializeMemory(e)); assert.equal(p.ok, true); return p.ok ? p.entry : e; }).reverse();
  const sortById = (xs: readonly MemoryEntry[]) => [...xs].sort((x, y) => (x.id < y.id ? -1 : 1));
  assert.deepEqual(sortById(rebuilt), sortById([...same, ...REVIEW]), "md 往返后条目逐字段相同");
  const before = selectMemories([...same, ...REVIEW], { anchors: ["room:g", "room:g-group", "tool:review"], text: "帮我安排审查", now: NOW });
  assert.deepEqual(pick(selectMemories(rebuilt, { anchors: ["room:g", "room:g-group", "tool:review"], text: "帮我安排审查", now: NOW })), pick(before));
});

test("G3-a5 AC-42 现有夹具(审查人从 Astra 改为 Codex 等)换分量前后展开与清单相同", () => {
  // 期望值是换分量前(4efdee0 的二字计数)跑出来的结果;同一组夹具在换分量后必须一字不差
  assert.deepEqual(pick(selectMemories(REVIEW, { anchors: ["room:g-group", "tool:review"], text: "帮我安排审查", now: NOW })), [["r1", "r2"], [["r3", "审查格式副本"], ["x1", "午饭"], ["x2", "天气"]]]);
  const byText = selectMemories([entry({ id: "lunch", title: "午饭", anchors: ["room:g"], body: "周五一起吃饭" }), entry({ id: "rev", title: "审查人", anchors: ["room:g"], body: "审查交给 Codex" })], { anchors: ["room:g"], text: "这次审查谁来做", now: NOW });
  assert.deepEqual(pick(byText), [["rev"], [["lunch", "午饭"]]]);
  const astra = entry();
  const codex = entry({ id: "m-codex", body: "PR 审查交给 Codex,不再交 Astra。", supersedes: ["m-astra"], createdAt: NOW, updatedAt: NOW });
  const lunch = entry({ id: "m-lunch", title: "午饭", anchors: ["room:g-group"], body: "周五一起吃饭" });
  const ctx = { anchors: ["room:g-group", "tool:review"], text: "这次审查交给谁", now: NOW };
  assert.deepEqual(pick(selectMemories([astra, lunch], ctx)), [["m-astra"], [["m-lunch", "午饭"]]], "改交之前读到 Astra");
  const after = selectMemories([{ ...astra, status: "superseded", supersededBy: "m-codex", version: 2 }, codex, lunch], ctx);
  assert.deepEqual(pick(after), [["m-codex"], [["m-lunch", "午饭"]]], "改交 Codex 之后只读到 Codex,Astra 不进");
  const flat = selectMemories([entry({ id: "p", anchors: ["room:g"] }), entry({ id: "q", anchors: ["room:g"], body: "另一条" })], { anchors: ["room:g"], text: "", now: NOW });
  assert.deepEqual(pick(flat), [["p", "q"], []], "没有断崖就全部展开");
});

test("G3-01e 全文最相关也越不过硬筛:已替代、已撤销、过期、锚点不相交、全局条目不进读取", () => {
  const text = "PR 审查交给 Astra 吗";
  const es = [
    entry({ id: "old", status: "superseded", body: "PR 审查交给 Astra。" }),
    entry({ id: "rev", status: "revoked", body: "PR 审查交给 Astra。" }),
    entry({ id: "exp", validTo: "2026-11-01T00:00:00.000Z", body: "PR 审查交给 Astra。" }),
    entry({ id: "far", anchors: ["room:other"], body: "PR 审查交给 Astra。" }),
    entry({ id: "glo", anchors: ["global"], body: "PR 审查交给 Astra。" }),
    entry({ id: "ok", anchors: ["room:g-group"], title: "午饭", body: "周五一起吃饭" }),
  ];
  const r = selectMemories(es, { anchors: ["room:g-group", "tool:review"], text, now: NOW });
  assert.deepEqual([...ids(r.expanded), ...ids(r.listed)], ["ok"]);
  assert.equal((memoryTextRanks(es, text).get("old") ?? 0) > 0, true, "前提:被硬筛掉的条目全文上确实最相关");
});
