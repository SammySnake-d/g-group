import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ContactMind, MindAction, RoundInput } from "@g-group/kernel";
import { scriptedCompute } from "./fakes.ts";
import { Host } from "./host.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(what: string, condition: () => boolean) {
  const end = Date.now() + 4000;
  while (!condition() && Date.now() < end) await sleep(5);
  assert.ok(condition(), `等不到:${what}`);
}

/** 第 1 块是通用固定前缀；只从后续的实际请求块找本任务的交付提示。 */
function taskDeliveryPrompt(input: RoundInput, taskId: string): string {
  return input.request.blocks.filter((b) => b.block !== 1 && b.text.includes(taskId) && /deliver/i.test(b.text)).map((b) => b.text).join("\n");
}

const dispatch = (input: RoundInput): MindAction[] => input.fresh.flatMap((f): MindAction[] =>
  f.kind === "message" && f.sender.kind === "user" && f.text === "请写结果"
    ? [{ kind: "dispatch", roomId: f.roomId, sourceSeq: f.seq, title: "写结果", task: "写结果" }]
    : [],
);

test("有效 completed 首次和自动重试都给本任务的交付提示；无用户消息不伪造", { timeout: 6000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-delivery-prompt-"));
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "completed", result: "结果文件已写好" }] });
  const seen: RoundInput[] = [];
  const mind: ContactMind = {
    async round(input) {
      seen.push(input);
      const completed = input.fresh.find((f) => f.kind === "compute" && f.signal === "completed");
      const n = seen.filter((s) => s.fresh.some((f) => f.kind === "compute" && f.signal === "completed")).length;
      return { actions: completed?.kind === "compute" && n === 2 ? [{ kind: "deliver", taskId: completed.taskId, text: "结果文件已写好" }] : dispatch(input), stateNote: null };
    },
  };
  const host = new Host({ file: path.join(dir, "host.db"), mind: () => mind, compute: () => compute.adapter, maxDeferMs: 5, retry: { baseDelayMs: 5, maxDelayMs: 10, jitter: 0 } });
  try {
    const contact = host.createContact({ name: "联系人" });
    const room = host.openDm(contact.id);
    host.send({ roomId: room.id, clientActionId: "prompt-first", text: "请写结果" });
    await until("第二次完成轮次交付", () => host.listTasks({ roomId: room.id })[0]?.state === "T8a_Delivered");
    await host.idle();
    const task = host.listTasks({ roomId: room.id })[0]!;
    const rounds = seen.filter((s) => s.fresh.some((f) => f.kind === "compute" && f.signal === "completed" && f.taskId === task.id));
    assert.equal(rounds.length, 2, "首次无动作后只自动重试一次");
    for (const [n, input] of rounds.entries()) {
      assert.ok(taskDeliveryPrompt(input, task.id), `第 ${n + 1} 次完成轮次未向模型提供针对该任务的 deliver 提示`);
      assert.ok(!input.fresh.some((f) => f.kind === "message" && f.sender.kind === "user"), "提示不得伪造用户消息");
      assert.equal(input.request.blocks[0]!.text, rounds[0]!.request.blocks[0]!.text, "任务相关提示不得改动固定前缀");
    }
    assert.equal(host.listMessages(room.id, {}).messages.filter((m) => m.text === "结果文件已写好").length, 1);
  } finally {
    compute.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("普通消息、进度事件和取消后的迟到 completed 不得产生交付提示", { timeout: 6000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gg-delivery-prompt-negative-"));
  const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "milestone", stage: "写入", summary: "正在写" }] });
  const seen: RoundInput[] = [];
  const host = new Host({
    file: path.join(dir, "host.db"),
    mind: () => ({ async round(input) { seen.push(input); return { actions: dispatch(input), stateNote: null }; } }),
    compute: () => compute.adapter,
    maxDeferMs: 5,
  });
  try {
    const contact = host.createContact({ name: "联系人" });
    const room = host.openDm(contact.id);
    host.send({ roomId: room.id, clientActionId: "prompt-negative", text: "请写结果" });
    await until("进度轮次", () => seen.some((s) => s.fresh.some((f) => f.kind === "compute" && f.signal === "milestone")));
    await host.idle();
    const task = host.listTasks({ roomId: room.id })[0]!;
    const computeId = compute.spawned[0]!.computeId;
    for (const input of seen) assert.equal(taskDeliveryPrompt(input, task.id), "", "普通消息或进度不能冒充完成交付");
    host.taskDecision(task.id, "cancel", "prompt-cancel");
    await until("取消任务", () => host.listTasks({ roomId: room.id })[0]?.state === "T10_Cancelled");
    compute.emit({ computeId, kind: "completed", result: "迟到旧结果" });
    await until("迟到完成轮次", () => seen.some((s) => s.fresh.some((f) => f.kind === "compute" && f.signal === "completed" && f.summary === "迟到旧结果")));
    const late = seen.find((s) => s.fresh.some((f) => f.kind === "compute" && f.signal === "completed" && f.summary === "迟到旧结果"))!;
    assert.equal(taskDeliveryPrompt(late, task.id), "", "已取消任务的迟到结果不能提示交付");
    assert.notEqual(host.listTasks({ roomId: room.id })[0]!.state, "T8a_Delivered");
  } finally {
    compute.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const decision of ["forward", "stop"] as const) {
  test(`完成后联系人仍可选择 ${decision} 而不强制交付`, { timeout: 6000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), `gg-delivery-prompt-${decision}-`));
    const compute = scriptedCompute({
      script: () => [{ kind: "started", sessionId: "s", resumed: false }, { kind: "completed", result: "首版结果" }],
      resumeScript: () => [{ kind: "completed", result: "补充后的结果" }],
    });
    let n = 0;
    const host = new Host({
      file: path.join(dir, "host.db"),
      mind: () => ({
        async round(input) {
          const completed = input.fresh.find((f) => f.kind === "compute" && f.signal === "completed");
          if (completed?.kind !== "compute") return { actions: dispatch(input), stateNote: null };
          n++;
          const action: MindAction = n === 1
            ? decision === "forward" ? { kind: "forward", taskId: completed.taskId, text: "再核对一遍" } : { kind: "stop", taskId: completed.taskId }
            : { kind: "deliver", taskId: completed.taskId, text: "补充后的结果" };
          return { actions: [action], stateNote: null };
        },
      }),
      compute: () => compute.adapter,
      maxDeferMs: 5,
    });
    try {
      const contact = host.createContact({ name: "联系人" });
      const room = host.openDm(contact.id);
      host.send({ roomId: room.id, clientActionId: `prompt-${decision}`, text: "请写结果" });
      const expected = decision === "forward" ? "T8a_Delivered" : "T10_Cancelled";
      await until(`任务进入 ${expected}`, () => host.listTasks({ roomId: room.id })[0]?.state === expected);
      if (decision === "forward") assert.deepEqual(compute.resumed.map((r) => r.text), ["再核对一遍"]);
      else assert.equal(host.listTasks({ roomId: room.id })[0]?.deliveredSeq ?? null, null, "取消任务不应伪造交付");
    } finally {
      compute.close();
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
