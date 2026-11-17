// slash 命令在输入框唤醒能力(用户 #719:像 Telegram 那样,不是只能在工具里点):/task 交活、/remind 建定时、/stop 停任务。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-slash-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `x${++n}.db`);
async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if ((!compute || compute.drained()) && !host.loop.busy()) return;
  }
  throw new Error("没安静下来");
}

test("/task 在群里自动 @ 目标联系人,它接活;没指定联系人被拒且消息不发出", async () => {
  const compute = scriptedCompute();
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const svc = createService(host);
  const a = host.createContact({ name: "A" });
  const b = host.createContact({ name: "B" });
  const g = host.createGroup("群", [{ kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  const bad = await svc.handle("messages.send", { roomId: g.id, clientActionId: "0", text: "/task 跑测试", command: { name: "task", args: { what: "跑测试" } } });
  assert.deepEqual(!bad.ok && [bad.error.code, bad.error.message], ["invalid_params", "/task 在群里要指定 contact"]);
  assert.equal(host.listMessages(g.id, {}).messages.length, 0);
  const ok = await svc.handle("messages.send", { roomId: g.id, clientActionId: "1", text: "帮我跑测试", command: { name: "task", args: { contact: b.id, what: "跑测试" } } });
  assert.ok(ok.ok);
  assert.deepEqual((ok.value as { mentions: unknown[] }).mentions, [{ id: b.id, source: "auto" }]);
  await settle(host, compute);
  assert.deepEqual(host.listTasks({ roomId: g.id }).map((t) => t.ownerContactId), [b.id]);
  compute.close();
  await host.close();
});

test("/remind 在私聊里给对方建 cron 定时(按设置里的时区);cron 不合格整条不发", async () => {
  const host = new Host({ file: file(), mind: () => scriptedMind(), maxDeferMs: 5 });
  const c = host.createContact({ name: "小秘" });
  const dm = host.openDm(c.id);
  assert.throws(() => host.send({ roomId: dm.id, clientActionId: "0", text: "/remind", command: { name: "remind", args: { cron: "0 25 * * *", what: "早报" } } }), /时字段「25」超出范围/);
  assert.equal(host.listMessages(dm.id, {}).messages.length, 0);
  host.send({ roomId: dm.id, clientActionId: "1", text: "/remind 0 8 * * * 早报", command: { name: "remind", args: { cron: "0 8 * * *", what: "早报" } } });
  const [s] = host.scheduler.list({ roomId: dm.id });
  assert.deepEqual(s && [s.contactId, s.cron, s.tz, s.prompt], [c.id, "0 8 * * *", "Asia/Shanghai", "早报"]);
  await settle(host);
  await host.close();
});

test("/stop 按标题找到进行中的任务并停掉 Compute;找不到如实报错", async () => {
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "帮我爬一下网站" });
  await settle(host, compute);
  assert.throws(() => host.send({ roomId: dm.id, clientActionId: "2", text: "/stop 数据库", command: { name: "stop", args: { task: "数据库" } } }), /没有进行中的任务「数据库」/);
  host.send({ roomId: dm.id, clientActionId: "3", text: "/stop 爬", command: { name: "stop", args: { task: "爬" } } });
  await settle(host, compute);
  assert.deepEqual(compute.stopped, ["cp-1"]);
  assert.equal(host.listTasks({})[0]?.state, "T10_Cancelled");
  compute.close();
  await host.close();
});
