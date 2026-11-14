// AC-57 文件列表与窗口联动的后端部分(U100/D28.7):files.list 列出会话里出现过的附件与任务产出,
// files.read 按 ref 给内容(文本 / base64,超过上限截断并标记),只能读用户所在会话里出现过的 ref。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { FileEntry } from "@g-group/api-contract";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-files-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const FIXTURE = "NEUTRAL_FIXTURE_NO_CREDENTIALS";
const AT = "2026-11-09T01:00:00.000Z";
async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if ((!compute || compute.drained()) && !host.loop.busy()) return;
  }
  throw new Error("没安静下来");
}
const opts = (name: string, compute: ReturnType<typeof scriptedCompute>) => ({ file: path.join(dir, `${name}.db`), dataDir: path.join(dir, `data-${name}`), now: () => AT, mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
function seed(host: Host, name: string) {
  const svc = createService(host);
  const txt = path.join(dir, `${name}-fixture.txt`);
  writeFileSync(txt, FIXTURE);
  const bin = path.join(dir, `${name}-blob.bin`);
  writeFileSync(bin, Buffer.from([0, 255, 1, 2]));
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  return { svc, txt, bin, c, dm };
}

test("发带附件的消息、完成一件任务后:list 按出现顺序给附件与任务产出,read 内容逐字节一致", async () => {
  const compute = scriptedCompute();
  const host = new Host(opts("ok", compute));
  const { svc, txt, bin, dm } = seed(host, "ok");
  const a1 = host.addAttachment(txt);
  const a2 = host.addAttachment(bin);
  const m = host.send({ roomId: dm.id, clientActionId: "m1", text: "看附件", attachments: [a1.ref, a2.ref] });
  await settle(host, compute);
  host.send({ roomId: dm.id, clientActionId: "m2", text: "帮我写报告" });
  await settle(host, compute);
  const [task] = host.listTasks({ roomId: dm.id });
  assert.ok(task);
  const result = host.taskDoc(task.id).value.result!;
  assert.equal(result, "做完了:完成:写报告");
  const delivery = host.listMessages(dm.id, {}).messages.find((x) => x.sender.kind === "contact" && x.text === result)!;

  const l = await svc.handle("files.list", { roomId: dm.id });
  assert.ok(l.ok, JSON.stringify(l));
  assert.deepEqual((l.value as { files: FileEntry[] }).files, [
    { ref: a1.ref, name: path.basename(txt), mime: "text/plain", bytes: FIXTURE.length, source: "attachment", seq: m.seq, taskId: null, at: AT },
    { ref: a2.ref, name: path.basename(bin), mime: "application/octet-stream", bytes: 4, source: "attachment", seq: m.seq, taskId: null, at: AT },
    { ref: `task:${task.id}/result`, name: "写报告 · 结果", mime: "text/plain", bytes: Buffer.byteLength(result), source: "task-result", seq: delivery.seq, taskId: task.id, at: AT },
  ]);

  const rt = await svc.handle("files.read", { ref: a1.ref });
  assert.deepEqual(rt, { ok: true, value: { ref: a1.ref, name: path.basename(txt), mime: "text/plain", bytes: FIXTURE.length, encoding: "text", content: FIXTURE, truncated: false } });
  const rb = await svc.handle("files.read", { ref: a2.ref });
  assert.ok(rb.ok);
  const vb = rb.value as unknown as { encoding: string; content: string; truncated: boolean };
  assert.deepEqual([vb.encoding, vb.truncated], ["base64", false]);
  assert.deepEqual(Buffer.from(vb.content, "base64"), readFileSync(bin));
  const rr = await svc.handle("files.read", { ref: `task:${task.id}/result` });
  assert.deepEqual(rr, { ok: true, value: { ref: `task:${task.id}/result`, name: "写报告 · 结果", mime: "text/plain", bytes: Buffer.byteLength(result), encoding: "text", content: result, truncated: false } });
  compute.close();
  await host.close();
});

test("超过上限截断并标记 truncated,bytes 仍是原大小", async () => {
  const compute = scriptedCompute();
  const host = new Host(opts("cut", compute));
  const { svc, txt, bin, dm } = seed(host, "cut");
  const a1 = host.addAttachment(txt);
  const a2 = host.addAttachment(bin);
  host.send({ roomId: dm.id, clientActionId: "m1", text: "看附件", attachments: [a1.ref, a2.ref] });
  await settle(host, compute);
  const r = await svc.handle("files.read", { ref: a1.ref, maxBytes: 7 });
  assert.ok(r.ok);
  const v = r.value as unknown as { content: string; truncated: boolean; bytes: number; encoding: string };
  assert.deepEqual([v.content, v.truncated, v.bytes, v.encoding], ["NEUTRAL", true, FIXTURE.length, "text"]);
  const exact = await svc.handle("files.read", { ref: a1.ref, maxBytes: FIXTURE.length });
  assert.ok(exact.ok);
  assert.deepEqual([(exact.value as unknown as { content: string }).content, (exact.value as unknown as { truncated: boolean }).truncated], [FIXTURE, false]);
  const b = await svc.handle("files.read", { ref: a2.ref, maxBytes: 3 });
  assert.ok(b.ok);
  const vb = b.value as unknown as { content: string; truncated: boolean };
  assert.deepEqual([Buffer.from(vb.content, "base64"), vb.truncated], [Buffer.from([0, 255, 1]), true]);
  compute.close();
  await host.close();
});

test("用户不在的会话里的 ref、没发出过的附件被拒(forbidden);不存在的 ref 与会话 not_found", async () => {
  const compute = scriptedCompute();
  const host = new Host(opts("deny", compute));
  const { svc, txt, bin, c, dm } = seed(host, "deny");
  const g = host.createGroup("旧群", [{ kind: "contact", id: c.id }]);
  const inGroup = host.addAttachment(txt);
  host.send({ roomId: g.id, clientActionId: "g1", text: "群里的附件", attachments: [inGroup.ref] });
  await settle(host, compute);
  assert.equal(((await svc.handle("files.read", { ref: inGroup.ref })) as { ok: boolean }).ok, true, "在群里时可读");
  host.removeMember(g.id, { kind: "user", id: "me" });
  const denied = await svc.handle("files.read", { ref: inGroup.ref });
  assert.equal(!denied.ok && denied.error.code, "forbidden");
  const listDenied = await svc.handle("files.list", { roomId: g.id });
  assert.equal(!listDenied.ok && listDenied.error.code, "forbidden");
  const unsent = host.addAttachment(bin);
  const u = await svc.handle("files.read", { ref: unsent.ref });
  assert.equal(!u.ok && u.error.code, "forbidden");
  const dmList = await svc.handle("files.list", { roomId: dm.id });
  assert.deepEqual(dmList, { ok: true, value: { files: [] } });
  for (const ref of ["att-0000", "task:t-none/result"]) {
    const nf = await svc.handle("files.read", { ref });
    assert.equal(!nf.ok && nf.error.code, "not_found", ref);
  }
  const nr = await svc.handle("files.list", { roomId: "g-none" });
  assert.equal(!nr.ok && nr.error.code, "not_found");
  compute.close();
  await host.close();
});
