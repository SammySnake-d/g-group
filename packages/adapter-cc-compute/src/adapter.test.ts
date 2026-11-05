// Claude Code Compute 适配器的行为测试。每条测试都起真实子进程:假 CLI(test-support/fake-claude.mjs)
// 按 stream-json 输出,并按 --mcp-config 真的起 report_progress MCP 服务器、走 JSON-RPC 汇报。不 mock child_process。
// 对应 AC-33 ④(brief 只收五个字段、凭据只给引用、工具子集、env 无明文)、V-06(completed 以 CLI 结果为准)、AC-07(交接快照)。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { REPORT_MCP_PATH, createComputeAdapter } from "./adapter.ts";
import { checkInit, terminalFor } from "./events.ts";
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

// RR-06:本文件只回收自己创建的进程。每个 fake() 有独立目录;清理时只对命令行里带本文件假 CLI 路径或该目录的进程下手。
const ownDirs = new Set<string>();
const ownedBy = (pid: number, needles: readonly string[]) => {
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return needles.some((n) => cmd.includes(n));
  } catch { return false; }
};
function reapOwn() {
  for (const dir of ownDirs) {
    const record = path.join(dir, "record.jsonl");
    const pids: number[] = [];
    if (fs.existsSync(record)) for (const l of fs.readFileSync(record, "utf8").trim().split("\n")) if (l) pids.push((JSON.parse(l) as { pid: number }).pid);
    for (const ext of [".grandchild.pid", ".daemon.pid"]) if (fs.existsSync(record + ext)) pids.push(Number(fs.readFileSync(record + ext, "utf8")));
    for (const pid of pids) {
      if (!(pid > 1) || !ownedBy(pid, [FAKE, dir])) continue;
      try { process.kill(-pid, "SIGKILL"); } catch { /* 不是组长或已退出 */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
    }
  }
  ownDirs.clear();
}
afterEach(reapOwn);
// 整个测试文件有界:240 秒还没跑完就回收自己的进程并以失败退出
setTimeout(() => { reapOwn(); console.error("adapter.test.ts 超过 240 秒,强制结束"); process.exit(1); }, 240_000).unref();
process.once("SIGTERM", () => { reapOwn(); process.exit(143); });

/** 假 CLI 的剧本与记录文件,经宿主运行配置 hostEnv 交给子进程;marker 是本测试专用的中性副作用文件 */
function fake(script: unknown, extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cc-"));
  ownDirs.add(dir);
  const record = path.join(dir, "record.jsonl");
  const marker = path.join(dir, "outside-marker.txt");
  const filled = JSON.parse(JSON.stringify(script).replaceAll("@MARKER@", marker.replaceAll("\\", "\\\\")));
  return { record, marker, options: { runner: { command: process.execPath, args: [FAKE] }, hostEnv: { FAKE_SCRIPT: JSON.stringify(filled), FAKE_RECORD: record }, stopGraceMs: 1500, ...extra } };
}
type Launch = { pid: number; argv: string[]; env: Record<string, string>; prompt: string; mcpConfig: { mcpServers: Record<string, { command: string; args: string[] }> } | null };
const launches = (record: string): Launch[] => fs.readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Launch);
const flagOf = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** 限时:被测实现挂住时把挂起变成按名字失败,而不是整个文件超时 */
const within = <T>(p: Promise<T>, ms = 8000) => Promise.race([p, new Promise<"超时">((ok) => setTimeout(() => ok("超时"), ms))]);
const grandchildPid = (record: string) => Number(fs.readFileSync(`${record}.grandchild.pid`, "utf8"));
/** 等到这个 Compute 的 started 事件(init 已核验通过);假 CLI 先与 MCP 握手再输出 init,记录文件出现时还没 started */
async function waitStarted(a: ReturnType<typeof createComputeAdapter>, id: string) {
  const got = await within((async () => {
    for await (const e of a.events()) if (e.computeId === id && e.kind === "started") return true;
    return false;
  })());
  if (got !== true) throw new Error("等 started 超时");
}
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
  const f = fake({ reports: [{ kind: "started", summary: "开始" }], hang: "graceful", grandchild: { delayMs: 1200, marker: "@MARKER@" } });
  const { marker } = f;
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
  const f = fake({ reports: [], result: "success", grandchild: { delayMs: 1200, marker: "@MARKER@" } });
  const { marker } = f;
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
  await waitStarted(a, r.computeId);
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
  await waitStarted(a, r.computeId);
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
  await waitStarted(a, r.computeId);
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

// ---------------------------------------------------------------- 第二轮审查 RR-01 – RR-05

test("RR-01:被拒收的 blocked 未合规重报时,另一种合规汇报(completed)不能把它清掉 → failed", async () => {
  const f = fake({ reports: [{ kind: "blocked", summary: "等待条件", needs: 1 }, { kind: "completed", summary: "结束" }], result: "success", text: "尚未完成" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["started", "failed"]);
  const last = evs.at(-1);
  assert.match(last?.kind === "failed" ? last.reason : "", /blocked/);
});

test("RR-01:被拒收的 blocked 之后只来一个合规 started,也不算解除(审查存活变异)", async () => {
  const f = fake({ reports: [{ kind: "blocked", summary: "等待条件", needs: 1 }, { kind: "started", summary: "继续" }], result: "success", text: "尚未完成" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  assert.deepEqual((await a.settled(r.computeId)).map((e) => e.kind), ["started", "failed"]);
});

test("RR-01:被拒收的 blocked 由宿主显式 resume 解除,续接一轮正常完成(对照)", async () => {
  const f = fake({ reports: [{ kind: "blocked", summary: "等待条件", needs: 1 }], result: "success", text: "尚未完成", resume: { reports: [], result: "success", text: "完成" } });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  assert.equal((await a.settled(r.computeId)).at(-1)?.kind, "failed");
  assert.deepEqual(await a.resume(r.computeId, "条件已满足"), { ok: true });
  assert.deepEqual((await a.settled(r.computeId)).map((e) => e.kind), ["started", "completed"]);
});

test("RR-01:已受理 blocked 后进程与后代被冻结回收,之后的 milestone/completed 和孙进程副作用都不发生", async () => {
  const f = fake({
    reports: [{ kind: "blocked", summary: "要确认", needs: "需要用户确认" }, { kind: "milestone", stage: "偷跑", summary: "继续做" }, { kind: "completed", summary: "做完" }],
    // 没有冻结时,CLI 在 blocked 之后还要再跑约 3 秒,孙进程在 1.2 秒时写标记;冻结回收才能挡住它
    reportGapMs: 1500, result: "success", text: "尚未完成", grandchild: { delayMs: 1200, marker: "@MARKER@" },
  });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await within(a.settled(r.computeId));
  assert.notEqual(evs, "超时");
  assert.deepEqual(evs === "超时" ? [] : evs.map((e) => e.kind), ["started", "blocked"]);
  assert.equal(alive(launches(f.record)[0]!.pid), false);
  assert.equal(alive(grandchildPid(f.record)), false);
  await new Promise((ok) => setTimeout(ok, 1600));
  assert.equal(fs.existsSync(f.marker), false);
  assert.deepEqual(a.snapshot(r.computeId), { ok: false, reason: "not-quiescent" });
});

test("RR-01:停在受阻的 Compute 可以被 stop,产出带 scope 的 stopped", async () => {
  const f = fake({ reports: [{ kind: "blocked", summary: "要确认", needs: "需要用户确认" }], result: "success" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await a.settled(r.computeId);
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  const last = (await a.settled(r.computeId)).at(-1);
  assert.equal(last?.kind, "stopped");
  assert.equal(last?.kind === "stopped" ? last.scope : "", "descendant-tree");
});

test("RR-02:report_progress MCP 起不来时 init 里 host 为 failed → 回收进程组并 failed,不报 completed", async () => {
  const f = fake({ reports: [], result: "success", text: "完成" }, { reportServer: { command: "/usr/bin/false" } });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["failed"]);
  assert.match(evs[0]?.kind === "failed" ? evs[0].reason : "", /MCP 未连接/);
});

test("RR-02:缺 init、tools 不是数组、tools 含非字符串 → failed;完整 init 对照 completed", async () => {
  for (const init of ["missing", "noTools", "badTools"]) {
    const f = fake({ init, reports: [], result: "success", text: "完成" });
    const a = createComputeAdapter(f.options);
    const r = await a.spawn(brief());
    assert.ok(r.ok);
    const evs = await a.settled(r.computeId);
    assert.deepEqual(evs.map((e) => e.kind), ["failed"], init);
  }
  const ok = fake({ reports: [], result: "success", text: "完成" });
  const a = createComputeAdapter(ok.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  assert.deepEqual((await a.settled(r.computeId)).map((e) => e.kind), ["started", "completed"]);
});

test("RR-02:与真实 CLI 同形的 init(host status failed、工具里无 report_progress)判为无法核验;connected 的同形 init 放行", () => {
  const real = { type: "system", subtype: "init", session_id: "s", tools: ["Read"], mcp_servers: [{ name: "host", status: "failed", source: "dynamic" }] };
  const bad = checkInit(real);
  assert.equal(bad.type, "bad-init");
  assert.match(bad.type === "bad-init" ? bad.reason : "", /未连接/);
  assert.equal(checkInit({ ...real, mcp_servers: [{ name: "host", status: "connected" }] }).type, "bad-init");
  assert.deepEqual(checkInit({ ...real, tools: ["Read", REPORT], mcp_servers: [{ name: "host", status: "connected" }] }), { type: "init", sessionId: "s", tools: ["Read", REPORT] });
  assert.equal(checkInit({ ...real, mcp_servers: undefined }).type, "bad-init");
  const mixed = checkInit({ ...real, tools: ["Read", REPORT, 42], mcp_servers: [{ name: "host", status: "connected" }] });
  assert.match(mixed.type === "bad-init" ? mixed.reason : "", /非字符串/);
  assert.equal(checkInit({ ...real, session_id: undefined }).type, "bad-init");
});

test("RR-03:setsid 脱离进程组的孙进程在 stopped 之前被杀,之后不出现标记文件", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始" }], hang: "graceful", grandchild: { delayMs: 1200, marker: "@MARKER@", setsid: true } });
  const a = createComputeAdapter(f.options);
  const it = a.events()[Symbol.asyncIterator]();
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitStarted(a, r.computeId);
  await waitFor(() => fs.existsSync(`${f.record}.grandchild.pid`));
  await new Promise((ok) => setTimeout(ok, 450)); // 让适配器至少采样一次后代树
  const gc = grandchildPid(f.record);
  const stopping = a.stop(r.computeId);
  let gcAliveAtStopped: boolean | undefined;
  let scope = "";
  const seen = await within((async () => {
    for (;;) {
      const { value } = await it.next();
      if (value?.computeId === r.computeId && value.kind === "stopped") { gcAliveAtStopped = alive(gc); scope = value.scope; return true; }
    }
  })());
  assert.equal(seen, true);
  assert.equal(gcAliveAtStopped, false);
  assert.equal(scope, "descendant-tree");
  assert.deepEqual(await within(stopping), { ok: true });
  await new Promise((ok) => setTimeout(ok, 1600));
  assert.equal(fs.existsSync(f.marker), false);
});

test("RR-03 已知不覆盖(记录性):双 fork 后被收养的守护进程不在后代树内,stopped 只声明 scope=descendant-tree", async () => {
  const f = fake({ reports: [], hang: "graceful", daemon: { delayMs: 60_000, marker: "@MARKER@" } });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitStarted(a, r.computeId);
  await waitFor(() => fs.existsSync(`${f.record}.daemon.pid`));
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  const last = (await a.settled(r.computeId)).at(-1);
  assert.equal(last?.kind, "stopped");
  assert.equal(last?.kind === "stopped" ? last.scope : "", "descendant-tree");
  // 不断言守护进程被杀:这是已披露的边界;它由 afterEach 按本测试目录回收
});

test("RR-04:运行中(进程与孙进程都在)取快照返回 not-quiescent;停止并确认后代树为空后才给出快照", async () => {
  const handoff = { constraintVer: 1, openQuestions: [], doneSideEffects: [] };
  const f = fake({ reports: [], hang: "graceful", grandchild: { delayMs: 60_000, marker: "@MARKER@" } });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief(), { handoff });
  assert.ok(r.ok);
  assert.deepEqual(a.snapshot(r.computeId), { ok: false, reason: "not-quiescent" });
  await waitStarted(a, r.computeId);
  await waitFor(() => fs.existsSync(`${f.record}.grandchild.pid`));
  assert.deepEqual(a.snapshot(r.computeId), { ok: false, reason: "not-quiescent" });
  const stopping = a.stop(r.computeId);
  // 停止竞态:stop 已发出、收尾还没完成时也不能给快照
  assert.deepEqual(a.snapshot(r.computeId), { ok: false, reason: "not-quiescent" });
  assert.deepEqual(await within(stopping), { ok: true });
  assert.equal(alive(grandchildPid(f.record)), false);
  assert.deepEqual(a.snapshot(r.computeId), { ok: true, snapshot: handoff });
});

test("RR-04/RR-05:后代树在 SIGKILL 后仍无法确认为空(ps 不可用)→ failed 而非 stopped,快照 not-quiescent", async () => {
  const f = fake({ reports: [], hang: "graceful" }, { procLister: async () => null });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief(), { handoff: { constraintVer: 1, openQuestions: [], doneSideEffects: [] } });
  assert.ok(r.ok);
  await waitStarted(a, r.computeId);
  assert.deepEqual(await within(a.stop(r.computeId), 15_000), { ok: true });
  const last = (await a.settled(r.computeId)).at(-1);
  assert.equal(last?.kind, "failed");
  assert.match(last?.kind === "failed" ? last.reason : "", /后代树/);
  assert.deepEqual(a.snapshot(r.computeId), { ok: false, reason: "not-quiescent" });
});

test("RR-05:init 越界后用户 stop → 对外 stopped,违规保留在 violations[]", async () => {
  const f = fake({ reports: [], hang: "stubborn", extraInitTools: ["Bash"] });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  // 越界的 init 不产出 started;等假 CLI 输出 init 之后再 stop,否则 stop 会先杀掉 MCP 服务器、init 变成"未连接"
  await waitFor(() => fs.existsSync(`${f.record}.init`));
  assert.deepEqual(await within(a.stop(r.computeId), 15_000), { ok: true });
  const last = (await a.settled(r.computeId)).at(-1);
  assert.equal(last?.kind, "stopped");
  assert.match(last?.kind === "stopped" ? last.violations.join(";") : "", /未授权的工具 Bash/);
});

test("RR-05:terminalFor 的优先级:后代树未清 > 停止 > 违规;没有停止时违规报 failed 并带 violations", () => {
  const exit = { code: 0, signal: null };
  const ok = { success: true, text: "完成" };
  const base = { stopRequested: false, treeClean: true, violations: [] as string[], pausedBlocked: false, unresolved: [] as string[] };
  assert.equal(terminalFor(exit, ok, { ...base, stopRequested: true, violations: ["越界"] }, "").kind, "stopped");
  assert.equal(terminalFor(exit, ok, { ...base, stopRequested: true, treeClean: false }, "").kind, "failed");
  const v = terminalFor(exit, ok, { ...base, violations: ["越界"] }, "");
  assert.deepEqual(v.kind === "failed" ? v.violations : [], ["越界"]);
  assert.equal(terminalFor(exit, ok, base, "").kind, "completed");
});

test("RR-03:CLI 自成进程组(pgid 等于自己的 pid),冻结时能先对整组发 SIGSTOP", async () => {
  const f = fake({ reports: [], hang: "graceful" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitStarted(a, r.computeId);
  const pid = launches(f.record)[0]!.pid;
  const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
  assert.equal(pgid, pid);
  assert.deepEqual(await within(a.stop(r.computeId)), { ok: true });
});
