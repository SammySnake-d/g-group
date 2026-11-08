// Claude Code Compute 适配器的行为测试。每条测试都起真实子进程:假 CLI(test-support/fake-claude.mjs)
// 按 stream-json 输出,并按 --mcp-config 真的起 report_progress MCP 服务器、走 JSON-RPC 汇报。不 mock child_process。
// 对应 AC-33 ④(brief 只收五个字段、凭据只给引用、工具子集、env 无明文)、V-06(completed 以 CLI 结果为准)、AC-07(交接快照)。
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_REAP_FORCE_MS, DEFAULT_RUNNER, REPORT_MCP_PATH, createComputeAdapter, resolveReapForceMs } from "./adapter.ts";
import { CC_BUILTIN_TOOLS, checkBrief, checkSnapshot, isCredentialRef } from "./brief.ts";
import { PRE_INIT_SYSTEM_SUBTYPES, checkInit, preInitFrame, streamParser, terminalFor } from "./events.ts";
import { REPORT_KINDS, reportErrors, reportToolDefinition } from "./report-schema.ts";
import * as root from "./index.ts";

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

// RR-06 / R3-04:本文件只回收自己创建的进程。每个 fake() 有独立目录,runner 参数带上 --fake-dir=<目录>,
// 孙进程与守护进程的 -e 代码里也带着该目录下的标记路径;回收时扫描进程表,只对命令行里含本测试目录的进程下手,
// 不依赖假 CLI 有没有来得及写记录文件(断言在写记录之前就失败也能回收)。
// 磁盘清理(g-group#2900,开发手册原则 67):回收进程之后一并删掉这些 fake-cc-* 目录,谁建谁清。
const ownDirs = new Set<string>();
function ownProcs(dir: string): number[] {
  let out = "";
  try { out = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }); } catch { return []; }
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) > 1 && Number(m[1]) !== process.pid && m[2]!.includes(`${dir}${path.sep}`)) pids.push(Number(m[1]));
  }
  return pids;
}
function reapOwn() {
  // 几轮扫描:刚 fork 还没 exec 完的进程在第一轮可能看不到命令行
  for (let round = 0; round < 3; round++) {
    let found = 0;
    for (const dir of ownDirs) {
      for (const pid of ownProcs(dir)) {
        found++;
        try { process.kill(-pid, "SIGKILL"); } catch { /* 不是组长或已退出 */ }
        try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
      }
    }
    if (found === 0 && round > 0) break;
    execFileSync("sleep", ["0.1"]);
  }
  for (const dir of ownDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
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
  return { record, marker, options: { runner: { command: process.execPath, args: [FAKE, `--fake-dir=${dir}${path.sep}`] }, hostEnv: { FAKE_SCRIPT: JSON.stringify(filled), FAKE_RECORD: record }, reapForceMs: 1500, ...extra } };
}
type Launch = { pid: number; argv: string[]; env: Record<string, string>; prompt: string; mcpConfig: { mcpServers: Record<string, { command: string; args: string[] }> } | null };
const launches = (record: string): Launch[] => fs.readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Launch);
const flagOf = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** 限时:被测实现挂住时把挂起变成按名字失败,而不是整个文件超时 */
const within = <T>(p: Promise<T>, ms = 8000) => Promise.race([p, new Promise<"超时">((ok) => setTimeout(() => ok("超时"), ms))]);
/** 孙进程 pid:假 CLI 在输出 init 之前写好,拿到 started/completed 时一定已存在(事件屏障,不靠时间) */
const grandchildPid = (record: string) => Number(fs.readFileSync(`${record}.grandchild.pid`, "utf8"));
/** 有界轮询 kill(pid,0) 直到进程消失;上限内没消失返回 false */
async function gone(pid: number, ms = 5000) {
  const t0 = Date.now();
  while (alive(pid)) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 20)); }
  return true;
}
/** 孙进程副作用协议:创建 trigger 后,活着且未被要求退出的孙进程才写 marker。返回上限内 marker 是否出现 */
async function sideEffect(marker: string, ms: number) {
  fs.writeFileSync(`${marker}.trigger`, "");
  const t0 = Date.now();
  while (!fs.existsSync(marker)) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 20)); }
  return true;
}
const termFile = (record: string) => `${record}.term`;
const procStat = (pid: number) => { try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return ""; } };
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

test("F-03:stop 立即产出 stopped;初始 SIGTERM 只发主进程,主进程按时退出就取消组 SIGKILL,同组孙进程收不到信号(与 mirasim 一致)", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始" }], hang: "graceful", grandchild: { marker: "@MARKER@" } }, { reapForceMs: 800 });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitStarted(a, r.computeId);
  const cli = launches(f.record)[0]!.pid;
  const gc = grandchildPid(f.record);
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  const last = (await a.settled(r.computeId)).at(-1);
  assert.equal(last?.kind === "stopped" ? last.scope : "", "main-then-group");
  assert.equal(fs.existsSync(termFile(f.record)), true);
  assert.equal(await gone(cli), true);
  // 主进程在 reapForceMs 之内退出:组 SIGKILL 已取消。过了 reapForceMs 孙进程仍活着,也从没收到 SIGTERM
  await new Promise((ok) => setTimeout(ok, 1300));
  assert.equal(alive(gc), true);
  assert.equal(fs.existsSync(`${f.marker}.term`), false);
});

test("F-03 已知不覆盖(记录性,与 mirasim 一致):CLI 正常结束时不发任何信号,completed 立即产出,同组孙进程继续存活并能产生副作用", async () => {
  const f = fake({ reports: [], result: "success", grandchild: { marker: "@MARKER@" } }, { reapForceMs: 300 });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await within(a.settled(r.computeId));
  assert.notEqual(evs, "超时");
  assert.equal(evs === "超时" ? undefined : evs.at(-1)?.kind, "completed");
  const gc = grandchildPid(f.record);
  await new Promise((ok) => setTimeout(ok, 600));
  assert.equal(alive(gc), true);
  assert.equal(fs.existsSync(`${f.marker}.term`), false);
  assert.equal(await sideEffect(f.marker, 5000), true);
  // 孙进程由 afterEach 按本测试目录回收
});

test("F-03:主进程无视 SIGTERM 时 reapForceMs 后对进程组 SIGKILL,同组孙进程一起消失;孙进程从没收到 SIGTERM", async () => {
  const f = fake({ reports: [], hang: "stubborn", grandchild: { marker: "@MARKER@" } }, { reapForceMs: 600 });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitStarted(a, r.computeId);
  const cli = launches(f.record)[0]!.pid;
  const gc = grandchildPid(f.record);
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  assert.equal(alive(cli), true);
  assert.equal(await gone(cli), true);
  assert.equal(await gone(gc), true);
  assert.equal(fs.existsSync(`${f.marker}.term`), false);
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

test("stop:SIGTERM 主进程后立即产出 stopped,不等进程退出;只产出一次,进程随后退出", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始" }], hang: "graceful" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitStarted(a, r.computeId);
  const pid = launches(f.record)[0]!.pid;
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  // stop 返回时 stopped 已经产出,进程还没退出(graceful 收到 SIGTERM 300ms 后才退)
  assert.equal(alive(pid), true);
  const evs = await a.settled(r.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["started", "stopped"]);
  const last = evs.at(-1);
  assert.equal(last?.kind === "stopped" ? last.scope : "", "main-then-group");
  assert.equal(await gone(pid), true);
  assert.equal((await a.stop(r.computeId)).ok, false);
});

test("stop:主进程无视 SIGTERM 时 stopped 照样立即产出,reapForceMs 后对进程组 SIGKILL", async () => {
  const f = fake({ reports: [], hang: "stubborn" }, { reapForceMs: 600 });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitStarted(a, r.computeId);
  const pid = launches(f.record)[0]!.pid;
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  // stop 返回时 stopped 已产出,进程无视 SIGTERM 仍活着;settled 等主进程退出,即 reapForceMs 后的组 SIGKILL
  assert.equal(alive(pid), true);
  const evs = await within(a.settled(r.computeId));
  assert.equal(evs === "超时" ? undefined : evs.at(-1)?.kind, "stopped");
  assert.equal(await gone(pid), true);
});

test("stop:默认升级间隔是 10 秒(对应 mirasim 的 MIRASIM_REAP_FORCE_MS),未到之前不发 SIGKILL", async () => {
  const f = fake({ reports: [], hang: "stubborn" }, { reapForceMs: undefined });
  const a = createComputeAdapter({ ...f.options, reapForceMs: DEFAULT_REAP_FORCE_MS });
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitStarted(a, r.computeId);
  const pid = launches(f.record)[0]!.pid;
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  await new Promise((ok) => setTimeout(ok, 1500));
  assert.equal(alive(pid), true);
  assert.equal(DEFAULT_REAP_FORCE_MS, 10_000);
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

test("RR-01(非 mirasim 对照项):已受理 blocked 后对进程组 SIGSTOP 冻结,之后的 milestone/completed 与同组孙进程副作用都不发生", async () => {
  const f = fake({
    reports: [{ kind: "blocked", summary: "要确认", needs: "需要用户确认" }, { kind: "milestone", stage: "偷跑", summary: "继续做" }, { kind: "completed", summary: "做完" }],
    reportGapMs: 300, result: "success", text: "尚未完成", grandchild: { marker: "@MARKER@" },
  });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await within(a.settled(r.computeId));
  assert.deepEqual(evs === "超时" ? [] : evs.map((e) => e.kind), ["started", "blocked"]);
  const cli = launches(f.record)[0]!.pid;
  const gc = grandchildPid(f.record);
  await waitFor(() => procStat(cli).startsWith("T") && procStat(gc).startsWith("T"));
  assert.equal(await sideEffect(f.marker, 300), false);
  assert.deepEqual(a.snapshot(r.computeId), { ok: false, reason: "not-quiescent" });
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  assert.equal(await gone(cli), true);
  assert.equal(await gone(gc), true);
  assert.deepEqual((await a.settled(r.computeId)).map((e) => e.kind), ["started", "blocked", "stopped"]);
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
  assert.equal(last?.kind === "stopped" ? last.scope : "", "main-then-group");
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

test("RR-03 已知不覆盖(记录性,与 mirasim 一致):setsid 脱离进程组的孙进程在 stopped 之后仍存活并能产生副作用;stopped.scope=main-then-group", async () => {
  const f = fake({ reports: [{ kind: "started", summary: "开始" }], hang: "graceful", grandchild: { marker: "@MARKER@", setsid: true } });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitStarted(a, r.computeId);
  const cli = launches(f.record)[0]!.pid;
  const gc = grandchildPid(f.record);
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  const last = (await a.settled(r.computeId)).at(-1);
  assert.equal(last?.kind === "stopped" ? last.scope : "", "main-then-group");
  assert.equal(await gone(cli), true);
  assert.equal(alive(gc), true);
  assert.equal(await sideEffect(f.marker, 5000), true);
  // 孙进程由 afterEach 按本测试目录回收
});

test("RR-03 已知不覆盖(记录性):双 fork 后被收养的守护进程不在进程组内,stopped 只声明 scope=main-then-group", async () => {
  const f = fake({ reports: [], hang: "graceful", daemon: { marker: "@MARKER@" } });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitStarted(a, r.computeId);
  await waitFor(() => fs.existsSync(`${f.record}.daemon.pid`));
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  const last = (await a.settled(r.computeId)).at(-1);
  assert.equal(last?.kind, "stopped");
  assert.equal(last?.kind === "stopped" ? last.scope : "", "main-then-group");
  // 不断言守护进程被杀:这是已披露的边界;它由 afterEach 按本测试目录回收
});

test("RR-04:运行中、stopped 已产出但主进程未退出时快照都是 not-quiescent;主进程退出后才给出快照", async () => {
  const handoff = { constraintVer: 1, openQuestions: [], doneSideEffects: [] };
  const f = fake({ reports: [], hang: "graceful" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief(), { handoff });
  assert.ok(r.ok);
  assert.deepEqual(a.snapshot(r.computeId), { ok: false, reason: "not-quiescent" });
  await waitStarted(a, r.computeId);
  assert.deepEqual(a.snapshot(r.computeId), { ok: false, reason: "not-quiescent" });
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  // 停止竞态:stopped 已经产出,主进程的退出事件还没到
  assert.deepEqual(a.snapshot(r.computeId), { ok: false, reason: "not-quiescent" });
  assert.equal(await gone(launches(f.record)[0]!.pid), true);
  await waitFor(() => a.snapshot(r.computeId).ok);
  assert.deepEqual(a.snapshot(r.computeId), { ok: true, snapshot: handoff });
});

test("RR-04:快照只看主进程已退出,不等进程组里仍在运行的孙进程(与 mirasim 一致)", async () => {
  const handoff = { constraintVer: 2, openQuestions: [], doneSideEffects: [] };
  const f = fake({ reports: [], result: "success", grandchild: { marker: "@MARKER@", ignoreTerm: true } }, { reapForceMs: 5000 });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief(), { handoff });
  assert.ok(r.ok);
  assert.equal((await a.settled(r.computeId)).at(-1)?.kind, "completed");
  assert.equal(alive(grandchildPid(f.record)), true);
  assert.deepEqual(a.snapshot(r.computeId), { ok: true, snapshot: handoff });
});

test("RR-05:init 越界后用户 stop → 对外 stopped,违规保留在 violations[]", async () => {
  const f = fake({ reports: [], hang: "stubborn", extraInitTools: ["Bash"] });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  // 越界的 init 不产出 started;等假 CLI 输出 init 之后再 stop,否则 stop 会先杀掉 MCP 服务器、init 变成"未连接"
  await waitFor(() => fs.existsSync(`${f.record}.init`));
  assert.deepEqual(await within(a.stop(r.computeId), 15_000), { ok: true });
  // 进程无视 SIGTERM,settled 要等 reapForceMs 后的组 SIGKILL;限时把"不升级"变成按名字失败,而不是整个文件挂住
  const evs = await within(a.settled(r.computeId), 15_000);
  assert.notEqual(evs, "超时");
  const last = evs === "超时" ? undefined : evs.at(-1);
  assert.equal(last?.kind, "stopped");
  assert.match(last?.kind === "stopped" ? last.violations.join(";") : "", /未授权的工具 Bash/);
});

test("RR-05:terminalFor 的优先级:停止 > 违规 > 进程失败 > 完成;违规保留在 violations,stopped.scope=main-then-group", () => {
  const exit = { code: 0, signal: null };
  const ok = { success: true, text: "完成" };
  const base = { stopRequested: false, violations: [] as string[], pausedBlocked: false, unresolved: [] as string[] };
  const stopped = terminalFor(exit, ok, { ...base, stopRequested: true, violations: ["越界"] }, "");
  assert.equal(stopped.kind, "stopped");
  assert.deepEqual(stopped.kind === "stopped" ? [stopped.scope, ...stopped.violations] : [], ["main-then-group", "越界"]);
  const v = terminalFor(exit, ok, { ...base, violations: ["越界"] }, "");
  assert.deepEqual(v.kind === "failed" ? v.violations : [], ["越界"]);
  assert.equal(terminalFor({ code: 3, signal: null }, ok, base, "").kind, "failed");
  assert.equal(terminalFor(exit, ok, { ...base, pausedBlocked: true }, "").kind, "paused-blocked");
  assert.equal(terminalFor(exit, ok, base, "").kind, "completed");
});

test("RR-03:CLI 以 detached 启动、自成进程组(pgid 等于自己的 pid),组 SIGKILL 与冻结的信号才能对整组发", async () => {
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

// ---------------------------------------------------------------- 第三轮审查 R3-01 – R3-04

test("R3-01:stopped 之后迟到的 milestone 不再产出事件,也不改变终态", async () => {
  const f = fake({ reports: [], hang: "late", lateReport: { kind: "milestone", stage: "迟到", summary: "停止后才报" } }, { reapForceMs: 3000 });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitStarted(a, r.computeId);
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  await waitFor(() => fs.existsSync(termFile(f.record)));
  const evs = await within(a.settled(r.computeId));
  assert.deepEqual(evs === "超时" ? [] : evs.map((e) => e.kind), ["started", "stopped"]);
});

test("R3-01:stopped 之后迟到的 blocked 不能把终态改回受阻、不发 SIGSTOP;第二次 stop 被拒绝", async () => {
  const f = fake({ reports: [], hang: "late", lateReport: { kind: "blocked", summary: "迟到受阻", needs: "迟到" } }, { reapForceMs: 3000 });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitStarted(a, r.computeId);
  const cli = launches(f.record)[0]!.pid;
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  await waitFor(() => fs.existsSync(termFile(f.record)));
  // 迟到的汇报已经写出,主进程 400ms 后才退出:这期间不得被 SIGSTOP 冻结
  await new Promise((ok) => setTimeout(ok, 150));
  assert.equal(procStat(cli).startsWith("T"), false);
  const evs = await within(a.settled(r.computeId));
  assert.deepEqual(evs === "超时" ? [] : evs.map((e) => e.kind), ["started", "stopped"]);
  assert.equal((await a.stop(r.computeId)).ok, false);
  assert.equal(await gone(cli), true);
});

test("R3-01:主进程在 stop 之后立即退出(退出竞态),终态仍只有一个 stopped", async () => {
  const f = fake({ reports: [], hang: "quick" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await waitStarted(a, r.computeId);
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  const evs = await within(a.settled(r.computeId));
  assert.deepEqual(evs === "超时" ? [] : evs.map((e) => e.kind), ["started", "stopped"]);
});

test("R3-02:空白续接先校验、返回输入错误,冻结的主进程与同组孙进程保持暂停;合法续接再执行(单开关)", async () => {
  const f = fake({ reports: [{ kind: "blocked", summary: "要确认", needs: "需要用户确认" }], result: "success", grandchild: { marker: "@MARKER@" },
    resume: { reports: [], result: "success", text: "完成" } });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await within(a.settled(r.computeId));
  const cli = launches(f.record)[0]!.pid;
  const gc = grandchildPid(f.record);
  await waitFor(() => procStat(cli).startsWith("T") && procStat(gc).startsWith("T"));
  assert.deepEqual(await a.resume(r.computeId, "   "), { ok: false, reason: "续接的内容不能为空" });
  assert.equal(procStat(cli).startsWith("T"), true);
  assert.equal(procStat(gc).startsWith("T"), true);
  assert.deepEqual(await a.resume(r.computeId, "已确认"), { ok: true });
  assert.equal(await gone(cli), true);
  assert.deepEqual((await within(a.settled(r.computeId)) as readonly { kind: string }[]).map((e) => e.kind), ["started", "completed"]);
});

test("R3-03:init 之前的 assistant 文本、非 JSON 行 → 回收并 failed,不报 started/completed", async () => {
  for (const pre of [JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "先说一句" }] } }), "not json at all"]) {
    const f = fake({ preInit: [pre], reports: [], result: "success", text: "完成" });
    const a = createComputeAdapter(f.options);
    const r = await a.spawn(brief());
    assert.ok(r.ok);
    const evs = await within(a.settled(r.computeId));
    assert.deepEqual(evs === "超时" ? [] : evs.map((e) => e.kind), ["failed"], pre);
    const last = evs === "超时" ? undefined : evs.at(-1);
    assert.match(last?.kind === "failed" ? last.reason : "", /init 之前/);
  }
});

test("R3-03:init 之前的 report_progress tool_use 不会在 init 之后配对生效 → failed,不产出 milestone", async () => {
  const f = fake({
    preInit: [JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_early", name: REPORT, input: { kind: "milestone", stage: "提前", summary: "提前报" } }] } })],
    postInit: [JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_early", content: [{ type: "text", text: "已记录。" }] }] } })],
    reports: [], result: "success", text: "完成",
  });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const evs = await within(a.settled(r.computeId));
  assert.deepEqual(evs === "超时" ? [] : evs.map((e) => e.kind), ["failed"]);
});

test("R3-03:init 之前认可的 system 帧(hook_started/hook_response/ui_invalidate)放行,随后合法 init 正常完成(对照)", async () => {
  const pre = ["hook_started", "hook_response", "ui_invalidate"].map((subtype) => JSON.stringify({ type: "system", subtype, session_id: "s" }));
  const f = fake({ preInit: pre, reports: [], result: "success", text: "完成" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  assert.deepEqual((await a.settled(r.computeId)).map((e) => e.kind), ["started", "completed"]);
  assert.deepEqual(preInitFrame(JSON.stringify({ type: "system", subtype: "api_retry" })), { kind: "rejected", reason: "system/api_retry" });
  assert.deepEqual(preInitFrame(JSON.stringify({ type: "result", subtype: "success" })), { kind: "rejected", reason: "result/success" });
  assert.deepEqual(preInitFrame(JSON.stringify({ type: "system", subtype: "init" })), { kind: "init" });
});

test("R3-04:断言在假 CLI 写记录之前就失败时,afterEach 仍按测试目录回收进程", async () => {
  const f = fake({ reports: [], hang: "stubborn" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  // 不等记录文件:立刻按目录扫描,能找到刚起的假 CLI;回收后进程表里不再有它
  const dir = path.dirname(f.record);
  await waitFor(() => ownProcs(dir).length > 0);
  const pids = ownProcs(dir);
  reapOwn();
  for (const pid of pids) assert.equal(await gone(pid), true);
  assert.deepEqual(ownProcs(dir), []);
  // 磁盘清理:回收时本测试的 fake-cc-* 目录一并删除
  assert.equal(fs.existsSync(dir), false);
});

// ---------------------------------------------------------------- 第四轮审查 R4-01 – R4-05、磁盘清理
// 合同(g-group#2662):只保证内置原型未被改的环境;外部输入(含状态参数)带 getter/setter/Proxy 不调用即拒收。
// 以下反例都不改动任何内置原型,计数器只数被测代码有没有调用访问器或 Proxy 陷阱。

type Adapter = ReturnType<typeof createComputeAdapter>;
type SpawnOpts = Parameters<Adapter["spawn"]>[1];
type AdapterOpts = Parameters<typeof createComputeAdapter>[0];
const asOpts = (x: unknown) => x as SpawnOpts;
const json = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const TRAPS = ["get", "set", "has", "ownKeys", "getOwnPropertyDescriptor", "defineProperty", "deleteProperty", "getPrototypeOf", "setPrototypeOf", "isExtensible", "preventExtensions"] as const;
/** 每个陷阱都计数后转给 Reflect 的 Proxy */
function counted<T extends object>(target: T, hits: { n: number }): T {
  const handler: Record<string, (...args: unknown[]) => unknown> = {};
  for (const trap of TRAPS) handler[trap] = (...args: unknown[]) => { hits.n++; return (Reflect[trap] as unknown as (...a: unknown[]) => unknown)(...args); };
  return new Proxy(target, handler as ProxyHandler<T>);
}
const revoked = <T extends object>(target: T): T => { const r = Proxy.revocable(target, {}); r.revoke(); return r.proxy; };
/** 把 obj[key] 换成计数的 getter(默认可枚举) */
function withGetter<T extends object>(obj: T, key: PropertyKey, value: unknown, hits: { n: number }, enumerable = true): T {
  Object.defineProperty(obj, key, { get() { hits.n++; return value; }, enumerable, configurable: true });
  return obj;
}
/** 只有 setter、不可枚举的属性(Object.keys 看不到) */
function withHiddenSetter<T extends object>(obj: T, key: PropertyKey, hits: { n: number }): T {
  Object.defineProperty(obj, key, { set() { hits.n++; }, enumerable: false, configurable: true });
  return obj;
}
/** 访问器挂在自定义原型上(不是内置原型) */
function onCustomProto<T extends object>(own: T, key: string, value: unknown, hits: { n: number }): T {
  const proto = {};
  withGetter(proto, key, value, hits);
  return Object.assign(Object.create(proto) as T, own);
}

test("R4-01:checkBrief 遇到字段/数组元素 getter、Proxy、撤销 Proxy、自定义原型 getter、不可枚举 setter 时不调用即拒收;纯 JSON brief 放行(对照)", () => {
  const hits = { n: 0 };
  const rules: string[] = [];
  withGetter(rules, 0, "群规", hits);
  const notEnumTask = brief();
  Object.defineProperty(notEnumTask, "task", { value: "x", enumerable: false });
  const { task: _t, ...noTask } = brief();
  const cases: [string, unknown][] = [
    ["task getter", withGetter(brief(), "task", "把 a.txt 改成大写", hits)],
    ["顶层 Proxy", counted(brief(), hits)],
    ["撤销的 Proxy", revoked(brief())],
    ["rules[0] getter", brief({ rules })],
    ["tools 是 Proxy 数组", brief({ tools: counted(["Read"], hits) })],
    ["credentialRefs 元素 getter", brief({ credentialRefs: withGetter(["vault://a/b"], 0, "vault://a/b", hits) })],
    ["自定义原型上的 task getter", onCustomProto(noTask, "task", "x", hits)],
    ["不可枚举 setter", withHiddenSetter(brief(), "memory", hits)],
    ["不可枚举的 task", notEnumTask],
  ];
  for (const [name, x] of cases) {
    let r: ReturnType<typeof checkBrief> | undefined;
    assert.doesNotThrow(() => { r = checkBrief(x); }, name);
    assert.equal(r?.ok, false, name);
  }
  assert.equal(hits.n, 0);
  const ok = checkBrief(json(brief()));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok ? ok.brief : null, brief());
});

test("R4-01:spawn 的 brief、选项与 handoff(含嵌套数组)带 getter/Proxy/非预期字段时不调用即拒收、不起子进程;纯 JSON 选项与 handoff 正常启动(对照)", async () => {
  const f = fake({ reports: [], result: "success" });
  const a = createComputeAdapter(f.options);
  const hits = { n: 0 };
  const handoff = () => ({ constraintVer: 4, openQuestions: ["q"], doneSideEffects: ["d"] });
  const cases: [string, unknown, unknown][] = [
    ["brief.task getter", withGetter(brief(), "task", "x", hits), undefined],
    ["brief 是 Proxy", counted(brief(), hits), undefined],
    ["选项是 Proxy", brief(), counted({ handoff: handoff() }, hits)],
    ["选项是撤销的 Proxy", brief(), revoked({})],
    ["选项的 handoff getter", brief(), withGetter({}, "handoff", handoff(), hits)],
    ["选项的 cwd getter", brief(), withGetter({}, "cwd", process.cwd(), hits)],
    ["选项带不可枚举 setter", brief(), withHiddenSetter({}, "env", hits)],
    ["选项带非预期字段", brief(), { handoff: handoff(), env: { A: "1" } }],
    ["选项在自定义原型上", brief(), onCustomProto({}, "handoff", handoff(), hits)],
    ["handoff.constraintVer getter", brief(), { handoff: withGetter(handoff(), "constraintVer", 4, hits) }],
    ["handoff 是 Proxy", brief(), { handoff: counted(handoff(), hits) }],
    ["handoff.openQuestions 是 Proxy 数组", brief(), { handoff: { ...handoff(), openQuestions: counted(["q"], hits) } }],
    ["handoff.doneSideEffects 元素 getter", brief(), { handoff: { ...handoff(), doneSideEffects: withGetter(["d"], 0, "d", hits) } }],
  ];
  for (const [name, b, o] of cases) {
    const r = await a.spawn(b, asOpts(o));
    assert.equal(r.ok, false, name);
  }
  assert.equal(hits.n, 0);
  assert.equal(fs.existsSync(f.record), false);
  const ok = await a.spawn(json(brief()), asOpts(json({ handoff: handoff() })));
  assert.ok(ok.ok);
  await a.settled(ok.computeId);
  assert.equal(launches(f.record).length, 1);
  assert.deepEqual(a.snapshot(ok.computeId), { ok: true, snapshot: handoff() });
});

test("R4-01:checkSnapshot 直接调用:访问器、Proxy、撤销 Proxy、非预期字段与嵌套数组 Proxy 不调用即拒收;纯 JSON 快照放行(对照)", () => {
  const hits = { n: 0 };
  const snap = () => ({ constraintVer: 1, openQuestions: ["q"], doneSideEffects: [] as string[] });
  const cases: [string, unknown][] = [
    ["constraintVer getter", withGetter(snap(), "constraintVer", 1, hits)],
    ["Proxy", counted(snap(), hits)],
    ["撤销的 Proxy", revoked(snap())],
    ["openQuestions 元素 getter", { ...snap(), openQuestions: withGetter(["q"], 0, "q", hits) }],
    ["doneSideEffects 是 Proxy 数组", { ...snap(), doneSideEffects: counted([], hits) }],
    ["不可枚举 setter", withHiddenSetter(snap(), "note", hits)],
    ["非预期字段", { ...snap(), memory: "私人记忆" }],
  ];
  for (const [name, x] of cases) {
    let r: ReturnType<typeof checkSnapshot> | undefined;
    assert.doesNotThrow(() => { r = checkSnapshot(x); }, name);
    assert.equal(r?.ok, false, name);
  }
  assert.equal(hits.n, 0);
  assert.deepEqual(checkSnapshot(json(snap())), { ok: true, snapshot: snap() });
});

test("R4-01:reportErrors 遇到 getter、Proxy、撤销 Proxy、嵌套数组访问器、不可枚举字段时返回错误且不调用;纯 JSON 汇报无错(对照)", () => {
  const hits = { n: 0 };
  const rep = () => ({ kind: "started", summary: "开始", openQuestions: ["q"], doneSideEffects: ["d"] });
  const notEnumSummary = rep();
  Object.defineProperty(notEnumSummary, "summary", { value: "开始", enumerable: false });
  const { kind: _k, ...noKind } = rep();
  const cases: [string, unknown][] = [
    ["kind getter", withGetter(rep(), "kind", "started", hits)],
    ["可选字段 stage getter", withGetter(rep(), "stage", "阶段", hits)],
    ["Proxy", counted(rep(), hits)],
    ["撤销的 Proxy", revoked(rep())],
    ["openQuestions 是 Proxy 数组", { ...rep(), openQuestions: counted(["q"], hits) }],
    ["doneSideEffects 元素 getter", { ...rep(), doneSideEffects: withGetter(["d"], 0, "d", hits) }],
    ["自定义原型上的 kind getter", onCustomProto(noKind, "kind", "started", hits)],
    ["不可枚举 setter", withHiddenSetter(rep(), "needs", hits)],
    ["不可枚举的 summary", notEnumSummary],
  ];
  for (const [name, x] of cases) {
    let errs: string[] = [];
    assert.doesNotThrow(() => { errs = reportErrors(x); }, name);
    assert.ok(errs.length > 0, name);
  }
  assert.equal(hits.n, 0);
  assert.deepEqual(reportErrors(json(rep())), []);
});

test("R4-01:适配器选项与状态参数(computeId、续接文本)带 getter/Proxy/toPrimitive 时不调用即拒收;纯数据的选项与续接正常(对照)", async () => {
  const hits = { n: 0 };
  const f = fake({ reports: [], result: "success" });
  const badOptions: [string, unknown][] = [
    ["hostEnv getter", { ...f.options, hostEnv: withGetter({ ...f.options.hostEnv }, "FAKE_RECORD", f.record, hits) }],
    ["选项是 Proxy", counted({ ...f.options }, hits)],
    ["选项是撤销的 Proxy", revoked({ ...f.options })],
    ["runner.args 元素 getter", { ...f.options, runner: { command: process.execPath, args: withGetter([FAKE], 0, FAKE, hits) } }],
    ["hostEnv 是 Proxy", { ...f.options, hostEnv: counted({ ...f.options.hostEnv }, hits) }],
    ["reapForceMs getter", withGetter({ ...f.options }, "reapForceMs", 1500, hits)],
    ["选项带不可枚举 setter", withHiddenSetter({ ...f.options }, "env", hits)],
  ];
  for (const [name, o] of badOptions) assert.throws(() => createComputeAdapter(o as AdapterOpts), TypeError, name);
  const a = createComputeAdapter(json(f.options));
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await a.settled(r.computeId);
  const evil = { [Symbol.toPrimitive]() { hits.n++; return r.computeId; }, toString() { hits.n++; return r.computeId; }, valueOf() { hits.n++; return r.computeId; } };
  const proxied = counted({}, hits);
  for (const id of [evil, proxied] as unknown as string[]) {
    assert.equal((await a.resume(id, "继续")).ok, false);
    assert.equal((await a.stop(id)).ok, false);
    assert.equal(a.snapshot(id).ok, false);
    assert.deepEqual(a.rejectedReports(id), []);
    assert.deepEqual(await a.settled(id), []);
  }
  assert.equal((await a.resume(r.computeId, evil as unknown as string)).ok, false);
  assert.equal((await a.resume(r.computeId, proxied as unknown as string)).ok, false);
  assert.equal(hits.n, 0);
  assert.equal(launches(f.record).length, 1);
  assert.deepEqual(await a.resume(r.computeId, "继续"), { ok: true });
  assert.deepEqual((await a.settled(r.computeId)).map((e) => e.kind), ["started", "completed"]);
});

test("导出的策略常量不可变:CC_BUILTIN_TOOLS、REPORT_KINDS、PRE_INIT_SYSTEM_SUBTYPES、DEFAULT_RUNNER 冻结,改写抛错且校验行为不变", () => {
  for (const c of [CC_BUILTIN_TOOLS, REPORT_KINDS, PRE_INIT_SYSTEM_SUBTYPES, DEFAULT_RUNNER, DEFAULT_RUNNER.args]) assert.equal(Object.isFrozen(c), true);
  assert.throws(() => (CC_BUILTIN_TOOLS as string[]).push("Task"), TypeError);
  assert.throws(() => (REPORT_KINDS as string[]).push("done"), TypeError);
  assert.throws(() => (PRE_INIT_SYSTEM_SUBTYPES as string[]).push("assistant"), TypeError);
  assert.throws(() => { (DEFAULT_RUNNER as { command: string }).command = "sh"; }, TypeError);
  assert.equal(checkBrief(brief({ tools: ["Task"] })).ok, false);
  assert.deepEqual(reportErrors({ kind: "done", summary: "x" }), ["kind 非法"]);
  assert.equal(preInitFrame(JSON.stringify({ type: "assistant" })).kind, "rejected");
  assert.equal(isCredentialRef("vault://team/upload-token"), true);
  assert.equal(isCredentialRef("ghp_PLAINTEXT"), false);
});

test("R4-04:多凭据引用:每一个位置放非引用都被拒绝、不起进程;全部合法的多元素放行并原样进清单(对照)", async () => {
  const f = fake({ reports: [], result: "success" });
  const a = createComputeAdapter(f.options);
  for (const refs of [["vault://team/a", "ref://fixture/path"], ["vault://team/a", "ref://fixture/path", "kms://k/2"]]) {
    for (let i = 0; i < refs.length; i++) {
      const bad = [...refs];
      bad[i] = "not-a-reference";
      assert.equal(checkBrief(brief({ credentialRefs: bad })).ok, false, JSON.stringify(bad));
      const r = await a.spawn(brief({ credentialRefs: bad }));
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.match(r.ok ? "" : r.reason, /引用句柄/);
    }
  }
  assert.equal(fs.existsSync(f.record), false);
  const refs = ["vault://team/a", "ref://fixture/path", "kms://k/2"];
  const ok = await a.spawn(brief({ credentialRefs: refs }));
  assert.ok(ok.ok);
  assert.deepEqual(ok.manifest.credentialRefs, refs);
  await a.settled(ok.computeId);
  assert.equal(launches(f.record)[0]!.env.G_GROUP_CREDENTIAL_REFS, JSON.stringify(refs));
});

type RpcReply = { id: unknown; result?: { tools?: unknown[]; isError?: boolean; content?: { text: string }[] }; error?: { code: number; message?: string } };
/** 向真实 report MCP 子进程 stdin 逐行写入,收集全部回复、退出码与 stderr */
function rpc(lines: string[], env: Record<string, string> = {}) {
  const out = spawnSync(process.execPath, [REPORT_MCP_PATH], { input: `${lines.join("\n")}\n`, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env }, timeout: 10_000 });
  return { status: out.status, stderr: out.stderr, replies: out.stdout.trim() ? out.stdout.trim().split("\n").map((l) => JSON.parse(l) as RpcReply) : [] };
}
const call = (id: number, args: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "report_progress", arguments: args } });
const list = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" });

test("R4-02:report MCP 收到合法 JSON null、其他原始值、数组与坏 JSON 时回 JSON-RPC 错误且进程继续可用,随后的合法请求照常处理(正反对照)", () => {
  const good = rpc([list(1), call(2, { kind: "started", summary: "x" })]);
  assert.equal(good.status, 0);
  assert.deepEqual(good.replies.map((x) => x.id), [1, 2]);
  const r = rpc(["null", list(1), "1", '"文本"', "true", "[]", "{坏", call(2, { kind: "started", summary: "x" }), call(3, { kind: "done", summary: "x" })]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  assert.deepEqual(r.replies.map((x) => [x.id, x.error?.code ?? null]), [[null, -32600], [1, null], [null, -32600], [null, -32600], [null, -32600], [null, -32600], [null, -32700], [2, null], [3, null]]);
  assert.deepEqual(r.replies[1]!.result?.tools, [reportToolDefinition()]);
  assert.deepEqual([r.replies[7]!.result?.isError, r.replies[8]!.result?.isError], [false, true]);
  assert.ok(r.replies[8]!.result?.content?.[0]?.text.includes(reportErrors({ kind: "done", summary: "x" })[0]!));
});

test("R4-05:tools/list 直接 JSON-RPC 返回 report_progress 及与共享定义一致的 schema;未知方法回 method not found(对照)", () => {
  const r = rpc([list(1), JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list" })]);
  assert.equal(r.status, 0);
  const tools = r.replies[0]!.result?.tools as { name: string; inputSchema: { properties: { kind: { enum: string[] } } } }[];
  assert.deepEqual(tools, [reportToolDefinition()]);
  assert.equal(tools[0]?.name, "report_progress");
  assert.deepEqual(tools[0]?.inputSchema.properties.kind.enum, [...REPORT_KINDS]);
  assert.deepEqual(r.replies[1]!.error?.code, -32601);
});

/** 只回 initialize、tools/list 返回空数组的 MCP 服务器(工具缺失路径);命令行带测试目录,便于按目录回收 */
const EMPTY_TOOLS_SERVER = `const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (l) => { let m; try { m = JSON.parse(l); } catch { return; } if (!m || typeof m !== "object") return;
  const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "empty", version: "0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } }); });`;

test("R4-05:经假 CLI 的工具发现:tools/list 列出 report_progress 时 init 带上它并 started→completed;tools/list 为空时 init 缺 report_progress → failed(正反对照)", async () => {
  const listed = fake({ reports: [{ kind: "milestone", stage: "阶段1", summary: "a" }], result: "success" });
  const a1 = createComputeAdapter(listed.options);
  const r1 = await a1.spawn(brief());
  assert.ok(r1.ok);
  assert.deepEqual((await a1.settled(r1.computeId)).map((e) => e.kind), ["started", "milestone", "completed"]);
  const init1 = JSON.parse(fs.readFileSync(`${listed.record}.init`, "utf8")) as { tools: string[] };
  assert.equal(init1.tools.includes(REPORT), true);
  const empty = fake({ reports: [], result: "success", text: "完成" });
  const a2 = createComputeAdapter({ ...empty.options, reportServer: { command: process.execPath, args: ["-e", EMPTY_TOOLS_SERVER, "--", `--fake-dir=${path.dirname(empty.record)}${path.sep}`] } });
  const r2 = await a2.spawn(brief());
  assert.ok(r2.ok);
  const evs = await a2.settled(r2.computeId);
  assert.deepEqual(evs.map((e) => e.kind), ["failed"]);
  // 原因是"清单里没有"而不是"MCP 未连接":服务器已连上(checkInit 先查连接、后查清单),只是 tools/list 没列出它。
  // 不读假 CLI 的 .init 记录:适配器判违规后立即 SIGTERM 主进程,记录可能来不及写完
  assert.match(evs[0]?.kind === "failed" ? evs[0].reason : "", /工具清单里没有 mcp__host__report_progress/);
});

test("R4-05:REPORT_LOG:合法与非法调用各追加一行,valid/errs 与共享校验一致,无效请求不记;未设 REPORT_LOG 时不写任何文件(正反对照)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cc-"));
  ownDirs.add(dir);
  const log = path.join(dir, "report.jsonl");
  const bad = { kind: "done", summary: "x" };
  const r = rpc([call(1, { kind: "started", summary: "开始", constraintVer: 2 }), "null", call(2, bad)], { REPORT_LOG: log });
  assert.equal(r.status, 0);
  const recs = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { ts: string; valid: boolean; errs: string[]; kind: string });
  assert.deepEqual(recs.map((x) => [x.valid, x.errs, x.kind]), [[true, [], "started"], [false, reportErrors(bad), "done"]]);
  assert.equal(recs.every((x) => !Number.isNaN(Date.parse(x.ts))), true);
  const quiet = rpc([call(1, { kind: "started", summary: "开始" })]);
  assert.equal(quiet.replies[0]?.result?.isError, false);
  assert.deepEqual(fs.readdirSync(dir), ["report.jsonl"]);
});

test("R4-03:resolveReapForceMs 与 mirasim Ukc 一致:未传显式值时合法正数环境值生效,缺失/无效/非正回落 10000;显式值优先", () => {
  assert.equal(resolveReapForceMs(undefined, undefined), DEFAULT_REAP_FORCE_MS);
  for (const bad of ["", "abc", "0", "-5", "NaN", "Infinity", "-Infinity", "1e400"]) assert.equal(resolveReapForceMs(undefined, bad), 10_000, bad);
  assert.equal(resolveReapForceMs(undefined, "500"), 500);
  assert.equal(resolveReapForceMs(undefined, " 750 "), 750);
  assert.equal(resolveReapForceMs(undefined, "1.5"), 1.5);
  assert.equal(resolveReapForceMs(1234, "500"), 1234);
  assert.equal(resolveReapForceMs(1234, undefined), 1234);
  assert.equal(resolveReapForceMs(0, "500"), 0);
});

test("R4-03:未传 reapForceMs 时读 MIRASIM_REAP_FORCE_MS=400,主进程无视 SIGTERM 约 400ms 后整组 SIGKILL;显式 reapForceMs=5000 优先,1.5 秒后主进程仍在(对照)", async () => {
  const prev = process.env.MIRASIM_REAP_FORCE_MS;
  process.env.MIRASIM_REAP_FORCE_MS = "400";
  try {
    const f1 = fake({ reports: [], hang: "stubborn", grandchild: { marker: "@MARKER@" } }, { reapForceMs: undefined });
    const a1 = createComputeAdapter(f1.options);
    const r1 = await a1.spawn(brief());
    assert.ok(r1.ok);
    await waitStarted(a1, r1.computeId);
    const cli = launches(f1.record)[0]!.pid;
    const gc = grandchildPid(f1.record);
    assert.deepEqual(await a1.stop(r1.computeId), { ok: true });
    assert.equal(alive(cli), true);
    assert.equal(await gone(cli, 3000), true);
    assert.equal(await gone(gc, 1000), true);
    const f2 = fake({ reports: [], hang: "stubborn" }, { reapForceMs: 5000 });
    const a2 = createComputeAdapter(f2.options);
    const r2 = await a2.spawn(brief());
    assert.ok(r2.ok);
    await waitStarted(a2, r2.computeId);
    assert.deepEqual(await a2.stop(r2.computeId), { ok: true });
    await new Promise((ok) => setTimeout(ok, 1500));
    assert.equal(alive(launches(f2.record)[0]!.pid), true);
  } finally {
    if (prev === undefined) delete process.env.MIRASIM_REAP_FORCE_MS;
    else process.env.MIRASIM_REAP_FORCE_MS = prev;
  }
});

test("R4-03:环境值无效(abc)且未传 reapForceMs 时回落默认 10000,1.5 秒后主进程仍在", async () => {
  const prev = process.env.MIRASIM_REAP_FORCE_MS;
  process.env.MIRASIM_REAP_FORCE_MS = "abc";
  try {
    const f = fake({ reports: [], hang: "stubborn" }, { reapForceMs: undefined });
    const a = createComputeAdapter(f.options);
    const r = await a.spawn(brief());
    assert.ok(r.ok);
    await waitStarted(a, r.computeId);
    assert.deepEqual(await a.stop(r.computeId), { ok: true });
    await new Promise((ok) => setTimeout(ok, 1500));
    assert.equal(alive(launches(f.record)[0]!.pid), true);
    assert.equal(resolveReapForceMs(undefined, process.env.MIRASIM_REAP_FORCE_MS), DEFAULT_REAP_FORCE_MS);
  } finally {
    if (prev === undefined) delete process.env.MIRASIM_REAP_FORCE_MS;
    else process.env.MIRASIM_REAP_FORCE_MS = prev;
  }
});

const mcpDir = (l: Launch) => path.dirname(flagOf(l.argv, "--mcp-config")!);

test("磁盘清理:每轮的 g-group-cc-* 临时目录运行中存在,CLI 结束、stop 或受阻后续接时删除;续接的新一轮另建目录并在结束后删除", async () => {
  const done = fake({ reports: [], result: "success" });
  const a1 = createComputeAdapter(done.options);
  const r1 = await a1.spawn(brief());
  assert.ok(r1.ok);
  await a1.settled(r1.computeId);
  const d1 = mcpDir(launches(done.record)[0]!);
  assert.equal(path.basename(d1).startsWith("g-group-cc-"), true);
  assert.equal(path.dirname(d1), os.tmpdir());
  assert.equal(fs.existsSync(d1), false);

  const running = fake({ reports: [], hang: "graceful" });
  const a2 = createComputeAdapter(running.options);
  const r2 = await a2.spawn(brief());
  assert.ok(r2.ok);
  await waitStarted(a2, r2.computeId);
  const d2 = mcpDir(launches(running.record)[0]!);
  assert.equal(fs.existsSync(d2), true);
  assert.deepEqual(await a2.stop(r2.computeId), { ok: true });
  await within(a2.settled(r2.computeId));
  assert.equal(fs.existsSync(d2), false);

  const blocked = fake({ reports: [{ kind: "blocked", summary: "要确认", needs: "需要用户确认" }], result: "success", resume: { reports: [], result: "success" } });
  const a3 = createComputeAdapter(blocked.options);
  const r3 = await a3.spawn(brief());
  assert.ok(r3.ok);
  await a3.settled(r3.computeId);
  const d3 = mcpDir(launches(blocked.record)[0]!);
  assert.equal(fs.existsSync(d3), true);
  assert.deepEqual(await a3.resume(r3.computeId, "已确认"), { ok: true });
  assert.equal(fs.existsSync(d3), false);
  assert.deepEqual((await a3.settled(r3.computeId)).map((e) => e.kind), ["started", "completed"]);
  const d4 = mcpDir(launches(blocked.record)[1]!);
  assert.notEqual(d4, d3);
  assert.equal(fs.existsSync(d4), false);
});

// ---------------------------------------------------------------- 第五轮审查 R5-01、R5-02
// R5-01 合同:未声明的自有字段按安全取得的描述符拒收,值为 undefined 也不能绕过白名单;
// 声明过的可选字段(spawn 选项 cwd/handoff、汇报 stage/needs/constraintVer/openQuestions/doneSideEffects、适配器选项)
// 值为 undefined 时按没给处理;必填字段为 undefined 按缺失拒收。

/** 中性启动标记:runner 只往本测试目录下的 launch-marker.txt 追加一行 "launched" 后退出,用来判断适配器有没有起进程。
 *  不含任何密钥或凭据;命令行带测试目录,afterEach 按目录回收 */
function markerRunner() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cc-"));
  ownDirs.add(dir);
  const marker = path.join(dir, "launch-marker.txt");
  const code = 'require("node:fs").appendFileSync(process.argv[1], "launched\\n")';
  return { marker, options: { runner: { command: process.execPath, args: ["-e", code, marker, `--fake-dir=${dir}${path.sep}`] }, reapForceMs: 1500 } };
}

test("R5-01:checkBrief、checkSnapshot、reportErrors 遇到值为 undefined 的未声明自有字段一律拒收;去掉该字段放行,声明过的可选字段为 undefined 按没给处理、必填字段为 undefined 拒收(单开关对照)", () => {
  for (const key of ["memory", "soul"]) {
    const r = checkBrief(brief({ [key]: undefined }));
    assert.equal(r.ok, false, key);
    assert.match(r.ok ? "" : r.reason, new RegExp(`额外字段 ${key}`), key);
  }
  assert.equal(checkBrief(brief({ task: undefined })).ok, false);
  assert.deepEqual(checkBrief(brief()), { ok: true, brief: brief() });

  const snap = () => ({ constraintVer: 3, openQuestions: ["q"], doneSideEffects: [] as string[] });
  const badSnap = checkSnapshot({ ...snap(), outside: undefined });
  assert.equal(badSnap.ok, false);
  assert.match(badSnap.ok ? "" : badSnap.reason, /额外字段 outside/);
  assert.equal(checkSnapshot({ ...snap(), constraintVer: undefined }).ok, false);
  assert.deepEqual(checkSnapshot(snap()), { ok: true, snapshot: snap() });

  const rep = { kind: "started", summary: "开始" };
  assert.deepEqual(reportErrors({ ...rep, memory: undefined }), ["未知字段 memory"]);
  assert.deepEqual(reportErrors(rep), []);
  assert.deepEqual(reportErrors({ ...rep, stage: undefined, needs: undefined, constraintVer: undefined, openQuestions: undefined, doneSideEffects: undefined }), []);
  assert.deepEqual(reportErrors({ kind: "milestone", summary: "x", stage: undefined }), ["milestone 缺 stage"]);
  assert.deepEqual(reportErrors({ ...rep, summary: undefined }), ["summary 须为非空字符串"]);
});

test("R5-01:spawn 的 brief 带 memory/soul:undefined、选项或 handoff 带 outside:undefined 时拒收且不起进程(中性启动标记不出现);去掉该字段的同一输入照常启动,选项 cwd/handoff 为 undefined 按没给处理(单开关对照)", async () => {
  const m = markerRunner();
  const a = createComputeAdapter(m.options);
  const handoff = () => ({ constraintVer: 2, openQuestions: [] as string[], doneSideEffects: [] as string[] });
  const cases: [string, unknown, unknown, RegExp][] = [
    ["brief.memory:undefined", brief({ memory: undefined }), undefined, /额外字段 memory/],
    ["brief.soul:undefined", brief({ soul: undefined }), undefined, /额外字段 soul/],
    ["spawn 选项 outside:undefined", brief(), { outside: undefined }, /拒绝 outside/],
    ["handoff outside:undefined", brief(), { handoff: { ...handoff(), outside: undefined } }, /额外字段 outside/],
  ];
  for (const [name, b, o, re] of cases) {
    const r = await a.spawn(b, asOpts(o));
    assert.equal(r.ok, false, name);
    assert.match(r.ok ? "" : r.reason, re, name);
  }
  assert.equal(fs.existsSync(m.marker), false);
  const controls: [string, unknown, unknown][] = [
    ["brief 不带额外字段", brief(), undefined],
    ["spawn 选项为空对象", brief(), {}],
    ["spawn 选项 cwd、handoff 为 undefined", brief(), { cwd: undefined, handoff: undefined }],
    ["handoff 不带额外字段", brief(), { handoff: handoff() }],
  ];
  for (const [name, b, o] of controls) {
    const r = await a.spawn(b, asOpts(o));
    assert.ok(r.ok, name);
    await within(a.settled(r.computeId));
  }
  assert.equal(fs.readFileSync(m.marker, "utf8"), "launched\n".repeat(controls.length));
});

const callNamed = (id: number, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params });

test("R5-02:report MCP 的 tools/call 只认 report_progress:未知、缺失或非字符串工具名回 -32602 协议错误,不回已记录、不写 REPORT_LOG;同一参数换成合法名称照常接收并记录(单开关对照)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cc-"));
  ownDirs.add(dir);
  const log = path.join(dir, "report.jsonl");
  const args = { kind: "started", summary: "开始" };
  const name = (reportToolDefinition() as { name: string }).name;
  const r = rpc([list(1), callNamed(2, { name: "unknown_tool", arguments: args }), callNamed(3, { arguments: args }), callNamed(4, { name: 7, arguments: args }), callNamed(5, { name, arguments: args })], { REPORT_LOG: log });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  assert.deepEqual(r.replies.map((x) => [x.id, x.error?.code ?? null, x.result?.isError ?? null]), [[1, null, null], [2, -32602, null], [3, -32602, null], [4, -32602, null], [5, null, false]]);
  assert.deepEqual(((r.replies[0]!.result?.tools ?? []) as { name: string }[]).map((t) => t.name), [name]);
  assert.match(r.replies[1]!.error?.message ?? "", /unknown_tool/);
  assert.equal(r.replies.slice(1, 4).some((x) => x.result !== undefined), false);
  assert.equal(r.replies[4]!.result?.content?.[0]?.text, "已记录。");
  const recs = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { valid: boolean; kind: string });
  assert.deepEqual(recs.map((x) => [x.valid, x.kind]), [[true, "started"]]);
  assert.deepEqual(reportErrors(args), []);
});

// ---------------------------------------------------------------- 第六轮审查 R6-01、R6-02、R6-03
// R6-01 合同:包根(./index.ts,即 @g-group/adapter-cc-compute)导出的每个函数都是外部入口。对象参数先按 plain.ts 纯数据合同判定
// (brief 过 checkBrief、交接快照过 checkSnapshot),状态参数(字符串、数字)先判 typeof;getter/setter、Proxy(含嵌套、已撤销)、
// 带 toPrimitive/toString/valueOf 访问器的对象一律不调用即拒收(抛受控 TypeError,或按该入口的约定返回拒绝),访问器与陷阱计数为 0;
// 合法纯数据照常工作。合同限定内置原型未被改的环境(g-group#2662),本节不改任何内置原型。

const PROXY_TRAPS = ["get", "set", "has", "ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf", "setPrototypeOf", "defineProperty", "deleteProperty", "isExtensible", "preventExtensions"] as const;
/** 计数器:任何访问器或 Proxy 陷阱被调用一次就加一 */
function hitCounter() {
  const c = { hits: 0 };
  const handler: ProxyHandler<object> = {};
  for (const k of PROXY_TRAPS) {
    (handler as Record<string, unknown>)[k] = (...args: unknown[]) => { c.hits++; return (Reflect as unknown as Record<string, (...a: unknown[]) => unknown>)[k]!(...args); };
  }
  return { c, proxy: <T extends object>(t: T): T => new Proxy(t, handler) as T };
}
function deadProxy(): object {
  const r = Proxy.revocable({}, {});
  r.revoke();
  return r.proxy;
}
/** 带计数 getter 的副本:把 x 的 key 换成可枚举 getter,返回原值 */
function getterCopy<T extends object>(x: T, key: string, k: ReturnType<typeof hitCounter>): T {
  const val = (x as Record<string, unknown>)[key];
  Object.defineProperty(x, key, { enumerable: true, configurable: true, get() { k.c.hits++; return val; } });
  return x;
}
/** 状态参数的反例:typeof 不是 string/number,隐式转换会经过 toPrimitive/toString/valueOf 访问器 */
function coercible(v: unknown, k: ReturnType<typeof hitCounter>): object {
  const o = {};
  for (const key of [Symbol.toPrimitive, "toString", "valueOf"]) Object.defineProperty(o, key, { get() { k.c.hits++; return () => v; } });
  return o;
}
/** 由合法参数派生的反例:已撤销 Proxy、整体 Proxy、首个自有键换 getter、首个对象值换成 Proxy / 已撤销 Proxy;原始值换成可转换对象 */
function hostileVariants(v: unknown, k: ReturnType<typeof hitCounter>): [string, unknown][] {
  const out: [string, unknown][] = [["已撤销 Proxy", deadProxy()]];
  if (typeof v !== "object" || v === null) return [...out, ["toPrimitive/toString/valueOf 访问器", coercible(v, k)], ["转换陷阱 Proxy", k.proxy({})]];
  out.push(["整体 Proxy", k.proxy(structuredClone(v))]);
  const keys = Object.keys(v);
  if (keys.length === 0) return [...out, ["自有 getter x", getterCopy({ x: "x" }, "x", k)]];
  out.push([`自有 getter ${keys[0]}`, getterCopy(structuredClone(v), keys[0]!, k)]);
  const nested = keys.find((key) => typeof (v as Record<string, unknown>)[key] === "object" && (v as Record<string, unknown>)[key] !== null);
  if (nested) {
    const p = structuredClone(v) as Record<string, unknown>;
    p[nested] = k.proxy(p[nested] as object);
    out.push([`嵌套 Proxy ${nested}`, p]);
    const r = structuredClone(v) as Record<string, unknown>;
    r[nested] = deadProxy();
    out.push([`嵌套已撤销 Proxy ${nested}`, r]);
  }
  return out;
}
type Attempt = { threw?: unknown; value?: unknown };
const attempt = (f: () => unknown): Attempt => { try { return { value: f() }; } catch (threw) { return { threw }; } };
const RESULT_LINE = JSON.stringify({ type: "result", subtype: "success", result: "完成" });
const legalFacts = () => ({ stopRequested: false, violations: ["越界"], pausedBlocked: false, unresolved: [] as string[] });
/** 包根每个导出函数的合法参数与“拒绝”的返回约定(不写 refused 的入口只以受控 TypeError 拒收) */
const PUBLIC_CALLS: Record<string, { readonly args: readonly unknown[]; readonly refused?: (v: unknown) => boolean }> = {
  createComputeAdapter: { args: [{ reapForceMs: 1000 }] },
  resolveReapForceMs: { args: [undefined, "400"] },
  checkBrief: { args: [brief()], refused: (v) => (v as { ok: boolean }).ok === false },
  checkSnapshot: { args: [{ constraintVer: 1, openQuestions: ["q"], doneSideEffects: [] }], refused: (v) => (v as { ok: boolean }).ok === false },
  isCredentialRef: { args: ["vault://team/upload-token"], refused: (v) => v === false },
  reportErrors: { args: [{ kind: "started", summary: "开始" }], refused: (v) => Array.isArray(v) && v.length > 0 },
  reportToolDefinition: { args: [] },
  allowedTools: { args: [brief()] },
  cliArgs: { args: [brief(), "提示", "/nonexistent/mcp.json", "sess-1"] },
  cliEnv: { args: [brief(), "cc-1", { SAFE_MARKER: "fixture" }] },
  firstPrompt: { args: [brief(), { constraintVer: 1, openQuestions: ["q"], doneSideEffects: ["d"] }] },
  toolOverreach: { args: [brief(), ["Read", REPORT]] },
  streamParser: { args: [RESULT_LINE] },
  terminalFor: { args: [{ code: 0, signal: null }, { success: true, text: "完成" }, legalFacts(), ""] },
};

test("R6-01:包根 firstPrompt 对 brief/交接快照的 getter、嵌套与已撤销 Proxy 不调用即抛受控 TypeError(计数 0);合法纯数据照常拼出首个提示,返回值深冻结", () => {
  const k = hitCounter();
  const bad: [string, unknown, unknown][] = [
    ["brief.task getter", getterCopy(brief(), "task", k), undefined],
    ["brief.rules 嵌套 Proxy", brief({ rules: k.proxy(["群规"]) }), undefined],
    ["brief 已撤销 Proxy", deadProxy(), undefined],
    ["handoff getter", brief(), getterCopy({ constraintVer: 1, openQuestions: [], doneSideEffects: [] }, "constraintVer", k)],
    ["handoff 嵌套已撤销 Proxy", brief(), { constraintVer: 1, openQuestions: deadProxy(), doneSideEffects: [] }],
  ];
  for (const [name, b, h] of bad) {
    const r = attempt(() => root.firstPrompt(b as never, h as never));
    assert.ok(r.threw instanceof TypeError, `${name}:没有以 TypeError 拒收`);
    assert.equal(k.c.hits, 0, `${name}:访问器或陷阱被调用`);
  }
  const ok = root.firstPrompt(brief() as never, { constraintVer: 4, openQuestions: ["q1"], doneSideEffects: ["已发邮件"] });
  assert.match(ok.prompt, /把 a\.txt 改成大写/);
  assert.match(ok.prompt, /约束版本: 4/);
  assert.deepEqual(ok.sections.map((s) => s.name), ["task", "rules", "handoff", "credentialRefs"]);
  assert.ok(Object.isFrozen(ok) && Object.isFrozen(ok.sections) && Object.isFrozen(ok.sections[1]!.detail) && Object.isFrozen((ok.sections[1]!.detail as { items: string[] }).items));
});

test("R6-01:包根 allowedTools、cliArgs、toolOverreach 对 brief Proxy/getter 与非字符串状态参数不调用即抛受控 TypeError(计数 0);合法输入给出按 brief 收窄的工具清单与参数", () => {
  const k = hitCounter();
  const proxied = () => k.proxy(brief());
  const cases: [string, () => unknown][] = [
    ["allowedTools brief Proxy", () => root.allowedTools(proxied() as never)],
    ["allowedTools brief.tools 嵌套 Proxy", () => root.allowedTools(brief({ tools: k.proxy(["Read"]) }) as never)],
    ["cliArgs brief Proxy", () => root.cliArgs(proxied() as never, "提示", "/nonexistent/mcp.json")],
    ["cliArgs brief getter", () => root.cliArgs(getterCopy(brief(), "tools", k) as never, "提示", "/nonexistent/mcp.json")],
    ["cliArgs prompt 可转换对象", () => root.cliArgs(brief() as never, coercible("提示", k) as never, "/nonexistent/mcp.json")],
    ["cliArgs mcpConfigPath Proxy", () => root.cliArgs(brief() as never, "提示", k.proxy({}) as never)],
    ["cliArgs resumeSession 可转换对象", () => root.cliArgs(brief() as never, "提示", "/nonexistent/mcp.json", coercible("s", k) as never)],
    ["toolOverreach brief 已撤销 Proxy", () => root.toolOverreach(deadProxy() as never, [REPORT])],
    ["toolOverreach initTools Proxy", () => root.toolOverreach(brief() as never, k.proxy([REPORT]))],
  ];
  for (const [name, f] of cases) {
    const r = attempt(f);
    assert.ok(r.threw instanceof TypeError, `${name}:没有以 TypeError 拒收`);
    assert.equal(k.c.hits, 0, `${name}:访问器或陷阱被调用`);
  }
  assert.deepEqual(root.allowedTools(brief() as never), ["Read", "Write", REPORT]);
  const args = root.cliArgs(brief() as never, "提示", "/nonexistent/mcp.json", "sess-1");
  assert.equal(flagOf([...args], "--tools"), "Read,Write");
  assert.equal(flagOf([...args], "--allowedTools"), `Read,Write,${REPORT}`);
  assert.equal(flagOf([...args], "--resume"), "sess-1");
  assert.deepEqual(root.toolOverreach(brief() as never, ["Read", "Bash", REPORT]), ["Bash"]);
});

test("R6-01:包根 cliEnv 对 hostEnv 的 getter、Proxy、非字符串或 undefined 值与非字符串 computeId 不调用即抛受控 TypeError(计数 0),与 createComputeAdapter 的 hostEnv 判定一致;合法 hostEnv 原样复制", () => {
  const k = hitCounter();
  const getterEnv = () => getterCopy({ SAFE_MARKER: "fixture" }, "SAFE_MARKER", k);
  assert.throws(() => createComputeAdapter({ hostEnv: getterEnv() }), TypeError);
  const cases: [string, () => unknown][] = [
    ["hostEnv getter", () => root.cliEnv(brief() as never, "cc-1", getterEnv())],
    ["hostEnv Proxy", () => root.cliEnv(brief() as never, "cc-1", k.proxy({ SAFE_MARKER: "fixture" }))],
    ["hostEnv 已撤销 Proxy", () => root.cliEnv(brief() as never, "cc-1", deadProxy() as never)],
    ["hostEnv 值是对象", () => root.cliEnv(brief() as never, "cc-1", { SAFE_MARKER: { x: 1 } } as never)],
    ["hostEnv 值是 undefined", () => root.cliEnv(brief() as never, "cc-1", { SAFE_MARKER: undefined } as never)],
    ["brief 嵌套 Proxy", () => root.cliEnv(brief({ credentialRefs: k.proxy(["vault://a/b"]) }) as never, "cc-1")],
    ["computeId 可转换对象", () => root.cliEnv(brief() as never, coercible("cc-1", k) as never)],
  ];
  for (const [name, f] of cases) {
    const r = attempt(f);
    assert.ok(r.threw instanceof TypeError, `${name}:没有以 TypeError 拒收`);
    assert.equal(k.c.hits, 0, `${name}:访问器或陷阱被调用`);
  }
  const env = root.cliEnv(brief() as never, "cc-1", { SAFE_MARKER: "fixture" });
  assert.equal(env.SAFE_MARKER, "fixture");
  assert.equal(env.G_GROUP_COMPUTE_ID, "cc-1");
  assert.equal(env.G_GROUP_CREDENTIAL_REFS, JSON.stringify(["vault://team/upload-token"]));
  assert.equal(root.cliEnv(brief() as never, "cc-2").G_GROUP_COMPUTE_ID, "cc-2");
});

test("R6-01:包根 streamParser 的输入行与 terminalFor 的退出/结果/事实参数遇到 Proxy、getter、嵌套 Proxy 不调用即抛受控 TypeError(计数 0);合法字符串行与纯数据照常解析和裁决", () => {
  const k = hitCounter();
  const toPrimitiveProxy = k.proxy({});
  const cases: [string, () => unknown][] = [
    ["streamParser 转换陷阱 Proxy", () => root.streamParser()(toPrimitiveProxy as never)],
    ["streamParser 可转换对象", () => root.streamParser()(coercible(RESULT_LINE, k) as never)],
    ["terminalFor exit getter", () => root.terminalFor(getterCopy({ code: 0, signal: null }, "code", k) as never, { success: true, text: "完成" }, legalFacts(), "")],
    ["terminalFor result Proxy", () => root.terminalFor({ code: 0, signal: null }, k.proxy({ success: true, text: "完成" }), legalFacts(), "")],
    ["terminalFor facts.violations 嵌套 Proxy", () => root.terminalFor({ code: 0, signal: null }, undefined, { ...legalFacts(), violations: k.proxy(["越界"]) }, "")],
    ["terminalFor facts 已撤销 Proxy", () => root.terminalFor({ code: 0, signal: null }, undefined, deadProxy() as never, "")],
    ["terminalFor stderrTail 可转换对象", () => root.terminalFor({ code: 1, signal: null }, undefined, { ...legalFacts(), violations: [] }, coercible("x", k) as never)],
  ];
  for (const [name, f] of cases) {
    const r = attempt(f);
    assert.ok(r.threw instanceof TypeError, `${name}:没有以 TypeError 拒收`);
    assert.equal(k.c.hits, 0, `${name}:访问器或陷阱被调用`);
  }
  assert.deepEqual(root.streamParser()(RESULT_LINE), [{ type: "result", success: true, text: "完成" }]);
  assert.deepEqual(root.streamParser()("不是 JSON"), []);
  const t = root.terminalFor({ code: 0, signal: null }, { success: true, text: "完成" }, legalFacts(), "");
  assert.deepEqual(t, { kind: "failed", reason: "越界", code: 0, signal: null, violations: ["越界"] });
  assert.deepEqual(root.terminalFor({ code: 0, signal: null }, { success: true, text: "完成" }, { ...legalFacts(), violations: [] }, ""), { kind: "completed", result: "完成" });
});

test("R6-01:包根导出的每个函数逐个参数换成已撤销 Proxy、整体 Proxy、getter、嵌套 Proxy/已撤销 Proxy 或可转换对象时都拒收且访问器与陷阱计数为 0;同一组合法参数照常工作;导出函数清单与本表一致", () => {
  const exported = Object.keys(root).filter((name) => typeof (root as Record<string, unknown>)[name] === "function").sort();
  assert.deepEqual(exported, Object.keys(PUBLIC_CALLS).sort());
  for (const [name, spec] of Object.entries(PUBLIC_CALLS)) {
    const fn = (name === "streamParser" ? root.streamParser() : (root as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!) as (...a: unknown[]) => unknown;
    const legal = attempt(() => fn(...spec.args));
    assert.equal(legal.threw, undefined, `${name} 合法对照抛错:${String(legal.threw)}`);
    assert.notEqual(spec.refused?.(legal.value), true, `${name} 合法对照被拒`);
    const k = hitCounter();
    spec.args.forEach((v, i) => {
      for (const [label, bad] of hostileVariants(v, k)) {
        const args = [...spec.args];
        args[i] = bad;
        const r = attempt(() => fn(...args));
        assert.equal(k.c.hits, 0, `${name} 第 ${i + 1} 个参数 ${label}:访问器或陷阱被调用`);
        assert.ok(r.threw instanceof TypeError || (r.threw === undefined && spec.refused?.(r.value) === true), `${name} 第 ${i + 1} 个参数 ${label}:没有拒收(${r.threw === undefined ? "返回了结果" : String(r.threw)})`);
      }
    });
  }
});

/** 从一个订阅者里读到这个 Compute 的指定种类事件 */
async function nextKind(it: AsyncIterator<ComputeEventT>, id: string, kind: string): Promise<ComputeEventT> {
  for (;;) {
    const n = await it.next();
    if (n.done) throw new Error(`事件流结束,没有 ${kind}`);
    if (n.value.computeId === id && n.value.kind === kind) return n.value;
  }
}
type ComputeEventT = Awaited<ReturnType<Adapter["settled"]>>[number];
const violationsOf = (e: ComputeEventT | undefined) => (e && (e.kind === "failed" || e.kind === "stopped") ? e.violations : undefined);

test("R6-02:failed 事件及其 violations 深冻结:一个消费者 splice(0) 抛 TypeError,两次 settled() 与两个订阅者读到同一份违规", async () => {
  const f = fake({ reports: [], result: "success", extraInitTools: ["Bash"] });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const sub1 = a.events()[Symbol.asyncIterator]();
  const sub2 = a.events()[Symbol.asyncIterator]();
  const first = await within(a.settled(r.computeId));
  assert.notEqual(first, "超时");
  const failed = first === "超时" ? undefined : first.find((e) => e.kind === "failed");
  const before = [...(violationsOf(failed) ?? [])];
  assert.match(before.join(";"), /未授权的工具 Bash/);
  assert.ok(Object.isFrozen(failed) && Object.isFrozen(violationsOf(failed)));
  assert.throws(() => (violationsOf(failed) as string[]).splice(0), TypeError);
  const second = await within(a.settled(r.computeId));
  assert.deepEqual(violationsOf(second === "超时" ? undefined : second.find((e) => e.kind === "failed")), before);
  const seen1 = await within(nextKind(sub1, r.computeId, "failed"));
  assert.throws(() => (violationsOf(seen1 as ComputeEventT) as string[]).splice(0), TypeError);
  const seen2 = await within(nextKind(sub2, r.computeId, "failed"));
  assert.deepEqual(violationsOf(seen2 as ComputeEventT), before);
  assert.deepEqual(violationsOf((await within(nextKind(a.events()[Symbol.asyncIterator](), r.computeId, "failed"))) as ComputeEventT), before);
});

test("R6-02:违规后 stop 的 stopped 事件及其 violations 深冻结:首个订阅者改写抛 TypeError,新订阅者与两次 settled() 仍看到原违规;停止优先、违规可审计", async () => {
  const f = fake({ reports: [], hang: "stubborn", extraInitTools: ["Bash"] }, { reapForceMs: 3000 });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  // 越界 init 触发违规回收:主进程收到 SIGTERM(忽略)写 .term,此时违规已记录,再 stop
  await waitFor(() => fs.existsSync(termFile(f.record)));
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  const s1 = await within(nextKind(a.events()[Symbol.asyncIterator](), r.computeId, "stopped"));
  const before = [...(violationsOf(s1 as ComputeEventT) ?? [])];
  assert.match(before.join(";"), /未授权的工具 Bash/);
  assert.ok(Object.isFrozen(s1) && Object.isFrozen(violationsOf(s1 as ComputeEventT)));
  assert.throws(() => (violationsOf(s1 as ComputeEventT) as string[]).splice(0), TypeError);
  const s2 = await within(nextKind(a.events()[Symbol.asyncIterator](), r.computeId, "stopped"));
  assert.deepEqual(violationsOf(s2 as ComputeEventT), before);
  const evs = await within(a.settled(r.computeId), 10_000);
  assert.notEqual(evs, "超时");
  assert.deepEqual(evs === "超时" ? [] : evs.map((e) => e.kind), ["stopped"]);
  assert.deepEqual(violationsOf(evs === "超时" ? undefined : evs[0]), before);
  const again = await within(a.settled(r.computeId));
  assert.deepEqual(violationsOf(again === "超时" ? undefined : again[0]), before);
});

test("R6-02:rejectedReports 记录里来自 JSON 的 kind(数组)深冻结,改写抛 TypeError,再次读取不变", async () => {
  const f = fake({ reports: [{ kind: ["blocked"], summary: "种类不是字符串" }], result: "success" });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await within(a.settled(r.computeId));
  const rec = a.rejectedReports(r.computeId)[0];
  assert.ok(rec);
  assert.deepEqual(rec.kind, ["blocked"]);
  assert.ok(Object.isFrozen(rec.kind));
  assert.throws(() => (rec.kind as string[]).splice(0), TypeError);
  assert.deepEqual(a.rejectedReports(r.computeId)[0]?.kind, ["blocked"]);
});

test("R6-03:report MCP 只认精确的 report_progress:前后空格、制表/换行、大小写不同、连字符等近似名称回 -32602 且不写 REPORT_LOG,同一参数的精确名称照常接收并只记一行(直接 JSON-RPC 正反对照)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cc-"));
  ownDirs.add(dir);
  const log = path.join(dir, "report.jsonl");
  const args = { kind: "started", summary: "开始" };
  const exact = (reportToolDefinition() as { name: string }).name;
  const near = [`${exact} `, ` ${exact}`, `\t${exact}\n`, exact.toUpperCase(), "Report_Progress", exact.replace("_", "-")];
  const r = rpc([...near.map((name, i) => callNamed(i + 1, { name, arguments: args })), callNamed(99, { name: exact, arguments: args })], { REPORT_LOG: log });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  assert.deepEqual(r.replies.map((x) => [x.id, x.error?.code ?? null, x.result?.isError ?? null]), [...near.map((_, i) => [i + 1, -32602, null]), [99, null, false]]);
  assert.equal(r.replies.slice(0, near.length).some((x) => x.result !== undefined), false);
  assert.equal(r.replies.at(-1)!.result?.content?.[0]?.text, "已记录。");
  const recs = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { valid: boolean; kind: string });
  assert.deepEqual(recs.map((x) => [x.valid, x.kind]), [[true, "started"]]);
});

// ---------------------------------------------------------------- 第七轮审查 R7-01 – R7-03
// R7-01:同一 Compute 的续接与停止竞态;R7-02:CLI 输出里合法 JSON 的对象/数组字段不得让适配器宿主异常退出;
// R7-03:init 之前认可帧的邻接反例。反例都不改动任何内置原型,输入全部是 JSON.parse 能产生的数据。

/** 等这个 Compute 的某个事件(事件流从头重放,不丢事件);上限内没等到按名字失败 */
async function waitEvent(a: Adapter, id: string, pred: (e: ComputeEventT) => boolean) {
  const got = await within((async () => {
    for await (const e of a.events()) if (e.computeId === id && pred(e)) return true;
    return false;
  })());
  if (got !== true) throw new Error("等事件超时");
}
const BLOCKED_THEN_STUBBORN = { reports: [{ kind: "blocked", summary: "中性等待", needs: "中性条件" }], hang: "stubborn", resume: { reports: [], hang: "stubborn" } };

test("R7-01:受阻后并发两次 resume 只受理一个、另一个立即被明确拒绝,只起一个续接 CLI;stop 后原 CLI 与续接 CLI 全部回收(正反对照)", async () => {
  const f = fake(BLOCKED_THEN_STUBBORN, { reapForceMs: 300 });
  const dir = path.dirname(f.record);
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  const first = await within(a.settled(r.computeId));
  assert.deepEqual(first === "超时" ? [] : first.map((e) => e.kind), ["started", "blocked"]);
  const original = launches(f.record)[0]!.pid;
  const both = await within(Promise.all([a.resume(r.computeId, "中性续接甲"), a.resume(r.computeId, "中性续接乙")]));
  assert.notEqual(both, "超时");
  const results = both === "超时" ? [] : both;
  // 恰好一个受理;落败者被明确拒绝,原因是已有续接在途
  assert.deepEqual(results.map((x) => x.ok).sort(), [false, true]);
  assert.deepEqual(results.find((x) => !x.ok), { ok: false, reason: "这个 Compute 正在续接,同一时刻只受理一个续接" });
  // 起进程是同步的:两个 resume 都返回时,本测试的进程只剩获胜的那一个续接 CLI(原 CLI 已被 SIGKILL 并退出)
  assert.equal(alive(original), false);
  assert.equal(ownProcs(dir).length, 1);
  // 获胜的续接真的在运行(正对照):started(resumed) 到达,启动记录恰好两条,续接提示是获胜者的文本
  await waitEvent(a, r.computeId, (e) => e.kind === "started" && e.resumed);
  const all = launches(f.record);
  assert.equal(all.length, 2);
  assert.equal(all[1]!.prompt, results[0]?.ok ? "中性续接甲" : "中性续接乙");
  // stop 回收全部已启动的 CLI:原 CLI 与续接 CLI 都消失,进程表里不剩本测试的进程
  assert.deepEqual(await a.stop(r.computeId), { ok: true });
  for (const l of all) assert.equal(await gone(l.pid), true);
  await waitFor(() => ownProcs(dir).length === 0);
  const last = await within(a.settled(r.computeId));
  assert.deepEqual(last === "超时" ? [] : last.map((e) => e.kind), ["started", "stopped"]);
});

test("R7-01:resume 在途(正等冻结的上一轮退出)时 stop:stop 受理,在途续接被明确拒绝,stop 确认之后不再起 CLI;原 CLI 回收、进程表里不剩本测试的进程(竞态对照)", async () => {
  const f = fake(BLOCKED_THEN_STUBBORN, { reapForceMs: 300 });
  const dir = path.dirname(f.record);
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief());
  assert.ok(r.ok);
  await within(a.settled(r.computeId));
  const original = launches(f.record)[0]!.pid;
  // 不等 resume 完成就 stop:resume 已认领并对冻结的进程组发了 SIGKILL,正在等上一轮主进程退出
  const pending = a.resume(r.computeId, "中性续接");
  const stopped = await a.stop(r.computeId);
  const resumed = await within(pending);
  assert.deepEqual(stopped, { ok: true });
  assert.notEqual(resumed, "超时");
  assert.deepEqual(resumed, { ok: false, reason: "续接还没启动时这个 Compute 已被停止,这次续接作废" });
  // 起进程是同步的:续接返回时若起过 CLI,它已在进程表里
  assert.equal(await gone(original), true);
  assert.deepEqual(ownProcs(dir), []);
  // 有界观察:之后也不出现续接的启动记录,这一轮的事件只到 stopped,第二次 stop 被拒绝
  await new Promise((ok) => setTimeout(ok, 500));
  assert.equal(launches(f.record).length, 1);
  assert.deepEqual(ownProcs(dir), []);
  assert.deepEqual((await a.settled(r.computeId)).map((e) => e.kind), ["started", "blocked", "stopped"]);
  assert.equal((await a.stop(r.computeId)).ok, false);
});

test("R7-02:init 前的帧与 init 里 type/subtype/host 状态是对象、数组、null 的合法 JSON 时 preInitFrame/checkInit 按合同拒收、给固定说明、不抛错;拒收回执的 text 是对象或数组时不拼接、不抛错;坏 JSON 与非对象照常拒收,合法字符串与 connected 的 init 照常(对照)", () => {
  // 每个输入都由 JSON.parse 产生:对象自有的 toString/valueOf 数据字段,没有 getter、Proxy、函数,不改内置原型
  assert.deepEqual(preInitFrame('{"type":{"toString":null}}'), { kind: "rejected", reason: "(对象)" });
  assert.deepEqual(preInitFrame('{"type":"system","subtype":{"toString":null}}'), { kind: "rejected", reason: "system/(对象)" });
  assert.deepEqual(preInitFrame('{"type":"system","subtype":{"toString":"hook_started","valueOf":"hook_started"}}'), { kind: "rejected", reason: "system/(对象)" });
  assert.deepEqual(preInitFrame('{"type":[{"toString":null}],"subtype":"hook_started"}'), { kind: "rejected", reason: "(数组)/hook_started" });
  assert.deepEqual(preInitFrame('{"type":"system","subtype":[{"valueOf":{}}]}'), { kind: "rejected", reason: "system/(数组)" });
  assert.deepEqual(preInitFrame('{"type":null,"subtype":null}'), { kind: "rejected", reason: "null/null" });
  assert.deepEqual(preInitFrame('{"type":7,"subtype":false}'), { kind: "rejected", reason: "7/false" });
  assert.deepEqual(preInitFrame("{}"), { kind: "rejected", reason: "undefined" });
  assert.deepEqual(preInitFrame('{"type":'), { kind: "rejected", reason: "不是 JSON" });
  assert.deepEqual(preInitFrame("null"), { kind: "rejected", reason: "不是 JSON 对象" });
  assert.deepEqual(preInitFrame('[{"toString":null}]'), { kind: "rejected", reason: "不是 JSON 对象" });
  assert.deepEqual(preInitFrame('{"type":"system","subtype":"api_retry"}'), { kind: "rejected", reason: "system/api_retry" });
  const init = (status: string) => JSON.parse(`{"type":"system","subtype":"init","session_id":"neutral","tools":["${REPORT}"],"mcp_servers":[{"name":"host","status":${status}}]}`) as Record<string, unknown>;
  assert.deepEqual(checkInit(init('{"toString":null}')), { type: "bad-init", reason: "report_progress MCP 未连接(host 状态 (对象))" });
  assert.deepEqual(checkInit(init('[{"toString":null}]')), { type: "bad-init", reason: "report_progress MCP 未连接(host 状态 (数组))" });
  assert.deepEqual(checkInit(init("null")), { type: "bad-init", reason: "report_progress MCP 未连接(host 状态 缺失)" });
  assert.deepEqual(checkInit(init('"failed"')), { type: "bad-init", reason: "report_progress MCP 未连接(host 状态 failed)" });
  assert.deepEqual(checkInit(init('"connected"')), { type: "init", sessionId: "neutral", tools: [REPORT] });
  // 拒收回执:text 是对象/数组的文本块不拼接,字符串文本照常拼成拒收原因
  const parse = streamParser();
  assert.deepEqual(parse(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_neutral", name: REPORT, input: { kind: "milestone", summary: "中性" } }] } })), []);
  assert.deepEqual(parse('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_neutral","is_error":true,"content":[{"type":"text","text":{"toString":null}},{"type":"text","text":[{"valueOf":{}}]},{"type":"text","text":"中性拒收"}]}]}}'), [{ type: "rejected-report", kind: "milestone", reason: "中性拒收" }]);
});

/** 隔离的适配器宿主进程:同一个适配器依次跑 HOST_TASKS 里的每个任务、再跑 CONTROL_TASK,把每个 Compute 的事件与拒收记录写到 stdout */
const HOST_SCRIPT = `const { createComputeAdapter } = await import(process.env.ADAPTER_URL);
const a = createComputeAdapter(JSON.parse(process.env.ADAPTER_OPTIONS));
const out = {};
for (const task of [...JSON.parse(process.env.HOST_TASKS), process.env.CONTROL_TASK]) {
  const r = await a.spawn({ task, rules: [], tools: [], credentialRefs: [], placement: "local" });
  out[task] = r.ok ? { events: await a.settled(r.computeId), rejected: a.rejectedReports(r.computeId) } : { refused: r.reason };
}
process.stdout.write(JSON.stringify(out));
`;
/** 起宿主子进程并有界等待退出;超时整组 SIGKILL(宿主脚本在测试目录里,afterEach 也会按目录回收它和它起的 CLI) */
function runHost(script: string, env: Record<string, string>, ms = 60_000) {
  return new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* 已退出 */ } }, ms);
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

test("R7-02:适配器宿主子进程里,CLI 输出 type/subtype/host 状态为对象或数组、拒收回执 text 为对象、汇报 kind 嵌套过深的合法 JSON:宿主不退出,对应 Compute 各自 failed(或按合同记拒收)并回收 CLI,同一适配器随后的正常 Compute 照常 completed(正反对照)", async () => {
  const deep = 20_000;
  const toolUse = (id: string, input: string) => `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"${id}","name":"${REPORT}","input":${input}}]}}`;
  const rejected = (id: string, content: string) => `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${id}","is_error":true,"content":${content}}]}}`;
  const badInit = (status: string) => `{"type":"system","subtype":"init","session_id":"neutral","tools":["${REPORT}"],"mcp_servers":[{"name":"host","status":${status}}]}`;
  const preCases: Record<string, string> = {
    "中性-type对象": '{"type":{"toString":null}}',
    "中性-subtype对象": '{"type":"system","subtype":{"toString":null}}',
    "中性-type数组": '{"type":[{"toString":null}]}',
  };
  const cases: Record<string, { preInit?: string[]; postInit?: string[] }> = {
    ...Object.fromEntries(Object.entries(preCases).map(([t, line]) => [t, { preInit: [line] }])),
    "中性-host状态对象": { preInit: [badInit('{"toString":null}')] },
    "中性-host状态数组": { preInit: [badInit('[{"toString":null}]')] },
    "中性-拒收text对象": { postInit: [toolUse("toolu_text", '{"kind":"milestone","summary":"中性"}'), rejected("toolu_text", '[{"type":"text","text":{"toString":null}},{"type":"text","text":"中性拒收"}]')] },
    "中性-kind嵌套过深": { postInit: [toolUse("toolu_deep", `{"kind":${"[".repeat(deep)}${"]".repeat(deep)},"summary":"中性"}`), rejected("toolu_deep", '"中性拒收"')] },
  };
  const byTask: Record<string, unknown> = { "中性-对照": { reports: [{ kind: "milestone", stage: "中性", summary: "中性" }], result: "success", text: "完成" } };
  for (const [task, c] of Object.entries(cases)) byTask[task] = { ...c, reports: [], result: "success", text: "完成" };
  const f = fake({ byTask });
  const host = path.join(path.dirname(f.record), "host.mjs");
  fs.writeFileSync(host, HOST_SCRIPT);
  const res = await runHost(host, { ADAPTER_URL: new URL("./index.ts", import.meta.url).href, ADAPTER_OPTIONS: JSON.stringify(f.options), HOST_TASKS: JSON.stringify(Object.keys(cases)), CONTROL_TASK: "中性-对照" });
  // 宿主没有因未捕获异常退出
  assert.equal(res.signal, null);
  assert.equal(res.code, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /TypeError|RangeError/);
  type Ev = { kind: string; reason?: string };
  const out = JSON.parse(res.stdout) as Record<string, { events?: Ev[]; rejected?: { kind: unknown; reason: string }[]; refused?: string }>;
  const kinds = (t: string) => (out[t]?.events ?? []).map((e) => e.kind);
  const lastReason = (t: string) => out[t]?.events?.at(-1)?.reason ?? "";
  // init 之前的畸形帧:failed,原因就是 preInitFrame 给的固定说明
  for (const [t, line] of Object.entries(preCases)) {
    const pre = preInitFrame(line);
    assert.deepEqual(kinds(t), ["failed"], t);
    assert.equal(lastReason(t), `CLI 在 init 之前输出了未认可的内容:${pre.kind === "rejected" ? pre.reason : "未拒收"}`, t);
  }
  assert.match(lastReason("中性-type对象"), /:\(对象\)$/);
  // init 里 host 状态是对象/数组:init 无法核验 → failed
  assert.deepEqual(kinds("中性-host状态对象"), ["failed"]);
  assert.equal(lastReason("中性-host状态对象"), "CLI 的 init 无法核验:report_progress MCP 未连接(host 状态 (对象))");
  assert.deepEqual(kinds("中性-host状态数组"), ["failed"]);
  assert.equal(lastReason("中性-host状态数组"), "CLI 的 init 无法核验:report_progress MCP 未连接(host 状态 (数组))");
  // 拒收回执的 text 是对象:不拼接、不抛错,只记一条拒收;milestone 不是受阻/放弃,CLI 成功结束 → completed
  assert.deepEqual(kinds("中性-拒收text对象"), ["started", "completed"]);
  assert.deepEqual(out["中性-拒收text对象"]?.rejected, [{ kind: "milestone", reason: "中性拒收" }]);
  // kind 嵌套过深:记录拒收时拷贝栈溢出,异常被受控边界接住 → 只有这个 Compute 记违规并 failed
  assert.deepEqual(kinds("中性-kind嵌套过深"), ["started", "failed"]);
  assert.match(lastReason("中性-kind嵌套过深"), /^处理 CLI 输出时出错:/);
  // 同一个适配器在这些失败之后照常服务(正对照)
  assert.deepEqual(kinds("中性-对照"), ["started", "milestone", "completed"]);
  // 每个启动过的 CLI 主进程都已退出(settled 在主进程退出后才返回)
  const all = launches(f.record);
  assert.equal(all.length, Object.keys(cases).length + 1);
  for (const l of all) assert.equal(await gone(l.pid), true);
});

test("R7-03:init 之前与认可帧只差子类型的 system 帧(hook_neutral_unlisted、前缀延长、大小写、空白、截短)一律拒收,端到端回收并 failed;同一剧本只把子类型换成认可的 hook_started 时放行并完成(单开关邻接对照)", async () => {
  const adjacent = ["hook_neutral_unlisted", "hook_started_extra", "hook_response2", "HOOK_STARTED", "Hook_response", " hook_started", "hook_started ", "hook", "hook_", "ui_invalidate_more", "UI_INVALIDATE", "ui", "invalidate"];
  for (const subtype of adjacent) {
    assert.deepEqual(preInitFrame(JSON.stringify({ type: "system", subtype, session_id: "s" })), { kind: "rejected", reason: `system/${subtype}` }, subtype);
  }
  // 三种认可帧保持放行(阴性对照)
  for (const subtype of ["hook_started", "hook_response", "ui_invalidate"]) {
    assert.deepEqual(preInitFrame(JSON.stringify({ type: "system", subtype, session_id: "s" })), { kind: "allowed" }, subtype);
  }
  const run = async (subtype: string) => {
    const f = fake({ preInit: [JSON.stringify({ type: "system", subtype, session_id: "s" })], reports: [], result: "success", text: "完成" });
    const a = createComputeAdapter(f.options);
    const r = await a.spawn(brief());
    assert.ok(r.ok);
    const evs = await within(a.settled(r.computeId));
    return evs === "超时" ? [] : evs;
  };
  const bad = await run("hook_neutral_unlisted");
  assert.deepEqual(bad.map((e) => e.kind), ["failed"]);
  const last = bad.at(-1);
  assert.equal(last?.kind === "failed" ? last.reason : "", "CLI 在 init 之前输出了未认可的内容:system/hook_neutral_unlisted");
  const good = await run("hook_started");
  assert.deepEqual(good.map((e) => e.kind), ["started", "completed"]);
});
