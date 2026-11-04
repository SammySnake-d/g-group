// 门禁自检(R-05 双侧标定 / R-18 规则自身可信):
// 每个样例都是一个真实 git 仓库(main → 红提交 → 绿提交 → 收据),用子进程调用真实命令行入口 run-all.ts,
// 只看退出码和输出。合规样例必须放行,违规样例必须拦下且原因文字对。
// 跑的是 import.meta.dirname 下的那份门禁代码,所以 mutation.ts 改坏一份副本后跑它的自检,必须失败。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Receipt } from "./lib.ts";
import { vendorOf } from "./vendor.ts";

const HERE = import.meta.dirname;
const CLI = path.join(HERE, "run-all.ts");
const GATE_IDS = ["G-TRACE", "G-REVIEW", "G-RED", "G-STUB", "G-TAUTO", "G-WORKFLOW", "G-LAYER", "G-PROVENANCE"];

const SPEC = "# 验收\n| AC-01 示例 |\n| AC-02 示例 |\n";
const PKG = (name: string, layer: string, extra: object = {}) => JSON.stringify({ name, gGroup: { layer }, ...extra });
const ADD_OK = "export function add(a: number, b: number): number { return a + b; }\n";
const ADD_EMPTY = "export function add(_a: number, _b: number): number { return 0; }\n";
const T = (body: string, imports = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./add.ts";\n`) => imports + body;
const TEST_OK = T(`test("adds", () => { assert.equal(add(1, 2), 3); });\n`);
const TRUSTED_WF = "name: trusted-gates\non: pull_request_target\npermissions: { contents: read }\njobs:\n  trusted-gates:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n";

type Files = Record<string, string | null>; // null = 删除
interface Case {
  name: string;
  head?: Files; // 相对 main 的改动(绿提交)
  red?: Files | null; // 红提交相对 main 的改动;null = 没有红提交
  receipt?: ((r: Receipt) => void) | null; // null = 不写收据
  reviewerTurns?: (hash: string) => object[]; // 审查会话内容
  authorTurns?: (repo: string) => object[];
  room?: (hash12: string) => object[];
  after?: Files; // 审查之后又改的东西
  local?: boolean; // 默认 true
  expect: string | null; // null = 必须放行
}

const MAIN: Files = { "docs/spec/验收文档-v0.1.md": SPEC, "README.md": "x\n", "packages/core/package.json": PKG("@g-group/core", "domain"), ".github/workflows/trusted-gates.yml": TRUSTED_WF };
const HEAD_OK: Files = { "packages/core/src/add.ts": ADD_OK, "packages/core/src/add.test.ts": TEST_OK, "packages/core/proof/adds.txt": "adds ok\n" };
const RED_OK: Files = { "packages/core/src/add.ts": ADD_EMPTY, "packages/core/src/add.test.ts": TEST_OK };
const reviewerOk = (hash: string) => [{ model: "ai-x/gpt-6-astra", toolCalls: [{ name: "shell", input: "node scripts/gates/run-all.ts --hash --branch feat/x", result: hash }] }];
const authorOk = (_repo: string) => [{ model: "ai-x/claude-opus-5-5", toolCalls: [{ name: "Write", input: { file_path: "/x/deliverables/g-group/packages/core/src/add.ts" } }] }];

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function write(root: string, files: Files) {
  for (const [f, t] of Object.entries(files)) {
    const full = path.join(root, f);
    if (t === null) { fs.rmSync(full, { force: true }); continue; }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, t);
  }
}
function commit(repo: string, msg: string): string {
  sh(repo, "add", "-A");
  sh(repo, "-c", "user.name=selftest", "-c", "user.email=s@t", "commit", "-q", "--allow-empty", "-m", msg);
  return sh(repo, "rev-parse", "HEAD");
}
function cli(repo: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, "--repo", repo, "--base", "main", "--branch", "feat/x", ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 600_000 });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function runCase(tmp: string, c: Case, i: number): { pass: boolean; detail: string } {
  const dir = path.join(tmp, `c${i}`);
  const repo = path.join(dir, "repo"), sessions = path.join(dir, "sessions"), rooms = path.join(dir, "rooms");
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  write(repo, MAIN);
  commit(repo, "main");
  sh(repo, "checkout", "-q", "-b", "feat/x");
  let redSha = "";
  const red = c.red === undefined ? RED_OK : c.red;
  if (red) { write(repo, red); redSha = commit(repo, "red"); }
  write(repo, c.head ?? HEAD_OK);
  commit(repo, "green");
  const env = { MIRASIM_SESSIONS: sessions, MIRASIM_ROOMS: rooms };
  const putTurns = (session: string, turns: object[]) => {
    const [h, id] = session.split(":");
    write(path.join(sessions, h!, id!), { "turns.jsonl": `${turns.map((t) => JSON.stringify(t)).join("\n")}\n` });
  };
  if (c.receipt !== null) {
    const r: Receipt = {
      slice: "selftest",
      acceptance: [{ id: "AC-01", status: "通过", evidence: "packages/core/proof/adds.txt" }, { id: "AC-02", status: "未测", reason: "本片不涉及" }],
      author: { agent: "claude", session: "claude:a", model: "claude-opus-5-5" },
      review: { agent: "astra", session: "codex:b", model: "gpt-6-astra", verdict: "approve", reviewed_hash: "", notes: "ok" },
      red: redSha ? { commit: redSha } : null,
      unverifiable: "AC-01 只验了整数相加",
      waiver: null,
    };
    c.receipt?.(r);
    const rel = "receipts/feat-x.json";
    write(repo, { [rel]: JSON.stringify(r, null, 1) });
    const hash = cli(repo, env, "--hash").out.trim();
    if (r.review) {
      if (!r.review.reviewed_hash) r.review.reviewed_hash = hash;
      write(repo, { [rel]: JSON.stringify(r, null, 1) });
      putTurns(r.review.session, (c.reviewerTurns ?? reviewerOk)(hash));
    }
    putTurns(r.author.session, (c.authorTurns ?? authorOk)(repo));
    if (c.room) write(path.join(rooms, "g-group", "log"), { "00000001.jsonl": `${c.room(hash.slice(0, 12)).map((e) => JSON.stringify(e)).join("\n")}\n` });
    commit(repo, "receipt");
  }
  if (c.after) { write(repo, c.after); commit(repo, "after-review"); }
  const res = c.local === false ? cli(repo, env) : cli(repo, env, "--local");
  if (c.expect === null) {
    const allListed = (c.local === false ? GATE_IDS.slice(0, -1) : GATE_IDS).every((id) => res.out.includes(`✓ ${id} `));
    return { pass: res.code === 0 && allListed, detail: res.out };
  }
  return { pass: res.code === 1 && res.out.includes(c.expect), detail: res.out };
}

const R = (f: (r: Receipt) => void) => f;
const user = (seq: number, text: string, by = "usr_1") => ({ v: 1, seq, by, kind: "message", text });

export const CASES: Case[] = [
  { name: "合规:先红后绿、跨厂商审查、来源核对通过", expect: null },
  { name: "合规:node:test 别名 + 断言", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`check("adds", () => { assert.equal(add(1, 2), 3); });\n`, `import { test as check } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./add.ts";\n`) }, red: { ...RED_OK, "packages/core/src/add.test.ts": T(`check("adds", () => { assert.equal(add(1, 2), 3); });\n`, `import { test as check } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./add.ts";\n`) }, expect: null },
  { name: "合规:只改文档不需要收据", head: { "docs/spec/notes.md": "x\n" }, red: null, receipt: null, expect: null },
  { name: "合规:用户本人对这一版批准豁免", receipt: R((r) => { r.review!.model = "claude-sonnet-5-5"; r.waiver = { by: "39impacts.talent", reason: "g-group#900" }; }), reviewerTurns: (h) => [{ model: "claude-sonnet-5-5", toolCalls: [{ input: "node scripts/gates/run-all.ts --hash", result: h }] }], room: (h) => [user(900, `批准豁免 ${h},这次同厂商审查可以`)], expect: null },

  { name: "合规(CI 模式,不跑来源核对)", local: false, expect: null },
  { name: "CI 模式下违规同样拦下", local: false, receipt: null, expect: "缺收据" },
  { name: "改了代码没收据", receipt: null, expect: "缺收据" },
  { name: "F-02 只改 workflow 没收据", head: { ".github/workflows/ci.yml": "on: pull_request\njobs: { x: { runs-on: ubuntu-latest, steps: [{ run: 'true' }] } }\n" }, red: null, receipt: null, expect: "缺收据" },
  { name: "只改 package.json 没收据", head: { "package.json": "{}\n" }, red: null, receipt: null, expect: "缺收据" },
  { name: "删掉源码也要收据", head: { "packages/core/package.json": null }, red: null, receipt: null, expect: "缺收据" },
  { name: "条目不在验收文档", receipt: R((r) => { r.acceptance[0]!.id = "AC-99"; }), expect: "不在验收文档" },
  { name: "状态不在四种之内", receipt: R((r) => { (r.acceptance[1] as { status: string }).status = "基本通过"; }), expect: "不是 通过/失败/未测/不适用" },
  { name: "第 7 栏没点到条目", receipt: R((r) => { r.unverifiable = "应该没问题"; }), expect: "第 7 栏" },

  { name: "作者自审", receipt: R((r) => { r.review!.agent = "claude"; }), expect: "同一个" },
  { name: "同厂商审查且无豁免", receipt: R((r) => { r.review!.model = "claude-sonnet-5-5"; }), reviewerTurns: (h) => [{ model: "claude-sonnet-5-5", toolCalls: [{ input: "run-all.ts --hash", result: h }] }], expect: "没有用户豁免" },
  { name: "审查模型认不出", receipt: R((r) => { r.review!.model = "stealth/crouton-alpha"; }), expect: "认不出" },
  { name: "审查结论 reject", receipt: R((r) => { r.review!.verdict = "reject"; }), expect: "审查结论是 reject" },
  { name: "审后又改代码", after: { "packages/core/src/add.ts": `${ADD_OK}// x\n` }, expect: "需要重审" },
  { name: "审后改 workflow", after: { ".github/workflows/trusted-gates.yml": `${TRUSTED_WF}# x\n` }, expect: "需要重审" },

  { name: "F-01 审查会话不存在", receipt: R((r) => { r.review!.session = "codex:ghost"; }), reviewerTurns: () => [], expect: "审查会话里没有一次" },
  { name: "F-01 审查会话里没算过这个 hash", reviewerTurns: () => [{ model: "gpt-6-astra", toolCalls: [{ input: "cat README.md", result: "x" }] }], expect: "审查会话里没有一次" },
  { name: "F-04 历史出现过别家模型,算 hash 那一轮是同厂商", reviewerTurns: (h) => [{ model: "gpt-6-astra", toolCalls: [{ input: "ls", result: "old" }] }, { model: "claude-opus-5-5", toolCalls: [{ input: "node scripts/gates/run-all.ts --hash", result: h }] }], expect: "实际是 anthropic" },
  { name: "审查会话算出的是别的 hash", reviewerTurns: () => [{ model: "gpt-6-astra", toolCalls: [{ input: "node scripts/gates/run-all.ts --hash", result: "0".repeat(64) }] }], expect: "审查会话里没有一次" },
  { name: "F-04 hash 只出现在聊天文本里", reviewerTurns: (h) => [{ model: "gpt-6-astra", text: `我审的是 ${h}`, toolCalls: [] }], expect: "审查会话里没有一次" },
  { name: "作者自报与实际产出厂商不符", authorTurns: () => [{ model: "gpt-6", toolCalls: [{ input: "/x/g-group/packages/core/src/add.ts" }] }], receipt: R((r) => { r.review!.model = "gemini-4"; }), reviewerTurns: (h) => [{ model: "gemini-4", toolCalls: [{ input: "run-all.ts --hash", result: h }] }], expect: "实际产出厂商是 openai" },
  { name: "作者会话没碰过本仓库", authorTurns: () => [{ model: "claude-opus-5-5", toolCalls: [{ input: "/x/g-group-requirements/a.md" }] }], expect: "找不到对本仓库的任何操作" },
  { name: "作者中途换成审查同厂商(累积集合)", authorTurns: () => [{ model: "claude-opus-5-5", toolCalls: [{ input: "cd ~/g-group && vim x" }] }, { model: "gpt-6", toolCalls: [{ input: "/x/g-group/y" }] }, { model: "gemini-4", toolCalls: [{ input: "/x/g-group-requirements/z" }] }], expect: "在作者的产出厂商集合" },
  { name: "F-03 用户明确不批准豁免", receipt: R((r) => { r.review!.model = "claude-sonnet-5-5"; r.waiver = { by: "39impacts.talent", reason: "g-group#900" }; }), reviewerTurns: (h) => [{ model: "claude-sonnet-5-5", toolCalls: [{ input: "run-all.ts --hash", result: h }] }], room: (h) => [user(900, `必须跨厂商，不批准豁免。${h}`)], expect: "不是明确的" },
  { name: "豁免是助手发的", receipt: R((r) => { r.review!.model = "claude-sonnet-5-5"; r.waiver = { by: "39impacts.talent", reason: "g-group#900" }; }), reviewerTurns: (h) => [{ model: "claude-sonnet-5-5", toolCalls: [{ input: "run-all.ts --hash", result: h }] }], room: (h) => [user(900, `批准豁免 ${h}`, "ai-claude")], expect: "不是用户本人" },
  { name: "豁免没绑定这一版", receipt: R((r) => { r.review!.model = "claude-sonnet-5-5"; r.waiver = { by: "39impacts.talent", reason: "g-group#900" }; }), reviewerTurns: (h) => [{ model: "claude-sonnet-5-5", toolCalls: [{ input: "run-all.ts --hash", result: h }] }], room: () => [user(900, "批准豁免")], expect: "没写当前内容 hash" },
  { name: "豁免之后被撤回", receipt: R((r) => { r.review!.model = "claude-sonnet-5-5"; r.waiver = { by: "39impacts.talent", reason: "g-group#900" }; }), reviewerTurns: (h) => [{ model: "claude-sonnet-5-5", toolCalls: [{ input: "run-all.ts --hash", result: h }] }], room: (h) => [user(900, `批准豁免 ${h}`), { v: 1, seq: 901, by: "usr_1", kind: "retract", target: 900 }], expect: "被retract" },

  { name: "F-05 node:test 别名、零断言、错误实现", head: { ...HEAD_OK, "packages/core/src/add.ts": "export function add(_a: number, _b: number): number { return 999; }\n", "packages/core/src/add.test.ts": `import { test as check } from "node:test";\nimport { add } from "./add.ts";\ncheck("adds", () => { add(1, 2); });\n` }, red: { ...RED_OK, "packages/core/src/add.ts": "export function add(): number { throw new Error('x'); }\n", "packages/core/src/add.test.ts": `import { test as check } from "node:test";\nimport { add } from "./add.ts";\ncheck("adds", () => { add(1, 2); });\n` }, expect: "没有任何断言" },
  { name: "间接注册测试绕过静态识别", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`const reg = test;\nreg("hidden", () => { add(1, 2); });\ntest("adds", () => { assert.equal(add(1, 2), 3); });\n`) }, expect: "运行时注册了" },
  { name: "F-07 断言只判复制的逻辑", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { void add; const actual = 1 + 2; assert.equal(actual, 3); });\n`) }, expect: "没有一条断言判的是被测源码" },
  { name: "恒真断言", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(add(1, 2), 3); assert.equal(1, 1); });\n`) }, expect: "恒真" },
  { name: "提交了 skip 的测试", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(add(1, 2), 3); });\ntest.skip("later", () => { assert.equal(add(1, 1), 2); });\n`) }, expect: "不许提交" },
  { name: "源码里偷偷导入 node:test", head: { ...HEAD_OK, "packages/core/src/add.ts": `import "node:test";\n${ADD_OK}` }, expect: "却导入了 node:test" },

  { name: "F-06 同文件后补的测试没有红记录", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(add(1, 2), 3); });\ntest("negative", () => { assert.equal(add(-1, -2), -3); });\n`) }, expect: "negative 在红提交上没有按名字失败" },
  { name: "红提交上测试本来就绿", red: { ...RED_OK, "packages/core/src/add.ts": ADD_OK }, expect: "adds 在红提交上没有按名字失败" },
  { name: "红提交只是加载失败", red: { "packages/core/src/add.test.ts": TEST_OK }, expect: "adds 在红提交上没有按名字失败" },
  { name: "收据没写红提交", red: null, expect: "缺 red.commit" },
  { name: "改源码不改测试", head: { "packages/core/src/add.ts": ADD_OK, "packages/core/src/add.test.ts": null }, red: null, receipt: R((r) => { r.acceptance = [{ id: "AC-02", status: "未测", reason: "x" }]; }), expect: "没有新增或改动任何测试" },

  { name: "F-07 测试只读顶层常量", head: { ...HEAD_OK, "packages/core/src/add.ts": `${ADD_OK}export const initialized = add(1, 2);\n`, "packages/core/src/add.test.ts": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { initialized } from "./add.ts";\ntest("adds", () => { assert.equal(initialized, 3); });\n` }, red: { ...RED_OK, "packages/core/src/add.ts": `${ADD_EMPTY}export const initialized = add(1, 2);\n`, "packages/core/src/add.test.ts": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { initialized } from "./add.ts";\ntest("adds", () => { assert.equal(initialized, 3); });\n` }, expect: "空桩后没有按名字失败" },
  { name: "空桩下测试自己 skip 掉", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", (t) => { try { add(1, 2); } catch { t.skip(); return; } assert.equal(add(1, 2), 3); });\n`) }, red: { ...RED_OK, "packages/core/src/add.test.ts": T(`test("adds", (t) => { try { add(1, 2); } catch { t.skip(); return; } assert.equal(add(1, 2), 3); });\n`) }, expect: "空桩后没有按名字失败" },
  { name: "门禁自身出错按拦下处理", head: { ...HEAD_OK, "packages/core/package.json": "{ 坏的 json" }, expect: "门禁自身出错" },
  { name: "吞掉异常的测试", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { let v = 3; try { v = add(1, 2); } catch {} assert.equal(v, 3); });\n`) }, red: { ...RED_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { let v = 3; try { v = add(1, 2); } catch {} assert.equal(v, 3); });\n`) }, expect: "空桩后没有按名字失败" },

  { name: "PR 的 workflow 冒充受保护检查名", head: { ...HEAD_OK, ".github/workflows/fake.yml": "on: pull_request\njobs:\n  provenance:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n" }, expect: "受保护检查名 provenance" },
  { name: "PR 的 workflow 写提交状态", head: { ...HEAD_OK, ".github/workflows/x.yml": "on: pull_request\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'gh api repos/o/r/statuses/abc' }]\n" }, expect: "在写提交状态" },
  { name: "PR 的 workflow 申请写权限", head: { ...HEAD_OK, ".github/workflows/x.yml": "on: pull_request\npermissions: { statuses: write }\njobs: {}\n" }, expect: "申请了写权限" },
  { name: "PR 的 workflow 用 pull_request_target", head: { ...HEAD_OK, ".github/workflows/x.yml": "on: pull_request_target\njobs: {}\n" }, expect: "用了 pull_request_target" },
  { name: "删掉 trusted-gates.yml", head: { ...HEAD_OK, ".github/workflows/trusted-gates.yml": null }, expect: "缺 .github/workflows/trusted-gates.yml" },

  { name: "领域层反向依赖内核", head: { ...HEAD_OK, "packages/kern/package.json": PKG("@g-group/kern", "kernel"), "packages/kern/src/k.ts": "export const k = 1;\n", "packages/core/src/bad.ts": `import { k } from "@g-group/kern";\nexport const b = k;\n` }, expect: "不能依赖 kernel" },
  { name: "插件依赖另一个插件", head: { ...HEAD_OK, "packages/p1/package.json": PKG("@g-group/plugin-a", "plugin"), "packages/p2/package.json": PKG("@g-group/plugin-b", "plugin"), "packages/p2/src/x.ts": "export const x = 1;\n", "packages/p1/src/y.ts": `import { x } from "@g-group/plugin-b";\nexport const y = x;\n` }, expect: "不能依赖 plugin" },
  { name: "相对路径跨包", head: { ...HEAD_OK, "packages/kern/package.json": PKG("@g-group/kern", "kernel"), "packages/kern/src/k.ts": `import { add } from "../../core/src/add.ts";\nexport const k = add;\n` }, expect: "跨出了包" },
  { name: "依赖声明里反向引用", head: { ...HEAD_OK, "packages/kern/package.json": PKG("@g-group/kern", "kernel"), "packages/core/package.json": PKG("@g-group/core", "domain", { dependencies: { "@g-group/kern": "*" } }) }, expect: "依赖声明里引用了 kernel" },
  { name: "包没声明层级", head: { ...HEAD_OK, "packages/core/package.json": JSON.stringify({ name: "@g-group/core" }) }, expect: "gGroup.layer" },
];

export function selfTest(only?: (c: Case) => boolean): boolean {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-selftest-"));
  let ok = true;
  const failFast = process.env.GATE_SELFTEST_FAILFAST === "1";
  try {
    CASES.forEach((c, i) => {
      if (only && !only(c)) return;
      if (failFast && !ok) return;
      const { pass, detail } = runCase(tmp, c, i);
      if (!pass) ok = false;
      console.log(`${pass ? "✓" : "✗"} ${c.expect === null ? "放行" : "拦下"}:${c.name}`);
      if (!pass && !failFast) console.log(detail.split("\n").map((l) => `      | ${l}`).join("\n"));
    });
    for (const [m, v] of [["o1", "openai"], ["gpt-6-astra", "openai"], ["ai-iisbo/[乾坤按量]gpt-6-astra", "openai"], ["claude-opus-5-5", "anthropic"], ["grok-4.7", "xai"], ["gemini-4-argon", "google"], ["stealth/crouton-alpha", "unknown"], [undefined, "unknown"]] as const) {
      const pass = vendorOf(m) === v;
      if (!pass) ok = false;
      console.log(`${pass ? "✓" : "✗"} vendorOf(${m}) = ${vendorOf(m)}`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(ok ? "自检通过" : "自检失败");
  return ok;
}
