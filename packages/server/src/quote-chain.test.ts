// 引用链接进联系人一轮(需求文档 D24;验收 AC-41):带引用的新消息在第 5 块(新消息之后,不进前缀)附引用链,
// 直接引用已由引用召回换入的标 in_context;撤回的不给原文也不越过;read_quote_parent 在本轮内往上读一级。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { RoundInput, RoundTools } from "@g-group/kernel";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-qc-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let no = 0;
const file = () => path.join(dir, `q${++no}.db`);
async function settle(host: Host) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (!host.loop.busy()) return;
  }
  throw new Error("宿主没有安静下来");
}
const quiet = (reqs: RoundInput["request"][], onTools?: (t: RoundTools | undefined, i: RoundInput) => Promise<void>) => () => ({
  async round(i: RoundInput, _s: AbortSignal, tools?: RoundTools) {
    reqs.push(i.request);
    await onTools?.(tools, i);
    return { actions: [], stateNote: null };
  },
});

test("带引用的新消息:第 5 块附引用链(前 3 级、每级标状态与有无上一级、整条深度与下一级);直接引用已换入的标 in_context;前缀不变", async () => {
  const reqs: RoundInput["request"][] = [];
  const host = new Host({ file: file(), maxDeferMs: 5, mind: quiet(reqs) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const seqs: number[] = [];
  for (let i = 1; i <= 5; i++) {
    const m = host.send({ roomId: dm.id, clientActionId: `m${i}`, text: `第${i}句话`, replyToSeq: seqs.at(-1) ?? null });
    seqs.push(m.seq);
    await settle(host);
  }
  assert.deepEqual(host.listMessages(dm.id, {}).messages.map((m) => m.replyToSeq), [null, ...seqs.slice(0, 4)], "五句依次回复上一句");
  const last = reqs.at(-1)!;
  const b5 = last.blocks[4]!.text;
  assert.match(b5, new RegExp(`引用链 depth_total=4 · truncated=true · next_seqs=#${seqs[0]}\\n`));
  assert.match(b5, new RegExp(`L1 #${seqs[3]} · 我 · [^\\n]* · via #${seqs[4]} · in_context\\n`), "直接引用已由召回换入,不重复贴");
  assert.match(b5, new RegExp(`L2 #${seqs[2]} · 我 · [^\\n]* · via #${seqs[3]} · inline\\n第3句话\\n`));
  assert.match(b5, new RegExp(`L3 #${seqs[1]} · 我 · [^\\n]* · via #${seqs[2]} · inline · has_more_above\\n第2句话\\n\\n(?:〔|$)`), "引用链到此为止,后面紧接下一条指针或块尾");
  assert.equal(last.blocks[0]!.text, reqs[0]!.blocks[0]!.text, "引用链不进第 1 块");
  assert.doesNotMatch(last.blocks[3]!.text, /引用链/, "不改第 4 块新消息原文");
  assert.doesNotMatch(reqs[0]!.blocks[4]!.text, /引用链/, "不带引用的消息没有引用链");
  await host.close();
});

test("撤回的一级只给占位、不给原文,也不越过它往上走", async () => {
  const reqs: RoundInput["request"][] = [];
  const host = new Host({ file: file(), maxDeferMs: 5, mind: quiet(reqs) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const a = host.send({ roomId: dm.id, clientActionId: "a", text: "最早一句" });
  const b = host.send({ roomId: dm.id, clientActionId: "b", text: "NEUTRAL_FIXTURE_NO_CREDENTIALS 中间这句", replyToSeq: a.seq });
  const d = host.send({ roomId: dm.id, clientActionId: "d", text: "第三句", replyToSeq: b.seq });
  await settle(host);
  host.retractMessage(dm.id, b.seq);
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "e", text: "回第三句", replyToSeq: d.seq });
  await settle(host);
  const all = reqs.at(-1)!.blocks.map((x) => x.text).join("");
  assert.doesNotMatch(all, /NEUTRAL_FIXTURE/);
  assert.match(all, new RegExp(`L2 #${b.seq} · 我 · [^\\n]* · via #${d.seq} · deleted_or_withdrawn\\n\\n(?:〔|$)`));
  assert.doesNotMatch(all, /最早一句/, "不越过撤回的一级");
  await host.close();
});

test("read_quote_parent:本轮内往上读一级,只返回直接上一级;别的会话的消息读不到", async () => {
  const got: (string | null)[] = [];
  let otherRoom = "";
  const host = new Host({
    file: file(), maxDeferMs: 5,
    mind: quiet([], async (tools, i) => {
      const m = i.fresh.find((f) => f.kind === "message");
      if (m?.kind !== "message" || m.text !== "读") return;
      const read = tools?.readQuoteParent;
      got.push(read ? await read(m.roomId, m.replyToSeq ?? 0) : "本轮没有 readQuoteParent 查询口");
      got.push(read ? await read(otherRoom, 1) : "本轮没有 readQuoteParent 查询口");
    }),
  });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const c2 = host.createContact({ name: "小前" });
  otherRoom = host.openDm(c2.id).id;
  host.send({ roomId: otherRoom, clientActionId: "x", text: "别的私聊" });
  const a = host.send({ roomId: dm.id, clientActionId: "a", text: "祖父句" });
  const b = host.send({ roomId: dm.id, clientActionId: "b", text: "父句", replyToSeq: a.seq });
  const d = host.send({ roomId: dm.id, clientActionId: "d", text: "子句", replyToSeq: b.seq });
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "r", text: "读", replyToSeq: d.seq });
  await settle(host);
  assert.match(got[0] ?? "", new RegExp(`^L1 #${b.seq} · 我 · [^\\n]* · via #${d.seq} · inline · has_more_above\\n父句\\n$`));
  assert.doesNotMatch(got[0] ?? "", /祖父句/, "只走一级");
  assert.equal(got[1], null);
  await host.close();
});

test("私聊 rewind 撤下的消息在引用链里当看不见:不给原文,也不越过它往上走", async () => {
  const reqs: RoundInput["request"][] = [];
  const host = new Host({ file: file(), maxDeferMs: 5, mind: quiet(reqs) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const a = host.send({ roomId: dm.id, clientActionId: "a", text: "回退点之前的一句" });
  await settle(host);
  const b = host.send({ roomId: dm.id, clientActionId: "b", text: "NEUTRAL_FIXTURE_NO_CREDENTIALS 被撤下的一句", replyToSeq: a.seq });
  await settle(host);
  host.rewind({ roomId: dm.id, toSeq: a.seq, clientActionId: "rw" });
  await settle(host);
  host.send({ roomId: dm.id, clientActionId: "c", text: "接着说", replyToSeq: b.seq });
  await settle(host);
  const all = reqs.at(-1)!.blocks.map((x) => x.text).join("");
  assert.doesNotMatch(all, /NEUTRAL_FIXTURE/);
  assert.match(all, new RegExp(`L1 #${b.seq} · \\? · [^\\n]*· via #\\d+ · not_visible\\n\\n(?:〔|$)`));
  assert.doesNotMatch(all, new RegExp(`L2 #${a.seq}`), "不越过它往上走");
  await host.close();
});
