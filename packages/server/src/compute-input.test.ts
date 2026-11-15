// 给 harness 的单次输入上限(需求文档 v3.20 §8.1 待决 13,用户 g-group#3523/#3537:mirasim 一次塞给 harness 超大 prompt,一进来就压缩、压缩后又满)。
// 只做接口与可配参数,不拍数字:宿主选项 computeInputMaxBytes 不给就不设上限;给了,派活说明或转交的补充超过它就显式拒绝,不截断、不悄悄塞进去。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { MindAction, RoundInput } from "@g-group/kernel";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-cap-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let no = 0;
const file = () => path.join(dir, `c${++no}.db`);
async function settle(host: Host, compute: { drained(): boolean }) {
  for (let i = 0; i < 300; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (compute.drained() && !host.loop.busy()) return;
  }
  throw new Error("宿主没有安静下来");
}
const LONG = "很长的任务说明".repeat(20);
const mind = (seen: RoundInput[]) => () => ({
  async round(i: RoundInput) {
    seen.push(i);
    const actions: MindAction[] = [];
    for (const f of i.fresh) {
      if (f.kind === "message" && f.text.startsWith("派")) actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: "活", task: f.text.slice(1) });
      if (f.kind === "message" && f.text.startsWith("补")) {
        const [t] = i.request.blocks[4]!.text.match(/t-[a-z0-9-]+/) ?? [];
        if (t) actions.push({ kind: "forward", taskId: t, text: f.text.slice(1) });
      }
    }
    return { actions, stateNote: null };
  },
});

test("派活说明超过 computeInputMaxBytes:不起 Compute,任务失败并把原因(多少字节、上限多少、不截断)告诉联系人;没超的照常起", async () => {
  const seen: RoundInput[] = [];
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  const host = new Host({ file: file(), maxDeferMs: 5, mind: mind(seen), compute: () => compute.adapter, computeInputMaxBytes: 100 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: `派${LONG}` });
  await settle(host, compute);
  assert.equal(compute.spawned.length, 0, "超上限不起 Compute");
  const [t] = host.listTasks({ roomId: dm.id });
  assert.match(t!.state, /^T1[01]_/);
  const failed = seen.flatMap((s) => s.fresh).find((f) => f.kind === "compute" && f.signal === "failed");
  assert.ok(failed && failed.kind === "compute");
  assert.match(failed.summary, new RegExp(`${Buffer.byteLength(LONG, "utf8")} 字节[^]*上限 100 字节[^]*不截断`));
  host.send({ roomId: dm.id, clientActionId: "2", text: "派写个短的" });
  await settle(host, compute);
  assert.equal(compute.spawned.length, 1);
  assert.deepEqual((compute.spawned[0]!.brief as { task: string }).task, "写个短的");
  compute.close();
  await host.close();
});

test("转交给在途 Compute 的补充超过上限:整条拒收并报告,不截断转交;没超的照常转交;不设上限时长说明照常起", async () => {
  const seen: RoundInput[] = [];
  const reports: [string, unknown][] = [];
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  const host = new Host({ file: file(), maxDeferMs: 5, mind: mind(seen), compute: () => compute.adapter, computeInputMaxBytes: 100, onReport: (w, d) => reports.push([w, d]) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "1", text: "派短活" });
  await settle(host, compute);
  host.send({ roomId: dm.id, clientActionId: "2", text: `补${LONG}` });
  await settle(host, compute);
  assert.equal(compute.resumed.length, 0, "超上限不转交");
  assert.ok(reports.some(([w, d]) => w === "action-rejected" && /上限 100 字节/.test(JSON.stringify(d))));
  host.send({ roomId: dm.id, clientActionId: "3", text: "补用 UTF-8" });
  await settle(host, compute);
  assert.deepEqual(compute.resumed.map((r) => r.text), ["用 UTF-8"]);
  compute.close();
  await host.close();
  const free = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
  const h2 = new Host({ file: file(), maxDeferMs: 5, mind: mind([]), compute: () => free.adapter });
  const c2 = h2.createContact({ name: "小克" });
  const dm2 = h2.openDm(c2.id);
  h2.send({ roomId: dm2.id, clientActionId: "1", text: `派${LONG}` });
  await settle(h2, free);
  assert.equal(free.spawned.length, 1, "不给上限就不设上限(数字待用户定)");
  free.close();
  await h2.close();
  const exact = Buffer.byteLength("写个短的", "utf8");
  for (const [cap, want] of [[exact, 1], [exact - 1, 0]] as const) {
    const cc = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }] });
    const h = new Host({ file: file(), maxDeferMs: 5, mind: mind([]), compute: () => cc.adapter, computeInputMaxBytes: cap });
    const k = h.createContact({ name: "小克" });
    h.send({ roomId: h.openDm(k.id).id, clientActionId: "1", text: "派写个短的" });
    await settle(h, cc);
    assert.equal(cc.spawned.length, want, `上限 ${cap} 字节、说明 ${exact} 字节:恰好等于上限可以,多 1 字节不行`);
    cc.close();
    await h.close();
  }
});
