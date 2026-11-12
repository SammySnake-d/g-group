// G6 固定题集:v1 自检干净、摘要冻结;方案要求的题型都在;自检拒收复读即答对、needs 出现在问题里、重复原文等坏题。
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, fixtureDigest, loadFixtureSet, stepTexts, validateFixtureSet } from "./fixture.ts";
import { mkItem, mkSet } from "./fixtures/build.ts";

const V1 = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/set-v1.json");

test("题集 v1 自检干净,摘要是固定的 64 位十六进制,改一个字就变", () => {
  const set = loadFixtureSet(V1);
  assert.deepEqual(validateFixtureSet(set), []);
  const d = fixtureDigest(set);
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(fixtureDigest(loadFixtureSet(V1)), d);
  assert.notEqual(fixtureDigest({ ...set, fillers: [...set.fillers.slice(1), "改过的一句填充"] }), d);
});

test("规范化 JSON:键排序、去掉 undefined,数组保序", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: undefined, c: "x" }] }), '{"a":[2,{"c":"x"}],"b":1}');
});

test("题集 v1 含方案要求的题型、故障注入与禁入原文", () => {
  const set = loadFixtureSet(V1);
  const cats = new Set(set.items.flatMap((i) => i.probes.map((p) => p.category)));
  for (const c of ["untagged-detail", "negation", "ambiguity", "old-instruction", "retract", "edit", "cross-room"] as const) assert.ok(cats.has(c), `缺题型 ${c}`);
  assert.deepEqual([...new Set(set.items.flatMap((i) => i.faults.map((f) => f.fault)))].sort(), ["http-400", "malformed", "truncated"]);
  assert.equal(set.items.filter((i) => i.forbidden.length > 0).length, 3);
  assert.equal(set.items.length, 17);
});

test("自检拒收复读即答对、needs 出现在问题里、同题重复原文、编辑指向后面的步", () => {
  const echo = mkItem({ id: "E", probes: [{ ...mkItem().probes[0]!, expect: "邮箱" }] });
  const needs = mkItem({ id: "N", probes: [{ ...mkItem().probes[0]!, needs: "邮箱" }] });
  const dup = mkItem({ id: "D", steps: [{ op: "send", room: "dm", text: "今天食堂的番茄炒蛋有点咸" }, { op: "filler", room: "dm", count: 1 }, { op: "send", room: "dm", text: "周报要发到哪个邮箱来着?", probe: "P1" }] });
  const fwd = mkItem({ id: "F", steps: [{ op: "edit", room: "dm", step: 1, text: "改过" }, ...mkItem().steps] });
  assert.deepEqual(validateFixtureSet(mkSet([echo, needs, dup, fwd])), [
    "题 E 追问 P1 的 expect 命中了问题原文,复读就算答对",
    "题 N 追问 P1 的 needs 出现在问题原文里,读回判定无意义",
    "题 D 消息「今天食堂的番茄炒蛋有点咸」在同一题里出现两次,覆盖判定无法区分",
    "题 F 第 0 步 edit 指向的第 1 步不是同会话里更早发出的消息",
    "题 F 追问 P1 指向的第 2 步不是带同名 probe 的 send",
    "题 F 期望记忆 M1 的来源第 0 步不是发消息的步",
  ]);
});

test("填充句按题内出现顺序轮流取,同一题里不重复", () => {
  const item = mkItem({ steps: [{ op: "filler", room: "dm", count: 1 }, { op: "send", room: "dm", text: "中间插一句话呀" }, { op: "filler", room: "dm", count: 1 }] });
  const set = mkSet([item]);
  assert.deepEqual([stepTexts(set, item, 0), stepTexts(set, item, 1), stepTexts(set, item, 2)], [["今天食堂的番茄炒蛋有点咸"], ["中间插一句话呀"], ["楼下咖啡店换了新的菜单"]]);
});
