import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";

test("完成后的无效转交重试有界，失败卡恢复后仅交付一次", { timeout: 5000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-rejected-limit-"));
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "completed", result: "已完成" }] });
  let completionRounds = 0;
  let ready = false;
  const mind: ContactMind = {
    async round(input) {
      const actions: MindAction[] = [];
      for (const f of input.fresh) {
        if (f.kind === "message" && f.sender.kind === "user" && f.text === "写结果") actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: "写结果", task: "写结果" });
        if (f.kind === "compute" && f.signal === "completed") {
          completionRounds++;
          actions.push(ready ? { kind: "deliver", taskId: f.taskId, text: "交付结果" } : { kind: "forward", taskId: f.taskId, sourceSeq: 999, text: "不存在的补充" });
        }
      }
      return { actions, stateNote: null };
    },
  };
  const host = new Host({ file: path.join(dir, "db"), mind: () => mind, compute: () => compute.adapter, maxDeferMs: 5, retry: { baseDelayMs: 5, maxDelayMs: 10, jitter: 0 } });
  try {
    const contact = host.createContact({ name: "联系人" });
    const room = host.openDm(contact.id);
    host.send({ roomId: room.id, clientActionId: "request", text: "写结果" });
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !host.listMessages(room.id, {}).messages.some((m) => m.card?.kind === "failure" && m.card.state === "open")) await new Promise((resolve) => setTimeout(resolve, 10));
    const cards = host.listMessages(room.id, {}).messages.filter((m) => m.card?.kind === "failure" && m.card.state === "open");
    assert.equal(cards.length, 1, "持续被拒必须有界重试并出失败卡");
    assert.equal(completionRounds, 2, "不能无界重试或吞掉完成事件");
    assert.equal(host.listTasks({ roomId: room.id })[0]?.state, "T3_Running");
    assert.equal(compute.resumed.length, 0);
    ready = true;
    host.cardAct({ roomId: room.id, seq: cards[0]!.seq, cardId: cards[0]!.card!.cardId, actionId: "retry", clientActionId: "retry" });
    await host.idle();
    assert.equal(host.listTasks({ roomId: room.id })[0]?.state, "T8a_Delivered");
    assert.equal(completionRounds, 3);
    assert.equal(host.listMessages(room.id, {}).messages.filter((m) => m.text === "交付结果").length, 1);
  } finally {
    compute.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
