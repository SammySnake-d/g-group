// AC-54 联系人资料(U96/D28.3)的后端接口:一次给出联系人视图、预设(persona 原文)、工作记忆(状态笔记与版本)、
// 职责(进行中的承诺、在途任务、定时、所在会话)。预设与职责分开给(#1370 是否合并待确认);长期记忆(AC-42)只留位置。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ContactProfileView, ContactView } from "@g-group/api-contract";
import type { RoundInput } from "@g-group/kernel";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-prof-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if ((!compute || compute.drained()) && !host.loop.busy()) return;
  }
  throw new Error("没安静下来");
}

test("资料一次给出视图、预设、工作记忆与职责(承诺、在途任务、定时、所在会话)", async () => {
  let n = 0;
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  const host = new Host({
    file: path.join(dir, `p${++fileNo}.db`),
    mind: () => scriptedMind(),
    compute: () => compute.adapter,
    clockMs: () => Date.parse("2026-11-09T00:00:00Z"),
    timers: { set: () => 0, clear: () => {} },
    newId: (p) => `${p}-${String(++n).padStart(3, "0")}`,
    maxDeferMs: 5,
  });
  const svc = createService(host);
  const created = await svc.handle("contacts.create", { clientActionId: "c1", name: "小克", persona: "做事先给结论" });
  assert.ok(created.ok);
  const c = created.value as ContactView;
  const dm = host.openDm(c.id);
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  const sent = host.send({ roomId: dm.id, clientActionId: "m1", text: "帮我写周报" });
  await settle(host, compute);
  const sch = host.scheduler.create({ contactId: c.id, roomId: g.id, title: "早报", cron: "0 8 * * *", tz: "UTC", prompt: "总结" });
  const [task] = host.listTasks({ contactId: c.id });
  assert.ok(task);

  const r = await svc.handle("contacts.profile", { contactId: c.id });
  assert.ok(r.ok, JSON.stringify(r));
  const p = r.value as ContactProfileView;
  assert.deepEqual([p.contact.id, p.contact.name], [c.id, "小克"]);
  assert.equal(p.persona, "做事先给结论");
  assert.deepEqual(p.memory, { stateNote: { text: `处理到 ${dm.id} #${sent.seq}`, version: 1 }, longTerm: null });
  assert.deepEqual(p.duties.commitments.map((k) => [k.text, k.status, k.taskId, k.roomId]), [["写周报", "active", task.id, dm.id]]);
  assert.deepEqual(p.duties.tasks.map((t) => [t.id, t.state, t.title]), [[task.id, "T3_Running", "写周报"]]);
  assert.deepEqual(p.duties.schedules.map((s) => [s.id, s.roomTitle, s.contactName]), [[sch.id, "项目群", "小克"]]);
  assert.deepEqual(p.duties.rooms, [
    { roomId: dm.id, kind: "dm", title: "小克" },
    { roomId: g.id, kind: "group", title: "项目群" },
  ]);
  compute.close();
  await host.close();
});

test("改预设后资料与下一轮装配第 1 块都是新值;不存在的联系人 not_found", async () => {
  const reqs: RoundInput["request"][] = [];
  const host = new Host({ file: path.join(dir, `p${++fileNo}.db`), mind: () => scriptedMind({ onRound: (i: RoundInput) => reqs.push(i.request) }), maxDeferMs: 5 });
  const svc = createService(host);
  const c = host.createContact({ name: "小研", persona: "旧预设甲" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "第一句" });
  await settle(host);
  const up = await svc.handle("contacts.update", { contactId: c.id, persona: "新预设乙" });
  assert.ok(up.ok, JSON.stringify(up));
  const r = await svc.handle("contacts.profile", { contactId: c.id });
  assert.ok(r.ok);
  assert.equal((r.value as ContactProfileView).persona, "新预设乙");
  host.send({ roomId: dm.id, clientActionId: "2", text: "第二句" });
  await settle(host);
  assert.equal(reqs.length, 2);
  assert.match(reqs[0]!.blocks[0]!.text, /旧预设甲/);
  assert.match(reqs[1]!.blocks[0]!.text, /新预设乙/);
  assert.doesNotMatch(reqs[1]!.blocks[0]!.text, /旧预设甲/);
  const nf = await svc.handle("contacts.profile", { contactId: "c-none" });
  assert.equal(!nf.ok && nf.error.code, "not_found");
  await host.close();
});
