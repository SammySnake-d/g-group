// G6 规则替身:理想读者——needs 在请求里就答对,不在就说看不到;检查只记陈述过的长期要求,问句与假设不记。
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReply } from "./capture.ts";
import { checkRequest, line, mkItem, roundRequest } from "./fixtures/build.ts";
import { createStandin, standinReply } from "./standin.ts";

const item = mkItem();
const round = (pointers: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model: "standin/rules-v1", tools: [{ name: "reply" }], system: "前缀", messages: [{ role: "user", content: [{ type: "text", text: roundRequest({ fresh: line(5, "周报要发到哪个邮箱来着?"), pointers }) }] }], ...extra });

test("追问时请求里有 needs 原文就答对,没有就答看不到", () => {
  const seen = parseReply(standinReply(item, round("记忆 m1:以后周报都发到 weekly@corp.example")));
  assert.equal(seen.stopReason, "tool_use");
  assert.deepEqual(seen.tools[0], { name: "reply", input: { roomId: "dm-1", text: "发到 weekly@corp.example。", replyToSeq: 5 } });
  const blind = parseReply(standinReply(item, round("(无)")));
  assert.deepEqual(blind.tools[0], { name: "reply", input: { roomId: "dm-1", text: "我这边看不到之前的内容,能再说一下吗?", replyToSeq: 5 } });
});

test("替身写有损笔记(只留最近两条用户原文),noNote 题不写笔记,plainText 追问不走 reply", () => {
  const r = parseReply(standinReply(item, round("(无)")));
  assert.deepEqual(r.tools[1], { name: "update_state_note", input: { note: "- 周报要发到哪个邮箱来着?" } });
  const noNote = parseReply(standinReply(mkItem({ standin: { noNote: true } }), round("(无)")));
  assert.deepEqual(noNote.tools.map((t) => t.name), ["reply"]);
  const plainItem = mkItem({ probes: [{ ...item.probes[0]!, needs: null, standin: { answer: "直接说出来", plainText: true } }] });
  const plain = parseReply(standinReply(plainItem, round("(无)")));
  assert.deepEqual([plain.text, plain.tools.map((t) => t.name)], ["直接说出来", ["update_state_note"]]);
});

test("同一轮工具往返之后收尾,不再调工具", () => {
  const after = JSON.stringify({ model: "m", tools: [{ name: "reply" }], messages: [{ role: "user", content: "x" }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "已登记" }] }] });
  const r = parseReply(standinReply(item, after));
  assert.deepEqual([r.stopReason, r.text, r.tools.length], ["end_turn", "好的。", 0]);
});

test("检查只记陈述过的长期要求:以后类给全局锚点,问句和假设不记,模型已写笔记时 note 为 null", () => {
  const material = line(1, "以后周报都发到 weekly@corp.example") + line(2, "假如以后都用英文会怎样?") + line(3, "记住,我的工位号是 A-7781");
  const req = JSON.stringify({ model: "m", system: '只输出 {"note", "memories": []}', messages: [{ role: "user", content: checkRequest(material) }] });
  const out = JSON.parse(parseReply(standinReply(item, req)).text) as { note: string | null; memories: { text: string; anchors: string[]; sourceSeq: number; evidence: string }[] };
  assert.deepEqual(
    out.memories.map((m) => [m.text, m.anchors, m.sourceSeq, m.evidence]),
    [
      ["以后周报都发到 weekly@corp.example", ["global"], 1, "以后周报都发到 weekly@corp.example"],
      ["记住,我的工位号是 A-7781", ["room:dm-1"], 3, "记住,我的工位号是 A-7781"],
    ],
  );
  assert.equal(out.note, "- 以后周报都发到 weekly@corp.example\n- 假如以后都用英文会怎样?\n- 记住,我的工位号是 A-7781");
  const written = JSON.stringify({ model: "m", system: '只输出 {"memories": []}', messages: [{ role: "user", content: `模型已写笔记(不要覆盖):\n- x\n${checkRequest(material)}` }] });
  assert.equal((JSON.parse(parseReply(standinReply(item, written)).text) as { note: unknown }).note, null);
});

test("替身端点只接 messages,其余 404", async () => {
  const f = createStandin(item);
  assert.equal((await f("http://g6-standin.invalid/v1/models", { method: "POST", body: "{}" })).status, 404);
  const r = await f("http://g6-standin.invalid/v1/messages?beta=true", { method: "POST", body: JSON.stringify({ model: "m", system: "你替一位联系人整理它的状态笔记", messages: [{ role: "user", content: line(1, "今天食堂的番茄炒蛋有点咸") }] }) });
  assert.equal(r.status, 200);
  assert.equal(parseReply(await r.text()).text, "- 今天食堂的番茄炒蛋有点咸");
});
