import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";

test("Compute 已完成但联系人首轮未交付:保留完成事件并有界重试,实际交付后仍等用户验收", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-delivery-retry-"));
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "completed", result: "结果文件已写好" }] });
  let completionRounds = 0;
  const mind: ContactMind = {
    async round(input) {
      const actions: MindAction[] = [];
      for (const f of input.fresh) {
        if (f.kind === "message" && f.sender.kind === "user") actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: "写结果", task: "写结果" });
        if (f.kind === "compute" && f.signal === "completed") {
          completionRounds++;
          if (completionRounds === 2) actions.push({ kind: "deliver", taskId: f.taskId, text: `已完成:${f.summary}` });
        }
      }
      return { actions, stateNote: null };
    },
  };
  const host = new Host({ file: path.join(dir, "host.db"), mind: () => mind, compute: () => compute.adapter, maxDeferMs: 5, retry: { baseDelayMs: 5, maxDelayMs: 10, jitter: 0 } });
  try {
    const contact = host.createContact({ name: "联系人" });
    const room = host.openDm(contact.id);
    const source = host.send({ roomId: room.id, clientActionId: "delivery-retry-1", text: "请写结果" });
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      await host.idle();
      if (compute.drained() && !host.loop.busy()) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const task = host.listTasks({ roomId: room.id })[0];
    assert.ok(task, "没有创建父任务");
    assert.equal(task.state, "T8a_Delivered", "未交付的完成事件不能被当作已处理");
    assert.equal(completionRounds, 2, "同一个完成事件应只重试一次");
    assert.ok(task.deliveredSeq, "实际交付后应有交付消息序号");
    const deliveries = host.listMessages(room.id, {}).messages.filter((message) => message.text === "已完成:结果文件已写好");
    assert.equal(deliveries.length, 1, "只发一次交付消息");
    assert.equal(deliveries[0]?.replyToSeq, source.seq);
  } finally {
    compute.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("完成事件两次都未交付:出可恢复失败卡,用户重试后只交付一次", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-delivery-card-"));
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "completed", result: "结果文件已写好" }] });
  let completionRounds = 0;
  let ready = false;
  const mind: ContactMind = {
    async round(input) {
      const actions: MindAction[] = [];
      for (const f of input.fresh) {
        if (f.kind === "message" && f.sender.kind === "user" && f.text === "请写结果") actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: "写结果", task: "写结果" });
        if (f.kind === "compute" && f.signal === "completed") {
          completionRounds++;
          if (ready) actions.push({ kind: "deliver", taskId: f.taskId, text: `已完成:${f.summary}` });
        }
      }
      return { actions, stateNote: null };
    },
  };
  const host = new Host({ file: path.join(dir, "host.db"), mind: () => mind, compute: () => compute.adapter, maxDeferMs: 5, retry: { baseDelayMs: 5, maxDelayMs: 10, jitter: 0 } });
  try {
    const contact = host.createContact({ name: "联系人" });
    const room = host.openDm(contact.id);
    host.send({ roomId: room.id, clientActionId: "delivery-card-1", text: "请写结果" });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !host.listMessages(room.id, {}).messages.some((m) => m.card?.kind === "failure")) await new Promise((r) => setTimeout(r, 5));
    const cards = host.listMessages(room.id, {}).messages.filter((m) => m.card?.kind === "failure");
    assert.equal(cards.length, 1, "耗尽有界重试后应出一张失败卡");
    assert.equal(completionRounds, 2);
    assert.match(cards[0]!.card!.body, /联系人尚未交付任务/);
    const pending = host.listTasks({ roomId: room.id })[0]!;
    assert.equal(pending.state, "T3_Running");
    assert.equal(pending.deliveredSeq ?? null, null, "不能把执行完成冒充交付");
    ready = true;
    host.cardAct({ roomId: room.id, seq: cards[0]!.seq, cardId: cards[0]!.card!.cardId, actionId: "retry", clientActionId: "delivery-card-retry" });
    await host.idle();
    const delivered = host.listTasks({ roomId: room.id })[0]!;
    assert.equal(delivered.state, "T8a_Delivered", "重试必须重新收到完成事件并等待用户验收");
    assert.equal(completionRounds, 3);
    assert.equal(host.listMessages(room.id, {}).messages.filter((m) => m.text === "已完成:结果文件已写好").length, 1);
  } finally {
    compute.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
