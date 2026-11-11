// 运行时配置与进度查询补齐(需求文档 D07.4 规则 2、D26 第 3–4 / 8.6 节、D27 第 4 节第 4 条;AC-43 ②④⑦⑧⑯、AC-51 ⑦ 拦截部分、U91、U92):
//   - Compute 工厂按 (Harness, 模型) 取:选了没接入的 Harness(现在是 codex)派活在启动前被拦,任务可重跑地失败并给两条修复路径,不起 Claude Code 代跑;
//     contacts.update / settings.update 选了它照常保存、返回 warning;
//   - 卡死阈值用户可设:settings.runThresholds(默认层 + 按上游)与联系人 stall 覆盖,宿主每次判定现读;startServer 透传基础层;
//   - 联系人 progress_get:按会话判可见范围(私聊只见自己在这个私聊的,群里见本群成员在本群的,别的群看不到);
//   - 同一启动里 Compute 执行进程消失:一个核对周期内轮次与会话变 orphaned,任务收口;等人回答的单元不按进程判;
//   - 换模型被拒:台账记 failed + invalid_request + 原文。
// 确定性替身驱动(脚本化脑子、按剧本吐事件的 Compute);时钟可拨;存活核对用真实子进程的 pid。
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { type ContactMind, type MindAction, type RoundTools, classifyFailure, runFailure } from "@g-group/kernel";
import { all, one } from "./db.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host, type HostOptions } from "./host.ts";
import { cliRunThresholds } from "./runtime-config.ts";
import { createService } from "./service.ts";
import { startServer } from "./start.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-rtcfg-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const file = () => path.join(dir, `r${++fileNo}.db`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEC = 1000;
const MIN = 60_000;
type Clock = { ms: () => number; iso: () => string; advance: (d: number) => void };
function fakeClock(): Clock {
  let t = Date.parse("2026-11-11T02:00:00.000Z");
  return { ms: () => t, iso: () => new Date(t).toISOString(), advance: (d) => { t += d; } };
}
const hosts: Host[] = [];
const kids: ChildProcess[] = [];
after(async () => {
  for (const h of hosts) await Promise.race([h.close().catch(() => {}), sleep(2000)]);
  for (const k of kids) if (k.exitCode === null && k.signalCode === null) k.kill("SIGKILL");
});
/** 建宿主:时钟可拨,核对周期 10 毫秒(存活核对的测试改成手动拨一拍);自动重试 0 次(失败当场收口) */
function mk(clock: Clock, o: Partial<HostOptions> & Pick<HostOptions, "mind">): Host {
  const h = new Host({ file: file(), clockMs: clock.ms, now: clock.iso, runCheckMs: 10, maxDeferMs: 5, retry: { maxAutoRetries: 0 }, ...o });
  hosts.push(h);
  return h;
}
async function settle(host: Host, compute?: { drained(): boolean }) {
  for (let i = 0; i < 400; i++) {
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
/** 一步一步拨时钟(每步小于休眠检测的跳变量),每步让核对周期跑过;返回拨了几步,拨到上限还没发生就抛错 */
async function advanceUntil(clock: Clock, pred: () => boolean, stepMs: number, maxSteps: number) {
  for (let i = 0; i <= maxSteps; i++) {
    if (pred()) return i;
    clock.advance(stepMs);
    await sleep(30);
  }
  throw new Error("拨到上限还没发生");
}
const runsOf = (host: Host, layer: string) => host.listRuns({}).runs.filter((r) => r.layer === layer);
const said = (host: Host, roomId: string) => host.listMessages(roomId, {}).messages.map((m) => m.text).join("\n");
const started = { kind: "started", sessionId: "s", resumed: false } as const;
/** 规则脑子 + 「补充:」开头的消息转给自己在途任务的 Compute(forward) */
function forwardingMind(host: () => Host): ContactMind {
  const base = scriptedMind();
  return {
    async round(input, signal) {
      const out = await base.round(input, signal);
      const extra: MindAction[] = [];
      for (const f of input.fresh) {
        if (f.kind !== "message" || f.sender.kind !== "user" || !f.text.startsWith("补充:")) continue;
        const t = host().listTasks({ contactId: input.contact.id }).find((x) => x.state === "T3_Running");
        if (t) extra.push({ kind: "forward", taskId: t.id, text: f.text.slice(3) });
      }
      return { actions: [...out.actions.filter((a) => !(a.kind === "reply" && a.text.startsWith("收到:补充"))), ...extra], stateNote: out.stateNote };
    },
  };
}
/** 一个一直在跑的真实子进程(存活核对用它的 pid);结束等它真的退出、被回收 */
function sleeper(): { pid: number; kill: () => Promise<void> } {
  const k = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  kids.push(k);
  return {
    pid: k.pid!,
    kill: () =>
      new Promise((resolve) => {
        if (k.exitCode !== null || k.signalCode !== null) return resolve();
        k.once("exit", () => resolve());
        k.kill("SIGKILL");
      }),
  };
}

test("联系人选 codex:派活在启动前被拦,任务可重跑地失败并给两条修复路径(改用 claude-code / 等 Codex 接入),没有起 Claude Code;改回 claude-code 后重跑照常起(AC-51 ⑦ 拦截部分)", async () => {
  const clock = fakeClock();
  const cc = scriptedCompute({ script: () => [started] });
  const made = { n: 0 };
  const host = mk(clock, {
    mind: () => scriptedMind(),
    compute: () => {
      made.n++;
      return cc.adapter;
    },
  });
  const c = host.createContact({ name: "小科", harness: "codex" });
  assert.equal(c.warning?.code, "harness-not-connected");
  assert.deepEqual(c.warning?.fixes.map((f) => [f.kind, f.harness, f.label]), [["use-connected-harness", "claude-code", "改用 claude-code"], ["wait-for-harness", "codex", "等 Codex 接入"]]);
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我写一个 hello.txt" });
  await settle(host, cc);
  assert.equal(made.n, 0, "没有为 codex 的活去要 Claude Code 的适配器");
  assert.equal(cc.spawned.length, 0, "没有起 Claude Code 代跑");
  assert.equal(one<{ n: number }>(host.db, "SELECT count(*) AS n FROM gg_compute")?.n, 0, "没有任何 Compute 实例被记成在 codex 上跑");
  const [task] = host.listTasks({ roomId: dm.id });
  assert.equal(task?.state, "T11_Failed");
  const session = runsOf(host, "compute-session")[0]!;
  assert.deepEqual([session.status, session.reasonClass, session.label, session.taskId], ["failed", "invalid_request", "请求被拒", task!.id], "可重跑的失败:原因类别是配置问题,不是人停的");
  assert.match(session.raw ?? "", /codex|Codex/);
  assert.match(session.raw ?? "", /改用 claude-code/);
  assert.match(session.raw ?? "", /等 Codex 接入/);
  const text = said(host, dm.id);
  assert.match(text, /改用 claude-code/, "联系人在聊天里转告两条修复路径");
  assert.match(text, /等 Codex 接入/);
  // 用户照第一条修:改用 claude-code,再重跑这个失败单元
  const fixed = host.updateContact(c.id, { harness: "claude-code" });
  assert.equal(fixed.warning, undefined, "改成已接入的 Harness 后不再带 warning");
  const rr = host.rerunRun(session.id, "rr-1");
  await settle(host, cc);
  assert.equal(cc.spawned.length, 1, "重跑在 Claude Code 上起来了");
  assert.equal(made.n, 1);
  assert.equal(one<{ harness: string }>(host.db, "SELECT harness FROM gg_compute WHERE task_id = ?", rr.taskId)?.harness, "claude-code");
  cc.close();
  await host.close();
});

test("Compute 工厂按 (Harness, 模型) 取:两种 Harness 都接入时各走各的适配器,codex 联系人的活不落到 Claude Code 上,也不带 warning", async () => {
  const clock = fakeClock();
  const cc = scriptedCompute({ script: () => [started], idPrefix: "cc" });
  const cx = scriptedCompute({ script: () => [started], idPrefix: "cx" });
  const asked: [string, string][] = [];
  const host = mk(clock, {
    mind: () => scriptedMind(),
    compute: {
      "claude-code": (m) => {
        asked.push(["claude-code", m]);
        return cc.adapter;
      },
      codex: (m) => {
        asked.push(["codex", m]);
        return cx.adapter;
      },
    },
  });
  const a = host.createContact({ name: "小克" });
  const b = host.createContact({ name: "小科", harness: "codex" });
  assert.equal(b.warning, undefined, "codex 接入了就没有 warning");
  host.send({ roomId: host.openDm(a.id).id, clientActionId: "u1", text: "帮我写 a.txt" });
  host.send({ roomId: host.openDm(b.id).id, clientActionId: "u2", text: "帮我写 b.txt" });
  await settle(host, cc);
  await settle(host, cx);
  assert.deepEqual([cc.spawned.length, cx.spawned.length], [1, 1]);
  assert.deepEqual(asked.map((x) => x[0]).sort(), ["claude-code", "codex"]);
  const rows = all<{ contact_id: string; harness: string; compute_id: string }>(host.db, "SELECT contact_id, harness, compute_id FROM gg_compute ORDER BY contact_id");
  const byContact = new Map(rows.map((r) => [r.contact_id, r]));
  assert.deepEqual([byContact.get(a.id)?.harness, byContact.get(a.id)?.compute_id.startsWith("cc-")], ["claude-code", true]);
  assert.deepEqual([byContact.get(b.id)?.harness, byContact.get(b.id)?.compute_id.startsWith("cx-")], ["codex", true]);
  cc.close();
  cx.close();
  await host.close();
});

test("settings 与 contacts 选没有适配器的 Harness:保存照常、返回 warning 带两条修复路径;改回已接入的不带 warning;能力声明不兼容时仍按保存前预检拦(沿用 AC-32)", async () => {
  const clock = fakeClock();
  const cc = scriptedCompute();
  const host = mk(clock, { mind: () => scriptedMind(), compute: () => cc.adapter });
  const svc = createService(host);
  const s1 = await svc.handle("settings.update", { defaultHarness: "codex" });
  assert.ok(s1.ok, JSON.stringify(s1));
  const v1 = s1.value as { defaultHarness: string; warning?: { harness: string; fixes: { kind: string }[]; message: string } };
  assert.equal(v1.defaultHarness, "codex", "不拒绝保存");
  assert.equal(v1.warning?.harness, "codex");
  assert.deepEqual(v1.warning?.fixes.map((f) => f.kind), ["use-connected-harness", "wait-for-harness"]);
  assert.match(v1.warning?.message ?? "", /启动前被拦下/);
  const g1 = await svc.handle("settings.get", {});
  assert.ok(g1.ok);
  assert.equal((g1.value as { warning?: { harness: string } }).warning?.harness, "codex", "settings.get 读到同样的 warning");
  const s2 = await svc.handle("settings.update", { defaultHarness: "claude-code" });
  assert.ok(s2.ok);
  assert.equal((s2.value as { warning?: unknown }).warning, undefined);
  const c = host.createContact({ name: "小克" });
  const u1 = await svc.handle("contacts.update", { contactId: c.id, harness: "codex" });
  assert.ok(u1.ok, JSON.stringify(u1));
  assert.deepEqual([(u1.value as { harness: string }).harness, (u1.value as { warning?: { code: string } }).warning?.code], ["codex", "harness-not-connected"]);
  const got = await svc.handle("contacts.get", { contactId: c.id });
  assert.ok(got.ok);
  assert.equal((got.value as { warning?: { harness: string } }).warning?.harness, "codex");
  const u2 = await svc.handle("contacts.update", { contactId: c.id, harness: "claude-code" });
  assert.ok(u2.ok);
  assert.equal((u2.value as { warning?: unknown }).warning, undefined);
  // 能力声明里 X 只能在 claude-code 上跑:联系人固定 X 再改 codex,保存前预检照旧拦(AC-32 ②)
  host.updateSettings({ models: [{ id: "model-x", label: "X", vendor: "anthropic", harnesses: ["claude-code"] }], confirmAffected: true });
  host.updateContact(c.id, { computeModel: { mode: "explicit", model: "model-x" } });
  const u3 = await svc.handle("contacts.update", { contactId: c.id, harness: "codex" });
  assert.equal(u3.ok ? "saved" : (u3.error.detail as { reason?: string }).reason, "model-incompatible");
  cc.close();
  await host.close();
});

test("改 settings.runThresholds 后下一次判定就用新值:Compute 轮次已跑 2 分钟时把整轮阈值改成 3 分钟,再过约 1 分钟判 stalled、阈值写 3 分钟;未设时默认 15 分钟 / 120 秒(AC-43 ⑦⑯)", async () => {
  const clock = fakeClock();
  const cc = scriptedCompute({ script: () => [started] });
  const host = mk(clock, { mind: () => scriptedMind(), compute: () => cc.adapter });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const g0 = await svc.handle("settings.get", {});
  assert.ok(g0.ok);
  assert.deepEqual((g0.value as { runThresholds?: unknown }).runThresholds, { defaults: { noProgressMs: 15 * MIN, firstByteMs: 120 * SEC }, byUpstream: [] }, "未设时默认 15 分钟 / 120 秒");
  const d = host.runThresholds(c.id, "claude-sonnet-4-6");
  assert.deepEqual([d.stallMs, d.firstByteMs, d.source.stallMs], [15 * MIN, 120 * SEC, "default"]);
  host.send({ roomId: host.openDm(c.id).id, clientActionId: "u1", text: "帮我整理日志" });
  await settle(host, cc);
  const turn = runsOf(host, "compute-turn")[0]!;
  for (let i = 0; i < 12; i++) {
    clock.advance(10 * SEC);
    await sleep(30);
  }
  assert.equal(host.getRun(turn.id).run.status, "running", "按默认 15 分钟,2 分钟时还在跑");
  const up = await svc.handle("settings.update", { runThresholds: { defaults: { noProgressMs: 3 * MIN } } });
  assert.ok(up.ok, JSON.stringify(up));
  assert.deepEqual((up.value as { runThresholds?: unknown }).runThresholds, { defaults: { noProgressMs: 3 * MIN, firstByteMs: 120 * SEC }, byUpstream: [] });
  const steps = await advanceUntil(clock, () => host.getRun(turn.id).run.status === "failed", 10 * SEC, 12);
  assert.ok(steps * 10 >= 60 && steps * 10 <= 80, `改完后按 3 分钟判(又拨了 ${steps * 10} 秒)`);
  const v = host.getRun(turn.id).run;
  assert.deepEqual([v.reasonClass, v.thresholdMs, v.thresholdSource], ["stalled", 3 * MIN, "default"]);
  assert.match(v.raw ?? "", /阈值 3 分钟/);
  await settle(host, cc);
  // 不合格的阈值拒收:合同层(小于 1 秒)与宿主层(同一上游两条)
  const bad = await svc.handle("settings.update", { runThresholds: { defaults: { noProgressMs: 0 } } });
  assert.equal(bad.ok ? "saved" : bad.error.code, "invalid_params");
  assert.throws(() => host.updateSettings({ runThresholds: { byUpstream: [{ upstream: "m", firstByteMs: 5000 }, { upstream: "m", noProgressMs: 9000 }] } }), /出现了不止一次/);
  assert.throws(() => host.updateSettings({ runThresholds: { defaults: { noProgressMs: -5 } } }), /整数毫秒/);
  assert.equal(host.runThresholds(c.id, null).stallMs, 3 * MIN, "拒收的改动什么都没写");
  cc.close();
  await host.close();
});

test("联系人 stall 覆盖与按上游单独设:contacts.update stall 后按联系人值判、清掉后回到默认;settings 按上游设首字节窗口后,调用发出按上游值判 no_response(AC-43 ⑯、U92)", async () => {
  const clock = fakeClock();
  const cc = scriptedCompute({ script: () => [started] });
  const host = mk(clock, { mind: () => scriptedMind(), compute: () => cc.adapter });
  const svc = createService(host);
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  const u = await svc.handle("contacts.update", { contactId: c.id, stall: { noProgressMs: 90 * SEC } });
  assert.ok(u.ok, JSON.stringify(u));
  assert.deepEqual((u.value as { stall?: unknown }).stall, { noProgressMs: 90 * SEC });
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理日志" });
  await settle(host, cc);
  const t1 = runsOf(host, "compute-turn")[0]!;
  const s1 = await advanceUntil(clock, () => host.getRun(t1.id).run.status === "failed", 10 * SEC, 14);
  assert.ok(s1 * 10 >= 90 && s1 * 10 <= 110, `按联系人单独设的 90 秒判(拨了 ${s1 * 10} 秒)`);
  assert.deepEqual([host.getRun(t1.id).run.thresholdMs, host.getRun(t1.id).run.thresholdSource], [90 * SEC, "contact"]);
  await settle(host, cc);
  const cleared = await svc.handle("contacts.update", { contactId: c.id, stall: null });
  assert.ok(cleared.ok);
  assert.equal((cleared.value as { stall?: unknown }).stall, null);
  const back = host.runThresholds(c.id, "claude-sonnet-4-6");
  assert.deepEqual([back.stallMs, back.source.stallMs], [15 * MIN, "default"], "清掉覆盖后回到默认");
  assert.throws(() => host.updateContact(c.id, { stall: { noProgressMs: 10 } }), /整数毫秒/, "小于 1 秒的覆盖拒收");
  const up = await svc.handle("settings.update", { runThresholds: { byUpstream: [{ upstream: "claude-sonnet-4-6", firstByteMs: 30 * SEC }] } });
  assert.ok(up.ok, JSON.stringify(up));
  host.send({ roomId: dm.id, clientActionId: "u2", text: "帮我再整理一次" });
  await settle(host, cc);
  const t2 = runsOf(host, "compute-turn").find((r) => r.id !== t1.id)!;
  assert.equal(t2.upstream, "claude-sonnet-4-6");
  cc.pushActivity({ computeId: t2.computeId!, kind: "model_call" });
  await waitFor(() => host.getRun(t2.id).run.waiting === "first_byte", "进入首字节窗口");
  const s2 = await advanceUntil(clock, () => host.getRun(t2.id).run.status === "failed", 5 * SEC, 12);
  assert.ok(s2 * 5 >= 30 && s2 * 5 <= 45, `按上游单独设的 30 秒判(拨了 ${s2 * 5} 秒)`);
  const v = host.getRun(t2.id).run;
  assert.deepEqual([v.reasonClass, v.thresholdMs, v.thresholdSource], ["no_response", 30 * SEC, "upstream"]);
  await settle(host, cc);
  cc.close();
  await host.close();
});

test("startServer 透传卡死阈值的基础层:Electron 主进程给的值生效,用户在设置里改的覆盖它;cli 的 --no-progress-ms / --first-byte-ms 解析成同一形状、不合格的拒收", async () => {
  const s = await startServer({ dataDir: path.join(dir, `start-${++fileNo}`), runThresholds: { defaults: { stallMs: 5 * MIN, firstByteMs: 45 * SEC } } });
  try {
    const c = s.host.createContact({ name: "小克" });
    const t = s.host.runThresholds(c.id, null);
    assert.deepEqual([t.stallMs, t.firstByteMs], [5 * MIN, 45 * SEC]);
    const view = s.host.updateSettings({ runThresholds: { defaults: { noProgressMs: 7 * MIN } } });
    assert.deepEqual(view.runThresholds?.defaults, { noProgressMs: 7 * MIN, firstByteMs: 45 * SEC });
    assert.equal(s.host.runThresholds(c.id, null).stallMs, 7 * MIN);
  } finally {
    await s.close();
  }
  assert.deepEqual(cliRunThresholds({ noProgressMs: "60000", firstByteMs: "30000" }), { defaults: { stallMs: 60_000, firstByteMs: 30_000 } });
  assert.deepEqual(cliRunThresholds({ firstByteMs: "5000" }), { defaults: { firstByteMs: 5000 } });
  assert.equal(cliRunThresholds({}), undefined);
  assert.throws(() => cliRunThresholds({ noProgressMs: "abc" }), /--no-progress-ms/);
  assert.throws(() => cliRunThresholds({ firstByteMs: "10" }), /--first-byte-ms/);
});

test("progress_get 可见范围:私聊里只见自己在这个私聊的单元,群里见本群成员在本群的单元,别的群、别人私聊、不在的会话都看不到;返回状态、原因类别、子单元与最近事件且条数有界(AC-43 ①④、U91)", async () => {
  const clock = fakeClock();
  const queries: { id: string; roomId: string }[] = [];
  const answers: (string | null)[] = [];
  const asking: ContactMind = {
    async round(_input, _signal, tools?: RoundTools) {
      for (const q of queries) answers.push(tools?.progressGet ? await tools.progressGet(q.id, q.roomId) : "没有查询口");
      return { actions: [], stateNote: null };
    },
  };
  const host = mk(clock, { mind: (c) => (c.name === "甲" ? asking : scriptedMind()) });
  const a = host.createContact({ name: "甲" });
  const b = host.createContact({ name: "乙" });
  const dmA = host.openDm(a.id);
  const dmB = host.openDm(b.id);
  const g1 = host.createGroup("一群", [{ kind: "user", id: host.userId }, { kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  const g2 = host.createGroup("二群", [{ kind: "user", id: host.userId }, { kind: "contact", id: a.id }, { kind: "contact", id: b.id }]);
  const g3 = host.createGroup("三群", [{ kind: "user", id: host.userId }, { kind: "contact", id: b.id }]);
  const unit = (roomId: string, contactId: string, parentId: string | null = null, layer: "compute-session" | "subagent" = "compute-session") =>
    host.runs.start({ layer, parentId, roomId, sourceSeq: 1, contactId, taskId: null, computeId: null, upstream: "m-1" });
  const aDm = unit(dmA.id, a.id);
  host.runs.end(aDm.id, "failed", { failure: runFailure(classifyFailure({ text: "API Error: 429 rate limit" })) });
  const aG1 = unit(g1.id, a.id);
  const bG1 = unit(g1.id, b.id);
  const kidsOf = Array.from({ length: 25 }, () => unit(g1.id, b.id, bG1.id, "subagent"));
  for (let i = 0; i < 15; i++) host.runs.addEvent(bG1.id, "note", { i });
  const bG2 = unit(g2.id, b.id);
  const bG3 = unit(g3.id, b.id);
  const bDm = unit(dmB.id, b.id);
  queries.push(
    { id: aDm.id, roomId: dmA.id },
    { id: aG1.id, roomId: dmA.id },
    { id: bDm.id, roomId: dmA.id },
    { id: bG1.id, roomId: g1.id },
    { id: bG2.id, roomId: g1.id },
    { id: bG3.id, roomId: g3.id },
    { id: bG2.id, roomId: g2.id },
    { id: "run-没有", roomId: g1.id },
  );
  host.send({ roomId: dmA.id, clientActionId: "u1", text: "查一下进度" });
  await settle(host);
  assert.equal(answers.length, queries.length, "甲的一轮里每个查询都经宿主的查询口走了一次");
  const own = JSON.parse(answers[0]!) as { unit: { id: string; status: string; reasonClass: string; label: string; raw: string; roomId: string } };
  assert.deepEqual([own.unit.id, own.unit.status, own.unit.reasonClass, own.unit.label, own.unit.roomId], [aDm.id, "failed", "rate_limited", "被限流", dmA.id], "私聊里查得到自己在这个私聊的单元");
  assert.match(own.unit.raw, /429/);
  assert.equal(answers[1], null, "私聊里查不到自己在群里的单元");
  assert.equal(answers[2], null, "别人私聊里的单元看不到");
  const grp = JSON.parse(answers[3]!) as { unit: { id: string; contactId: string; status: string }; children: { id: string; layer: string; status: string }[]; childrenTotal: number; events: { kind: string }[]; moreEvents: boolean };
  assert.deepEqual([grp.unit.id, grp.unit.contactId, grp.unit.status], [bG1.id, b.id, "running"], "群里查得到本群别的成员在本群的单元");
  assert.equal(grp.children.length, 20, "子单元条数有界");
  assert.equal(grp.childrenTotal, 25);
  assert.deepEqual(grp.children.slice(0, 2).map((x) => [x.id, x.layer, x.status]), kidsOf.slice(0, 2).map((x) => [x.id, "subagent", "running"]));
  assert.equal(grp.events.length, 10, "最近事件条数有界");
  assert.equal(grp.moreEvents, true);
  assert.equal(grp.events.at(-1)?.kind, "note");
  assert.equal(answers[4], null, "在一群查不到二群的单元(别的群看不到)");
  assert.equal(answers[5], null, "不在的群里查不到");
  assert.equal((JSON.parse(answers[6]!) as { unit: { id: string } }).unit.id, bG2.id, "在二群里查二群的单元查得到");
  assert.equal(answers[7], null, "没有的单元与看不到的回同一句");
  await host.close();
});

test("同一次启动里 Compute 执行进程被杀:一个核对周期内这一轮与会话变 orphaned「执行进程已不在」,任务按失败收口、负责联系人收到停滞事件;进程活着时同一核对不误报,续接的新一轮沿用这个 pid(AC-43 ②)", async () => {
  const clock = fakeClock();
  const proc = sleeper();
  const cc = scriptedCompute({ script: () => [{ ...started, pid: proc.pid }] });
  const host: Host = mk(clock, { mind: () => forwardingMind(() => host), compute: () => cc.adapter, runCheckMs: 30_000 });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我跑一个长任务" });
  await settle(host, cc);
  const t1 = runsOf(host, "compute-turn")[0]!;
  await waitFor(() => host.runs.get(t1.id)?.pid === proc.pid, "这一轮记下执行进程 pid");
  host.runs.tick();
  assert.equal(host.getRun(t1.id).run.status, "running", "进程活着:核对不误报孤儿");
  host.send({ roomId: dm.id, clientActionId: "u2", text: "补充:顺便统计行数" });
  await settle(host, cc);
  assert.equal(cc.resumed.length, 1);
  const t2 = runsOf(host, "compute-turn").find((r) => r.id !== t1.id)!;
  assert.equal(host.runs.get(t2.id)?.pid, proc.pid, "常驻进程跨轮不变:新一轮沿用还活着的 pid");
  const session = runsOf(host, "compute-session")[0]!;
  await proc.kill();
  host.runs.tick();
  const tv = host.getRun(t2.id).run;
  assert.deepEqual([tv.status, tv.note], ["orphaned", "执行进程已不在"], "一个核对周期内这一轮变孤儿");
  const sv = host.getRun(session.id).run;
  assert.deepEqual([sv.status, sv.note], ["orphaned", "执行进程已不在"], "所属会话跟着成孤儿,不留「运行中」");
  const [task] = host.listTasks({ roomId: dm.id });
  assert.equal(task?.state, "T11_Failed", "任务按失败收口");
  assert.equal(host.listRuns({ statuses: ["running", "queued", "waiting_user"] }).runs.filter((r) => r.taskId === task!.id).length, 0);
  await settle(host, cc);
  assert.match(said(host, dm.id), /任务卡住了:没跑完:执行进程已不在/, "负责联系人收到停滞事件并在会话里报");
  cc.close();
  await host.close();
});

test("存活核对的边界:进程被杀的一次性实例在等人回答时不被判孤儿,进程活着的在跑单元照常不被判(存活核对用真实进程判定),没报 pid 的在跑单元也不受影响", async () => {
  const clock = fakeClock();
  const gone = sleeper();
  const dead = gone.pid;
  await gone.kill();
  const alive = sleeper();
  const cc = scriptedCompute({
    script: (id) =>
      id === "cp-1"
        ? [{ ...started, pid: dead }, { kind: "blocked", needs: "请提供数据库地址", summary: "缺数据库地址" }]
        : id === "cp-2"
          ? [{ ...started, pid: alive.pid }]
          : [started],
  });
  const host = mk(clock, { mind: () => scriptedMind(), compute: () => cc.adapter, runCheckMs: 30_000 });
  const c = host.createContact({ name: "小克" });
  const d = host.createContact({ name: "小研" });
  const e = host.createContact({ name: "小工" });
  host.send({ roomId: host.openDm(c.id).id, clientActionId: "u1", text: "帮我迁移数据库" });
  await settle(host, cc);
  host.send({ roomId: host.openDm(d.id).id, clientActionId: "u2", text: "帮我写报告" });
  await settle(host, cc);
  host.send({ roomId: host.openDm(e.id).id, clientActionId: "u3", text: "帮我跑长任务" });
  await settle(host, cc);
  const blocked = runsOf(host, "compute-turn").find((r) => r.computeId === "cp-1")!;
  const running = runsOf(host, "compute-turn").find((r) => r.computeId === "cp-2")!;
  const plain = runsOf(host, "compute-turn").find((r) => r.computeId === "cp-3")!;
  assert.deepEqual([host.runs.get(blocked.id)?.pid, host.runs.get(running.id)?.pid], [dead, alive.pid]);
  host.runs.tick();
  assert.deepEqual([host.getRun(blocked.id).run.status, host.getRun(blocked.parentId!).run.status], ["waiting_user", "waiting_user"], "等人回答时进程不在,不判孤儿");
  assert.equal(host.getRun(running.id).run.status, "running", "进程活着的在跑单元照常不被判孤儿(存活按真实进程判)");
  assert.deepEqual([host.getRun(plain.id).run.status, host.runs.get(plain.id)?.pid], ["running", null], "没报 pid 的单元照常在跑");
  await alive.kill();
  host.runs.tick();
  assert.deepEqual([host.getRun(running.id).run.status, host.getRun(running.id).run.note], ["orphaned", "执行进程已不在"], "进程被杀后同一个核对拍就判孤儿");
  assert.equal(host.getRun(blocked.id).run.status, "waiting_user", "等人回答的单元仍然不受影响");
  cc.close();
  await host.close();
});

test("换模型被拒:这一轮没发出,台账记一条 failed 的 Compute 轮次,原因类别 invalid_request、原文是 harness 的拒绝原文;会话不收口,改回兼容模型后同一会话照常续接(D27 第 4 节第 4 条、AC-43 ⑧)", async () => {
  const clock = fakeClock();
  const cc = scriptedCompute({
    script: () => [started],
    resumeResult: (_id, _t, turn) => (turn?.model === "no-such-model" ? { ok: false, reason: "harness 拒绝 no-such-model(check_failed)", code: "model-switch-failed", fixes: ["explicit-compatible-model", "change-harness"] } : null),
  });
  const host: Host = mk(clock, { mind: () => forwardingMind(() => host), compute: () => cc.adapter });
  const c = host.createContact({ name: "小克" });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理资料" });
  await settle(host, cc);
  const session = runsOf(host, "compute-session")[0]!;
  const first = runsOf(host, "compute-turn")[0]!;
  host.updateContact(c.id, { computeModel: { mode: "explicit", model: "no-such-model" } });
  host.send({ roomId: dm.id, clientActionId: "u2", text: "补充:加图表" });
  await settle(host, cc);
  assert.equal(cc.resumed.length, 0, "被拒的这一轮没有发出");
  const refused = runsOf(host, "compute-turn").filter((r) => r.id !== first.id);
  assert.equal(refused.length, 1, "台账多了一条这一轮的记录");
  const r = refused[0]!;
  assert.deepEqual([r.status, r.reasonClass, r.label, r.parentId, r.computeId], ["failed", "invalid_request", "请求被拒", session.id, "cp-1"]);
  assert.match(r.raw ?? "", /check_failed/, "原文是 harness 的拒绝原文");
  assert.match(r.raw ?? "", /换模型没成功/);
  assert.equal(host.getRun(session.id).run.status, "running", "会话不收口");
  host.updateContact(c.id, { computeModel: { mode: "inherit" } });
  host.send({ roomId: dm.id, clientActionId: "u3", text: "补充:加表格" });
  await settle(host, cc);
  assert.equal(cc.resumed.length, 1, "改回兼容模型后同一会话续接");
  assert.equal(cc.spawned.length, 1, "没有另起会话");
  const next = runsOf(host, "compute-turn").filter((x) => x.id !== first.id && x.id !== r.id);
  assert.deepEqual(next.map((x) => [x.status, x.parentId]), [["running", session.id]]);
  cc.close();
  await host.close();
});
