// AC-29 联系人能力默认隔离加白名单(常驻适配器一侧,生产入口 start.ts / cli.ts 用的就是它;需求文档 D07 §3)。
// 起真实子进程:假 CLI(test-support/fake-claude-resident.mjs)按 --mcp-config 真的和 report_progress 握手,
// 勾选的 MCP 与 --plugin-dir 里的 skill 照真实 CLI 2.1.319 的实测行为列进每轮 init(packages/server/proof/v02-config-dir.txt):
// 带 --bare 只加载 --plugin-dir 里的 skill,不带才读 CLAUDE_CONFIG_DIR/skills 或 HOME/.claude/skills。
// 只用临时目录、假 HOME 与中性内容(NEUTRAL_FIXTURE_NO_CREDENTIALS),不读本机任何账户文件。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createResidentComputeAdapter, residentArgs } from "./resident.ts";
import type { ComputeAdapter, ComputeEvent } from "./types.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-claude-resident.mjs", import.meta.url));
const REPORT = "mcp__host__report_progress";
const brief = { task: "整理笔记", rules: [], tools: ["Read"], credentialRefs: [], placement: "local" };
const notes = { command: "/usr/bin/true", args: ["--neutral"], env: { NOTES_MODE: "NEUTRAL_FIXTURE_NO_CREDENTIALS" } };
const files = { command: "/usr/bin/true", args: ["--files"] };

const ownDirs = new Set<string>();
const computes: [ComputeAdapter, string][] = [];
function reapOwn() {
  for (const [a, id] of computes.splice(0)) void a.stop(id).catch(() => {});
  for (let round = 0; round < 3; round++) {
    let out = "";
    try { out = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }); } catch { break; }
    let found = 0;
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m || Number(m[1]) <= 1 || Number(m[1]) === process.pid) continue;
      if (![...ownDirs].some((d) => m[2]!.includes(d))) continue;
      found++;
      try { process.kill(-Number(m[1]), "SIGKILL"); } catch { /* 不是组长 */ }
      try { process.kill(Number(m[1]), "SIGKILL"); } catch { /* 已退出 */ }
    }
    if (!found) break;
    execFileSync("sleep", ["0.1"]);
  }
  for (const d of ownDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  ownDirs.clear();
}
afterEach(reapOwn);
setTimeout(() => { reapOwn(); console.error("resident-isolation.test.ts 超过 120 秒,强制结束"); process.exit(1); }, 120_000).unref();

/** 一个插件目录:.claude-plugin/plugin.json 的 name 作命名空间,skills/<skill>/SKILL.md 是中性正文 */
function plugin(root: string, ns: string, skill: string): string {
  const d = path.join(root, `plugin-${ns}`);
  fs.mkdirSync(path.join(d, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(d, ".claude-plugin", "plugin.json"), JSON.stringify({ name: ns }));
  fs.mkdirSync(path.join(d, "skills", skill), { recursive: true });
  fs.writeFileSync(path.join(d, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: NEUTRAL_FIXTURE_NO_CREDENTIALS\n---\n`);
  return d;
}
/** 一个装了「全局」skill 的目录(假 HOME 的 .claude/skills 或个人配置目录的 skills) */
function globalSkill(dir: string, skill: string) {
  fs.mkdirSync(path.join(dir, skill), { recursive: true });
  fs.writeFileSync(path.join(dir, skill, "SKILL.md"), `---\nname: ${skill}\ndescription: NEUTRAL_FIXTURE_NO_CREDENTIALS\n---\n`);
}

type Launch = { pid: number; kind: string; argv: string[]; configDir: string | null; home: string | null; sessionId: string; resume: boolean; pluginDirs: string[]; mcpConfig: { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } | null };
type Rec = { pid: number; kind: string; text?: string; [k: string]: unknown };
function rig(make: typeof createResidentComputeAdapter, script: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-ccr-iso-"));
  ownDirs.add(dir);
  const record = path.join(dir, "record.jsonl");
  const adapter = make({
    runner: { command: process.execPath, args: [FAKE, `--fake-dir=${dir}${path.sep}`] },
    hostEnv: { FAKE_SCRIPT: JSON.stringify(script), FAKE_RECORD: record, ...env },
    reapForceMs: 1000,
    ...extra,
  } as Parameters<typeof createResidentComputeAdapter>[0]);
  const events: ComputeEvent[] = [];
  void (async () => { for await (const e of adapter.events()) events.push(e); })();
  const recs = (): Rec[] => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec) : []);
  const launches = () => recs().filter((x) => x.kind === "launch") as unknown as Launch[];
  const until = async (pred: () => boolean, ms = 8000, what = "条件") => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`等待超时:${what}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  const ends = (id: string) => events.filter((e) => e.computeId === id && (e.kind === "completed" || e.kind === "failed"));
  const configDir = path.join(dir, "run", "config");
  fs.mkdirSync(configDir, { recursive: true });
  return { dir, adapter, events, recs, launches, until, ends, configDir };
}
const flagOf = (argv: readonly string[], name: string) => argv[argv.indexOf(name) + 1];
const flagsOf = (argv: readonly string[], name: string) => argv.flatMap((x, i) => (x === name ? [argv[i + 1]!] : []));
const startedOf = (events: ComputeEvent[], id: string) => events.find((e) => e.computeId === id && e.kind === "started") as Extract<ComputeEvent, { kind: "started" }> | undefined;

test("常驻适配器声明 isolation 能力;勾选能力进常驻进程:CLAUDE_CONFIG_DIR、逐个 --plugin-dir、勾选 MCP 与 host 合并进 --mcp-config 并整组放行", async () => {
  const r = rig(createResidentComputeAdapter);
  assert.equal(r.adapter.capabilities?.isolation, true);
  assert.equal(r.adapter.capabilities?.inSessionModelSwitch, true);
  const pluginDir = plugin(r.dir, "gg-skills", "notes-style");
  const res = await r.adapter.spawn(brief, { cwd: r.dir, model: "model-A", configDir: r.configDir, pluginDirs: [pluginDir], mcpServers: { notes } });
  assert.ok(res.ok, res.ok ? "" : res.reason);
  computes.push([r.adapter, res.computeId]);
  await r.until(() => r.ends(res.computeId).length === 1, 8000, "第 1 轮结束");
  const [l] = r.launches();
  assert.equal(l!.configDir, r.configDir);
  assert.deepEqual(l!.pluginDirs, [pluginDir]);
  assert.ok(l!.argv.includes("--bare") && l!.argv.includes("--strict-mcp-config"));
  assert.deepEqual(Object.keys(l!.mcpConfig!.mcpServers).sort(), ["host", "notes"]);
  assert.deepEqual(l!.mcpConfig!.mcpServers.notes, { command: "/usr/bin/true", args: ["--neutral"], env: { NOTES_MODE: "NEUTRAL_FIXTURE_NO_CREDENTIALS" } });
  assert.equal(flagOf(l!.argv, "--allowedTools"), `Read,${REPORT},mcp__notes`);
  assert.deepEqual(res.manifest.mcpServers, ["notes"]);
  assert.deepEqual(res.manifest.pluginDirs, [pluginDir]);
  assert.equal(res.manifest.configDir, r.configDir);
  assert.deepEqual(res.manifest.allowedTools, ["Read", REPORT, "mcp__notes"]);
  // --bare 下没有 Skill 工具:首条输入列出勾选 skill 与 SKILL.md 绝对路径
  const skillFile = path.join(pluginDir, "skills", "notes-style", "SKILL.md");
  const first = r.recs().find((x) => x.kind === "in")!;
  assert.ok(first.text!.endsWith(`[可用 skill](联系人勾选的;要用时先用 Read 读对应 SKILL.md 再照做)\n- gg-skills:notes-style:NEUTRAL_FIXTURE_NO_CREDENTIALS —— ${skillFile}`), first.text);
  assert.deepEqual(res.manifest.sections.at(-1), { name: "skills", detail: { items: [{ name: "gg-skills:notes-style", file: skillFile }] } });
  assert.deepEqual(startedOf(r.events, res.computeId)?.loaded, { skills: ["gg-skills:notes-style"], mcpServers: ["host", "notes"] });
  assert.equal(r.ends(res.computeId)[0]!.kind, "completed");
});

test("未勾选的全局 skill 不进入:假 HOME 与个人配置目录里的 skill 都不加载;专属配置目录盖过 hostEnv 里的 CLAUDE_CONFIG_DIR", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-ccr-home-"));
  ownDirs.add(root);
  const home = path.join(root, "home");
  const personal = path.join(root, "personal-config");
  globalSkill(path.join(home, ".claude", "skills"), "personal-style");
  globalSkill(path.join(personal, "skills"), "personal-cfg-style");
  const r = rig(createResidentComputeAdapter, {}, {}, { HOME: home, CLAUDE_CONFIG_DIR: personal });
  const pluginDir = plugin(r.dir, "gg-skills", "notes-style");
  const a = await r.adapter.spawn(brief, { cwd: r.dir, model: "model-A", configDir: r.configDir, pluginDirs: [pluginDir] });
  assert.ok(a.ok, a.ok ? "" : a.reason);
  computes.push([r.adapter, a.computeId]);
  await r.until(() => r.ends(a.computeId).length === 1);
  assert.equal(r.launches()[0]!.configDir, r.configDir, "专属配置目录盖过 hostEnv 里的个人配置目录");
  assert.deepEqual(startedOf(r.events, a.computeId)?.loaded?.skills, ["gg-skills:notes-style"]);
  // 不给专属配置目录:CLI 落回 hostEnv 的 HOME,靠 --bare 也不读 HOME/.claude/skills
  const r2 = rig(createResidentComputeAdapter, {}, {}, { HOME: home });
  const b = await r2.adapter.spawn(brief, { cwd: r2.dir, model: "model-A" });
  assert.ok(b.ok);
  computes.push([r2.adapter, b.computeId]);
  await r2.until(() => r2.ends(b.computeId).length === 1);
  assert.equal(r2.launches()[0]!.home, home);
  assert.equal(r2.launches()[0]!.configDir, null);
  assert.deepEqual(startedOf(r2.events, b.computeId)?.loaded, { skills: [], mcpServers: ["host"] });
  assert.equal(r2.recs().find((x) => x.kind === "in")!.text!.includes("[可用 skill]"), false);
});

test("两个联系人勾不同集合:同一个常驻适配器起的两个 Compute 各自只带自己的配置目录、插件目录与 MCP,互不可见", async () => {
  const r = rig(createResidentComputeAdapter);
  const cfgA = path.join(r.dir, "a", "config");
  const cfgB = path.join(r.dir, "b", "config");
  const plugA = plugin(path.join(r.dir, "a"), "gg-a", "a-style");
  const plugB = plugin(path.join(r.dir, "b"), "gg-b", "b-style");
  const a = await r.adapter.spawn(brief, { cwd: r.dir, model: "model-A", configDir: cfgA, pluginDirs: [plugA], mcpServers: { notes } });
  const b = await r.adapter.spawn(brief, { cwd: r.dir, model: "model-A", configDir: cfgB, pluginDirs: [plugB], mcpServers: { files } });
  assert.ok(a.ok && b.ok);
  computes.push([r.adapter, a.computeId], [r.adapter, b.computeId]);
  await r.until(() => r.ends(a.computeId).length === 1 && r.ends(b.computeId).length === 1);
  const sa = startedOf(r.events, a.computeId)!;
  const sb = startedOf(r.events, b.computeId)!;
  const la = r.launches().find((x) => x.pid === sa.pid)!;
  const lb = r.launches().find((x) => x.pid === sb.pid)!;
  assert.deepEqual([la.configDir, la.pluginDirs, Object.keys(la.mcpConfig!.mcpServers).sort()], [cfgA, [plugA], ["host", "notes"]]);
  assert.deepEqual([lb.configDir, lb.pluginDirs, Object.keys(lb.mcpConfig!.mcpServers).sort()], [cfgB, [plugB], ["files", "host"]]);
  assert.deepEqual(sa.loaded, { skills: ["gg-a:a-style"], mcpServers: ["host", "notes"] });
  assert.deepEqual(sb.loaded, { skills: ["gg-b:b-style"], mcpServers: ["host", "files"] });
  assert.equal(flagOf(la.argv, "--allowedTools"), `Read,${REPORT},mcp__notes`);
  assert.equal(flagOf(lb.argv, "--allowedTools"), `Read,${REPORT},mcp__files`);
  const inA = r.recs().find((x) => x.kind === "in" && x.pid === sa.pid)!.text!;
  assert.ok(inA.includes("gg-a:a-style") && !inA.includes("b-style"), inA);
});

test("空闲回收后用同一会话恢复:新进程照样带专属配置目录、插件目录与合并的 MCP 配置", async () => {
  const r = rig(createResidentComputeAdapter, {}, { idleReclaimMs: 50 });
  const pluginDir = plugin(r.dir, "gg-skills", "notes-style");
  const res = await r.adapter.spawn(brief, { cwd: r.dir, model: "model-A", configDir: r.configDir, pluginDirs: [pluginDir], mcpServers: { notes } });
  assert.ok(res.ok);
  computes.push([r.adapter, res.computeId]);
  await r.until(() => r.ends(res.computeId).length === 1);
  const first = r.launches()[0]!;
  await r.until(() => r.recs().some((x) => x.kind === "stdin-closed" && x.pid === first.pid), 5000, "空闲回收");
  assert.equal((await r.adapter.resume(res.computeId, "第二轮", { model: "model-A" })).ok, true);
  await r.until(() => r.ends(res.computeId).length === 2);
  const again = r.launches()[1]!;
  assert.deepEqual([again.resume, again.sessionId, again.configDir, again.pluginDirs], [true, first.sessionId, r.configDir, [pluginDir]]);
  assert.deepEqual(Object.keys(again.mcpConfig!.mcpServers).sort(), ["host", "notes"]);
  assert.equal(flagOf(again.argv, "--allowedTools"), `Read,${REPORT},mcp__notes`);
  assert.equal(r.ends(res.computeId)[1]!.kind, "completed");
});

test("每轮 init 照样核对勾选:CLI 挂了未勾选的 MCP、或勾选的 MCP 没连上,这一轮判违规失败并回收进程", async () => {
  const r = rig(createResidentComputeAdapter, { extraInitMcp: ["personal-notes"] });
  const a = await r.adapter.spawn(brief, { cwd: r.dir, model: "model-A", configDir: r.configDir, mcpServers: { notes } });
  assert.ok(a.ok);
  computes.push([r.adapter, a.computeId]);
  await r.until(() => r.ends(a.computeId).length === 1);
  const fa = r.ends(a.computeId)[0]!;
  assert.equal(fa.kind, "failed");
  assert.match(fa.kind === "failed" ? fa.violations.join(";") : "", /未勾选的 MCP 服务器 personal-notes/);
  assert.equal(startedOf(r.events, a.computeId), undefined, "核对没过不报 started");
  const r2 = rig(createResidentComputeAdapter, { mcpStatus: { notes: "failed" } });
  const b = await r2.adapter.spawn(brief, { cwd: r2.dir, model: "model-A", configDir: r2.configDir, mcpServers: { notes } });
  assert.ok(b.ok);
  computes.push([r2.adapter, b.computeId]);
  await r2.until(() => r2.ends(b.computeId).length === 1);
  const fb = r2.ends(b.computeId)[0]!;
  assert.match(fb.kind === "failed" ? fb.violations.join(";") : "", /没有连上:notes/);
  const pid = r2.launches()[0]!.pid;
  await r2.until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000, "违规后回收进程");
});

test("应失败的勾选选项:MCP 名 host、名字不合规、相对路径的配置目录与插件目录、MCP 缺 command 或多字段,一律拒收且不起进程", async () => {
  const r = rig(createResidentComputeAdapter);
  const cases: [string, unknown, RegExp][] = [
    ["host", { mcpServers: { host: notes } }, /host/],
    ["名字不合规", { mcpServers: { "a b": notes } }, /不合规/],
    ["相对配置目录", { configDir: "run/config" }, /configDir/],
    ["相对插件目录", { pluginDirs: ["skills-x"] }, /pluginDirs/],
    ["缺 command", { mcpServers: { notes: { args: [] } } }, /command/],
    ["多余字段", { mcpServers: { notes: { ...notes, cwd: "/" } } }, /command/],
  ];
  for (const [label, opts, why] of cases) {
    const res = await r.adapter.spawn(brief, opts as never);
    assert.equal(res.ok, false, label);
    assert.match(res.ok ? "" : res.reason, why, label);
  }
  await new Promise((ok) => setTimeout(ok, 100));
  assert.equal(r.launches().length, 0);
});

test("residentArgs:逐个 --plugin-dir、勾选 MCP 整组进 --allowedTools;插件目录必须绝对路径、MCP 名不能是 host", () => {
  const args = residentArgs(brief as never, "/tmp/m.json", { sessionId: "S1", resume: false, pluginDirs: ["/abs/a", "/abs/b"], mcpServers: ["notes"] });
  assert.deepEqual(flagsOf(args, "--plugin-dir"), ["/abs/a", "/abs/b"]);
  assert.equal(flagOf(args, "--allowedTools"), `Read,${REPORT},mcp__notes`);
  assert.ok(args.indexOf("--plugin-dir") > args.indexOf("--bare"));
  const plain = residentArgs(brief as never, "/tmp/m.json", { sessionId: "S1", resume: false });
  assert.equal(plain.includes("--plugin-dir"), false);
  assert.equal(flagOf(plain, "--allowedTools"), `Read,${REPORT}`);
  assert.throws(() => residentArgs(brief as never, "/tmp/m.json", { sessionId: "S1", resume: false, pluginDirs: ["rel"] }), /绝对路径/);
  assert.throws(() => residentArgs(brief as never, "/tmp/m.json", { sessionId: "S1", resume: false, mcpServers: ["host"] }), /host/);
});
