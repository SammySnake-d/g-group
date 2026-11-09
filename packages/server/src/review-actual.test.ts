// AC-26「严禁只静态比对联系人说话模型而忽略审查 Compute 实际模型」:审查 Compute 完成时 harness 回报了实际用过的模型
// (常驻适配器 completed.models,来自 result 帧),宿主按实际模型判跨厂商门禁;实际模型与任一生产厂商同源或认不出 → 这次审查不算数,
// 记没做成、交给提出者豁免,绝不按下发的模型放行。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { reviewModelProblem } from "./review.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-review-actual-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `a${++fileNo}.db`);
const CLAUDE = "claude-sonnet-4-6";
const GPT = "agentrouter/gpt-6.1-sol";

async function settle(host: Host, ...computes: { drained(): boolean }[]) {
  for (let i = 0; i < 300; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (computes.every((c) => c.drained()) && !host.loop.busy()) {
      await new Promise((r) => setTimeout(r, 5));
      if (!host.loop.busy()) return;
    }
  }
  throw new Error("宿主没有安静下来");
}
/** 审查人配置的是 GPT;审查 Compute 完成时回报 actual 这些实际模型。H 是被测的宿主类。 */
async function reviewWith(H: typeof Host, actual: string[]) {
  const exec = scriptedCompute({ modelAware: false });
  const review = scriptedCompute({ modelAware: false, idPrefix: "rv", script: () => [{ kind: "started", sessionId: "rv", resumed: false }, { kind: "completed", result: "APPROVE\n看过了", models: actual }] as never });
  const host = new H({ file: file(), mind: () => scriptedMind(), compute: (m) => (m === CLAUDE ? exec.adapter : review.adapter), maxDeferMs: 5 });
  host.updateSettings({ defaultSpeakingModel: CLAUDE, defaultComputeModel: CLAUDE });
  const owner = host.createContact({ name: "小克" });
  host.createContact({ name: "小审", computeModel: { mode: "explicit", model: GPT } });
  const dm = host.openDm(owner.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await settle(host, exec, review);
  const [task] = host.listTasks({ roomId: dm.id });
  const done = async () => {
    exec.close();
    review.close();
    await host.close();
  };
  return { host, dm, task: host.taskView(host.taskDoc(task!.id).value), done };
}

test("AC-26 审查 Compute 回报的实际模型与生产厂商同源 → 不算合规通过,记没做成并交给提出者豁免", async () => {
  const w = await reviewWith(Host, ["claude-haiku-4-5"]);
  assert.equal(w.task.state, "T5_InReview", "没有按下发的 GPT 放行");
  assert.equal(w.task.reviewGate, "none");
  assert.equal(w.task.reviews?.[0]?.status, "failed");
  assert.match(w.task.reviews?.[0]?.notes ?? "", /实际审查模型/);
  assert.match(w.task.reviews?.[0]?.notes ?? "", /claude-haiku-4-5/);
  assert.match(w.host.listMessages(w.dm.id, {}).messages.at(-1)!.text, /审查没做成/);
  await w.done();
});

test("AC-26 实际审查模型里有一个认不出厂商(unknown)→ 同样不放行", async () => {
  const w = await reviewWith(Host, [GPT, "stealth/crouton-alpha"]);
  assert.equal(w.task.state, "T5_InReview");
  assert.equal(w.task.reviews?.[0]?.status, "failed");
  assert.match(w.task.reviews?.[0]?.notes ?? "", /stealth\/crouton-alpha/);
  await w.done();
});

test("AC-26 回报的实际模型合格 → 以实际模型判门禁,审查记录里记实际模型", async () => {
  const w = await reviewWith(Host, ["gpt-6-astra"]);
  assert.equal(w.task.state, "T8a_Delivered");
  assert.equal(w.task.reviewGate, "compliant");
  assert.deepEqual(w.task.reviews?.map((r) => [r.model, r.vendor, r.status]), [["gpt-6-astra", "openai", "approved"]]);
  await w.done();
});

test("reviewModelProblem:每个实际模型都要认得出厂商且不在生产厂商里;有问题返回说明,合格返回 null", () => {
  assert.equal(reviewModelProblem(["gpt-6-astra"], [CLAUDE]), null);
  assert.equal(reviewModelProblem(["gpt-6-astra", "gemini-3-pro"], [CLAUDE]), null);
  assert.match(reviewModelProblem(["gpt-6-astra", "claude-haiku-4-5"], [CLAUDE]) ?? "", /claude-haiku-4-5.*anthropic/);
  assert.match(reviewModelProblem(["stealth/x"], [CLAUDE]) ?? "", /stealth\/x.*认不出/);
  assert.match(reviewModelProblem(["gpt-6-astra"], ["gpt-6.1-terra", CLAUDE]) ?? "", /openai/, "累积生产厂商里有 openai");
  assert.match(reviewModelProblem([], [CLAUDE]) ?? "", /没有/);
});
