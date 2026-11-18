import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOCK_LABELS, type BlockNo } from "@g-group/kernel";
import { fakeAnthropic, MODEL } from "../fixtures/history-provider.ts";
import { createPiContactMind } from "./mind.ts";

test("历史回读工具的原文进工具结果,不进小于 4000 UTF-8 字节的缓存前缀", async () => {
  const model = fakeAnthropic([{ calls: [{ name: "query_history", input: { roomId: "g1", seq: 7 } }] }, { text: "已阅" }]);
  const mind = createPiContactMind({ provider: "fake", model: MODEL, baseUrl: "http://fake-anthropic.invalid", apiKey: "k", fetch: model.fetch });
  const prefix = `系统\n${"界".repeat(1330)}`;
  const blocks = ([1, 2, 3, 4, 5] as const).map((block: BlockNo) => ({ block, label: BLOCK_LABELS[block], text: block === 1 ? prefix : `第${block}块`, cacheBreakpoint: block === 1 }));
  const recalled = `OLD_G1_7 ${"旧历史".repeat(1900)}`;
  assert.deepEqual(await mind.round({ contact: { id: "c1", name: "联系人", speakingModel: MODEL, persona: "" }, request: { blocks, basedOnSeq: { g1: 8 } }, fresh: [] }, new AbortController().signal, { readMemory: async () => null, queryHistory: async () => recalled }), { actions: [], stateNote: null });
  assert.equal(model.seen.length, 2);
  assert.deepEqual(model.seen[0]?.system, model.seen[1]?.system);
  const wirePrefix = model.seen[1]?.system?.map((block) => block.text).join("") ?? "";
  assert.equal(wirePrefix, prefix);
  assert.ok(Buffer.byteLength(wirePrefix) < 4000);
  assert.match(JSON.stringify(model.seen[1]?.messages.at(-1)?.content), /OLD_G1_7/);
});
