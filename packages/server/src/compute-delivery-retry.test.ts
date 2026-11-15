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

test("未交付失败卡出现后,同会话新的用户指令仍能处理并交付", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-delivery-new-user-"));
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "completed", result: "结果文件已写好" }] });
  const mind: ContactMind = {
    async round(input) {
      const actions: MindAction[] = [];
      const deliver = input.fresh.some((f) => f.kind === "message" && f.sender.kind === "user" && f.text === "交付吧");
      for (const f of input.fresh) {
        if (f.kind === "message" && f.sender.kind === "user" && f.text === "请写结果") actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: "写结果", task: "写结果" });
        if (deliver && f.kind === "compute" && f.signal === "completed") actions.push({ kind: "deliver", taskId: f.taskId, text: `已完成:${f.summary}` });
      }
      return { actions, stateNote: null };
    },
  };
  const host = new Host({ file: path.join(dir, "host.db"), mind: () => mind, compute: () => compute.adapter, maxDeferMs: 5, retry: { baseDelayMs: 5, maxDelayMs: 10, jitter: 0 } });
  try {
    const contact = host.createContact({ name: "联系人" });
    const room = host.openDm(contact.id);
    host.send({ roomId: room.id, clientActionId: "new-user-1", text: "请写结果" });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !host.listMessages(room.id, {}).messages.some((m) => m.card?.kind === "failure")) await new Promise((r) => setTimeout(r, 5));
    const card = host.listMessages(room.id, {}).messages.find((m) => m.card?.kind === "failure");
    assert.ok(card, "应先观察到未交付失败卡");
    host.send({ roomId: room.id, clientActionId: "new-user-2", text: "交付吧" });
    await host.idle();
    assert.equal(host.listTasks({ roomId: room.id })[0]!.state, "T8a_Delivered");
    assert.equal(host.listMessages(room.id, {}).messages.find((m) => m.seq === card.seq)?.card?.state, "expired");
    assert.equal(host.listMessages(room.id, {}).messages.filter((m) => m.text === "已完成:结果文件已写好").length, 1);
  } finally {
    compute.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("交付期间来了取消指令:慢反思结束后旧交付不能越过新消息", { timeout: 4000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-delivery-stale-"));
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "completed", result: "结果文件已写好" }] });
  let inReflection!: () => void;
  let finishReflection!: () => void;
  const reflectionStarted = new Promise<void>((resolve) => { inReflection = resolve; });
  const reflectionRelease = new Promise<void>((resolve) => { finishReflection = resolve; });
  const mind: ContactMind = {
    async round(input) {
      const actions: MindAction[] = [];
      const cancelled = input.fresh.some((f) => f.kind === "message" && f.sender.kind === "user" && f.text === "不要交付，停下");
      for (const f of input.fresh) {
        if (f.kind === "message" && f.sender.kind === "user" && f.text === "请写结果") actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: "写结果", task: "写结果" });
        if (f.kind === "compute" && f.signal === "completed") actions.push(cancelled ? { kind: "stop", taskId: f.taskId } : { kind: "deliver", taskId: f.taskId, text: `已完成:${f.summary}` });
      }
      return { actions, stateNote: null };
    },
  };
  const host = new Host({
    file: path.join(dir, "host.db"), mind: () => mind, compute: () => compute.adapter, maxDeferMs: 5,
    compactor: () => ({
      async compact() { return "笔记"; },
      async reflect(req) {
        if (req.material.includes("结果文件已写好")) { inReflection(); await reflectionRelease; }
        return { note: "笔记", memories: [], personaSuggestion: null };
      },
    }),
  });
  try {
    const contact = host.createContact({ name: "联系人" });
    const room = host.openDm(contact.id);
    host.send({ roomId: room.id, clientActionId: "stale-1", text: "请写结果" });
    await reflectionStarted;
    host.send({ roomId: room.id, clientActionId: "stale-2", text: "不要交付，停下" });
    finishReflection();
    await host.idle();
    assert.equal(host.listMessages(room.id, {}).messages.filter((m) => m.text === "已完成:结果文件已写好").length, 0, "旧轮次不能在新指令后交付");
    assert.notEqual(host.listTasks({ roomId: room.id })[0]?.state, "T8a_Delivered");
  } finally {
    finishReflection();
    compute.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
