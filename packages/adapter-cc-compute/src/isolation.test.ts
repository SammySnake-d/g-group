// AC-29 联系人能力默认隔离加白名单(适配器一侧):专属配置目录、勾选 skill 的插件目录、勾选 MCP 服务器。
// 起真实子进程:假 CLI(test-support/fake-claude.mjs)按 --mcp-config 真的和 report_progress 握手,
// 勾选的 MCP 与 --plugin-dir 里的 skill 照真实 CLI 2.1.319 在 --bare 下的实测行为列进 init(packages/server/proof/v02-config-dir.txt)。
// 只用临时目录与中性内容(NEUTRAL_FIXTURE_NO_CREDENTIALS),不读本机任何账户文件。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createComputeAdapter } from "./adapter.ts";
import { allowedTools, cliArgs, cliEnv, toolOverreach } from "./cli.ts";
import { initLoaded } from "./events.ts";
import type { ComputeEvent } from "./types.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-claude.mjs", import.meta.url));
const REPORT = "mcp__host__report_progress";
const brief = { task: "整理笔记", rules: [], tools: ["Read"], credentialRefs: [], placement: "local" };

// 本文件只回收自己建的进程与目录(命令行里带本测试目录的进程)
const ownDirs = new Set<string>();
function reapOwn() {
  let out = "";
  try { out = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }); } catch { out = ""; }
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid) continue;
    if ([...ownDirs].some((d) => m[2]!.includes(`${d}${path.sep}`))) { try { process.kill(Number(m[1]), "SIGKILL"); } catch { /* 已退出 */ } }
  }
  for (const d of ownDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  ownDirs.clear();
}
afterEach(reapOwn);
setTimeout(() => { reapOwn(); console.error("isolation.test.ts 超过 120 秒,强制结束"); process.exit(1); }, 120_000).unref();

function fixture(script: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cc-iso-"));
  ownDirs.add(dir);
  const record = path.join(dir, "record.jsonl");
  const configDir = path.join(dir, "run", "config");
  const pluginDir = path.join(dir, "run", "skills-x");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "gg-skills" }));
  fs.mkdirSync(path.join(pluginDir, "skills", "notes-style"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "skills", "notes-style", "SKILL.md"), "---\nname: notes-style\ndescription: NEUTRAL_FIXTURE_NO_CREDENTIALS\n---\n");
  const options = { runner: { command: process.execPath, args: [FAKE, `--fake-dir=${dir}${path.sep}`] }, hostEnv: { FAKE_SCRIPT: JSON.stringify(script), FAKE_RECORD: record }, reapForceMs: 1500 };
  return { dir, record, configDir, pluginDir, options };
}
type Launch = { argv: string[]; env: Record<string, string>; prompt: string; mcpConfig: { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } | null };
const launches = (record: string): Launch[] => fs.readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Launch);
const flagOf = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
const done = { reports: [{ kind: "started", summary: "开始" }, { kind: "completed", summary: "好了" }], result: "success" };
const notes = { command: "/usr/bin/true", args: ["--neutral"], env: { NOTES_MODE: "NEUTRAL_FIXTURE_NO_CREDENTIALS" } };

test("勾选能力:专属配置目录进 CLAUDE_CONFIG_DIR,勾选 skill 经 --plugin-dir,勾选 MCP 进 --mcp-config 并整组放行", async () => {
  const f = fixture(done);
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief, { configDir: f.configDir, pluginDirs: [f.pluginDir], mcpServers: { notes } });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const evs = await a.settled(r.computeId);
  const [l] = launches(f.record);
  assert.equal(l!.env.CLAUDE_CONFIG_DIR, f.configDir);
  assert.equal(flagOf(l!.argv, "--plugin-dir"), f.pluginDir);
  assert.ok(l!.argv.includes("--bare") && l!.argv.includes("--strict-mcp-config"));
  assert.deepEqual(Object.keys(l!.mcpConfig!.mcpServers).sort(), ["host", "notes"]);
  assert.deepEqual(l!.mcpConfig!.mcpServers.notes, { command: "/usr/bin/true", args: ["--neutral"], env: { NOTES_MODE: "NEUTRAL_FIXTURE_NO_CREDENTIALS" } });
  assert.equal(flagOf(l!.argv, "--allowedTools"), `Read,${REPORT},mcp__notes`);
  assert.deepEqual(r.manifest.mcpServers, ["notes"]);
  assert.deepEqual(r.manifest.pluginDirs, [f.pluginDir]);
  assert.equal(r.manifest.configDir, f.configDir);
  // --bare 下没有 Skill 工具:首个提示列出勾选 skill 与 SKILL.md 绝对路径,需要时 Read 来照做
  const skillFile = path.join(f.pluginDir, "skills", "notes-style", "SKILL.md");
  assert.ok(l!.prompt.endsWith(`[可用 skill](联系人勾选的;要用时先用 Read 读对应 SKILL.md 再照做)\n- gg-skills:notes-style:NEUTRAL_FIXTURE_NO_CREDENTIALS —— ${skillFile}`), l!.prompt);
  assert.deepEqual(r.manifest.sections.at(-1), { name: "skills", detail: { items: [{ name: "gg-skills:notes-style", file: skillFile }] } });
  const started = evs.find((e) => e.kind === "started") as Extract<ComputeEvent, { kind: "started" }> | undefined;
  assert.deepEqual(started?.loaded, { skills: ["gg-skills:notes-style"], mcpServers: ["host", "notes"] });
  assert.equal(evs.at(-1)?.kind, "completed");
});

test("hostEnv 里的 CLAUDE_CONFIG_DIR 盖不过专属配置目录;不给配置目录时不注入;没勾 skill 时首个提示不列 skill", async () => {
  const f = fixture(done);
  const a = createComputeAdapter({ ...f.options, hostEnv: { ...f.options.hostEnv, CLAUDE_CONFIG_DIR: path.join(f.dir, "personal") } });
  const r1 = await a.spawn(brief, { configDir: f.configDir });
  assert.ok(r1.ok);
  await a.settled(r1.computeId);
  assert.equal(launches(f.record)[0]!.env.CLAUDE_CONFIG_DIR, f.configDir);
  assert.equal(launches(f.record)[0]!.prompt.includes("[可用 skill]"), false);
  assert.equal(r1.manifest.sections.some((x) => x.name === "skills"), false);
  assert.equal(cliEnv(brief as never, "cc-1").CLAUDE_CONFIG_DIR, undefined);
  assert.equal(cliEnv(brief as never, "cc-1", {}, "/abs/run/config").CLAUDE_CONFIG_DIR, "/abs/run/config");
});

test("应失败的 spawn 选项:MCP 名 host、相对路径的配置目录与插件目录、MCP 缺 command,一律拒收且不起进程", async () => {
  const f = fixture(done);
  const a = createComputeAdapter(f.options);
  const cases: [string, unknown, RegExp][] = [
    ["host", { mcpServers: { host: notes } }, /host/],
    ["名字不合规", { mcpServers: { "a b": notes } }, /不合规/],
    ["相对配置目录", { configDir: "run/config" }, /configDir/],
    ["相对插件目录", { pluginDirs: ["skills-x"] }, /pluginDirs/],
    ["缺 command", { mcpServers: { notes: { args: [] } } }, /command/],
    ["多余字段", { mcpServers: { notes: { ...notes, cwd: "/" } } }, /command/],
  ];
  for (const [label, opts, why] of cases) {
    const r = await a.spawn(brief, opts as never);
    assert.equal(r.ok, false, label);
    assert.match(r.ok ? "" : r.reason, why, label);
  }
  assert.equal(fs.existsSync(f.record), false);
});

test("CLI 挂了未勾选的 MCP 服务器 → 判违规失败,不发 started", async () => {
  const f = fixture({ ...done, extraInitMcp: ["personal-notes"] });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief, { configDir: f.configDir, mcpServers: { notes } });
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  assert.equal(evs.some((e) => e.kind === "started"), false);
  const last = evs.at(-1);
  assert.equal(last?.kind, "failed");
  assert.match(last?.kind === "failed" ? last.violations.join(";") : "", /未勾选的 MCP 服务器 personal-notes/);
});

test("勾选的 MCP 没连上 → 判违规失败(勾选的项必须全部可用)", async () => {
  const f = fixture({ ...done, mcpStatus: { notes: "failed" } });
  const a = createComputeAdapter(f.options);
  const r = await a.spawn(brief, { configDir: f.configDir, mcpServers: { notes } });
  assert.ok(r.ok);
  const evs = await a.settled(r.computeId);
  const last = evs.at(-1);
  assert.equal(last?.kind, "failed");
  assert.match(last?.kind === "failed" ? last.violations.join(";") : "", /没有连上:notes/);
});

test("纯函数:勾选 MCP 只放行 mcp__<名>__ 开头的工具,别的服务器的工具算越界;--plugin-dir 只收绝对路径", () => {
  assert.deepEqual(allowedTools(brief as never, ["notes"]), ["Read", REPORT, "mcp__notes"]);
  assert.deepEqual(toolOverreach(brief as never, ["Read", REPORT, "mcp__notes__echo", "mcp__personal__read", "mcp__notesx__y"], ["notes"]), ["mcp__personal__read", "mcp__notesx__y"]);
  assert.deepEqual(toolOverreach(brief as never, ["Read", REPORT, "mcp__notes__echo"]), ["mcp__notes__echo"]);
  assert.throws(() => allowedTools(brief as never, ["host"]), /host/);
  const args = cliArgs(brief as never, "p", "/tmp/m.json", undefined, { pluginDirs: ["/abs/a", "/abs/b"], mcpServers: ["notes"] });
  assert.deepEqual(args.flatMap((x, i) => (x === "--plugin-dir" ? [args[i + 1]] : [])), ["/abs/a", "/abs/b"]);
  assert.throws(() => cliArgs(brief as never, "p", "/tmp/m.json", undefined, { pluginDirs: ["rel"] }), /绝对路径/);
});

test("init 自报的实际加载清单:mcp 服务器名与状态、skills;没名字记空名、skills 缺失或不是字符串数组记为空", () => {
  const base = { session_id: "s1", tools: ["Read", REPORT], mcp_servers: [{ name: "host", status: "connected" }, { name: "notes", status: "failed" }, { status: 1 }] };
  assert.deepEqual(initLoaded({ ...base, skills: ["gg-skills:notes-style"] }), { mcpServers: [{ name: "host", status: "connected" }, { name: "notes", status: "failed" }, { name: "", status: "unknown" }], skills: ["gg-skills:notes-style"] });
  assert.deepEqual(initLoaded({ ...base, skills: ["x", 1] }).skills, []);
  assert.deepEqual(initLoaded({ session_id: "s1" }), { mcpServers: [], skills: [] });
});
