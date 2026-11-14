// 联系人记忆的纯函数(需求文档 D25;验收 AC-42)。md 真源的序列化、写入判关系、读取按锚点硬筛与断崖截断、前缀准入、用后反馈降级。
// 夹具:审查人从 Astra 改为 Codex(g-group#1531)这条替代关系(AC-42 证据列指定)。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type MemoryEntry,
  type MemoryWrite,
  parseMemory,
  planMemoryWrite,
  prefixMemories,
  recordMemoryUse,
  selectMemories,
  serializeMemory,
} from "./memory.ts";

const T0 = "2026-11-05T10:00:00.000Z";
const T1 = "2026-11-06T10:00:00.000Z";
const NOW = "2026-11-09T10:00:00.000Z";
let n = 0;
const newId = () => `m-${++n}`;

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
const write = (over: Partial<MemoryWrite> = {}): MemoryWrite => ({
  title: "审查交给谁",
  body: "PR 审查交给 Codex,不再交 Astra。",
  anchors: ["room:g-group", "tool:review"],
  source: { roomId: "g-group", seq: 1531, userQuote: true },
  relation: null,
  ...over,
});

test("md 真源:序列化后再解析得到同一条记忆;正文多行、frontmatter 字段齐全;坏文件给出原因不抛错", () => {
  const e = entry({ body: "第一行\n第二行 # 不是标题\n---\n仍是正文", evidence: [{ roomId: "g-group", seq: 1200, at: T1 }], uses: [{ at: T1, good: false, note: "走错路" }] });
  const md = serializeMemory(e);
  assert.ok(md.startsWith("---\n"));
  assert.match(md, /"id": "m-astra"/);
  assert.match(md, /"anchors"/);
  assert.match(md, /"supersedes"/);
  assert.ok(md.endsWith("第一行\n第二行 # 不是标题\n---\n仍是正文\n"));
  const back = parseMemory(md);
  assert.equal(back.ok, true);
  if (back.ok) assert.deepEqual(back.entry, e);
  const why = (t: string) => {
    const r = parseMemory(t);
    assert.equal(r.ok, false, t);
    return r.ok ? "" : r.why;
  };
  assert.match(why("没有 frontmatter"), /缺少 frontmatter/);
  assert.match(why("x---\n{}\n---\n正文\n"), /缺少 frontmatter/, "不以 --- 开头就拒,不往后找");
  assert.match(why("---\n{不是 json\n---\n正文\n"), /不是合法 JSON/);
  assert.match(why(`---\n${JSON.stringify({ id: "x" })}\n---\n正文\n`), /字段 version/);
  const { body: _b, ...front } = e;
  assert.match(why(`---\n${JSON.stringify({ ...front, status: "bogus" })}\n---\n正文\n`), /字段 status/);
  assert.match(why(`---\n${JSON.stringify({ ...front, anchors: "room:g" })}\n---\n正文\n`), /字段 anchors/);
});

test("写入判关系·新增:邻域里没有相关条目就新建,立即是生效状态(不进候选区、不等回放)", () => {
  const other = entry({ id: "m-other", anchors: ["room:dm-1"], body: "用户喜欢简短回复。", title: "回复风格" });
  const p = planMemoryWrite([other], write(), NOW, newId);
  assert.equal(p.kind, "new");
  if (p.kind !== "new") return;
  assert.equal(p.entry.status, "active");
  assert.equal(p.entry.version, 1);
  assert.deepEqual(p.entry.anchors, ["room:g-group", "tool:review"]);
  assert.deepEqual(p.changed, [p.entry]);
  assert.equal(p.entry.createdAt, NOW);
});

test("写入判关系·复述:与邻域里某条生效条目内容相同(忽略空白),不新增条目,旧条目 evidence 加一", () => {
  const old = entry();
  const p = planMemoryWrite([old], write({ body: "  PR 审查交给\nAstra。 ", source: { roomId: "g-group", seq: 1400, userQuote: true } }), NOW, newId);
  assert.equal(p.kind, "restate");
  if (p.kind !== "restate") return;
  assert.equal(p.target, "m-astra");
  assert.equal(p.changed.length, 1);
  assert.deepEqual(p.changed[0]!.evidence, [{ roomId: "g-group", seq: 1400, at: NOW }]);
  assert.equal(p.changed[0]!.version, 2);
  assert.equal(p.changed[0]!.body, old.body, "正文不变");
  const elsewhere = planMemoryWrite([old], write({ body: "PR 审查交给 Astra。", anchors: ["room:dm-9"] }), NOW, newId);
  assert.equal(elsewhere.kind, "new", "锚点不相交的不算邻域");
});

test("写入判关系·改变:指明替代某条生效条目时出新版本,新条目 supersedes 指向旧条目,旧条目标已替代并链到新条目", () => {
  const old = entry();
  const p = planMemoryWrite([old], write({ relation: { kind: "change", target: "m-astra" } }), NOW, newId);
  assert.equal(p.kind, "change");
  if (p.kind !== "change") return;
  const [fresh, prev] = [p.changed.find((x) => x.id !== "m-astra")!, p.changed.find((x) => x.id === "m-astra")!];
  assert.deepEqual(fresh.supersedes, ["m-astra"]);
  assert.equal(fresh.status, "active");
  assert.equal(prev.status, "superseded");
  assert.equal(prev.supersededBy, fresh.id);
  assert.equal(prev.version, 2);
  const gone = planMemoryWrite([old], write({ relation: { kind: "change", target: "m-nope" } }), NOW, newId);
  assert.equal(gone.kind, "invalid");
  const dead = planMemoryWrite([entry({ status: "superseded" })], write({ relation: { kind: "change", target: "m-astra" } }), NOW, newId);
  assert.equal(dead.kind, "invalid", "只能替代生效条目");
});

test("写入判关系·细化:新条目 refines 指向旧条目,旧条目仍生效", () => {
  const p = planMemoryWrite([entry()], write({ body: "审查 Astra 时附上变异报告。", relation: { kind: "refine", target: "m-astra" } }), NOW, newId);
  assert.equal(p.kind, "refine");
  if (p.kind !== "refine") return;
  assert.equal(p.changed.length, 1);
  assert.deepEqual(p.changed[0]!.refines, ["m-astra"]);
});

test("写入判关系·冲突:两边都来自用户原话时不自动替代,新条目带 conflictsWith、要求问用户;不都是用户原话按改变处理", () => {
  const old = entry();
  const p = planMemoryWrite([old], write({ relation: { kind: "conflict", target: "m-astra" } }), NOW, newId);
  assert.equal(p.kind, "ask-user");
  if (p.kind !== "ask-user") return;
  assert.equal(p.changed.length, 1, "旧条目不动");
  assert.deepEqual(p.changed[0]!.conflictsWith, ["m-astra"]);
  assert.equal(p.target, "m-astra");
  const notQuote = planMemoryWrite([old], write({ relation: { kind: "conflict", target: "m-astra" }, source: { roomId: "g-group", seq: 1531, userQuote: false } }), NOW, newId);
  assert.equal(notQuote.kind, "change");
});

test("读取硬筛:已替代、已撤销、过期、尚未生效、锚点不相交的不进;全局条目走前缀不走读取;降级条目可进但排在后面", () => {
  const es = [
    entry({ id: "a", anchors: ["room:g-group"], body: "群里先给结论" }),
    entry({ id: "b", status: "superseded", body: "旧的" }),
    entry({ id: "c", status: "revoked", body: "撤销的" }),
    entry({ id: "d", validTo: "2026-11-01T00:00:00.000Z", body: "过期的" }),
    entry({ id: "e", validFrom: "2026-12-01T00:00:00.000Z", body: "未来的" }),
    entry({ id: "f", anchors: ["room:other"], body: "别的群" }),
    entry({ id: "g", anchors: ["global"], body: "全局偏好" }),
    entry({ id: "h", status: "degraded", anchors: ["room:g-group"], body: "降级的" }),
    entry({ id: "i", anchors: ["global", "room:g-group"], body: "全局且带会话锚点" }),
    entry({ id: "j", status: "degraded", anchors: ["global"], body: "降级的全局" }),
  ];
  const r = selectMemories(es, { anchors: ["room:g-group"], text: "", now: NOW });
  const ids = [...r.expanded.map((x) => x.id), ...r.listed.map((x) => x.id)];
  assert.deepEqual(ids.sort(), ["a", "h"]);
  assert.equal([...r.expanded, ...r.listed].findIndex((x) => x.id === "h") > [...r.expanded, ...r.listed].findIndex((x) => x.id === "a"), true, "降级排后");
  assert.deepEqual(prefixMemories(es, NOW).map((x) => x.id), ["g", "i"], "只有生效的全局条目进前缀,降级的全局条目不进");
  const degradedFirst = selectMemories([entry({ id: "h", status: "degraded", anchors: ["room:g-group"], body: "降级的" }), entry({ id: "a", anchors: ["room:g-group"], body: "群里先给结论" })], { anchors: ["room:g-group"], text: "", now: NOW });
  assert.deepEqual([...degradedFirst.expanded, ...degradedFirst.listed].map((x) => x.id), ["a", "h"], "降级条目排在同等锚点的生效条目之后,不看输入顺序");
});

test("读取排序与断崖截断:锚点多、正文与本轮文字相关的排前;在分数断崖处截断,其余给 id 加标题;内容重复的只展开一条;不按固定条数", () => {
  const es = [
    entry({ id: "r1", title: "审查人", anchors: ["room:g-group", "tool:review"], body: "审查交给 Codex" }),
    entry({ id: "r2", title: "审查格式", anchors: ["room:g-group", "tool:review"], body: "审查报告写进 reviews 目录" }),
    entry({ id: "r3", title: "审查格式副本", anchors: ["room:g-group", "tool:review"], body: "审查报告写进  reviews 目录" }),
    entry({ id: "x1", title: "午饭", anchors: ["room:g-group"], body: "周五一起吃饭" }),
    entry({ id: "x2", title: "天气", anchors: ["room:g-group"], body: "最近下雨" }),
  ];
  const r = selectMemories(es, { anchors: ["room:g-group", "tool:review"], text: "帮我安排审查", now: NOW });
  assert.deepEqual(r.expanded.map((x) => x.id), ["r1", "r2"], "断崖之前的展开,重复内容只展开一条");
  assert.deepEqual(r.listed.map((x) => [x.id, x.title]), [["r3", "审查格式副本"], ["x1", "午饭"], ["x2", "天气"]]);
  const byText = selectMemories([entry({ id: "lunch", title: "午饭", anchors: ["room:g"], body: "周五一起吃饭" }), entry({ id: "rev", title: "审查人", anchors: ["room:g"], body: "审查交给 Codex" })], { anchors: ["room:g"], text: "这次审查谁来做", now: NOW });
  assert.deepEqual([byText.expanded.map((x) => x.id), byText.listed.map((x) => x.id)], [["rev"], ["lunch"]], "锚点相同时,与本轮文字字面相关的排前并在断崖处截断");
  const flat = selectMemories([entry({ id: "p", anchors: ["room:g"] }), entry({ id: "q", anchors: ["room:g"], body: "另一条" })], { anchors: ["room:g"], text: "", now: NOW });
  assert.deepEqual(flat.expanded.map((x) => x.id).sort(), ["p", "q"], "没有断崖就全部展开");
  const many = Array.from({ length: 30 }, (_, i) => entry({ id: `k${i}`, anchors: ["room:g"], body: `条目 ${i}` }));
  assert.equal(selectMemories(many, { anchors: ["room:g"], text: "", now: NOW }).expanded.length, 30, "不设固定条数上限");
});

test("用后反馈:记一笔 uses;同一条连续三次结果不好就降级,不删除;降级后一次好结果恢复生效", () => {
  let e = entry();
  e = recordMemoryUse(e, { at: T1, good: false }, NOW);
  e = recordMemoryUse(e, { at: T1, good: false }, NOW);
  assert.equal(e.status, "active");
  e = recordMemoryUse(e, { at: T1, good: false, note: "又走错" }, NOW);
  assert.equal(e.status, "degraded");
  assert.equal(e.uses.length, 3);
  assert.equal(e.version, 4);
  e = recordMemoryUse(e, { at: T1, good: true }, NOW);
  assert.equal(e.status, "active");
  const mixed = [false, true, false, false].reduce((x, g) => recordMemoryUse(x, { at: T1, good: g }, NOW), entry());
  assert.equal(mixed.status, "active", "中间有好结果就重新计数");
  const sup = recordMemoryUse(entry({ status: "superseded" }), { at: T1, good: false }, NOW);
  assert.equal(sup.status, "superseded", "已替代的不因反馈改状态");
});
