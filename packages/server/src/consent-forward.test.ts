// AC-20(U99、R-10):授权只来自用户本人的直接表态——转发块里的「同意」不放行。
// 阴性对照在同一个测试里:同一房间里用户本人直接回的「同意」照常放行,证明待授权本身有效、拒收来自「这条是转发」这件事,
// 不是「什么都没放行」。拒收原因由宿主记在 report 通道(consent-forwarded),这是这条守卫唯一的可观察面。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-consent-fwd-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `c${++n}.db`);
const RULE = "改代码前先问我";
async function settle(host: Host, compute: { drained(): boolean }) {
  for (let i = 0; i < 200; i++) {
    await host.loop.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (compute.drained() && !host.loop.busy()) return;
  }
  throw new Error("宿主没有安静下来");
}

test("AC-20 转发块里的「同意」不放行;阴性对照:本人直接回的「同意」才放行", async () => {
  const compute = scriptedCompute({
    script: () => [
      { kind: "started", sessionId: "s", resumed: false },
      { kind: "blocked", needs: "要改 app.ts 加导出函数", summary: "读完了,准备改 app.ts" },
    ],
    resumeScript: () => [{ kind: "milestone", stage: "写文件", summary: "写好 app.ts" }, { kind: "completed", result: "app.ts 已加导出" }],
  });
  const reports: { what: string; detail: unknown }[] = [];
  const host = new Host({ file: file(), mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5, onReport: (what, detail) => reports.push({ what, detail }) });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  host.updateRoom(g.id, { rules: RULE });
  host.send({ roomId: g.id, clientActionId: "u1", text: "帮我给 app.ts 加个导出", mentions: [{ id: c.id, source: "manual" }] });
  await settle(host, compute);
  const task = () => host.listTasks({ roomId: g.id })[0]!;
  assert.equal(task().state, "T4b_BlockedOnHuman", "群规要求先问:停下来等本人授权");
  assert.equal(task().authorizations?.[0]?.state, "pending");

  // 用户在私聊里说过「同意」,再把那条转发到群里:转发的是旧记录,不是此刻的授权
  const said = host.send({ roomId: dm.id, clientActionId: "d1", text: "同意" });
  const fwd = host.forwardMessages({ fromRoomId: dm.id, seqs: [said.seq], toRoomId: g.id, clientActionId: "fw1" });
  await settle(host, compute);
  const refusals = reports.filter((r) => r.what === "consent-forwarded").map((r) => (r.detail as { seq: number }).seq);
  assert.deepEqual(refusals, [fwd.seq], "转发副本被授权判定拒收,原因记在 report 里");
  assert.equal(task().state, "T4b_BlockedOnHuman", "转发里的「同意」不放行,任务还停在等授权");
  assert.equal(task().authorizations?.[0]?.state, "pending");
  assert.equal(compute.resumed.length, 0, "没有续接 Compute,写工具没放开");

  // 阴性对照:本人直接在同一个房间里回「同意」——照常放行、续接并换上写工具
  host.send({ roomId: g.id, clientActionId: "u2", text: "同意" });
  await settle(host, compute);
  assert.notEqual(task().state, "T4b_BlockedOnHuman", "本人直接同意才离开等授权");
  assert.equal(task().authorizations?.[0]?.state, "granted");
  assert.equal(compute.resumed.length, 1, "续接同一个实例");
  assert.ok(compute.resumed[0]!.tools?.includes("Write"), "续接换上写工具");
  assert.deepEqual(reports.filter((r) => r.what === "consent-forwarded").map((r) => (r.detail as { seq: number }).seq), [fwd.seq], "本人自己的表态不算转发,不记拒收");
  compute.close();
  await host.close();
});
