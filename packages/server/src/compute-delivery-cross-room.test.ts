import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";

test("群任务未交付的失败卡不能阻塞同一联系人的私聊，群任务仍可恢复交付", { timeout: 6000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-delivery-cross-room-"));
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "completed", result: "群任务结果" }] });
  let ready = false;
  const mind: ContactMind = {
    async round(input) {
      const actions: MindAction[] = [];
      for (const f of input.fresh) {
        if (f.kind === "message" && f.sender.kind === "user" && f.text === "请写结果") actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: "群任务", task: "写结果" });
        if (f.kind === "message" && f.sender.kind === "user" && f.text === "私聊你好") actions.push({ kind: "reply", roomId: f.roomId, text: "私聊收到", replyToSeq: f.seq });
        if (f.kind === "compute" && f.signal === "completed" && ready) actions.push({ kind: "deliver", taskId: f.taskId, text: "群任务交付" });
      }
      return { actions, stateNote: null };
    },
  };
  const host = new Host({ file: path.join(dir, "db"), mind: () => mind, compute: () => compute.adapter, maxDeferMs: 5, retry: { baseDelayMs: 5, maxDelayMs: 10, jitter: 0 } });
  try {
    const contact = host.createContact({ name: "联系人" });
    const group = host.createGroup("群", [{ kind: "contact", id: contact.id }]);
    const dm = host.openDm(contact.id);
    host.send({ roomId: group.id, clientActionId: "group-request", text: "请写结果", mentions: [{ id: contact.id, source: "manual" }] });
    let deadline = Date.now() + 1500;
    while (Date.now() < deadline && !host.listMessages(group.id, {}).messages.some((m) => m.card?.kind === "failure" && m.card.state === "open")) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(host.listMessages(group.id, {}).messages.some((m) => m.card?.kind === "failure" && m.card.state === "open"), "群里先出现未交付失败卡");
    host.send({ roomId: dm.id, clientActionId: "dm-request", text: "私聊你好" });
    deadline = Date.now() + 1500;
    while (Date.now() < deadline && !host.listMessages(dm.id, {}).messages.some((m) => m.text === "私聊收到")) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(host.listMessages(dm.id, {}).messages.filter((m) => m.text === "私聊收到").length, 1, "群失败不能吞掉或阻塞私聊回复");
    assert.equal(host.listTasks({ roomId: group.id })[0]?.state, "T3_Running", "不能伪造群任务交付");
    ready = true;
    host.send({ roomId: group.id, clientActionId: "group-retry", text: "请交付" });
    deadline = Date.now() + 1500;
    while (Date.now() < deadline && host.listTasks({ roomId: group.id })[0]?.state !== "T8a_Delivered") await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(host.listTasks({ roomId: group.id })[0]?.state, "T8a_Delivered", "群里的完成事件仍能恢复并交付");
    assert.equal(host.listMessages(group.id, {}).messages.filter((m) => m.text === "群任务交付").length, 1);
  } finally {
    compute.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
