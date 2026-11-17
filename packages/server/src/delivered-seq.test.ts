// 交付消息序号(TaskView.deliveredSeq,原型 #1790「消息优先」):Compute 做完、联系人在会话里发了交付消息后,
// 任务视图带上那条消息的序号,界面据此把做完的 Compute 挂在交付消息下面;还没交付时为 null(不是缺字段)。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { TaskView } from "@g-group/api-contract";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-delivered-"));
after(() => rmSync(dir, { recursive: true, force: true }));
async function settle(host: Host, compute: { drained(): boolean }) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (compute.drained() && !host.loop.busy()) return;
  }
  throw new Error("没安静下来");
}
function boot(name: string, compute: ReturnType<typeof scriptedCompute>) {
  const host = new Host({ file: path.join(dir, `${name}.db`), dataDir: path.join(dir, `data-${name}`), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  return { host, svc: createService(host), dm };
}

test("联系人交付后,任务视图的 deliveredSeq 是那条交付消息的序号(列表、单查、推来的事件一致)", async () => {
  const compute = scriptedCompute();
  const { host, svc, dm } = boot("done", compute);
  const events: TaskView[] = [];
  host.bus.subscribe((e) => {
    if (e.type === "task.updated") events.push(e.task);
  });
  host.send({ roomId: dm.id, clientActionId: "m1", text: "帮我整理周报" });
  await settle(host, compute);
  const [task] = host.listTasks({ roomId: dm.id });
  assert.ok(task);
  const delivery = host.listMessages(dm.id, {}).messages.find((m) => m.sender.kind === "contact" && m.text.startsWith("做完了"));
  assert.ok(delivery, "联系人发了交付消息");
  assert.equal(task.deliveredSeq, delivery.seq, "列表里的任务指向交付消息");
  const got = await svc.handle("tasks.get", { taskId: task.id });
  assert.ok(got.ok, JSON.stringify(got));
  assert.equal((got.value as TaskView).deliveredSeq, delivery.seq, "经合同单查也带着(回包过了 schema 校验)");
  assert.equal(events.at(-1)?.deliveredSeq, delivery.seq, "最后一次 task.updated 也带着");
  compute.close();
  await host.close();
});

test("还没交付(Compute 还在做)时 deliveredSeq 为 null", async () => {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "milestone", stage: "动手", summary: "在整理" }] });
  const { host, svc, dm } = boot("running", compute);
  host.send({ roomId: dm.id, clientActionId: "m1", text: "帮我整理周报" });
  await settle(host, compute);
  const [task] = host.listTasks({ roomId: dm.id });
  assert.ok(task);
  assert.equal(task.state, "T3_Running");
  assert.equal(task.deliveredSeq, null);
  const listed = await svc.handle("tasks.list", { roomId: dm.id });
  assert.ok(listed.ok);
  assert.equal((listed.value as { tasks: TaskView[] }).tasks[0]?.deliveredSeq, null);
  compute.close();
  await host.close();
});
