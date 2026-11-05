// Claude Code Compute 适配器的行为测试。每条测试都起真实子进程:假 CLI(test-support/fake-claude.mjs)
// 按 stream-json 输出,并按 --mcp-config 真的起 report_progress MCP 服务器、走 JSON-RPC 汇报。不 mock child_process。
// 对应 AC-33 ④(brief 只收五个字段、凭据只给引用、工具子集、env 无明文)、V-06(completed 以 CLI 结果为准)、AC-07(交接快照)。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REPORT_MCP_PATH, createComputeAdapter } from "./adapter.ts";
import { reportErrors } from "./report-schema.ts";

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
/** 限时:被测实现挂住时把挂起变成按名字失败,而不是整个文件超时 */
const within = <T>(p: Promise<T>, ms = 8000) => Promise.race([p, new Promise<"超时">((ok) => setTimeout(() => ok("超时"), ms))]);
const grandchildPid = (record: string) => Number(fs.readFileSync(`${record}.grandchild.pid`, "utf8"));
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

test("F-01:brief.tools 里的 CLI 控制词与非内置工具名一律拒绝、不起进程;具体内置工具名放行(正反对照)", async () => {
  const f = fake({ reports: [], result: "success" });
  const a = createComputeAdapter(f.options);
  for (const tools of [["default"], [""], ["*"], ["Bash(rm:*)"], ["mcp__host__report_progress"], ["Task"], ["Read", "default"]]) {
    const r = await a.spawn(brief({ tools }));
    assert.equal(r.ok, false, JSON.stringify(tools));
  }
  assert.equal(fs.existsSync(f.record), false);
  const ok = await a.spawn(brief({ tools: ["Read", "Grep"] }));
  assert.ok(ok.ok);
  await a.settled(ok.computeId);
  assert.equal(launches(f.record).length, 1);
});

test("F-01:brief.tools 为空时 --tools 是空串,CLI 实际挂载的只有 report_progress", async () => {
  const f = fake({ reports: [], result: "success" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief({ tools: [] }));
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  const [l] = launches(f.record);
  assert.equal(flagOf(l!.argv, "--tools"), "");
  assert.equal(flagOf(l!.argv, "--allowedTools"), REPORT);
  assert.equal(evs.at(-1)?.kind, "completed");
});

test("F-01:CLI init 自报挂载了 brief 之外的工具 → 终止整个进程组并报 failed;只挂授权工具时 completed(单开关)", async () => {
  const over = fake({ reports: [], hang: "graceful", extraInitTools: ["Bash"] });
  const exact = fake({ reports: [], result: "success" });
  const a1 = createComputeAdapter(over.options);
  const a2 = createComputeAdapter(exact.options);
  const r1 = await a1.spawn(brief());
  const r2 = await a2.spawn(brief());
  assert.ok(r1.ok && r2.ok);
  const e1 = await within(a1.settled(r1.computeId));
  assert.notEqual(e1, "超时");
  const last = e1 === "超时" ? undefined : e1.at(-1);
  assert.equal(last?.kind, "failed");
  assert.match(last?.kind === "failed" ? last.reason : "", /未授权的工具 Bash/);
  assert.equal(alive(launches(over.record)[0]!.pid), false);
  assert.equal((await a2.settled(r2.computeId)).at(-1)?.kind, "completed");
});

test("F-03:stop 回收整个进程组,孙进程在 stopped 之前退出,之后不再产生副作用", async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-marker-")), "outside-marker.txt");
  const f = fake({ reports: [{ kind: "started", summary: "开始" }], hang: "graceful", grandchild: { delayMs: 1200, marker } });
  const a = createComputeAdapter(f.options);
  const it = a.events()[Symbol.asyncIterator]();
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitFor(() => fs.existsSync(`${f.record}.grandchild.pid`));
  const gc = grandchildPid(f.record);
  try {
    const stopping = a.stop(r.computeId);
    let gcAliveAtStopped: boolean | undefined;
    const seen = await within((async () => {
      for (;;) {
        const { value } = await it.next();
        if (value?.computeId === r.computeId && value.kind === "stopped") { gcAliveAtStopped = alive(gc); return true; }
      }
    })());
    assert.equal(seen, true);
    assert.equal(gcAliveAtStopped, false);
    assert.deepEqual(await within(stopping), { ok: true });
    await new Promise((ok) => setTimeout(ok, 1600));
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (alive(gc)) process.kill(gc, "SIGKILL");
  }
});

test("F-03:CLI 正常结束但留下孙进程时,收尾先回收进程组再报 completed;孙进程不再产生副作用", async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-marker-")), "outside-marker.txt");
  const f = fake({ reports: [], result: "success", grandchild: { delayMs: 1200, marker } });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await within(a.settled(r.computeId));
  const gc = grandchildPid(f.record);
  try {
    assert.notEqual(evs, "超时");
    assert.equal(evs === "超时" ? undefined : evs.at(-1)?.kind, "completed");
    assert.equal(alive(gc), false);
    await new Promise((ok) => setTimeout(ok, 1600));
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (alive(gc)) process.kill(gc, "SIGKILL");
  }
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

test("服务器拒收的 blocked(约束版本非法)不产出 blocked、被记录;没有重报时 CLI 成功也报 failed,非法字段不进快照", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始", constraintVer: 2 }, { kind: "blocked", summary: "要令牌", needs: "上传令牌", constraintVer: -1 }], result: "success", text: "尚未完成" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["started", "failed"]);
  assert.match(evs.at(-1)?.kind === "failed" ? (evs.at(-1) as { reason: string }).reason : "", /constraintVer/);
  assert.deepEqual(a.rejectedReports(r.computeId).map((x) => x.kind), ["blocked"]);
  assert.deepEqual(a.snapshot(r.computeId), { ok: true, snapshot: { constraintVer: 2, openQuestions: [], doneSideEffects: [] } });
});

test("F-04:needs/stage 类型不对的汇报被拒收、不产出事件,按 schema 重报后照常产出 blocked(正反对照)", async () => {
  const f = fake({
    reports: [
      { kind: "milestone", summary: "阶段名是数字", stage: 1 },
      { kind: "blocked", summary: "要令牌", needs: 1 },
      { kind: "blocked", summary: "要令牌", needs: "请提供上传令牌" },
    ],
    result: "success", text: "尚未完成",
  });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["started", "blocked"]);
  assert.equal(evs[1]?.kind === "blocked" ? evs[1].needs : "", "请提供上传令牌");
  assert.deepEqual(a.rejectedReports(r.computeId).map((x) => x.kind), ["milestone", "blocked"]);
  assert.match(a.rejectedReports(r.computeId)[1]?.reason ?? "", /needs 须为非空字符串/);
});

test("F-04:report_progress 服务器直接 JSON-RPC:类型、枚举、constraintVer、未知字段不合 schema 一律 isError,合规输入接收", async () => {
  const bad = [
    { kind: "blocked", summary: "x", needs: 1 },
    { kind: "milestone", summary: "x", stage: 1 },
    { kind: "done", summary: "x" },
    { kind: "started", summary: 3 },
    { kind: "started", summary: "x", constraintVer: 1.5 },
    { kind: "started", summary: "x", constraintVer: "3" },
    { kind: "started", summary: "x", openQuestions: [1] },
    { kind: "started", summary: "x", doneSideEffects: "发了邮件" },
    { kind: "started", summary: "x", memory: "私人记忆" },
  ];
  const good = [{ kind: "blocked", summary: "x", needs: "令牌" }, { kind: "started", summary: "x", constraintVer: 0, openQuestions: [], doneSideEffects: ["建表"] }];
  const lines = [...bad, ...good].map((args, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "report_progress", arguments: args } })).join("\n");
  const { spawnSync } = await import("node:child_process");
  const out = spawnSync(process.execPath, [REPORT_MCP_PATH], { input: `${lines}\n`, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  const replies = out.stdout.trim().split("\n").map((l) => JSON.parse(l) as { result: { isError: boolean; content: { text: string }[] } });
  assert.deepEqual(replies.map((x) => x.result.isError), [...bad.map(() => true), ...good.map(() => false)]);
  for (const [i, args] of bad.entries()) assert.ok(replies[i]!.result.content[0]!.text.includes(reportErrors(args)[0]!), JSON.stringify(args));
  assert.deepEqual(good.map((g) => reportErrors(g)), [[], []]);
});

test("F-04:服务器校验失效、回执说已记录时,适配器自己的 schema 校验仍拒收不合规的 blocked", async () => {
  const f = fake({ forgeAccept: true, reports: [{ kind: "blocked", summary: "要令牌", needs: 1 }], result: "success", text: "尚未完成" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["started", "failed"]);
  assert.deepEqual(a.rejectedReports(r.computeId).map((x) => x.kind), ["blocked"]);
});

test("CLI 以权限拒绝回绝的 report_progress(内容合规,tool_result is_error)不产出事件,只记入拒收", async () => {
  const f = fake({ denyReports: true, reports: [{ kind: "milestone", stage: "阶段1", summary: "a 完成" }], result: "success", text: "做完了" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["started", "completed"]);
  assert.deepEqual(a.rejectedReports(r.computeId).map((x) => x.kind), ["milestone"]);
  assert.match(a.rejectedReports(r.computeId)[0]?.reason ?? "", /denied/);
});

test("F-02:Compute 经 report_progress 明确汇报放弃,CLI 正常结束也报 failed 不报 completed", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始" }, { kind: "failed", summary: "无法完成,放弃任务" }], result: "success", text: "无法完成,放弃任务" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["started", "failed"]);
  assert.match(evs.at(-1)?.kind === "failed" ? (evs.at(-1) as { reason: string }).reason : "", /放弃/);
});

test("F-02:result 行 subtype 是 success 但 is_error 为 true → failed", async () => {
  const f = fake({ reports: [{ kind: "completed", summary: "我觉得完成了" }], result: "success_is_error", text: "API Error: 503" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.equal(evs.at(-1)?.kind, "failed");
  assert.equal(evs.some((e) => e.kind === "completed"), false);
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
