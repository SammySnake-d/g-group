import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ContactMind, MindAction, RoundInput } from "@g-group/kernel";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";

test("Compute 完成本轮的会话应显示待交付，而不是谎称等用户回答", { timeout: 5000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-completed-run-label-"));
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "completed", result: "结果文件已写好" }] });
  const seen: RoundInput[] = [];
  const mind: ContactMind = {
    async round(input) {
      seen.push(input);
      const actions: MindAction[] = [];
      for (const f of input.fresh) if (f.kind === "message" && f.sender.kind === "user") actions.push({ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: "写结果", task: "写结果" });
      return { actions, stateNote: null };
    },
  };
  const host = new Host({ file: path.join(dir, "db"), mind: () => mind, compute: () => compute.adapter, maxDeferMs: 5, retry: { baseDelayMs: 5, maxDelayMs: 10, jitter: 0 } });
  try {
    const contact = host.createContact({ name: "联系人" });
    const room = host.openDm(contact.id);
    host.send({ roomId: room.id, clientActionId: "request", text: "请写结果" });
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && !seen.some((x) => x.fresh.some((f) => f.kind === "compute" && f.signal === "completed"))) await new Promise((resolve) => setTimeout(resolve, 10));
    const round = seen.find((x) => x.fresh.some((f) => f.kind === "compute" && f.signal === "completed"));
    assert.ok(round, "应收到完成事件");
    const session = host.listRuns({ roomId: room.id }).runs.find((r) => r.layer === "compute-session");
    assert.ok(session, "应有 Compute 会话");
    assert.equal(session.status, "waiting_user", "会话保持可续接，不能冒充任务已验收");
    assert.match(session.text, /Compute 已完成.*交付/, "会话状态要区分完成待交付与等待用户回答");
    assert.doesNotMatch(session.text, /等你回答/);
    const modelContext = round.request.blocks.find((b) => b.block === 5)!.text;
    assert.match(modelContext, /Compute 已完成.*交付/, "联系人看到的运行台账也要准确");
    assert.doesNotMatch(modelContext, /等你回答/, "没有提问时不能误导联系人等用户回答");
    assert.equal(host.listTasks({ roomId: room.id })[0]?.state, "T3_Running", "执行完成不等于交付或用户验收");
  } finally {
    compute.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
