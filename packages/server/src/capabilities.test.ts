// AC-29 联系人能力默认隔离加白名单(宿主一侧):全局能力库 → 每位联系人的专属运行目录 → 派活时交给 Compute。
// 只用临时目录、假 HOME 与中性内容(NEUTRAL_FIXTURE_NO_CREDENTIALS),不读本机任何账户文件。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { CapabilityLibrary } from "./capabilities.ts";
import { scriptedCompute, scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gg-cap-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
/** 一个数据目录:库里有 skill a-style、b-style 与 MCP notes、files;假 HOME 里有一个全局 skill personal-style */
function dataDir() {
  const d = path.join(root, `d${++n}`);
  const skill = (name: string) => {
    fs.mkdirSync(path.join(d, "library", "skills", name), { recursive: true });
    fs.writeFileSync(path.join(d, "library", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} NEUTRAL_FIXTURE_NO_CREDENTIALS\n---\n正文\n`);
  };
  skill("a-style");
  skill("b-style");
  fs.mkdirSync(path.join(d, "library", "mcp"), { recursive: true });
  fs.writeFileSync(path.join(d, "library", "mcp", "notes.json"), JSON.stringify({ command: "/usr/bin/true", args: ["--notes"] }));
  fs.writeFileSync(path.join(d, "library", "mcp", "files.json"), JSON.stringify({ command: "/usr/bin/true", env: { MODE: "NEUTRAL_FIXTURE_NO_CREDENTIALS" } }));
  fs.writeFileSync(path.join(d, "library", "mcp", "broken.json"), "{不是 JSON");
  const home = path.join(d, "fake-home");
  fs.mkdirSync(path.join(home, ".claude", "skills", "personal-style"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "skills", "personal-style", "SKILL.md"), "---\nname: personal-style\ndescription: NEUTRAL_FIXTURE_NO_CREDENTIALS\n---\n");
  return { d, home };
}
/** 运行目录里所有文件与软链(相对运行目录),用来证明全局与未勾选的东西一样都不在 */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      out.push(path.relative(dir, full));
      if (e.isDirectory() && !e.isSymbolicLink()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}
async function settle(host: Host, compute: { drained(): boolean }) {
  for (let i = 0; i < 200; i++) {
    await host.idle();
    await new Promise((r) => setTimeout(r, 5));
    if (compute.drained() && !host.loop.busy()) return;
  }
  throw new Error("宿主没有安静下来");
}

test("专属运行目录只放勾选的 skill 与 MCP:库里没勾的、假 HOME 里的全局 skill 一样都不进", () => {
  const { d, home } = dataDir();
  const lib = new CapabilityLibrary(d);
  const r = lib.prepare("c1", "claude-code", [{ name: "a-style", kind: "skill" }, { name: "notes", kind: "mcp" }, { name: "run.sh", kind: "script" }]);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.home.configDir, path.join(d, "run_homes", "c1", "claude-code", "config"));
  assert.equal(r.home.pluginDirs.length, 1);
  assert.deepEqual(lib.linkedSkills(r.home.pluginDirs[0]!), [{ name: "a-style", target: path.join(d, "library", "skills", "a-style") }]);
  assert.deepEqual(r.home.skills, ["gg-skills:a-style"]);
  assert.deepEqual(r.home.mcpServers, { notes: { command: "/usr/bin/true", args: ["--notes"] } });
  const all = tree(path.join(d, "run_homes"));
  assert.equal(all.some((p) => p.includes("b-style") || p.includes("personal-style") || p.includes("files")), false, all.join("\n"));
  assert.equal(fs.readFileSync(path.join(r.home.pluginDirs[0]!, ".claude-plugin", "plugin.json"), "utf8").includes('"gg-skills"'), true);
  assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "personal-style", "SKILL.md")), "假 HOME 的全局 skill 原样留着,只是不进运行目录");
});

test("两个同 harness 的联系人勾选不同集合,运行目录与 MCP 互不可见", () => {
  const { d } = dataDir();
  const lib = new CapabilityLibrary(d);
  const r1 = lib.prepare("c1", "claude-code", [{ name: "a-style", kind: "skill" }, { name: "notes", kind: "mcp" }]);
  const r2 = lib.prepare("c2", "claude-code", [{ name: "b-style", kind: "skill" }, { name: "files", kind: "mcp" }]);
  assert.ok(r1.ok && r2.ok);
  if (!r1.ok || !r2.ok) return;
  assert.notEqual(r1.home.configDir, r2.home.configDir);
  assert.deepEqual(lib.linkedSkills(r1.home.pluginDirs[0]!).map((s) => s.name), ["a-style"]);
  assert.deepEqual(lib.linkedSkills(r2.home.pluginDirs[0]!).map((s) => s.name), ["b-style"]);
  assert.deepEqual(Object.keys(r1.home.mcpServers), ["notes"]);
  assert.deepEqual(Object.keys(r2.home.mcpServers), ["files"]);
  assert.equal(tree(path.join(d, "run_homes", "c1")).some((p) => p.includes("b-style")), false);
  assert.equal(tree(path.join(d, "run_homes", "c2")).some((p) => p.includes("a-style")), false);
});

test("改了勾选就换新插件目录,旧目录不被改动;没勾 skill 就不给插件目录", () => {
  const { d } = dataDir();
  const lib = new CapabilityLibrary(d);
  const r1 = lib.prepare("c1", "claude-code", [{ name: "a-style", kind: "skill" }]);
  const r2 = lib.prepare("c1", "claude-code", [{ name: "b-style", kind: "skill" }]);
  const r3 = lib.prepare("c1", "claude-code", [{ name: "a-style", kind: "skill" }]);
  const r4 = lib.prepare("c1", "claude-code", [{ name: "notes", kind: "mcp" }]);
  assert.ok(r1.ok && r2.ok && r3.ok && r4.ok);
  if (!r1.ok || !r2.ok || !r3.ok || !r4.ok) return;
  assert.notEqual(r1.home.pluginDirs[0], r2.home.pluginDirs[0]);
  assert.equal(r1.home.pluginDirs[0], r3.home.pluginDirs[0]);
  assert.deepEqual(lib.linkedSkills(r1.home.pluginDirs[0]!).map((s) => s.name), ["a-style"]);
  assert.deepEqual(r4.home.pluginDirs, []);
  assert.deepEqual(r4.home.skills, []);
});

test("勾选的能力库里没有或配置坏了 → 不给运行目录,点名缺哪几项", () => {
  const { d } = dataDir();
  const lib = new CapabilityLibrary(d);
  const r = lib.prepare("c1", "claude-code", [{ name: "a-style", kind: "skill" }, { name: "ghost", kind: "skill" }, { name: "broken", kind: "mcp" }, { name: "nope", kind: "mcp" }, { name: "../x", kind: "skill" }]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.ok ? [] : r.missing, ["skill ghost(能力库里没有)", "MCP broken(配置不是合法 JSON)", "MCP nope(能力库里没有)", "../x(名字不合规)"]);
  assert.equal(fs.existsSync(path.join(d, "run_homes")), false);
});

test("宿主派活把专属配置目录、勾选 skill 的插件目录和勾选 MCP 交给 Compute;实际加载清单记进任务视图", async () => {
  const { d } = dataDir();
  const compute = scriptedCompute({
    script: () => [
      { kind: "started", sessionId: "s", resumed: false, loaded: { skills: ["gg-skills:a-style"], mcpServers: ["host", "notes"] } },
      { kind: "completed", result: "好了" },
    ],
  });
  const host = new Host({ file: path.join(d, "h.db"), dataDir: d, mind: () => scriptedMind(), compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  host.updateContact(c.id, { computeAssets: [{ name: "a-style", kind: "skill" }, { name: "notes", kind: "mcp" }] });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理笔记" });
  await settle(host, compute);
  assert.equal(compute.spawned.length, 1);
  const o = compute.spawned[0]!.opts!;
  assert.equal(o.configDir, path.join(d, "run_homes", c.id, "claude-code", "config"));
  assert.equal(o.pluginDirs?.length, 1);
  assert.deepEqual(host.capabilities.linkedSkills(o.pluginDirs![0]!).map((s) => s.name), ["a-style"]);
  assert.deepEqual(o.mcpServers, { notes: { command: "/usr/bin/true", args: ["--notes"] } });
  const [task] = host.listTasks({ roomId: dm.id });
  assert.deepEqual(task?.computeRuns[0]?.loaded, { skills: ["gg-skills:a-style"], mcpServers: ["host", "notes"] });
  const svc = createService(host);
  const got = await svc.handle("tasks.get", { taskId: task!.id });
  assert.ok(got.ok);
  assert.deepEqual(got.ok ? (got.value as { computeRuns: { loaded?: unknown }[] }).computeRuns[0]?.loaded : null, { skills: ["gg-skills:a-style"], mcpServers: ["host", "notes"] });
  compute.close();
  await host.close();
});

test("勾选的能力不可用 → 不启动 Compute,任务落 T11 并告诉联系人缺哪项", async () => {
  const { d } = dataDir();
  const compute = scriptedCompute();
  const seen: string[] = [];
  const host = new Host({ file: path.join(d, "h.db"), dataDir: d, mind: () => scriptedMind({ onRound: (i) => { for (const f of i.fresh) if (f.kind === "compute") seen.push(f.summary); } }), compute: () => compute.adapter, maxDeferMs: 5 });
  const c = host.createContact({ name: "小克" });
  host.updateContact(c.id, { computeAssets: [{ name: "ghost", kind: "skill" }] });
  const dm = host.openDm(c.id);
  host.send({ roomId: dm.id, clientActionId: "u1", text: "帮我整理笔记" });
  await settle(host, compute);
  assert.equal(compute.spawned.length, 0);
  const [task] = host.listTasks({ roomId: dm.id });
  assert.equal(task?.state, "T11_Failed");
  assert.ok(seen.some((s) => s.includes("勾选的能力不可用:skill ghost(能力库里没有)")), seen.join("|"));
  compute.close();
  await host.close();
});

test("capabilities.list:列出库里可勾选的 skill(带描述)与配置合格的 MCP", async () => {
  const { d } = dataDir();
  const host = new Host({ file: path.join(d, "h.db"), dataDir: d, mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const r = await svc.handle("capabilities.list", {});
  assert.ok(r.ok);
  assert.deepEqual(r.ok ? r.value : null, {
    skills: [{ name: "a-style", description: "a-style NEUTRAL_FIXTURE_NO_CREDENTIALS" }, { name: "b-style", description: "b-style NEUTRAL_FIXTURE_NO_CREDENTIALS" }],
    mcp: [{ name: "files" }, { name: "notes" }],
  });
  await host.close();
});
