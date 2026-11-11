// T-177 G3-01:检索接缝 searchHistory(上游 acp-kernel 的 hybrid 检索)。只对调用方给的、已可见的文本排序。
// 夹具是 11-10 对照探针用过的 7 条中文聊天(deliverables/g-group-bc-design/evidence/search-probe.ts),问法是改写过的,字面子串找不到。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type HistoryDoc, searchHistory } from "./history-search.ts";

const CHAT: HistoryDoc[] = [
  { ref: "g:101", role: "user", text: "明天下午三点的会议改到周四上午十点，地点还是三楼会议室" },
  { ref: "g:102", role: "assistant", text: "好的，已记下周四上午十点开会" },
  { ref: "g:103", role: "user", text: "测试服端口改成 8081 了，之前的 8080 不用了" },
  { ref: "g:104", role: "user", text: "以后审查都交给 Codex，hy4 只做辅助" },
  { ref: "g:105", role: "user", text: "周末去哪玩？我想去爬山" },
  { ref: "g:106", role: "assistant", text: "部署脚本在 scripts/deploy.sh，需要先登录堡垒机" },
  { ref: "g:107", role: "user", text: "身份验证用 OAuth，不要再用旧的 session cookie" },
];
const refs = (hits: readonly { ref: string }[]) => hits.map((h) => h.ref);

test("G3-01a 改写问法能找回原消息:会议安排、谁来审查、部署到测试服都命中原文(这些问法在原文里没有字面子串)", () => {
  for (const q of ["会议安排", "谁来审查", "部署到测试服"]) assert.equal(CHAT.some((d) => d.text.includes(q)), false, `夹具前提:「${q}」不是任何原文的子串`);
  assert.equal(searchHistory(CHAT, "会议安排")[0]?.ref, "g:101");
  assert.equal(searchHistory(CHAT, "谁来审查")[0]?.ref, "g:104");
  assert.deepEqual(refs(searchHistory(CHAT, "部署到测试服")).sort(), ["g:103", "g:106"]);
  const hit = searchHistory(CHAT, "会议安排")[0];
  assert.equal(typeof hit?.score === "number" && hit.score > 0, true, "命中带正分");
  assert.match(hit?.preview ?? "", /会议/, "预览取自原文");
});

test("G3-01b 空查询、空集合、不相关的查询都返回空,不回退成整个集合", () => {
  assert.deepEqual(searchHistory(CHAT, ""), []);
  assert.deepEqual(searchHistory(CHAT, "   "), []);
  assert.deepEqual(searchHistory([], "会议安排"), []);
  assert.deepEqual(searchHistory(CHAT, "量子物理"), [], "没有命中就是空,不把整个集合当结果");
  assert.deepEqual(searchHistory(CHAT, "会议安排", 0), [], "limit 小于 1 返回空");
  const some = searchHistory(CHAT, "会议安排");
  assert.equal(some.length > 0 && some.length < CHAT.length, true, "对照:同一集合换成有命中的查询,只返回命中的几条");
});

test("G3-01c 同分按传入先后排,换个顺序传入结果跟着换;最多返回 limit 条", () => {
  const same: HistoryDoc[] = [
    { ref: "a", role: "user", text: "审查交给 Codex" },
    { ref: "b", role: "user", text: "审查交给 Codex" },
    { ref: "c", role: "user", text: "审查交给 Codex" },
    { ref: "x", role: "user", text: "周五一起吃饭" },
  ];
  const fwd = searchHistory(same, "审查");
  assert.deepEqual(refs(fwd), ["a", "b", "c"]);
  assert.equal(fwd[0]?.score, fwd[2]?.score, "三条同分");
  assert.deepEqual(refs(searchHistory([...same].reverse(), "审查")), ["c", "b", "a"]);
  assert.deepEqual(refs(searchHistory(same, "审查", 2)), ["a", "b"]);
  const mixed = searchHistory(CHAT, "部署到测试服", 10);
  for (let i = 0; i + 1 < mixed.length; i++) assert.equal(mixed[i]!.score >= mixed[i + 1]!.score, true, "分数从高到低");
});

test("G3-01d 只在传入的文档里排序:结果都来自传入集合;ref 重复直接报错,不让上游按 ref 合并时串文", () => {
  const sub = CHAT.filter((d) => d.ref !== "g:101");
  const hits = searchHistory(sub, "会议安排", 10);
  assert.equal(hits.every((h) => sub.some((d) => d.ref === h.ref)), true);
  assert.equal(refs(hits).includes("g:101"), false, "调用方没给的(例如无权限、已撤回)不会出现");
  assert.throws(() => searchHistory([...CHAT, { ref: "g:101", role: "user", text: "重复编号" }], "会议安排"), /ref 重复/);
});
