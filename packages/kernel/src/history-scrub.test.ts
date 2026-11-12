// 撤回原文的纯规则(T-177 G4b;G6 实测缺口 k1-g4on-R1:联系人回话里抄了用户原文,用户撤回后,原文经预取行回到第 5 块)。
// 一条可见消息的正文里可能抄了后来被撤回的原文(联系人回话、用户的另一条消息、引用副本都算),这些正文进请求前要过这里:
//   哪些文本算已撤回原文(retractedBodies)、抄来的原文怎么处理(scrubLineBody)——与状态笔记同一规则(scrubRetracted)。
import assert from "node:assert/strict";
import { test } from "node:test";
import { append, emptyLog, type Log } from "@g-group/domain";
import { RETRACT_PLACEHOLDER } from "./compact.ts";
import { retractedBodies, SCRUBBED_BODY, scrubLineBody } from "./history-tools.ts";

const AT = "2026-11-11T08:00:00.000Z";
const U = { kind: "user", id: "me" };
const C = { kind: "contact", id: "c1" };
const SECRET = "我的储物柜号码是 4471,钥匙放在前台";
function log(steps: readonly (["m", typeof U | typeof C, string] | ["e", number, string] | ["r", number])[]): Log {
  let l = emptyLog();
  for (const s of steps) {
    if (s[0] === "m") l = append(l, s[1], { kind: "message", text: s[2] }, AT);
    else if (s[0] === "e") l = append(l, U, { kind: "edit", target: s[1], text: s[2] }, AT);
    else l = append(l, U, { kind: "retract", target: s[1] }, AT);
  }
  return l;
}

test("已撤回原文的集合:消息本体与撤回前的每个编辑稿都在内;没撤回就是空", () => {
  const l = log([["m", U, SECRET], ["e", 1, "我的储物柜号码是 4471"], ["r", 1], ["m", U, "留着的一句"]]);
  assert.deepEqual(retractedBodies(l.events), [SECRET, "我的储物柜号码是 4471"], "本体与编辑稿都算撤回原文");
  assert.deepEqual(retractedBodies(log([["m", U, "留着的一句"]]).events), [], "没撤回就没有原文要扫");
  assert.deepEqual(retractedBodies(emptyLog().events), []);
  const l2 = log([["m", U, "甲的原文"], ["m", C, "回话"], ["r", 1]]);
  assert.deepEqual(retractedBodies(l2.events), ["甲的原文"], "撤回的是哪条就只算哪条");
});

test("正文里出现已撤回原文:只换掉那一段,别的字留着(联系人回话「收到:…」与用户自己的消息都算)", () => {
  const reply = scrubLineBody(`收到:${SECRET}`, [SECRET]);
  assert.equal(reply.text, `收到:${RETRACT_PLACEHOLDER}`);
  assert.equal(reply.scrubbed, true);
  assert.doesNotMatch(reply.text, /4471/);
  const mine = scrubLineBody(`补充一下,${SECRET},别忘了`, [SECRET]);
  assert.equal(mine.text, `补充一下,${RETRACT_PLACEHOLDER},别忘了`, "用户自己的正常消息只被换掉那一段,不被整体抹掉");
  const clean = scrubLineBody("今天食堂的番茄炒蛋有点咸", [SECRET]);
  assert.deepEqual([clean.text, clean.scrubbed], ["今天食堂的番茄炒蛋有点咸", false], "没抄到就没有改动");
  assert.deepEqual(scrubLineBody(SECRET, []).scrubbed, false, "没有撤回原文就原样返回");
  const short = scrubLineBody("好的,收到,稍后发你", ["好的"]);
  assert.deepEqual([short.text, short.scrubbed], ["好的,收到,稍后发你", false], "太短的撤回原文不换(与状态笔记同一规则)");
});

test("抄写时分了行或加了空格、精确替换不掉:整段隐去,不留半截", () => {
  // 抄来的原文后面还接着别的话:替换不掉时整段都隐去(不是只把抄来的那段删掉留个洞)
  const spaced = scrubLineBody("收到:我的储物柜号码是 4471, 钥匙放在前台,回头再说", [SECRET]);
  assert.equal(spaced.text, SCRUBBED_BODY);
  assert.equal(spaced.scrubbed, true);
  assert.doesNotMatch(spaced.text, /4471|钥匙|回头再说/);
  const split = scrubLineBody(`收到:\n我的储物柜号码是 4471,\n钥匙放在前台,回头再说`, [SECRET]);
  assert.doesNotMatch(split.text, /4471|钥匙|回头再说/);
  assert.equal(split.scrubbed, true);
});

test("短文本不扫(与状态笔记同一规则):撤回「好的」不会把别的消息里的「好的」一起抹掉", () => {
  const short = log([["m", U, "好的"], ["r", 1], ["m", C, "好的,收到,稍后发你"]]);
  assert.deepEqual(retractedBodies(short.events), ["好的"], "短文本仍在撤回原文集合里,只是不拿去扫");
  const other = scrubLineBody("好的,收到,稍后发你", retractedBodies(short.events));
  assert.deepEqual([other.text, other.scrubbed], ["好的,收到,稍后发你", false]);
  const long = log([["m", U, "好的没问题"], ["r", 1]]);
  const hit = scrubLineBody("收到,好的没问题", retractedBodies(long.events));
  assert.deepEqual([hit.text, hit.scrubbed], [`收到,${RETRACT_PLACEHOLDER}`, true], "够长的照常换掉");
});
