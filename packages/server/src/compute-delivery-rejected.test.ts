import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ContactMind, MindAction } from "@g-group/kernel";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";

test("Compute 完成后联系人转交无效来源被拒:完成事件保留,后续可交付", { timeout: 5000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-rejected-forward-"));
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "completed", result: "已写完" }] });
  let completions = 0;
  const reports: { what: string; detail: unknown }[] = [];
  const mind: ContactMind = {
    async round(input) {
      const actions: MindAction[] = [];
      for (const f of input.fresh) {
        if (f.kind === "message" && f.sender.kind === "user") actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: "写结果", task: "写结果" });
        if (f.kind === "compute" && f.signal === "completed") {
          completions++;
          actions.push(completions === 1 ? { kind: "forward", taskId: f.taskId, sourceSeq: 999, text: "不存在的补充" } : { kind: "deliver", taskId: f.taskId, text: "结果已写完" });
        }
      }
      return { actions, stateNote: null };
    },
  };
  const host = new Host({ file: path.join(dir, "db"), mind: () => mind, compute: () => compute.adapter, maxDeferMs: 5, retry: { baseDelayMs: 5, maxDelayMs: 10, jitter: 0 }, onReport: (what, detail) => reports.push({ what, detail }) });
  try {
    const contact = host.createContact({ name: "联系人" });
    const room = host.openDm(contact.id);
    host.send({ roomId: room.id, clientActionId: "request", text: "请写结果" });
    const until = Date.now() + 1000;
    while (Date.now() < until && host.listTasks({ roomId: room.id })[0]?.state !== "T8a_Delivered") await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(reports.some((r) => r.what === "action-rejected"), "第一轮的转交应被宿主拒绝");
    assert.equal(host.listTasks({ roomId: room.id })[0]?.state, "T8a_Delivered", "被拒绝的转交不能吞掉完成事件");
    assert.equal(completions, 2);
    assert.equal(host.listMessages(room.id, {}).messages.filter((m) => m.text === "结果已写完").length, 1);
    assert.equal(compute.resumed.length, 0, "无效来源不得续接 Compute");
  } finally {
    compute.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
