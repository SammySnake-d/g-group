// Claude Code Compute 适配器的行为测试。每条测试都起真实子进程:假 CLI(test-support/fake-claude.mjs)
// 按 stream-json 输出,并按 --mcp-config 真的起 report_progress MCP 服务器、走 JSON-RPC 汇报。不 mock child_process。
// 对应 AC-33 ④(brief 只收五个字段、凭据只给引用、工具子集、env 无明文)、V-06(completed 以 CLI 结果为准)、AC-07(交接快照)。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createComputeAdapter } from "./adapter.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-claude.mjs", import.meta.url));
const REPORT = "mcp__host__report_progress";

const brief = (over: Record<string, unknown> = {}) => ({
  task: "把 a.txt 改成大写",
  rules: ["群规 v3:不对外发布"],
  tools: ["Read", "Write"],
  credentialRefs: ["vault://team/upload-token"],
  placement: "local",
  ...over,
});

/** 假 CLI 的剧本与记录文件,经宿主运行配置 hostEnv 交给子进程 */
function fake(script: unknown) {
  const record = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fake-cc-")), "record.jsonl");
  return { record, options: { runner: { command: process.execPath, args: [FAKE] }, hostEnv: { FAKE_SCRIPT: JSON.stringify(script), FAKE_RECORD: record }, stopGraceMs: 1500 } };
}
type Launch = { pid: number; argv: string[]; env: Record<string, string>; prompt: string; mcpConfig: { mcpServers: Record<string, { command: string; args: string[] }> } | null };
const launches = (record: string): Launch[] => fs.readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Launch);
const flagOf = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 20)); }
}

test("brief 带 memory 或 soul 字段被拒绝,不起任何进程(AC-33 ④ 阳性埋雷)", async () => {
  const f = fake({ reports: [], result: "success" });
  const a = createComputeAdapter(f.options);
  const withMemory = await a.spawn(brief({ memory: ["用户喜欢简短回复"] }));
  const withSoul = await a.spawn(brief({ soul: "SOUL.md 全文" }));
  assert.equal(withMemory.ok, false);
  assert.match(withMemory.ok ? "" : withMemory.reason, /memory/);
  assert.equal(withSoul.ok, false);
  assert.match(withSoul.ok ? "" : withSoul.reason, /soul/);
  assert.equal(fs.existsSync(f.record), false);
});

test("同一 brief 只切凭据:明文 token 被拒绝,引用句柄放行(单开关)", async () => {
  const f = fake({ reports: [], result: "success" });
  const a = createComputeAdapter(f.options);
  const plain = await a.spawn(brief({ credentialRefs: ["ghp_0123456789abcdefPLAINTEXT"] }));
  assert.equal(plain.ok, false);
  assert.match(plain.ok ? "" : plain.reason, /引用句柄/);
  const ref = await a.spawn(brief());
  assert.equal(ref.ok, true);
  if (ref.ok) await a.settled(ref.computeId);
  assert.equal(launches(f.record).length, 1);
});

test("brief 的运行位置不是本机、工具名带逗号拼接时被拒绝", async () => {
  const a = createComputeAdapter(fake({ reports: [], result: "success" }).options);
  const cloud = await a.spawn(brief({ placement: "cloud_sandbox" }));
  const smuggled = await a.spawn(brief({ tools: ["Read,Bash"] }));
  assert.equal(cloud.ok, false);
  assert.equal(smuggled.ok, false);
});

test("CLI 的 --tools 与 --allowedTools 按 brief.tools 收窄,只额外挂 report_progress", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始" }], result: "success" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief({ tools: ["Read"] }));
  assert.ok(r.ok);
  await a.settled(r.computeId);
  const [l] = launches(f.record);
  assert.equal(flagOf(l!.argv, "--tools"), "Read");
  assert.equal(flagOf(l!.argv, "--allowedTools"), `Read,${REPORT}`);
  assert.equal(flagOf(l!.argv, "--permission-mode"), "dontAsk");
  assert.ok(l!.argv.includes("--bare") && l!.argv.includes("--strict-mcp-config"));
  assert.deepEqual(r.manifest.allowedTools, ["Read", REPORT]);
  assert.equal(l!.mcpConfig?.mcpServers.host?.args[0]?.endsWith("report-mcp.mjs"), true);
});

test("子进程 env 不继承宿主进程环境里的明文密钥,凭据只以引用句柄出现", async () => {
  process.env.G_TEST_PLAINTEXT_SECRET = "sk-live-PLAINTEXT-should-never-leak";
  try {
    const f = fake({ reports: [], result: "success" });
    const a = createComputeAdapter(f.options);
    const r = await a.spawn(brief());
    assert.ok(r.ok);
    await a.settled(r.computeId);
    const { env } = launches(f.record)[0]!;
    assert.equal(Object.values(env).some((v) => v.includes("PLAINTEXT")), false);
    assert.deepEqual(Object.keys(env).filter((k) => /^(ANTHROPIC_|CLAUDE|G_TEST_)/.test(k)), []);
    assert.equal(env.G_GROUP_CREDENTIAL_REFS, JSON.stringify(["vault://team/upload-token"]));
    assert.equal(env.G_GROUP_COMPUTE_ID, r.computeId);
  } finally {
    delete process.env.G_TEST_PLAINTEXT_SECRET;
  }
});

test("正常多阶段:stream-json 与 report_progress 映射成 started → milestone×2 → completed", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始" }, { kind: "milestone", stage: "阶段1", summary: "a 完成" }, { kind: "milestone", stage: "阶段2", summary: "b 完成" }, { kind: "completed", summary: "全部完成" }], result: "success", text: "三个文件都写好了" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["started", "milestone", "milestone", "completed"]);
  assert.deepEqual(evs.filter((e) => e.kind === "milestone").map((e) => e.kind === "milestone" && e.stage), ["阶段1", "阶段2"]);
  assert.equal(evs.at(-1)?.kind === "completed" && evs.at(-1)?.kind === "completed" ? (evs.at(-1) as { result: string }).result : "", "三个文件都写好了");
  assert.equal(evs.every((e) => e.computeId === r.computeId), true);
});

test("milestone 漏报、也没调 report_progress 的 completed 时,CLI 成功结束仍报 completed(V-06 约束)", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始" }], result: "success", text: "做完了" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["started", "completed"]);
});

test("report_progress 服务器拒收的汇报(milestone 缺 stage)不产出事件", async () => {
  const f = fake({ reports: [{ kind: "milestone", summary: "没写阶段名" }, { kind: "milestone", stage: "阶段1", summary: "补报" }], result: "success" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.filter((e) => e.kind === "milestone").map((e) => e.kind === "milestone" && e.summary), ["补报"]);
});

test("服务器拒收的 blocked(约束版本非法)不产出 blocked,也不阻止 completed;合法字段不进快照", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始", constraintVer: 2 }, { kind: "blocked", summary: "要令牌", needs: "上传令牌", constraintVer: -1 }], result: "success", text: "做完了" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["started", "completed"]);
  assert.deepEqual(a.snapshot(r.computeId), { ok: true, snapshot: { constraintVer: 2, openQuestions: [], doneSideEffects: [] } });
});

test("brief.tools 为空时 report_progress 仍挂载并被放行,汇报照常产出事件(阴性对照)", async () => {
  const f = fake({ reports: [{ kind: "milestone", stage: "阶段1", summary: "a 完成" }], result: "success" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief({ tools: [] }));
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["started", "milestone", "completed"]);
});

test("CLI 给出 success 结果但进程非零退出 → failed,不报 completed", async () => {
  const f = fake({ reports: [{ kind: "completed", summary: "我觉得完成了" }], result: "success", exit: 3, stderr: "boom: 写入失败" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  const last = evs.at(-1);
  assert.equal(last?.kind, "failed");
  assert.equal(last?.kind === "failed" ? last.code : null, 3);
  assert.match(last?.kind === "failed" ? last.reason : "", /写入失败/);
  assert.equal(evs.some((e) => e.kind === "completed"), false);
});

test("退出码 0 但 CLI 没给结束结果或结果是出错 → failed", async () => {
  const noResult = fake({ reports: [], exit: 0 });
  const errResult = fake({ reports: [], result: "error", exit: 0 });
  const a1 = createComputeAdapter(noResult.options);
  const a2 = createComputeAdapter(errResult.options);
  const r1 = await a1.spawn(brief());
  const r2 = await a2.spawn(brief());
  assert.ok(r1.ok && r2.ok);
  assert.equal((await a1.settled(r1.computeId)).at(-1)?.kind, "failed");
  assert.equal((await a2.settled(r2.computeId)).at(-1)?.kind, "failed");
});

test("进程被外部杀掉 → failed,带信号", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始" }], hang: "stubborn" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitFor(() => fs.existsSync(f.record));
  process.kill(launches(f.record)[0]!.pid, "SIGKILL");
  const last = (await a.settled(r.computeId)).at(-1);
  assert.equal(last?.kind, "failed");
  assert.equal(last?.kind === "failed" ? last.signal : null, "SIGKILL");
});

test("stop:子进程真的退出之后才产出 stopped,且只产出一次", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始" }], hang: "graceful" });
  const a = createComputeAdapter(f.options);
  const it = a.events()[Symbol.asyncIterator]();
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitFor(() => fs.existsSync(f.record));
  const pid = launches(f.record)[0]!.pid;
  const stopping = a.stop(r.computeId);
  let aliveAtStopped: boolean | undefined;
  for (;;) {
    const { value } = await it.next();
    if (value?.computeId === r.computeId && value.kind === "stopped") { aliveAtStopped = alive(pid); break; }
  }
  const res = await stopping;
  assert.equal(aliveAtStopped, false);
  assert.deepEqual(res, { ok: true });
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["started", "stopped"]);
});

test("stop:进程无视 SIGTERM 时升级为 SIGKILL,结束后才报 stopped", async () => {
  const f = fake({ reports: [], hang: "stubborn" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitFor(() => fs.existsSync(f.record));
  const pid = launches(f.record)[0]!.pid;
  try {
    // 不升级 SIGKILL 时 stop 会永远等下去;限时把挂起变成按名字失败
    const res = await Promise.race([a.stop(r.computeId), new Promise((ok) => setTimeout(() => ok("stop 超时未返回"), 5000))]);
    assert.deepEqual(res, { ok: true });
    assert.equal(alive(pid), false);
    const last = (await a.settled(r.computeId)).at(-1);
    assert.equal(last?.kind === "stopped" ? last.signal : "", "SIGKILL");
  } finally {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
});

test("blocked 后 CLI 结束不报 completed;resume 用同一 CLI 会话续接后报 completed", async () => {
  const f = fake({
    reports: [{ kind: "started", summary: "开始" }, { kind: "blocked", summary: "缺上传令牌", needs: "请提供上传令牌" }], result: "success",
    resume: { reports: [{ kind: "milestone", stage: "上传", summary: "已上传" }], result: "success", text: "发布完成" },
  });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const first = await a.settled(r.computeId);
  assert.deepEqual(first.map((e) => e.kind), ["started", "blocked"]);
  const sid = first[0]?.kind === "started" ? first[0].sessionId : "";
  assert.deepEqual(await a.resume(r.computeId, "令牌已放进 vault://team/upload-token"), { ok: true });
  const second = await a.settled(r.computeId);
  assert.deepEqual(second.map((e) => e.kind), ["started", "milestone", "completed"]);
  assert.equal(second[0]?.kind === "started" && second[0].resumed, true);
  const [, l2] = launches(f.record);
  assert.equal(flagOf(l2!.argv, "--resume"), sid);
  assert.equal(l2!.prompt, "令牌已放进 vault://team/upload-token");
});

test("运行中不能 resume;未知 Compute 不能 stop", async () => {
  const f = fake({ reports: [], hang: "graceful" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  assert.equal((await a.resume(r.computeId, "再做点")).ok, false);
  assert.equal((await a.stop("cc-不存在")).ok, false);
  await a.stop(r.computeId);
});

test("snapshot 取自事件流里 report_progress 的结构化字段", async () => {
  const f = fake({
    reports: [
      { kind: "started", summary: "开始", constraintVer: 3 },
      { kind: "milestone", stage: "建表", summary: "表已建", doneSideEffects: ["建表 orders"], openQuestions: ["要不要加索引"] },
      { kind: "milestone", stage: "导数", summary: "已导入", doneSideEffects: ["导入 1200 行"], openQuestions: [] },
    ],
    result: "success",
  });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await a.settled(r.computeId);
  assert.deepEqual(a.snapshot(r.computeId), { ok: true, snapshot: { constraintVer: 3, openQuestions: [], doneSideEffects: ["建表 orders", "导入 1200 行"] } });
});

test("没汇报过约束版本的 Compute 拿不到快照;缺 constraintVer 的 handoff 被 spawn 拒绝(AC-07 阳性埋雷)", async () => {
  const f = fake({ reports: [{ kind: "milestone", stage: "s", summary: "只有文字", doneSideEffects: ["发了邮件"] }], result: "success" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await a.settled(r.computeId);
  const snap = a.snapshot(r.computeId);
  assert.equal(snap.ok, false);
  assert.match(snap.ok ? "" : snap.reason, /constraintVer/);
  const prose = await a.spawn(brief(), { handoff: { openQuestions: [], doneSideEffects: ["发了邮件"] } });
  const text = await a.spawn(brief(), { handoff: "上一个 Compute 已经发了邮件,约束是最新的" });
  assert.equal(prose.ok, false);
  assert.equal(text.ok, false);
  assert.equal(launches(f.record).length, 1);
});

test("带 handoff 的新 spawn:快照写进新会话首个提示,并列在装配清单里", async () => {
  const f = fake({ reports: [], result: "success" });
  const a = createComputeAdapter(f.options);
  const handoff = { constraintVer: 7, openQuestions: ["发布窗口是否改到周五"], doneSideEffects: ["已发送通知邮件"] };
  const r = await a.spawn(brief(), { handoff });
  assert.ok(r.ok);
  await a.settled(r.computeId);
  const { prompt } = launches(f.record)[0]!;
  assert.match(prompt, /约束版本: 7/);
  assert.match(prompt, /发布窗口是否改到周五/);
  assert.match(prompt, /已发送通知邮件/);
  assert.match(prompt, /把 a\.txt 改成大写/);
  assert.deepEqual(r.manifest.sections.find((s) => s.name === "handoff")?.detail, handoff);
  assert.deepEqual(r.manifest.sections.map((s) => s.name), ["task", "rules", "handoff", "credentialRefs"]);
  assert.deepEqual(a.snapshot(r.computeId), { ok: true, snapshot: handoff });
});

test("没有 handoff 的 spawn:首个提示与装配清单都不含交接段(阴性对照)", async () => {
  const f = fake({ reports: [], result: "success" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await a.settled(r.computeId);
  assert.doesNotMatch(launches(f.record)[0]!.prompt, /交接快照/);
  assert.deepEqual(r.manifest.sections.map((s) => s.name), ["task", "rules", "credentialRefs"]);
});
