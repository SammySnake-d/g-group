// AC-43 运行台账接到宿主(需求文档 D26 第 3–5、8 节)与 AC-14 卡住必有人推(I5 候选,只做底座和停滞事件):
//   ① 联系人轮次、Compute 会话、Compute 轮次、后台任务、子代理都进台账,状态由宿主从 harness 事件核对;宿主进程退出后重启,上次的 running 在启动核对时变 orphaned;
//   ③ 子单元在跑父单元不记 done;④ 联系人看到的范围由宿主按私聊 / 群机械过滤;⑤–⑦c 重跑规则;⑥⑧ 画板(runs.*)与联系人第 5 块读同一张台账;
//   ⑦ 卡死判失败(先停这一轮再写失败,带原因类别、原文、用时、最后进展、阈值);⑨⑮ 人停的与失败分色、同一上游同一原因合并;⑩⑪⑫⑯ 见各条。
// 用确定性替身驱动:脚本化联系人脑子、按剧本吐事件的 Compute(可补发事件和 harness 活动);时钟可拨,核对周期用真实的 10 毫秒。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ContactMind, Inbound, MindAction, RoundInput } from "@g-group/kernel";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host, type HostOptions } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-runs-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `r${++fileNo}.db`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEC = 1000;
const MIN = 60_000;
type Clock = { ms: () => number; iso: () => string; advance: (d: number) => void };
function fakeClock(): Clock {
  let t = Date.parse("2026-11-09T02:00:00.000Z");
  return { ms: () => t, iso: () => new Date(t).toISOString(), advance: (d) => { t += d; } };
}
const hosts: Host[] = [];
// 测试中途断言失败时也关掉宿主(停核对计时器、注意循环),不让文件挂住;关不掉的最多等 2 秒
after(async () => {
  for (const h of hosts) await Promise.race([h.close().catch(() => {}), sleep(2000)]);
});
/** 建宿主:被测类作为参数传入;时钟可拨,核对周期 10 毫秒。
 *  AC-36 的静默退避有自己的测试(retry.test.ts);这里测的是自动重试用尽之后台账与重跑的规则,所以自动重试次数取 0(失败当场出原位卡) */
function mk(H: typeof Host, clock: Clock, o: Partial<HostOptions> & Pick<HostOptions, "mind">): Host {
  const h = new H({ file: file(), clockMs: clock.ms, now: clock.iso, runCheckMs: 10, maxDeferMs: 5, retry: { maxAutoRetries: 0 }, ...o });
  hosts.push(h);
  return h;
}
async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 400; i++) {
    // 有界等待:宿主一直忙(例如每轮都出错、按退避重试)时不无限挂住,400 次后按名字失败
    await Promise.race([host.idle(), sleep(50)]);
    await sleep(5);
    if ((!compute || compute.drained()) && !host.loop.busy()) {
      await sleep(15);
      if (!host.loop.busy() && (!compute || compute.drained())) return;
    }
  }
  throw new Error("宿主没有安静下来");
}
async function waitFor(pred: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await sleep(5);
  }
  throw new Error(`没等到:${what}`);
}
/** 一步一步拨时钟(每步小于休眠检测的跳变量),每步让核对周期跑过;返回拨了几步 */
async function advanceUntil(clock: Clock, pred: () => boolean, stepMs: number, maxSteps: number) {
  for (let i = 0; i <= maxSteps; i++) {
    if (pred()) return i;
    clock.advance(stepMs);
    await sleep(30);
  }
  throw new Error("拨到上限还没发生");
}
const runsOf = (host: Host, layer: string) => host.listRuns({}).runs.filter((r) => r.layer === layer);
const texts = (host: Host, roomId: string) => host.listMessages(roomId, {}).messages.map((m) => `${m.sender.kind}:${m.text}`);
const started = { kind: "started", sessionId: "s", resumed: false } as const;

test("私聊派活:台账里有联系人轮次 → Compute 会话 → Compute 轮次 → 子代理 / 后台任务,带来源会话、消息序号、属于谁;Compute 在跑时轮次不记 done;验收后全部收口,画板与查询读同一份(AC-43 ①③⑥⑧)", async () => {
  const clock = fakeClock();
  const compute = scriptedCompute({ script: () => [started] });
  const host = mk(Host, clock, { mind: () => scriptedMind(), compute: () => compute.adapter });
  const seen: string[] = [];
  host.bus.subscribe((e) => {
    if (e.type === "run.updated") seen.push(`${e.run.layer}:${e.run.status}`);
  });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const sent = host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await settle(host, compute);
  const round = runsOf(host, "contact-round")[0]!;
  const session = runsOf(host, "compute-session")[0]!;
  const turn = runsOf(host, "compute-turn")[0]!;
  const task = host.listTasks({ roomId: dm.id })[0]!;
  assert.deepEqual([round.roomId, round.sourceSeq, round.contactId, round.parentId], [dm.id, sent.seq, c.id, null]);
  assert.deepEqual([session.parentId, session.taskId, session.computeId, turn.parentId, turn.computeId], [round.id, task.id, "cp-1", session.id, "cp-1"]);
  assert.deepEqual([round.status, round.waiting, session.status, turn.status], ["running", "children", "running", "running"], "Compute 在跑,派活的轮次等它,不记 done");
  compute.pushActivity({ computeId: "cp-1", kind: "tool_start", toolId: "tu-1", name: "Task", background: false, subagent: true });
  compute.pushActivity({ computeId: "cp-1", kind: "tool_start", toolId: "tu-2", name: "Bash", background: true, subagent: false });
  compute.pushActivity({ computeId: "cp-1", kind: "tool_end", toolId: "tu-2", isError: false });
  await waitFor(() => runsOf(host, "subagent").length === 1 && runsOf(host, "background").length === 1, "子代理与后台任务进台账");
  compute.pushActivity({ computeId: "cp-1", kind: "tool_end", toolId: "tu-1", isError: false });
  await waitFor(() => runsOf(host, "subagent")[0]?.status === "done", "子代理随 Task 结果结束");
  assert.deepEqual([runsOf(host, "background")[0]!.status, runsOf(host, "background")[0]!.parentId, runsOf(host, "subagent")[0]!.parentId], ["running", turn.id, turn.id]);
  compute.emit({ computeId: "cp-1", kind: "completed", result: "完成:写一个 hello.txt" });
  await settle(host, compute);
  assert.equal(host.getRun(turn.id).run.status, "done");
  assert.equal(host.getRun(session.id).run.status, "waiting_user", "等交付验收");
  assert.equal(runsOf(host, "background")[0]!.status, "orphaned", "所属轮次结束时还没确认结束的后台任务不留运行中");
  assert.equal(host.getRun(round.id).run.status, "running");
  assert.equal(host.taskDecision(task.id, "accept", "u2").state, "T8_Accepted");
  await settle(host, compute);
  assert.deepEqual([host.getRun(session.id).run.status, host.getRun(round.id).run.status], ["done", "done"], "子单元都结束后父单元才 done");
  assert.equal(host.listRuns({ statuses: ["running", "queued", "waiting_user"] }).runs.length, 0);
  // 同一份数据:runs.list 与 runs.get 对同一单元给出同样的状态与画板文字
  const svc = createService(host);
  const listed = await svc.handle("runs.list", {});
  assert.ok(listed.ok);
  const runs = (listed.value as { runs: { id: string; status: string; text: string }[] }).runs;
  assert.ok(runs.length >= 6);
  for (const r of runs) {
    const got = await svc.handle("runs.get", { runId: r.id });
    assert.ok(got.ok);
    const one = (got.value as { run: { status: string; text: string } }).run;
    assert.deepEqual([one.status, one.text], [r.status, r.text], r.id);
  }
  assert.ok(seen.includes("compute-session:done") && seen.includes("contact-round:done"), "状态变化推 run.updated");
  compute.close();
  await host.close();
});

test("重放 2430 号:一个会话带 3 个后台任务,宿主进程退出后重启,启动核对就把它们和会话、轮次全变 orphaned「宿主进程退出」,任务按失败收口,负责联系人在会话里报卡点,用户不用发「继续」(AC-43 ①②、AC-14)", async () => {
  const clock = fakeClock();
  const f = file();
  const c1 = scriptedCompute({ script: () => [started] });
  const h1 = mk(Host, clock, { file: f, mind: () => scriptedMind(), compute: () => c1.adapter, bootId: "boot-a" });
  const c = h1.createContact({ name: "小克" });
  const dm = h1.openDm(c.id);
  h1.send({ roomId: dm.id, clientActionId: "u1", text: "帮我跑一个很久的任务" });
  await settle(h1, c1);
  for (const id of ["b1", "b2", "b3"]) c1.pushActivity({ computeId: "cp-1", kind: "tool_start", toolId: id, name: "Bash", background: true, subagent: false });
  await waitFor(() => runsOf(h1, "background").length === 3, "三个后台任务进台账");
  const before = h1.listRuns({}).runs;
  assert.equal(before.filter((r) => r.status === "running").length, 6);
  c1.close();
  await h1.close();
  clock.advance(5 * MIN);
  const c2 = scriptedCompute();
  const h2 = mk(Host, clock, { file: f, mind: () => scriptedMind(), compute: () => c2.adapter, bootId: "boot-b" });
  await settle(h2);
  const after_ = h2.listRuns({}).runs.filter((r) => before.some((b) => b.id === r.id));
  assert.equal(after_.length, 6);
  assert.deepEqual([...new Set(after_.map((r) => `${r.status}|${r.note}`))], ["orphaned|宿主进程退出"]);
  assert.ok(after_.every((r) => r.text === "没跑完 · 宿主进程退出" && r.tone === "orphaned"));
  assert.equal(h2.listRuns({ statuses: ["running"] }).runs.filter((r) => before.some((b) => b.id === r.id)).length, 0, "不留「运行中」");
  assert.equal(h2.listTasks({ roomId: dm.id })[0]!.state, "T11_Failed");
  const all = texts(h2, dm.id);
  assert.equal(all.filter((t) => t.startsWith("user:")).length, 1, "用户没有手发「继续」");
  assert.match(all.at(-1)!, /^contact:任务卡住了:没跑完:宿主进程退出/);
  c2.close();
  await h2.close();
});

test("同一夹具不杀进程:全部单元正常结束为 done,没有误报 orphaned;重启后核对不改已结束的单元;没有失败时 runs.rerun 没有可重跑项", async () => {
  const clock = fakeClock();
  const f = file();
  const compute = scriptedCompute();
  const h1 = mk(Host, clock, { file: f, mind: () => scriptedMind(), compute: () => compute.adapter });
  const c = h1.createContact({ name: "小克" });
  const dm = h1.openDm(c.id);
  h1.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await settle(h1, compute);
  h1.taskDecision(h1.listTasks({ roomId: dm.id })[0]!.id, "accept", "u2");
  await settle(h1, compute);
  const done = h1.listRuns({}).runs;
  assert.ok(done.length >= 4);
  assert.deepEqual([...new Set(done.map((r) => r.status))], ["done"]);
  compute.close();
  await h1.close();
  const h2 = mk(Host, clock, { file: f, mind: () => scriptedMind(), bootId: "boot-2" });
  await settle(h2);
  assert.deepEqual(h2.listRuns({}).runs.map((r) => r.status), done.map((r) => r.status));
  const svc = createService(h2);
  const r = await svc.handle("runs.rerun", { runId: done[0]!.id, clientActionId: "x1" });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.error.code === "conflict" && /not-rerunnable/.test(r.error.message));
  await h2.close();
});

test("重放 2734 号上游无响应:Compute 调用发出后既不回应也不断开,过了首字节窗口在一个核对周期内判 failed no_response;先停这一轮再写失败,带原因原文、用时、最后进展、阈值;任务走 ExecFailed,负责联系人收到停滞事件在会话里报卡点(AC-43 ⑦⑩、AC-14)", async () => {
  const clock = fakeClock();
  const compute = scriptedCompute({ script: () => [started] });
  const host = mk(Host, clock, { mind: () => scriptedMind(), compute: () => compute.adapter, runThresholds: { defaults: { stallMs: MIN, firstByteMs: 20 * SEC } } });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我查一下天气" });
  await settle(host, compute);
  const turn = runsOf(host, "compute-turn")[0]!;
  let statusAtStop: string | null = null;
  const stop = compute.adapter.stop.bind(compute.adapter);
  compute.adapter.stop = async (id) => {
    statusAtStop = host.getRun(turn.id).run.status;
    return stop(id);
  };
  compute.pushActivity({ computeId: "cp-1", kind: "model_call" });
  await waitFor(() => host.runs.get(turn.id)?.progress.awaitingSince !== null, "记下调用发出");
  const steps = await advanceUntil(clock, () => host.getRun(turn.id).run.status === "failed", 5 * SEC, 20);
  assert.ok(steps * 5 >= 20 && steps * 5 <= 30, `过了 20 秒窗口、一个周期内判(拨了 ${steps * 5} 秒)`);
  await settle(host, compute);
  const v = host.getRun(turn.id);
  assert.deepEqual([v.run.reasonClass, v.run.label, v.run.retryClass, v.run.thresholdMs, v.run.thresholdSource], ["no_response", "上游没回应", "Transient", 20 * SEC, "default"]);
  assert.match(v.run.raw ?? "", /没有任何回应/);
  assert.ok(v.run.durationMs >= 20 * SEC && v.run.judgedAt !== null && v.run.lastProgressAt <= v.run.judgedAt!);
  assert.equal(statusAtStop, "running", "先停这一轮,停的时候台账还没写失败");
  assert.deepEqual(compute.stopped, ["cp-1"]);
  const kinds = v.events.map((e) => e.kind);
  assert.ok(kinds.indexOf("stall-judged") >= 0 && kinds.indexOf("stall-judged") < kinds.lastIndexOf("status"));
  assert.equal(host.getRun(runsOf(host, "compute-session")[0]!.id).run.reasonClass, "no_response");
  assert.equal(host.listTasks({ roomId: dm.id })[0]!.state, "T11_Failed");
  assert.match(texts(host, dm.id).at(-1)!, /^contact:任务卡住了:失败 · 上游没回应/);
  assert.equal(texts(host, dm.id).filter((t) => t.startsWith("user:")).length, 1);
  compute.close();
  await host.close();
});

test("重放断流重试:harness 每隔几秒报一次「正在重试」但始终没有输出,重试公告不刷新计时,到整轮阈值判 stream_dropped,原文带最近一次重试(AC-43 ⑪)", async () => {
  const clock = fakeClock();
  const compute = scriptedCompute({ script: () => [started] });
  const host = mk(Host, clock, { mind: () => scriptedMind(), compute: () => compute.adapter, runThresholds: { defaults: { stallMs: MIN, firstByteMs: 20 * SEC } } });
  const c = host.createContact({ name: "小克" });
  host.send({ roomId: host.openDm(c.id).id, clientActionId: "u1", text: "帮我查一下天气" });
  await settle(host, compute);
  const turn = runsOf(host, "compute-turn")[0]!;
  compute.pushActivity({ computeId: "cp-1", kind: "model_call" });
  let n = 0;
  const steps = await advanceUntil(
    clock,
    () => {
      compute.pushActivity({ computeId: "cp-1", kind: "retry", error: `API 重试 第 ${++n}/10 次:API Error: 503 stream disconnected`, httpStatus: 503 });
      return host.getRun(turn.id).run.status === "failed";
    },
    5 * SEC,
    30,
  );
  assert.ok(steps * 5 >= 60 && steps * 5 <= 70, `重试公告不算进展:到 60 秒阈值才判(拨了 ${steps * 5} 秒)`);
  const v = host.getRun(turn.id).run;
  assert.deepEqual([v.reasonClass, v.label], ["stream_dropped", "上游一直断流"]);
  assert.match(v.raw ?? "", /重试 \d+ 次之间一直没有输出/);
  assert.match(v.raw ?? "", /API Error: 503 stream disconnected/);
  await settle(host, compute);
  compute.close();
  await host.close();
});

test("合法等待不误判:Compute 受阻等用户回答、一个工具子进程持续运行,都超过阈值也不判卡死、不发停滞事件;工具结束后从结束时刻重新计时(AC-43 ⑫、AC-14 等慢工具不报停滞)", async () => {
  const clock = fakeClock();
  let calls = 0;
  const compute = scriptedCompute({ script: () => (++calls === 1 ? [started, { kind: "blocked", needs: "确认", summary: "要不要覆盖旧文件" }] : [started]) });
  const host = mk(Host, clock, { mind: () => scriptedMind(), compute: () => compute.adapter, runThresholds: { defaults: { stallMs: MIN, firstByteMs: 20 * SEC } } });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我改一下配置" });
  await settle(host, compute);
  const blocked = runsOf(host, "compute-turn")[0]!;
  assert.equal(blocked.status, "waiting_user");
  host.send({ roomId: dm.id, clientActionId: "u2", text: "帮我跑全量测试" });
  await settle(host, compute);
  const busy = runsOf(host, "compute-turn")[1]!;
  compute.pushActivity({ computeId: "cp-2", kind: "tool_start", toolId: "bash-1", name: "Bash", background: false, subagent: false });
  await waitFor(() => host.getRun(busy.id).run.waiting === "tool_running", "工具在跑");
  for (let i = 0; i < 36; i++) {
    clock.advance(5 * SEC);
    await sleep(15);
  }
  assert.deepEqual([host.getRun(blocked.id).run.status, host.getRun(busy.id).run.status], ["waiting_user", "running"], "3 分钟超过阈值仍不判");
  assert.ok(!texts(host, dm.id).some((t) => t.includes("任务卡住了")));
  compute.pushActivity({ computeId: "cp-2", kind: "tool_end", toolId: "bash-1", isError: false });
  await waitFor(() => host.getRun(busy.id).run.waiting === null, "工具结束");
  const steps = await advanceUntil(clock, () => host.getRun(busy.id).run.status === "failed", 5 * SEC, 20);
  assert.ok(steps * 5 >= 60, `从工具结束起算满阈值才判(拨了 ${steps * 5} 秒)`);
  assert.equal(host.getRun(busy.id).run.reasonClass, "stalled");
  assert.equal(host.getRun(blocked.id).run.status, "waiting_user");
  await settle(host, compute);
  compute.close();
  await host.close();
});

test("卡死阈值默认 15 分钟 / 120 秒;按联系人、按上游单独设都生效,判定按单独设的值走并在失败详情写明来源(AC-43 ⑯)", async () => {
  const clock = fakeClock();
  const plain = mk(Host, clock, { mind: () => scriptedMind() });
  const p = plain.createContact({ name: "默认" });
  const d = plain.runThresholds(p.id, "claude-sonnet-4-6");
  assert.deepEqual([d.stallMs, d.firstByteMs, d.source.stallMs, d.source.firstByteMs], [15 * MIN, 120 * SEC, "default", "default"]);
  await plain.close();
  const cfg: { byContact: Record<string, { stallMs: number }>; byUpstream: Record<string, { firstByteMs: number }> } = { byContact: {}, byUpstream: { "claude-sonnet-4-6": { firstByteMs: 45 * SEC } } };
  const compute = scriptedCompute({ script: () => [started] });
  const host = mk(Host, clock, { mind: () => scriptedMind(), compute: () => compute.adapter, runThresholds: () => cfg });
  const c = host.createContact({ name: "小克" });
  const other = host.createContact({ name: "小A" });
  cfg.byContact[c.id] = { stallMs: 90 * SEC };
  const t = host.runThresholds(c.id, "claude-sonnet-4-6");
  assert.deepEqual([t.stallMs, t.source.stallMs, t.firstByteMs, t.source.firstByteMs], [90 * SEC, "contact", 45 * SEC, "upstream"]);
  const o = host.runThresholds(other.id, "another-model");
  assert.deepEqual([o.stallMs, o.firstByteMs, o.source.stallMs], [15 * MIN, 120 * SEC, "default"], "没单独设的用默认");
  host.send({ roomId: host.openDm(c.id).id, clientActionId: "u1", text: "帮我整理日志" });
  await settle(host, compute);
  const turn = runsOf(host, "compute-turn")[0]!;
  const steps = await advanceUntil(clock, () => host.getRun(turn.id).run.status === "failed", 10 * SEC, 20);
  assert.ok(steps * 10 >= 90 && steps * 10 <= 100, `按联系人单独设的 90 秒判(拨了 ${steps * 10} 秒)`);
  const v = host.getRun(turn.id).run;
  assert.deepEqual([v.reasonClass, v.thresholdMs, v.thresholdSource], ["stalled", 90 * SEC, "contact"]);
  assert.match(v.raw ?? "", /按联系人单独设的值/);
  await settle(host, compute);
  compute.close();
  await host.close();
});

test("联系人轮次卡死:脑子一直不返回,超过阈值宿主中止这一轮并记 failed stalled,交 AC-36 原位出失败卡、不再静默重试同一轮;关闭宿主不被卡住的脑子拖住(AC-43 ⑦)", async () => {
  const clock = fakeClock();
  let calls = 0;
  const hang: ContactMind = {
    round: () => {
      calls++;
      return new Promise(() => {});
    },
  };
  const host = mk(Host, clock, { mind: () => hang, runThresholds: { defaults: { stallMs: MIN } } });
  const c = host.createContact({ name: "小克" });
  host.send({ roomId: host.openDm(c.id).id, clientActionId: "u1", text: "你好" });
  await waitFor(() => runsOf(host, "contact-round").length === 1, "轮次开始");
  const round = runsOf(host, "contact-round")[0]!;
  const steps = await advanceUntil(clock, () => host.getRun(round.id).run.status === "failed", 5 * SEC, 20);
  assert.ok(steps * 5 >= 60 && steps * 5 <= 70, `拨了 ${steps * 5} 秒`);
  const v = host.getRun(round.id).run;
  assert.deepEqual([v.reasonClass, v.label, v.tone, v.thresholdMs], ["stalled", "卡住无进展", "failed", MIN]);
  // 判卡死后交 AC-36:整轮已判失败,不再静默重试同一轮(D26 第 8.3 节「不叠加重试」),原位出 1 张失败卡等用户
  await waitFor(() => host.listMessages(host.openDm(c.id).id, {}).messages.some((m) => m.card?.kind === "failure" && /卡住没有进展/.test(JSON.stringify(m.card))), "原位失败卡写明卡住");
  await sleep(100);
  assert.equal(calls, 1, "判卡死后没有静默重试同一轮");
  await host.close();
});

test("可见范围:联系人第 5 块只列它在私聊里自己的单元和所在群里全部成员的单元;别的群、别人私聊的不列;用户本人在 runs.list 看全部(AC-43 ④)", async () => {
  const clock = fakeClock();
  const compute = scriptedCompute({ script: () => [started] });
  const block5: string[] = [];
  let a = "";
  const mind = () =>
    scriptedMind({
      onRound: (i: RoundInput) => {
        if (i.contact.id === a) block5.push(i.request.blocks.find((b) => b.block === 5)?.text ?? "");
      },
    });
  const host = mk(Host, clock, { mind, compute: () => compute.adapter });
  const A = host.createContact({ name: "A" });
  const B = host.createContact({ name: "B" });
  a = A.id;
  const dmA = host.openDm(A.id);
  const dmB = host.openDm(B.id);
  const g1 = host.createGroup("一组", [{ kind: "contact", id: A.id }, { kind: "contact", id: B.id }]);
  const g2 = host.createGroup("二组", [{ kind: "contact", id: B.id }]);
  host.send({ roomId: dmA.id, clientActionId: "1", text: "帮我任务一" });
  host.send({ roomId: dmB.id, clientActionId: "2", text: "帮我任务二" });
  host.send({ roomId: g1.id, clientActionId: "3", text: "帮我任务三", mentions: [{ id: A.id, source: "manual" }] });
  host.send({ roomId: g1.id, clientActionId: "4", text: "帮我任务四", mentions: [{ id: B.id, source: "manual" }] });
  host.send({ roomId: g2.id, clientActionId: "5", text: "帮我任务五", mentions: [{ id: B.id, source: "manual" }] });
  await settle(host, compute);
  const sessions = runsOf(host, "compute-session");
  assert.equal(sessions.length, 5, "用户本人看全部");
  const at = (roomId: string, who: string) => sessions.find((s) => s.roomId === roomId && s.contactId === who)!.id;
  block5.length = 0;
  host.send({ roomId: dmA.id, clientActionId: "6", text: "进度怎么样" });
  await settle(host, compute);
  const seen = block5.at(-1) ?? "";
  for (const id of [at(dmA.id, A.id), at(g1.id, A.id), at(g1.id, B.id)]) assert.ok(seen.includes(id), `应看到 ${id}`);
  for (const id of [at(dmB.id, B.id), at(g2.id, B.id)]) assert.ok(!seen.includes(id), `不应看到 ${id}`);
  compute.close();
  await host.close();
});

/** 认得「自己重跑 <单元>」「明确重跑 <单元>」两句话的脑子:前者是自己决定的自动重跑(不带依据),后者带依据消息 */
function rerunMind(base: ContactMind): ContactMind {
  return {
    async round(input, signal) {
      const out = await base.round(input, signal);
      const extra: MindAction[] = [];
      for (const f of input.fresh) {
        if (f.kind !== "message") continue;
        const auto = /^自己重跑 (\S+)$/.exec(f.text);
        const exp = /^明确重跑 (\S+)$/.exec(f.text);
        if (auto && f.mentions.includes(input.contact.id)) extra.push({ kind: "rerun", runId: auto[1]!, roomId: f.roomId, basisSeq: null });
        if (exp && f.mentions.includes(input.contact.id)) extra.push({ kind: "rerun", runId: exp[1]!, roomId: f.roomId, basisSeq: f.seq });
      }
      return { ...out, actions: [...out.actions, ...extra] };
    },
  };
}

test("重跑:只接受失败 / 中断 / 没跑完的;用户明确发起开新任务和新会话并留重跑事件,同一 clientActionId 幂等;同一单元租约期内第二次重跑被拒;人停的联系人不能自动重跑、用户明确要求才执行(AC-43 ⑤⑥⑦)", async () => {
  const clock = fakeClock();
  let calls = 0;
  const compute = scriptedCompute({ script: () => (++calls === 1 ? [started, { kind: "failed", reason: "进程以 1 退出:boom", code: 1, signal: null, violations: [] }] : [started]) });
  const host = mk(Host, clock, { mind: () => rerunMind(scriptedMind()), compute: () => compute.adapter });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: c.id }]);
  host.send({ roomId: g.id, clientActionId: "u1", text: "帮我跑一下构建", mentions: [{ id: c.id, source: "manual" }] });
  await settle(host, compute);
  const failed = runsOf(host, "compute-session")[0]!;
  assert.deepEqual([failed.status, failed.reasonClass, failed.retryClass], ["failed", "harness_crashed", "MidTurn"]);
  const r1 = await svc.handle("runs.rerun", { runId: failed.id, clientActionId: "r1" });
  assert.ok(r1.ok);
  const again = await svc.handle("runs.rerun", { runId: failed.id, clientActionId: "r1" });
  assert.deepEqual(again.ok && again.value, r1.value, "同一 clientActionId 重发返回同一结果");
  const second = await svc.handle("runs.rerun", { runId: failed.id, clientActionId: "r2" });
  assert.ok(!second.ok && second.error.code === "conflict" && /lease-held/.test(second.error.message), "同一单元同时只一个重跑");
  await settle(host, compute);
  const v = r1.value as { runId: string; mode: string; taskId: string; attempt: number };
  assert.deepEqual([v.runId, v.mode, v.attempt], [failed.id, "same_session", 1]);
  assert.equal(compute.spawned.length, 2);
  const fresh = runsOf(host, "compute-session").find((s) => s.rerunOf === failed.id)!;
  assert.deepEqual([fresh.taskId, fresh.attempt, fresh.status], [v.taskId, 1, "running"]);
  const ev = host.getRun(failed.id).events.find((e) => e.kind === "rerun")!.detail as { initiator: { kind: string }; trigger: string; basis: { reasonClass: string } };
  assert.deepEqual([ev.initiator.kind, ev.trigger, ev.basis.reasonClass], ["user", "explicit", "harness_crashed"]);
  // 用户停掉新任务:人停的,联系人自己不能重跑
  host.stopTask(v.taskId, host.userId);
  await settle(host, compute);
  const stopped = host.getRun(fresh.id).run;
  assert.deepEqual([stopped.status, stopped.reasonClass, stopped.tone, stopped.text], ["interrupted", "user_stopped", "stopped", "已停止"]);
  host.send({ roomId: g.id, clientActionId: "u2", text: `自己重跑 ${fresh.id}`, mentions: [{ id: c.id, source: "manual" }] });
  await settle(host, compute);
  const refused = host.getRun(fresh.id).events.filter((e) => e.kind === "rerun-refused").map((e) => (e.detail as { reason: string }).reason);
  assert.deepEqual(refused, ["user-stopped"]);
  assert.equal(compute.spawned.length, 2);
  const byUser = await svc.handle("runs.rerun", { runId: fresh.id, clientActionId: "r3" });
  assert.ok(byUser.ok, "用户本人这次明确要求才执行");
  await settle(host, compute);
  assert.equal(compute.spawned.length, 3);
  compute.close();
  await host.close();
});

test("重放 1663 号:cyber_policy 平台拒绝的 Compute 重跑开新任务、新会话,带原任务引用与上次原因,不在原会话「继续」(AC-43 坏实现 ⑤)", async () => {
  const clock = fakeClock();
  let calls = 0;
  const compute = scriptedCompute({ script: () => (++calls === 1 ? [started, { kind: "failed", reason: "进程以 1 退出:API Error: 400 cyber_policy violation", code: 1, signal: null, violations: [] }] : [started]) });
  const host = mk(Host, clock, { mind: () => scriptedMind(), compute: () => compute.adapter });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我分析这个样本" });
  await settle(host, compute);
  const failed = runsOf(host, "compute-session")[0]!;
  assert.deepEqual([failed.reasonClass, failed.label], ["platform_refused", "平台拒绝"]);
  const r = host.rerunRun(failed.id, "r1");
  await settle(host, compute);
  assert.equal(r.mode, "new_session");
  const origTask = failed.taskId!;
  assert.notEqual(r.taskId, origTask);
  const brief = (compute.spawned[1]!.brief as { task: string }).task;
  assert.ok(brief.includes(`任务 ${origTask} 的第 1 次重跑(开新会话,不接着原会话)`), brief);
  assert.match(brief, /平台拒绝/);
  const fresh = runsOf(host, "compute-session").find((s) => s.rerunOf === failed.id)!;
  assert.notEqual(fresh.computeId, failed.computeId);
  compute.close();
  await host.close();
});

test("自己名下自动重跑到上限 2 次后在群里报「未做:原因」;别人名下不自动重跑,有人明确要求才执行并在群里留记录:发起人、任务归属、依据的失败记录(AC-43 坏实现 ⑦b ⑦c)", async () => {
  const clock = fakeClock();
  const compute = scriptedCompute({ script: () => [started, { kind: "failed", reason: "进程以 1 退出:boom", code: 1, signal: null, violations: [] }] });
  let hostRef: Host | null = null;
  let aId = "";
  /** A:自己的 Compute 失败了就自己重跑最近那次失败(不带依据,算自动重跑) */
  const aMind: ContactMind = {
    async round(input, signal) {
      const out = await scriptedMind().round(input, signal);
          const failedNow = input.fresh.filter((f): f is Extract<Inbound, { kind: "compute" }> => f.kind === "compute" && f.signal === "failed");
      const extra: MindAction[] = [];
      for (const f of failedNow) {
        const mine = hostRef!.listRuns({ roomId: f.roomId }).runs.filter((r) => r.layer === "compute-session" && r.contactId === aId && r.status === "failed" && r.taskId === f.taskId);
        if (mine.length) extra.push({ kind: "rerun", runId: mine.at(-1)!.id, roomId: f.roomId, basisSeq: null });
      }
      return { ...out, actions: [...out.actions, ...extra] };
    },
  };
  const host = mk(Host, clock, { mind: (c) => (c.id === aId ? aMind : rerunMind(scriptedMind())), compute: () => compute.adapter });
  hostRef = host;
  assert.deepEqual(host.listRuns({}).runs, [], "开始时台账是空的");
  const A = host.createContact({ name: "A" });
  aId = A.id;
  const B = host.createContact({ name: "B" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: A.id }, { kind: "contact", id: B.id }]);
  host.send({ roomId: g.id, clientActionId: "u1", text: "帮我跑一下构建", mentions: [{ id: A.id, source: "manual" }] });
  await settle(host, compute);
  assert.equal(compute.spawned.length, 3, "原任务 + 自己名下自动重跑 2 次");
  const notDone = texts(host, g.id).filter((t) => t.startsWith("contact:未做:自动重跑已到上限 2 次"));
  assert.equal(notDone.length, 1);
  const sessions = runsOf(host, "compute-session");
  const last = sessions.at(-1)!;
  assert.equal(last.attempt, 2);
  // B 自己决定重跑 A 的:不执行
  host.send({ roomId: g.id, clientActionId: "u2", text: `自己重跑 ${last.id}`, mentions: [{ id: B.id, source: "manual" }] });
  await settle(host, compute);
  assert.equal(compute.spawned.length, 3);
  assert.deepEqual(host.getRun(last.id).events.filter((e) => e.kind === "rerun-refused").map((e) => (e.detail as { reason: string }).reason).slice(-1), ["not-owner-auto"]);
  // 用户明确要求 B 重跑 A 的:执行,群里留记录
  const ask = host.send({ roomId: g.id, clientActionId: "u3", text: `明确重跑 ${last.id}`, mentions: [{ id: B.id, source: "manual" }] });
  await settle(host, compute);
  assert.ok(compute.spawned.length >= 4);
  const record = texts(host, g.id).find((t) => t.startsWith("contact:重跑了 A 名下的任务"))!;
  assert.match(record, new RegExp(`发起:我,依据 #${ask.seq};依据失败记录 ${last.id}:执行器崩溃`));
  const ev = host.getRun(last.id).events.find((e) => e.kind === "rerun")!.detail as { initiator: { kind: string }; actor: { id: string }; owner: string; announce: boolean; countsTowardLimit: boolean };
  assert.deepEqual([ev.initiator.kind, ev.actor.id, ev.owner, ev.announce, ev.countsTowardLimit], ["user", B.id, A.id, true, false]);
  compute.close();
  await host.close();
});

test("画板:同一上游同一原因的多条失败在 runs.list 里合并成一条群级提示;人停的显示「已停止」且色调与失败不同(AC-43 ⑨⑮)", async () => {
  const clock = fakeClock();
  let calls = 0;
  const compute = scriptedCompute({ script: () => (++calls <= 3 ? [started, { kind: "failed", reason: "进程以 1 退出:API Error: 429 Too Many Requests", code: 1, signal: null, violations: [] }] : [started]) });
  const host = mk(Host, clock, { mind: () => scriptedMind(), compute: () => compute.adapter });
  const A = host.createContact({ name: "A" });
  const g = host.createGroup("项目群", [{ kind: "contact", id: A.id }]);
  for (const i of [1, 2, 3]) host.send({ roomId: g.id, clientActionId: `u${i}`, text: `帮我任务${i}`, mentions: [{ id: A.id, source: "manual" }] });
  await settle(host, compute);
  const { runs, hints } = host.listRuns({ roomId: g.id });
  const failed = runs.filter((r) => r.layer === "compute-session");
  assert.equal(failed.length, 3);
  assert.deepEqual(hints.map((h) => [h.roomId, h.upstream, h.reasonClass, h.label, h.runIds.length]), [[g.id, "claude-sonnet-4-6", "rate_limited", "被限流", 3]], "3 个单元只合成 1 条提示");
  assert.ok(failed.every((r) => r.tone === "failed" && r.text.startsWith("失败 · 被限流 · 用时")));
  host.send({ roomId: g.id, clientActionId: "u4", text: "帮我任务4", mentions: [{ id: A.id, source: "manual" }] });
  await settle(host, compute);
  // 前 3 个任务停在 AC-36 的原位失败卡 / 熔断暂停上(状态机仍是 T3),人停的是第 4 个
  const live = host.listTasks({ roomId: g.id, states: ["T3_Running"] }).find((t) => !failed.some((r) => r.taskId === t.id))!;
  host.stopTask(live.id, host.userId);
  await settle(host, compute);
  const stopped = host.listRuns({ roomId: g.id }).runs.find((r) => r.layer === "compute-session" && r.taskId === live.id)!;
  assert.deepEqual([stopped.status, stopped.tone, stopped.text, stopped.label], ["interrupted", "stopped", "已停止", "已停止"]);
  assert.equal(host.listRuns({ roomId: g.id }).hints.length, 1, "人停的不进失败提示");
  compute.close();
  await host.close();
});

test("确定不会自愈的错误不等阈值:harness 的重试公告带 401,宿主当场停这一轮并记 auth_or_quota,任务走 ExecFailed", async () => {
  const clock = fakeClock();
  const compute = scriptedCompute({ script: () => [started] });
  const host = mk(Host, clock, { mind: () => scriptedMind(), compute: () => compute.adapter });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我查一下天气" });
  await settle(host, compute);
  const turn = runsOf(host, "compute-turn")[0]!;
  compute.pushActivity({ computeId: "cp-1", kind: "retry", error: "API 重试 第 1/10 次:API Error: 401 invalid x-api-key", httpStatus: 401 });
  await waitFor(() => host.getRun(turn.id).run.status === "failed", "当场判失败");
  await settle(host, compute);
  const v = host.getRun(turn.id).run;
  assert.deepEqual([v.reasonClass, v.label, v.retryClass, v.thresholdMs], ["auth_or_quota", "鉴权或额度问题", "Permanent", null]);
  assert.deepEqual(compute.stopped, ["cp-1"]);
  assert.equal(host.listTasks({ roomId: dm.id })[0]!.state, "T11_Failed");
  assert.match(texts(host, dm.id).at(-1)!, /任务卡住了:失败 · 鉴权或额度问题/);
  compute.close();
  await host.close();
});
