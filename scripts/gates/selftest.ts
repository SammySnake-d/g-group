// 门禁自检(R-05 双侧标定 / R-18 规则自身可信):
// 每个样例都是一个真实 git 仓库(main → 红提交 → 绿提交 → 收据),用子进程调用真实命令行入口 run-all.ts,
// 只看退出码和输出。合规样例必须放行,违规样例必须拦下且原因文字对。
// 跑的是 import.meta.dirname 下的那份门禁代码,所以 mutation.ts 改坏一份副本后跑它的自检,必须失败。
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GIT_SAFE_ARGS, gitEnv, type Receipt } from "./lib.ts";
import { CASE_MARK, type CaseResult, evidence, type Kind, killedBy, parseGateOutput } from "./judge.ts";
import { verdict as runnerVerdict } from "./test-runner.ts";
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
  headFn?: (dir: string) => Files; // 需要知道样例目录的绿提交内容
  env?: Record<string, string>;
  authorRecord?: object; // 作者会话的 record.json
  setup?: (x: { dir: string; repo: string; sessions: string; hash: string }) => void; // 写完收据和会话后、跑门禁前
  postCheck?: (dir: string) => string | undefined; // 跑完后检查副作用,返回问题
  hostileGit?: boolean; // 在 GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE 指向另一个仓库的环境里跑
  main?: Files; // main 上额外的文件
  direct?: () => string | undefined; // 不建夹具仓库、直接检查;返回问题,undefined = 通过
}

const MAIN: Files = { "docs/spec/验收文档-v0.1.md": SPEC, "README.md": "x\n", "packages/core/package.json": PKG("@g-group/core", "domain"), ".github/workflows/trusted-gates.yml": TRUSTED_WF };
const HEAD_OK: Files = { "packages/core/src/add.ts": ADD_OK, "packages/core/src/add.test.ts": TEST_OK, "packages/core/proof/adds.txt": "adds ok\n" };
const RED_OK: Files = { "packages/core/src/add.ts": ADD_EMPTY, "packages/core/src/add.test.ts": TEST_OK };
const reviewerOk = (hash: string) => [{ model: "ai-x/gpt-6-astra", toolCalls: [{ name: "shell", input: "node scripts/gates/run-all.ts --hash --branch feat/x", result: hash }] }];
const authorOk = (_repo: string) => [{ model: "ai-x/claude-opus-5-5", toolCalls: [{ name: "Write", input: { file_path: "/x/deliverables/g-group/packages/core/src/add.ts" } }] }];

const sh = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT_SAFE_ARGS, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv() }).trim();
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
  const r = spawnSync(process.execPath, [CLI, "--repo", repo, "--base", "main", "--branch", "feat/x", "--pr", "7", ...args], { encoding: "utf8", env: gitEnv(env as Record<string, string>), timeout: 600_000 });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

type Run = CaseResult & { detail: string };
function mk(c: Case, o: Partial<CaseResult> & { pass: boolean; kind: Kind; detail: string }): Run {
  return { name: c.name, direct: !!c.direct, expect: c.expect, exit: null, gates: {}, expectHit: [], gateErrors: [], ...o };
}
function runCase(tmp: string, c: Case, i: number): Run {
  if (!c.hostileGit) return runCaseInner(tmp, c, i);
  // 造一个"另一个仓库",把 GIT_* 指向它,模拟 pre-push hook 的环境;跑完它必须分毫未动
  const other = path.join(tmp, `other${i}`);
  fs.mkdirSync(other, { recursive: true });
  sh(other, "init", "-q", "-b", "trunk");
  write(other, { "keep.txt": "keep\n" });
  commit(other, "keep");
  const snapOf = () => [sh(other, "config", "--local", "--list"), sh(other, "for-each-ref"), sh(other, "rev-parse", "HEAD"), sh(other, "status", "--porcelain")].join("\n---\n");
  const before = snapOf();
  const saved = { d: process.env.GIT_DIR, w: process.env.GIT_WORK_TREE, x: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = path.join(other, ".git"); process.env.GIT_WORK_TREE = other; process.env.GIT_INDEX_FILE = path.join(other, ".git", "index");
  let res: Run;
  try { res = runCaseInner(tmp, c, i); }
  finally {
    for (const [k, v] of [["GIT_DIR", saved.d], ["GIT_WORK_TREE", saved.w], ["GIT_INDEX_FILE", saved.x]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const after = snapOf();
  if (after !== before) return { ...res, pass: false, kind: "side", why: "GIT_DIR 指向的另一个仓库被改动了", detail: `GIT_DIR 指向的另一个仓库被改动了:\n${before}\n=====\n${after}` };
  return res;
}

function runCaseInner(tmp: string, c: Case, i: number): Run {
  if (c.direct) { const why = c.direct(); return mk(c, { pass: why === undefined, kind: why === undefined ? "ok" : "verdict", detail: why ?? "", ...(why === undefined ? {} : { why }) }); }
  const dir = path.join(tmp, `c${i}`);
  const repo = path.join(dir, "repo"), sessions = path.join(dir, "sessions"), rooms = path.join(dir, "rooms");
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  write(repo, { ...MAIN, ...c.main });
  commit(repo, "main");
  sh(repo, "checkout", "-q", "-b", "feat/x");
  let redSha = "";
  const red = c.red === undefined ? RED_OK : c.red;
  if (red) { write(repo, red); redSha = commit(repo, "red"); }
  write(repo, c.headFn ? c.headFn(dir) : (c.head ?? HEAD_OK));
  commit(repo, "green");
  fs.mkdirSync(sessions, { recursive: true });
  const env = { MIRASIM_SESSIONS: sessions, MIRASIM_ROOMS: rooms, GATE_OWNER_UID: OWNER_UID, GATE_OWNER_NAME: OWNER_NAME, ...c.env };
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
    if (c.authorRecord) { const [h, id] = r.author.session.split(":"); write(path.join(sessions, h!, id!), { "record.json": JSON.stringify(c.authorRecord) }); }
    c.setup?.({ dir, repo, sessions, hash });
    if (c.room) write(path.join(rooms, "g-group", "log"), { "00000001.jsonl": `${c.room(hash.slice(0, 12)).map((e) => JSON.stringify(e)).join("\n")}\n` });
    commit(repo, "receipt");
  }
  if (c.after) { write(repo, c.after); commit(repo, "after-review"); }
  const res = c.local === false ? cli(repo, env) : cli(repo, env, "--local");
  if (res.code === null) return mk(c, { pass: false, kind: "timeout", why: "门禁命令行超时", detail: res.out });
  const g = parseGateOutput(res.out, c.expect);
  const seen = { exit: res.code, gates: g.gates, expectHit: g.expectHit, gateErrors: g.gateErrors };
  if (!g.header || (res.code !== 0 && res.code !== 1)) return mk(c, { ...seen, pass: false, kind: "crash", why: `门禁命令行没有正常跑完(退出 ${res.code})`, detail: res.out });
  const side = c.postCheck?.(dir);
  if (side) return mk(c, { ...seen, pass: false, kind: "side", why: side, detail: `${side}\n${res.out}` });
  const pass = c.expect === null
    ? res.code === 0 && (c.local === false ? GATE_IDS.slice(0, -1) : GATE_IDS).every((id) => res.out.includes(`✓ ${id} `))
    : res.code === 1 && res.out.includes(c.expect);
  return mk(c, { ...seen, pass, kind: pass ? "ok" : "verdict", detail: res.out, ...(pass ? {} : { why: c.expect === null ? "该放行的没放行" : `没有按「${c.expect}」拦下` }) });
}

const R = (f: (r: Receipt) => void) => f;
const OWNER_UID = "usr_owner", OWNER_NAME = "39impacts.talent";
const user = (seq: number, text: string, by = OWNER_UID, name = OWNER_NAME) => ({ v: 1, seq, by, name, kind: "message", text });
const SAME = R((r) => { r.review!.model = "claude-sonnet-5-5"; r.waiver = { by: OWNER_NAME, reason: "g-group#900" }; });
const sameTurns = (h: string) => [{ model: "claude-sonnet-5-5", toolCalls: [{ input: "node scripts/gates/run-all.ts --hash", result: h }] }];
const WF = (y: string): Files => ({ ...HEAD_OK, ".github/workflows/x.yml": y });
// RR-09:self-check.yml 必须无条件跑门禁自检与变异校验,package.json 对应脚本必须是规范值
const SC_STEP_SELF = "      - name: 门禁自检\n        run: npm run gates:selftest\n";
const SC_STEP_MUT = "      - name: 门禁变异校验\n        run: GATE_MUTATION_JOBS=4 npm run gates:mutation\n";
// R4-01:变异判定的双侧样例(直接调用 judge.ts)
const ALL_OK: Record<string, "✓" | "✗"> = Object.fromEntries(GATE_IDS.map((g) => [g, "✓" as const]));
const BLOCKED = (o: Partial<CaseResult> = {}): CaseResult => ({ name: "改了代码没收据", pass: true, kind: "ok", direct: false, expect: "缺收据", exit: 1, gates: { ...ALL_OK, "G-TRACE": "✗" }, expectHit: ["G-TRACE"], gateErrors: [], ...o });
const ALLOWED = (o: Partial<CaseResult> = {}): CaseResult => ({ name: "合规:先红后绿、跨厂商审查、来源核对通过", pass: true, kind: "ok", direct: false, expect: null, exit: 0, gates: { ...ALL_OK }, expectHit: [], gateErrors: [], ...o });
const notKilled = (target: string[], base: CaseResult, mut: CaseResult) => { const ev = evidence(target, base, mut); return ev === undefined ? undefined : `不该算发现,却给出判因:${ev}`; };
const SC_STEP_TEST = "      - name: 测试\n        run: npm test\n";
const SC_WF = (steps = SC_STEP_SELF + SC_STEP_MUT, jobExtra = "", testStep = SC_STEP_TEST) => `on: pull_request\npermissions: { contents: read }\njobs:\n  self-check:\n    runs-on: ubuntu-latest\n${jobExtra}    steps:\n${testStep}${steps}`;
const TEST_SCRIPT = 'node scripts/gates/test-runner.ts "packages/**/*.test.ts" "scripts/gates/*.test.ts"';
// g-group#2538:直接跑 test-runner.ts,0 条用例必须判失败
function runTestRunner(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-runner-"));
  try {
    write(dir, files);
    const r = spawnSync(process.execPath, [path.join(HERE, "test-runner.ts"), "*.test.ts"], { cwd: dir, encoding: "utf8", env: gitEnv(), timeout: 120_000 });
    return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const ROOT_PKG = (scripts: Record<string, string> = {}) => JSON.stringify({ name: "g-group", private: true, type: "module", scripts: { test: TEST_SCRIPT, "gates:selftest": "node scripts/gates/run-all.ts --self-test", "gates:mutation": "node scripts/gates/mutation.ts", ...scripts } });
const SC = (wf: string, pkg = ROOT_PKG()): Files => ({ ...HEAD_OK, ".github/workflows/self-check.yml": wf, "package.json": pkg });
// RR-11:测试经 helper 拿期望值
const TEST_HELPER = (spec: string) => T(`import { expected } from "${spec}";\ntest("adds", () => { assert.equal(add(1, 2), expected); });\n`);
// RR-12:同文件一强一弱
const ADD2 = `${ADD_OK}export function difference(_a: number, _b: number): number { return 999; }\n`;
const RED2 = `${ADD_EMPTY}export function difference(_a: number, _b: number): number { throw new Error("red"); }\n`;
const TEST2 = (diffAssert: string) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add, difference } from "./add.ts";\ntest("addition", () => { assert.equal(add(1, 2), 3); });\ntest("difference", () => { ${diffAssert} });\n`;
// RR-14:审查轮次的工具调用(codex 的真实形状:{ command, shell, cwd })
const hashCall = (command: string) => (h: string) => [{ model: "gpt-6-astra", toolCalls: [{ name: "shell", input: { command, shell: "/bin/zsh -lc", cwd: "/x/review" }, result: h }] }];

export const CASES: Case[] = [
  { name: "合规:先红后绿、跨厂商审查、来源核对通过", expect: null },
  { name: "合规:node:test 别名 + 断言", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`check("adds", () => { assert.equal(add(1, 2), 3); });\n`, `import { test as check } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./add.ts";\n`) }, red: { ...RED_OK, "packages/core/src/add.test.ts": T(`check("adds", () => { assert.equal(add(1, 2), 3); });\n`, `import { test as check } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./add.ts";\n`) }, expect: null },
  { name: "合规:只改文档不需要收据", head: { "docs/spec/notes.md": "x\n" }, red: null, receipt: null, expect: null },

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
  { name: "同厂商审查且无豁免", receipt: R((r) => { r.review!.model = "claude-sonnet-5-5"; }), reviewerTurns: (h) => [{ model: "claude-sonnet-5-5", toolCalls: [{ input: "node scripts/gates/run-all.ts --hash", result: h }] }], expect: "没有用户豁免" },
  { name: "审查模型认不出", receipt: R((r) => { r.review!.model = "stealth/crouton-alpha"; }), expect: "认不出" },
  { name: "审查结论 reject", receipt: R((r) => { r.review!.verdict = "reject"; }), expect: "审查结论是 reject" },
  { name: "审后又改代码", after: { "packages/core/src/add.ts": `${ADD_OK}// x\n` }, expect: "需要重审" },
  { name: "审后改 workflow", after: { ".github/workflows/trusted-gates.yml": `${TRUSTED_WF}# x\n` }, expect: "需要重审" },

  { name: "F-01 审查会话不存在", receipt: R((r) => { r.review!.session = "codex:ghost"; }), reviewerTurns: () => [], expect: "审查会话里没有一次" },
  { name: "F-01 审查会话里没算过这个 hash", reviewerTurns: () => [{ model: "gpt-6-astra", toolCalls: [{ input: "cat README.md", result: "x" }] }], expect: "审查会话里没有一次" },
  { name: "F-04 历史出现过别家模型,算 hash 那一轮是同厂商", reviewerTurns: (h) => [{ model: "gpt-6-astra", toolCalls: [{ input: "ls", result: "old" }] }, { model: "claude-opus-5-5", toolCalls: [{ input: "node scripts/gates/run-all.ts --hash", result: h }] }], expect: "实际是 anthropic" },
  { name: "审查会话算出的是别的 hash", reviewerTurns: () => [{ model: "gpt-6-astra", toolCalls: [{ input: "node scripts/gates/run-all.ts --hash", result: "0".repeat(64) }] }], expect: "审查会话里没有一次" },
  { name: "F-04 hash 只出现在聊天文本里", reviewerTurns: (h) => [{ model: "gpt-6-astra", text: `我审的是 ${h}`, toolCalls: [] }], expect: "审查会话里没有一次" },
  { name: "作者自报与实际产出厂商不符", authorTurns: () => [{ model: "gpt-6", toolCalls: [{ input: "/x/g-group/packages/core/src/add.ts" }] }], receipt: R((r) => { r.review!.model = "gemini-4"; }), reviewerTurns: (h) => [{ model: "gemini-4", toolCalls: [{ input: "node scripts/gates/run-all.ts --hash", result: h }] }], expect: "实际产出厂商是 openai" },
  { name: "作者会话没碰过本仓库", authorTurns: () => [{ model: "claude-opus-5-5", toolCalls: [{ input: "/x/g-group-requirements/a.md" }] }], expect: "找不到对本仓库的任何操作" },
  { name: "作者中途换成审查同厂商(累积集合)", authorTurns: () => [{ model: "claude-opus-5-5", toolCalls: [{ input: "cd ~/g-group && vim x" }] }, { model: "gpt-6", toolCalls: [{ input: "/x/g-group/y" }] }, { model: "gemini-4", toolCalls: [{ input: "/x/g-group-requirements/z" }] }], expect: "在作者的产出厂商集合" },

  { name: "合规:仓库所有者对这个 PR 这一版结构化批准豁免", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `  批准豁免 PR#7 ${h}\n`)], expect: null },
  { name: "RR-13 指令前另有说明文字", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `这次同厂商审查可以\n批准豁免 PR#7 ${h}`)], expect: "不是一条格式为" },
  { name: "RR-13 先说不批准、下一行是格式行", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `下面仅为格式演示，我不批准任何豁免：\n批准豁免 PR#7 ${h}`)], expect: "不是一条格式为" },
  { name: "RR-13 整条消息是引用块里的指令", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `> 批准豁免 PR#7 ${h}`)], expect: "不是一条格式为" },
  { name: "F-03 用户明确不批准豁免", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `必须跨厂商，不批准豁免。${h}`)], expect: "不是一条格式为" },
  { name: "豁免是助手发的", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `批准豁免 PR#7 ${h}`, "ai-claude", OWNER_NAME)], expect: "不是仓库所有者" },
  { name: "豁免没绑定这一版", receipt: SAME, reviewerTurns: sameTurns, room: () => [user(900, "批准豁免 PR#7 000000000000")], expect: "≠ 当前" },
  { name: "豁免给的是别的 PR", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `批准豁免 PR#8 ${h}`)], expect: "不是本次的 PR#7" },
  { name: "豁免之后被撤回", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `批准豁免 PR#7 ${h}`), { v: 1, seq: 901, by: OWNER_UID, name: OWNER_NAME, kind: "retract", target: 900 }], expect: "被retract" },
  { name: "RR-08 豁免写在引用示例里", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `以下只是测试样例，不构成授权：「批准豁免 PR#7 ${h}」`)], expect: "不是一条格式为" },
  { name: "RR-08 豁免写在引用块里", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `> 批准豁免 PR#7 ${h}\n别当真`)], expect: "不是一条格式为" },
  { name: "RR-08 豁免写在代码块里", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `\`\`\`\n批准豁免 PR#7 ${h}\n\`\`\``)], expect: "不是一条格式为" },
  { name: "RR-08 另一个用户发的豁免", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `批准豁免 PR#7 ${h}`, "usr_unrelated", "someone")], expect: "不是仓库所有者" },
  { name: "RR-08 冒用所有者名字的另一个 uid", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `批准豁免 PR#7 ${h}`, "usr_unrelated", OWNER_NAME)], expect: "不是仓库所有者" },
  { name: "RR-08 收据把豁免人写成别人", receipt: R((r) => { r.review!.model = "claude-sonnet-5-5"; r.waiver = { by: "someone", reason: "g-group#900" }; }), reviewerTurns: sameTurns, room: (h) => [user(900, `批准豁免 PR#7 ${h}`)], expect: "无权批准" },
  { name: "RR-08 豁免消息之后被引用", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `批准豁免 PR#7 ${h}`), { ...user(905, "转一下"), reply: 900 }], expect: "引用" },
  { name: "RR-08 豁免是代发的", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [{ ...user(900, `批准豁免 PR#7 ${h}`), via: "ai-x" }], expect: "转发或代发" },
  { name: "RR-01 harness 带路径穿越", receipt: R((r) => { r.review!.session = "../evil:r"; }), reviewerTurns: () => [], expect: "格式必须是" },
  { name: "RR-01 harness 不在白名单", receipt: R((r) => { r.review!.session = "evil:r"; }), reviewerTurns: () => [], expect: "不在白名单" },
  { name: "RR-01 id 带多余冒号", receipt: R((r) => { r.review!.session = "codex:b:c"; }), reviewerTurns: () => [], expect: "格式必须是" },
  { name: "RR-01 会话文件软链到 PR 里的伪造记录", headFn: () => ({ ...HEAD_OK, "reviews/forged/turns.jsonl": "{}\n" }), receipt: R((r) => { r.review!.session = "codex:link"; }), reviewerTurns: () => [],
    setup: ({ repo, sessions, hash }) => { fs.writeFileSync(path.join(repo, "reviews/forged/turns.jsonl"), `${JSON.stringify(reviewerOk(hash)[0])}\n`); fs.mkdirSync(path.join(sessions, "codex", "link"), { recursive: true }); fs.rmSync(path.join(sessions, "codex", "link", "turns.jsonl"), { force: true }); fs.symlinkSync(path.join(repo, "reviews/forged/turns.jsonl"), path.join(sessions, "codex", "link", "turns.jsonl")); }, expect: "会话根目录之外" },
  { name: "RR-02 测试往目录外写文件被沙箱挡住", headFn: (dir) => ({ ...HEAD_OK, "packages/core/src/add.test.ts": T(`import fs from "node:fs";\ntest("adds", () => { try { fs.writeFileSync(${JSON.stringify(path.join(dir, "escaped.txt"))}, "x"); } catch {} assert.equal(add(1, 2), 3); });\n`, `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./add.ts";\n`) }),
    red: null, receipt: R((r) => { r.red = null; }), postCheck: (dir) => (fs.existsSync(path.join(dir, "escaped.txt")) ? "PR 测试在沙箱外写出了文件" : undefined), expect: "缺 red.commit" },
  { name: "RR-02 测试补造来源记录被挡住", headFn: (dir) => ({ ...HEAD_OK, "packages/core/src/add.test.ts": T(`import fs from "node:fs";\ntest("adds", () => { try { fs.mkdirSync(${JSON.stringify(path.join(dir, "sessions", "codex", "late"))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(path.join(dir, "sessions", "codex", "late", "turns.jsonl"))}, "{}"); } catch {} assert.equal(add(1, 2), 3); });\n`, `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./add.ts";\n`) }),
    red: null, receipt: R((r) => { r.red = null; }), postCheck: (dir) => (fs.existsSync(path.join(dir, "sessions", "codex", "late", "turns.jsonl")) ? "PR 测试写进了会话目录" : undefined), expect: "缺 red.commit" },
  { name: "RR-02 没有沙箱就停", env: { GATE_SIMULATE_NO_SANDBOX: "1" }, expect: "没有可用沙箱" },
  { name: "RR-02 CI 设了沙箱镜像时,模拟无沙箱仍然停", env: { GATE_SIMULATE_NO_SANDBOX: "1", GATE_SANDBOX_IMAGE: "node:22.22.0-slim" }, expect: "没有可用沙箱" },
  { name: "RR-05 相对路径的写操作算进产出厂商", authorRecord: { workdir: "/x/deliverables/g-group" }, authorTurns: () => [{ model: "claude-opus-5-5", toolCalls: [{ name: "Write", input: { file_path: "/x/deliverables/g-group/a.ts" } }] }, { model: "gpt-6", toolCalls: [{ name: "apply_patch", input: "*** Begin Patch\n*** Update File: packages/core/src/add.ts\n*** End Patch" }] }], expect: "在作者的产出厂商集合" },
  { name: "RR-05 判不了路径的 shell 轮次也算进去", authorTurns: () => [{ model: "claude-opus-5-5", toolCalls: [{ name: "Write", input: { file_path: "/x/g-group/a.ts" } }] }, { model: "gpt-6", toolCalls: [{ name: "shell", input: { command: "sed -i s/a/b/ src/add.ts" } }] }], expect: "在作者的产出厂商集合" },
  { name: "RR-05 工作目录在仓库外的相对写不算(阴性对照)", authorRecord: { workdir: "/x/other-project" }, authorTurns: () => [{ model: "claude-opus-5-5", toolCalls: [{ name: "Write", input: { file_path: "/x/g-group/a.ts" } }] }, { model: "gpt-6", toolCalls: [{ name: "apply_patch", input: { cwd: "/x/other-project", patch: "*** Update File: notes.md" } }] }], expect: null },
  { name: "RR-04 自比较断言", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(add(1, 2), add(1, 2)); });\n`) }, red: { ...RED_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(add(1, 2), add(1, 2)); });\n`) }, expect: "自比较或恒真" },
  { name: "RR-04 恒真关系断言", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { const v = add(1, 2); assert.ok(v === v); });\n`) }, red: { ...RED_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { const v = add(1, 2); assert.ok(v === v); });\n`) }, expect: "自比较或恒真" },
  { name: "RR-04 不可达断言", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { add(1, 2); if (false) { assert.equal(add(1, 2), 3); } });\n`) }, red: { ...RED_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { add(1, 2); if (false) { assert.equal(add(1, 2), 3); } });\n`) }, expect: "执行不到" },
  { name: "RR-04 return 之后的断言", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { add(1, 2); return; assert.equal(add(1, 2), 3); });\n`) }, red: { ...RED_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { add(1, 2); return; assert.equal(add(1, 2), 3); });\n`) }, expect: "执行不到" },
  { name: "RR-04 断言没检查返回值(返回值变异存活)", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(typeof add(1, 2), "number"); });\n`) }, red: { ...RED_OK, "packages/core/src/add.ts": "export function add(): number { throw new Error('x'); }\n", "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(typeof add(1, 2), "number"); });\n`) }, expect: "返回错误值" },
  { name: "RR-06 同名间接测试零断言", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(add(1, 2), 3); });\nconst register = test;\nregister("adds", () => { add(1, 2); });\n`) }, red: { ...RED_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(add(1, 2), 3); });\nconst register = test;\nregister("adds", () => { add(1, 2); });\n`) }, expect: "运行时注册了 2 次" },
  { name: "RR-07 红提交上是另一份假断言", red: { ...RED_OK, "packages/core/src/add.ts": ADD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(add(1, 2), -100); });\n`) }, expect: "测试体和现在不同" },
  { name: "RR-07 红提交实现已正确(现在的测试放上去不红)", red: { ...RED_OK, "packages/core/src/add.ts": ADD_OK }, expect: "放到红提交的实现上没有按名字失败" },
  { name: "RR-03 带引号的写权限", head: WF('on: pull_request\npermissions:\n  statuses: "write"\njobs: {}\n'), expect: "申请了写权限 statuses" },
  { name: "RR-03 write-all 字符串权限", head: WF("on: pull_request\npermissions: write-all\njobs: {}\n"), expect: "只允许 read-all" },
  { name: "RR-03 job 级写权限", head: WF("on: pull_request\njobs:\n  a:\n    permissions: { checks: write }\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n"), expect: "申请了写权限 checks" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这里就是要构造含 GitHub 表达式的 workflow 原文
  { name: "RR-03 job 名用表达式拼出受保护名", head: WF("on: pull_request\njobs:\n  aux:\n    name: ${{ format('pro{0}', 'venance') }}\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n"), expect: "名字含表达式" },
  { name: "RR-03 job 名用折叠标量", head: WF("on: pull_request\njobs:\n  aux:\n    name: >-\n      provenance\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n"), expect: "冒充受保护检查名 provenance" },
  { name: "RR-03 权限经锚点合并进来", head: WF("on: pull_request\nx-perm: &p\n  statuses: write\njobs:\n  a:\n    permissions:\n      <<: *p\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n"), expect: "申请了写权限 statuses" },
  { name: "RR-03 别的 workflow 冒充 self-check", head: WF("on: pull_request\njobs:\n  self-check:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n"), expect: "冒充受保护检查名 self-check" },
  { name: "RR-03 self-check.yml 自己产出 self-check(阴性对照)", head: SC(SC_WF()), expect: null },
  { name: "RR-09 门禁自检步骤加 if: false", head: SC(SC_WF(SC_STEP_SELF.replace("        run:", "        if: false\n        run:") + SC_STEP_MUT)), expect: "带了 if" },
  { name: "RR-09 变异步骤按 PR 自己的路径判定跳过", head: SC(SC_WF(SC_STEP_SELF + SC_STEP_MUT.replace("        run:", "        if: steps.x.outputs.changed == 'true'\n        run:"))), expect: "带了 if" },
  { name: "RR-09 变异步骤 continue-on-error", head: SC(SC_WF(SC_STEP_SELF + SC_STEP_MUT.replace("        run:", "        continue-on-error: true\n        run:"))), expect: "带了 continue-on-error" },
  { name: "RR-09 缺变异步骤", head: SC(SC_WF(SC_STEP_SELF)), expect: "缺必需步骤" },
  { name: "RR-09 变异命令后接 || true", head: SC(SC_WF(SC_STEP_SELF + SC_STEP_MUT.replace("gates:mutation\n", "gates:mutation || true\n"))), expect: "缺必需步骤" },
  { name: "RR-09 job 加 continue-on-error", head: SC(SC_WF(undefined, "    continue-on-error: true\n")), expect: "带了 continue-on-error" },
  { name: "RR-09 job 加 if", head: SC(SC_WF(undefined, "    if: false\n")), expect: "带了 if" },
  { name: "RR-09 self-check.yml 里没有 self-check job", head: SC(SC_WF().replace("  self-check:", "  other:")), expect: "缺 job self-check" },
  { name: "RR-09 package.json 把 gates:mutation 改成 true", head: SC(SC_WF(), ROOT_PKG({ "gates:mutation": "true" })), expect: 'scripts["gates:mutation"] 必须是' },
  { name: "RR-09 package.json 把 gates:selftest 改掉", head: SC(SC_WF(), ROOT_PKG({ "gates:selftest": "node scripts/gates/run-all.ts" })), expect: 'scripts["gates:selftest"] 必须是' },
  { name: "RR-09 规范 self-check.yml(变异命令不带并发参数)+ 规范 scripts(阴性对照)", head: SC(SC_WF(`${SC_STEP_SELF}      - run: npm run gates:mutation\n        timeout-minutes: 120\n`)), expect: null },
  { name: "RR-03 只读权限的普通 workflow(阴性对照)", head: WF("on: pull_request\npermissions:\n  contents: read\njobs:\n  lint:\n    name: lint\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n"), expect: null },
  { name: "隔离:hook 环境的 GIT_DIR 指向别的仓库,门禁不碰它", hostileGit: true, expect: null },
  { name: "RR-09 self-check.yml 只 echo", head: SC(SC_WF("      - run: echo no-checks-were-run\n")), expect: "缺必需步骤" },
  { name: "RR-09 必需步骤换 shell", head: SC(SC_WF(SC_STEP_SELF.replace("        run:", '        shell: "true {0}"\n        run:') + SC_STEP_MUT)), expect: "带了 shell" },
  { name: "RR-09 job 用 defaults 换 shell", head: SC(SC_WF(undefined, '    defaults: { run: { shell: "true {0}" } }\n')), expect: "带了 defaults" },
  { name: "RR-09 自检命令后接 || true", head: SC(SC_WF(SC_STEP_SELF.replace("gates:selftest\n", "gates:selftest || true\n") + SC_STEP_MUT)), expect: "缺必需步骤" },
  { name: "R4-01 self-check job env 设 GATE_ 开关缩小自检", head: SC(SC_WF(undefined, '    env: { GATE_SELFTEST_ONLY: "^合规" }\n')), expect: "设置了门禁开关 GATE_SELFTEST_ONLY" },
  { name: "R4-01 self-check 步骤 env 设 GATE_MUTATION_ONLY", head: SC(SC_WF(SC_STEP_SELF + SC_STEP_MUT.replace("        run:", '        env: { GATE_MUTATION_ONLY: "x" }\n        run:'))), expect: "设置了门禁开关 GATE_MUTATION_ONLY" },
  { name: "R4-01 self-check 顶层 env 设 GATE_MUTANT_TIMEOUT_MS", head: SC(`env: { GATE_MUTANT_TIMEOUT_MS: "1" }\n${SC_WF()}`), expect: "设置了门禁开关 GATE_MUTANT_TIMEOUT_MS" },
  { name: "R4-01 self-check job env 只设沙箱镜像(阴性对照)", head: SC(SC_WF(undefined, "    env: { GATE_SANDBOX_IMAGE: node:22.22.0-slim }\n")), expect: null },
  { name: "RR-09 必需步骤换 working-directory", head: SC(SC_WF(SC_STEP_SELF + SC_STEP_MUT.replace("        run:", "        working-directory: fake\n        run:"))), expect: "带了 working-directory" },
  { name: "RR-09 workflow 顶层 defaults 换 shell", head: SC(`defaults: { run: { shell: "true {0}" } }\n${SC_WF()}`), expect: "顶层带了 defaults" },
  { name: "g-group#2538 test 脚本改回裸 node --test(0 用例也判通过)", head: SC(SC_WF(), ROOT_PKG({ test: 'node --test "packages/**/*.test.ts"' })), expect: 'scripts["test"] 必须是' },
  { name: "g-group#2538 test 脚本改成 true", head: SC(SC_WF(), ROOT_PKG({ test: "true" })), expect: 'scripts["test"] 必须是' },
  { name: "g-group#2538 self-check 缺 npm test 步骤", head: SC(SC_WF(undefined, "", "")), expect: "缺必需步骤:run 为 npm test" },
  { name: "g-group#2538 测试入口 0 条用例判失败", direct: () => { const r = runTestRunner({}); return r.code === 1 && r.out.includes("跑了 0 条用例,不算通过") ? undefined : `0 条用例没有判失败(退出 ${r.code})\n${r.out}`; }, expect: "" },
  { name: "g-group#2538 测试入口 1 条通过的用例判通过(阴性对照)", direct: () => { const r = runTestRunner({ "a.test.ts": 'import { test } from "node:test";\ntest("ok", () => {});\n' }); return r.code === 0 ? undefined : `1 条通过的用例没有判通过(退出 ${r.code})\n${r.out}`; }, expect: null },
  { name: "R4-01 提示用例无关夹具故障不算发现", direct: () => notKilled(["G-TRACE"], BLOCKED(), BLOCKED({ pass: false, kind: "error", exit: null, gates: {}, expectHit: [], why: "用例自身出错:模拟与变异无关的用例准备失败" })), expect: null },
  { name: "R4-01 用例超时不算发现", direct: () => notKilled(["G-TRACE"], BLOCKED(), BLOCKED({ pass: false, kind: "timeout", exit: null, gates: {}, expectHit: [] })), expect: null },
  { name: "R4-01 用例没给出结果(缺观察)不算发现", direct: () => notKilled(["G-TRACE"], BLOCKED(), BLOCKED({ pass: false, kind: "no-result", exit: null, gates: {}, expectHit: [] })), expect: null },
  { name: "R4-01 门禁命令行崩溃不算发现", direct: () => notKilled(["G-TRACE"], BLOCKED(), BLOCKED({ pass: false, kind: "crash", exit: 134, gates: {}, expectHit: [] })), expect: null },
  { name: "R4-01 错的门禁变了不算发现目标", direct: () => notKilled(["G-RED"], BLOCKED(), BLOCKED({ pass: false, kind: "verdict", exit: 0, gates: { ...ALL_OK }, expectHit: [] })), expect: null },
  { name: "R4-01 目标门禁因自身出错拦下不算预期原因", direct: () => notKilled(["G-RED"], ALLOWED(), ALLOWED({ pass: false, kind: "verdict", exit: 1, gates: { ...ALL_OK, "G-RED": "✗" }, gateErrors: ["G-RED"] })), expect: null },
  { name: "R4-01 同一变异无故障时不算发现(对照)", direct: () => notKilled(["G-TRACE"], BLOCKED(), BLOCKED()) ?? (killedBy(["G-TRACE"], new Map([["改了代码没收据", BLOCKED()]]), [BLOCKED()]) ? "全部通过却判了发现" : undefined), expect: null },
  { name: "R4-01 目标门禁不再按预期原因拦下算发现", direct: () => { const ev = evidence(["G-TRACE"], BLOCKED(), BLOCKED({ pass: false, kind: "verdict", exit: 0, gates: { ...ALL_OK }, expectHit: [] })); return ev?.includes("G-TRACE") ? undefined : `真正的目标故障没算发现(判因 ${ev})`; }, expect: null },
  { name: "R4-01 目标门禁由放行变为拦下算发现", direct: () => { const ev = evidence(["G-RED"], ALLOWED(), ALLOWED({ pass: false, kind: "verdict", exit: 1, gates: { ...ALL_OK, "G-RED": "✗" } })); return ev?.includes("G-RED") ? undefined : `真正的目标故障没算发现(判因 ${ev})`; }, expect: null },
  { name: "R4-01 端到端:中性变异 + 提示用例夹具故障,变异校验必须判存活", direct: () => {
    // 这条用例会在副本里跑一整套变异校验,副本的自检里又有这条用例:嵌套一层后不再展开
    if (process.env.GATE_SELFTEST_NESTED === "1") return undefined;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-r401-"));
    try {
      const d = path.join(tmp, "gates");
      fs.cpSync(HERE, path.join(d, "scripts/gates"), { recursive: true, filter: (src) => !src.includes(`${path.sep}proof`) });
      fs.symlinkSync(path.resolve(HERE, "../../node_modules"), path.join(d, "node_modules"));
      fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ type: "module" }));
      const mf = path.join(d, "scripts/gates/mutation.ts");
      const ms = fs.readFileSync(mf, "utf8");
      const at = ms.indexOf("export const MUTATIONS: Mutation[] = [");
      if (at < 0) return "mutation.ts 里找不到 MUTATIONS";
      const end = ms.indexOf("\n];\n", at);
      fs.writeFileSync(mf, `${ms.slice(0, at)}export const MUTATIONS: Mutation[] = [\n  { name: "中性注释变异", kill: "改了代码没收据", target: ["G-TRACE"], file: "gates.ts", from: "// 各条机械门禁。", to: "// 各条机械门禁(注释改了)。" },\n${ms.slice(end + 1)}`);
      const st = path.join(d, "scripts/gates/selftest.ts");
      const ss = fs.readFileSync(st, "utf8");
      const hook = "function runCaseInner(tmp: string, c: Case, i: number): Run {\n";
      if (!ss.includes(hook)) return "selftest.ts 里找不到 runCaseInner";
      // 只在变异副本(注释被改过)里、只对提示用例,在准备阶段抛与变异无关的错
      fs.writeFileSync(st, ss.replace(hook, `${hook}  if (c.name === "改了代码没收据" && fs.readFileSync(path.join(HERE, "gates.ts"), "utf8").includes("注释改了")) throw new Error("模拟与变异无关的用例准备失败");\n`));
      // 外层的 GATE_*(只跑子集、目标、基线、提示)不能漏进这次内层变异校验
      const outer = Object.fromEntries(Object.entries(gitEnv()).filter(([k]) => !/^GATE_(MUTATION|SELFTEST|MUTANT|CLEAN)_/.test(k)));
      const r = spawnSync(process.execPath, [mf], { encoding: "utf8", env: { ...outer, ...{ GATE_MUTATION_JOBS: "1", GATE_SELFTEST_JOBS: "2", GATE_SELFTEST_NESTED: "1", GATE_SELFTEST_ONLY: "^(改了代码没收据|删掉源码也要收据|只改 package.json 没收据|合规:只改文档不需要收据)$" } }, timeout: 600_000 });
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      if (!out.includes("✓ 原样副本自检通过")) return `原样对照没通过,反例不成立\n${out}`;
      return r.status === 1 && /✗ 变异「中性注释变异」/.test(out) ? undefined : `中性变异在提示用例夹具故障下被判成发现(退出 ${r.status})\n${out}`;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }, expect: null },
  { name: "R4-01 提示用例无关故障后由其余用例判定", direct: () => {
    const other = BLOCKED({ name: "删掉源码也要收据" });
    const k = killedBy(["G-TRACE"], new Map([["改了代码没收据", BLOCKED()], ["删掉源码也要收据", other]]), [BLOCKED({ pass: false, kind: "error", exit: null, gates: {}, expectHit: [], why: "用例自身出错" }), { ...other, pass: false, kind: "verdict", exit: 0, gates: { ...ALL_OK }, expectHit: [] }]);
    return k?.case === "删掉源码也要收据" ? undefined : `应由后面那条真实故障判定,实际 ${JSON.stringify(k)}`; }, expect: null },
  { name: "R4-02 判定:读不到汇总行判失败", direct: () => { const why = runnerVerdict("TAP version 13\nok 1 - x\n"); return why?.includes("汇总行") ? undefined : `没有汇总行却判 ${why ?? "通过"}`; }, expect: "" },
  { name: "R4-02 测试入口全部 skip 判失败", direct: () => { const r = runTestRunner({ "a.test.ts": 'import { test } from "node:test";\ntest.skip("s", () => {});\n' }); return r.code === 1 && r.out.includes("没有实际执行") ? undefined : `全部 skip 没有按"没有实际执行"判失败(退出 ${r.code})\n${r.out}`; }, expect: "" },
  { name: "R4-02 测试入口全部 todo 判失败", direct: () => { const r = runTestRunner({ "a.test.ts": 'import { test } from "node:test";\ntest.todo("t");\n' }); return r.code === 1 && r.out.includes("没有实际执行") ? undefined : `全部 todo 没有按"没有实际执行"判失败(退出 ${r.code})\n${r.out}`; }, expect: "" },
  { name: "R4-02 测试入口 skip 与 todo 混合判失败", direct: () => { const r = runTestRunner({ "a.test.ts": 'import { test } from "node:test";\ntest.skip("s", () => {});\ntest.todo("t");\n' }); return r.code === 1 && r.out.includes("没有实际执行") ? undefined : `skip+todo 没有按"没有实际执行"判失败(退出 ${r.code})\n${r.out}`; }, expect: "" },
  { name: "R4-02 测试入口通过与 skip 混合判失败", direct: () => { const r = runTestRunner({ "a.test.ts": 'import { test } from "node:test";\ntest("ok", () => {});\ntest.skip("s", () => {});\n' }); return r.code === 1 && r.out.includes("没有实际执行") ? undefined : `通过+skip 没有按"没有实际执行"判失败(退出 ${r.code})\n${r.out}`; }, expect: "" },
  { name: "g-group#2538 测试入口有失败用例判失败", direct: () => { const r = runTestRunner({ "a.test.ts": 'import { test } from "node:test";\ntest("bad", () => { throw new Error("x"); });\n' }); return r.code !== 0 && r.code !== null ? undefined : `失败用例没有判失败(退出 ${r.code})\n${r.out}`; }, expect: "" },
  { name: "RR-10 把门禁文件改名移出受管目录(重命名检测会只报新路径)", main: { "scripts/gates/vendor.ts": "export const v = 1;\n" }, head: { "scripts/gates/vendor.ts": null, "docs/vendor.ts": "export const v = 1;\n" }, red: null, receipt: null, expect: "缺收据" },
  { name: "RR-11 helper 在红提交上给了错期望值", head: { ...HEAD_OK, "packages/core/src/add.test.ts": TEST_HELPER("./expected.ts"), "packages/core/src/expected.ts": "export const expected = 3;\n" }, red: { ...RED_OK, "packages/core/src/add.ts": ADD_OK, "packages/core/src/add.test.ts": TEST_HELPER("./expected.ts"), "packages/core/src/expected.ts": "export const expected = -100;\n" }, expect: "没有按名字失败" },
  { name: "RR-11 fixtures 下的 helper 在红提交上给了错期望值", head: { ...HEAD_OK, "packages/core/src/add.test.ts": TEST_HELPER("./fixtures/expected.ts"), "packages/core/src/fixtures/expected.ts": "export const expected = 3;\n" }, red: { ...RED_OK, "packages/core/src/add.ts": ADD_OK, "packages/core/src/add.test.ts": TEST_HELPER("./fixtures/expected.ts"), "packages/core/src/fixtures/expected.ts": "export const expected = -100;\n" }, expect: "没有按名字失败" },
  { name: "RR-11 helper 两边一致、红提交是空壳实现(阴性对照)", head: { ...HEAD_OK, "packages/core/src/add.test.ts": TEST_HELPER("./fixtures/expected.ts"), "packages/core/src/fixtures/expected.ts": "export const expected = 3;\n" }, red: { ...RED_OK, "packages/core/src/add.test.ts": TEST_HELPER("./fixtures/expected.ts"), "packages/core/src/fixtures/expected.ts": "export const expected = 3;\n" }, expect: null },
  { name: "RR-12 一条强测试 + 一条只断言 typeof", head: { ...HEAD_OK, "packages/core/src/add.ts": ADD2, "packages/core/src/add.test.ts": TEST2('assert.equal(typeof difference(9, 2), "number");') }, red: { ...RED_OK, "packages/core/src/add.ts": RED2, "packages/core/src/add.test.ts": TEST2('assert.equal(typeof difference(9, 2), "number");') }, expect: "返回错误值" },
  { name: "RR-12 两条测试都判结果(阴性对照)", head: { ...HEAD_OK, "packages/core/src/add.ts": `${ADD_OK}export function difference(a: number, b: number): number { return a - b; }\n`, "packages/core/src/add.test.ts": TEST2("assert.equal(difference(9, 2), 7);") }, red: { ...RED_OK, "packages/core/src/add.ts": RED2, "packages/core/src/add.test.ts": TEST2("assert.equal(difference(9, 2), 7);") }, expect: null },
  { name: "RR-14 printf 打印 hash、run-all 只在注释里", reviewerTurns: (h) => hashCall(`printf '%s\\n' '${h}' # node scripts/gates/run-all.ts --hash`)(h), expect: "审查会话里没有一次" },
  { name: "RR-14 node -e 打印 hash、run-all 只是多余参数", reviewerTurns: (h) => hashCall(`node -e "console.log('${h}')" scripts/gates/run-all.ts --hash`)(h), expect: "审查会话里没有一次" },
  { name: "RR-14 echo 后接真实 hash 命令", reviewerTurns: (h) => hashCall(`echo ${h} && node scripts/gates/run-all.ts --hash`)(h), expect: "审查会话里没有一次" },
  { name: "RR-14 真实 hash 输出被丢弃、再 echo hash", reviewerTurns: (h) => hashCall(`node scripts/gates/run-all.ts --hash >/dev/null; echo ${h}`)(h), expect: "审查会话里没有一次" },
  { name: "RR-14 node 先跑别的脚本、run-all 只是它的参数", reviewerTurns: hashCall("node /tmp/print-hash.mjs scripts/gates/run-all.ts --hash"), expect: "审查会话里没有一次" },
  { name: "RR-14 codex 真实形状的 hash 调用(阴性对照)", reviewerTurns: hashCall("node scripts/gates/run-all.ts --hash --branch=feat/x --base=main"), expect: null },
  { name: "RR-15 后续轮次写进同仓库的另一个 clone", authorRecord: { workdir: "/tmp" }, authorTurns: (repo) => [{ model: "claude-opus-5-5", toolCalls: [{ name: "Write", input: { file_path: "/x/g-group/a.ts" } }] }, { model: "gpt-6", toolCalls: [{ name: "Write", input: { file_path: path.join(path.dirname(repo), "other-clone", "packages/core/src/add.ts") } }] }],
    setup: ({ dir, repo }) => { sh(dir, "clone", "-q", repo, path.join(dir, "other-clone")); }, expect: "在作者的产出厂商集合" },
  { name: "RR-15 后续轮次写进无关的 git 仓库(阴性对照)", authorRecord: { workdir: "/tmp" }, authorTurns: (repo) => [{ model: "claude-opus-5-5", toolCalls: [{ name: "Write", input: { file_path: "/x/g-group/a.ts" } }] }, { model: "gpt-6", toolCalls: [{ name: "Write", input: { file_path: path.join(path.dirname(repo), "unrelated", "a.ts") } }] }],
    setup: ({ dir }) => { const u = path.join(dir, "unrelated"); fs.mkdirSync(u, { recursive: true }); sh(u, "init", "-q", "-b", "main"); write(u, { "x.txt": "x\n" }); commit(u, "x"); }, expect: null },
  { name: "审查人 codex 放行(g-group#1531 默认审查人)", receipt: R((r) => { r.review!.agent = "codex"; }), room: () => [{ v: 1, seq: 50, by: "ai-claude", name: "Claude Code", kind: "message", text: "审查", card: { type: "dispatch", session: "codex:b", assistant: "ai-codex" } }], expect: null },
  { name: "审查人 astra 放行", room: () => [{ v: 1, seq: 50, by: "ai-claude", name: "Claude Code", kind: "message", text: "审查", card: { type: "dispatch", session: "codex:b", assistant: "ai-astra" } }], expect: null },
  { name: "审查人 grok 被拦", receipt: R((r) => { r.review!.agent = "grok"; r.review!.model = "grok-4.7"; }), reviewerTurns: (h) => [{ model: "grok-4.7", toolCalls: [{ input: "node scripts/gates/run-all.ts --hash", result: h }] }], expect: "审查人必须是" },
  { name: "审查人 argon 放行(g-group#2404 临时审查人,claude 会话)", receipt: R((r) => { r.review!.agent = "argon"; r.review!.model = "gemini-4-argon"; r.review!.session = "claude:argon1"; }), reviewerTurns: (h) => [{ model: "ai-iisbo-2/[vertex]gemini-4-argon", toolCalls: [{ name: "Bash", input: { command: "node scripts/gates/run-all.ts --hash" }, result: h }] }],
    room: () => [{ v: 1, seq: 50, by: "ai-claude", name: "Claude Code", kind: "message", text: "审查", card: { type: "dispatch", session: "claude:argon1", assistant: "ai-argon" } }], expect: null },
  { name: "argon 审查照样要跨研发厂商:作者也用 Google 模型", authorTurns: () => [{ model: "gemini-4-argon", toolCalls: [{ name: "Write", input: { file_path: "/x/g-group/a.ts" } }] }], receipt: R((r) => { r.author.model = "gemini-4-argon"; r.review!.agent = "argon"; r.review!.model = "gemini-4-argon"; r.review!.session = "claude:argon1"; }), reviewerTurns: (h) => [{ model: "gemini-4-argon", toolCalls: [{ name: "Bash", input: { command: "node scripts/gates/run-all.ts --hash" }, result: h }] }], expect: "同为 google" },
  { name: "argon 审查会话必须是 claude 会话", receipt: R((r) => { r.review!.agent = "argon"; r.review!.model = "gemini-4-argon"; }), reviewerTurns: (h) => [{ model: "gemini-4-argon", toolCalls: [{ input: "node scripts/gates/run-all.ts --hash", result: h }] }], expect: "必须是 claude 会话" },
  { name: "astra 审查会话不能是 claude 会话", receipt: R((r) => { r.review!.session = "claude:astra1"; }), reviewerTurns: (h) => reviewerOk(h), expect: "必须是 codex 会话" },
  { name: "审查会话不是 codex 会话", receipt: R((r) => { r.review!.session = "pi:b"; }), reviewerTurns: (h) => reviewerOk(h), expect: "必须是 codex 会话" },
  { name: "派活卡片显示会话属于别的助手", room: () => [{ v: 1, seq: 50, by: "ai-claude", name: "Claude Code", kind: "message", text: "审查", card: { type: "dispatch", session: "codex:b", assistant: "ai-codex" } }], expect: "对不上" },
  { name: "自报 codex 但会话实际是 Anthropic 模型", receipt: R((r) => { r.review!.agent = "codex"; }), reviewerTurns: (h) => [{ model: "claude-opus-5-5", toolCalls: [{ input: "node scripts/gates/run-all.ts --hash", result: h }] }], expect: "实际是 anthropic" },
  { name: "跨厂商不变:作者用 OpenAI 模型时 Codex/Astra 审查同样被拦", authorTurns: () => [{ model: "gpt-6", toolCalls: [{ name: "Write", input: { file_path: "/x/g-group/a.ts" } }] }], receipt: R((r) => { r.author.model = "gpt-6"; }), expect: "同为 openai" },
  { name: "F-05 node:test 别名、零断言、错误实现", head: { ...HEAD_OK, "packages/core/src/add.ts": "export function add(_a: number, _b: number): number { return 999; }\n", "packages/core/src/add.test.ts": `import { test as check } from "node:test";\nimport { add } from "./add.ts";\ncheck("adds", () => { add(1, 2); });\n` }, red: { ...RED_OK, "packages/core/src/add.ts": "export function add(): number { throw new Error('x'); }\n", "packages/core/src/add.test.ts": `import { test as check } from "node:test";\nimport { add } from "./add.ts";\ncheck("adds", () => { add(1, 2); });\n` }, expect: "没有任何断言" },
  { name: "间接注册测试绕过静态识别", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`const reg = test;\nreg("hidden", () => { add(1, 2); });\ntest("adds", () => { assert.equal(add(1, 2), 3); });\n`) }, expect: "运行时注册了" },
  { name: "F-07 断言只判复制的逻辑", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { void add; const actual = 1 + 2; assert.equal(actual, 3); });\n`) }, expect: "没有一条断言判的是被测源码" },
  { name: "恒真断言", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(add(1, 2), 3); assert.equal(1, 1); });\n`) }, expect: "恒真" },
  { name: "提交了 skip 的测试", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(add(1, 2), 3); });\ntest.skip("later", () => { assert.equal(add(1, 1), 2); });\n`) }, expect: "不许提交" },
  { name: "源码里偷偷导入 node:test", head: { ...HEAD_OK, "packages/core/src/add.ts": `import "node:test";\n${ADD_OK}` }, expect: "却导入了 node:test" },

  { name: "F-06 同文件后补的测试没有红记录", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(add(1, 2), 3); });\ntest("negative", () => { assert.equal(add(-1, -2), -3); });\n`) }, expect: "negative 在红提交上不存在" },
  { name: "红提交上测试本来就绿", red: { ...RED_OK, "packages/core/src/add.ts": ADD_OK }, expect: "adds 放到红提交的实现上没有按名字失败" },
  { name: "红提交上第二条测试本来就绿", head: { ...HEAD_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(add(1, 2), 3); });\ntest("zero", () => { assert.equal(add(0, 0), 0); });\n`), "packages/core/proof/zero.txt": "zero ok\n" }, red: { ...RED_OK, "packages/core/src/add.test.ts": T(`test("adds", () => { assert.equal(add(1, 2), 3); });\ntest("zero", () => { assert.equal(add(0, 0), 0); });\n`) }, expect: "zero 放到红提交的实现上没有按名字失败" },
  { name: "红提交只是加载失败", red: { "packages/core/src/add.test.ts": TEST_OK }, expect: "adds 放到红提交的实现上没有按名字失败" },
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

/**
 * 有界并发(GATE_SELFTEST_JOBS,默认 min(4, CPU 数)):每个用例在自己的子进程、自己的临时目录里跑,
 * 结果按用例顺序输出。GATE_SELFTEST_FAILFAST=1 时出现失败就不再启动新用例。
 */
const WORKER_TIMEOUT_MS = 900_000;
function runCaseInWorker(i: number): Promise<Run & { secs: number }> {
  const c0 = CASES[i]!;
  const t0 = Date.now();
  return timed(t0, new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(HERE, "selftest.ts"), "--case", String(i)], { env: gitEnv() });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; c.kill("SIGKILL"); }, WORKER_TIMEOUT_MS);
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => {
      clearTimeout(timer);
      const line = out.split("\n").reverse().find((l) => l.startsWith(RESULT_MARK));
      if (timedOut) return resolve(mk(c0, { pass: false, kind: "timeout", why: `用例超时(${WORKER_TIMEOUT_MS / 1000}s)`, detail: out }));
      if (!line) return resolve(mk(c0, { pass: false, kind: "no-result", why: `用例子进程没有给出结果(退出 ${code})`, detail: out }));
      resolve(JSON.parse(line.slice(RESULT_MARK.length)) as Run);
    });
  }));
}
const timed = (t0: number, p: Promise<Run>) => p.then((r) => ({ ...r, secs: Math.round((Date.now() - t0) / 1000) }));
const RESULT_MARK = "__GATE_SELFTEST_RESULT__";

export async function selfTest(only?: (c: Case) => boolean): Promise<boolean> {
  const t0 = Date.now();
  let ok = true;
  const failFast = process.env.GATE_SELFTEST_FAILFAST === "1";
  // GATE_SELFTEST_ONLY=<正则>:只跑名字匹配的用例(本机诊断与端到端夹具用;self-check 里设它会被 G-WORKFLOW 拦下)
  const onlyRe = process.env.GATE_SELFTEST_ONLY ? new RegExp(process.env.GATE_SELFTEST_ONLY) : undefined;
  const idx = CASES.map((c, i) => [c, i] as const).filter(([c]) => (!only || only(c)) && (!onlyRe || onlyRe.test(c.name))).map(([, i]) => i);
  // GATE_SELFTEST_FIRST=<用例名>:先跑这一条,其余照原顺序随后全跑。只改顺序,不跳过任何用例。
  const first = process.env.GATE_SELFTEST_FIRST;
  if (first) {
    const fi = CASES.findIndex((c) => c.name === first);
    if (fi < 0) { console.log(`✗ GATE_SELFTEST_FIRST 指向不存在的用例「${first}」`); console.log("自检失败"); return false; }
    const at = idx.indexOf(fi);
    if (at > 0) { idx.splice(at, 1); idx.unshift(fi); }
  }
  const width = Math.max(1, Math.min(Number(process.env.GATE_SELFTEST_JOBS ?? Math.min(4, os.availableParallelism())), idx.length || 1));
  const results: ((Run & { secs: number }) | undefined)[] = new Array(CASES.length);
  // 变异校验传入目标与原样基线:FAILFAST 只在出现"目标判因"时停;执行故障、非目标原因的失败继续往下跑
  const target = process.env.GATE_SELFTEST_TARGET?.split(",").filter(Boolean);
  const baseline = process.env.GATE_SELFTEST_BASELINE ? new Map((JSON.parse(fs.readFileSync(process.env.GATE_SELFTEST_BASELINE, "utf8")) as CaseResult[]).map((r) => [r.name, r])) : undefined;
  const stopOn = (r: Run) => failFast && (target && baseline ? evidence(target, baseline.get(r.name), r) !== undefined : !r.pass);
  let stop = false;
  let next = 0;
  let printed = 0;
  const printOne = (i: number) => {
    const c = CASES[i]!, r = results[i]!, { detail, secs, ...cr } = r;
    console.log(`${r.pass ? "✓" : "✗"} ${c.expect === null ? "放行" : "拦下"}:${c.name} (${secs}s)`);
    console.log(CASE_MARK + JSON.stringify(cr));
    if (r.pass) return;
    const ev = target && baseline ? evidence(target, baseline.get(r.name), r) : undefined;
    // FAILFAST 也留判因证据:失败类型、原因、门禁结论;全量模式打印完整输出
    console.log(`      | 失败类型 ${r.kind}${r.why ? `:${r.why.split("\n")[0]}` : ""}${ev ? `;目标判因:${ev}` : target ? ";不是目标判因" : ""}`);
    const lines = detail.split("\n");
    console.log((failFast ? lines.filter((l) => /^(✓|✗) G-|^ {4}- |Error|出错/.test(l)).slice(0, 12) : lines).map((l) => `      | ${l}`).join("\n"));
  };
  const flush = () => { while (printed < idx.length && results[idx[printed]!]) printOne(idx[printed++]!); };
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < idx.length && !stop) {
      const i = idx[next++]!;
      const r = await runCaseInWorker(i);
      results[i] = r;
      if (!r.pass) ok = false;
      if (stopOn(r)) stop = true;
      flush();
    }
  }));
  // FAILFAST 下没启动的用例不打印;已跑完的按顺序补齐
  for (const i of idx) if (results[i] && idx.indexOf(i) >= printed) printOne(i);
  for (const [m, v] of [["o1", "openai"], ["gpt-6-astra", "openai"], ["ai-iisbo/[乾坤按量]gpt-6-astra", "openai"], ["claude-opus-5-5", "anthropic"], ["grok-4.7", "xai"], ["gemini-4-argon", "google"], ["stealth/crouton-alpha", "unknown"], [undefined, "unknown"]] as const) {
    const pass = vendorOf(m) === v;
    if (!pass) ok = false;
    console.log(`${pass ? "✓" : "✗"} vendorOf(${m}) = ${vendorOf(m)}`);
  }
  const ran = idx.filter((i) => results[i]).length;
  console.log(ok ? "自检通过" : "自检失败");
  console.log(`自检耗时 ${Math.round((Date.now() - t0) / 1000)}s:用例 ${ran}/${idx.length},并发 ${width}(GATE_SELFTEST_JOBS),CPU ${os.availableParallelism()},node ${process.version}`);
  return ok;
}

// 子进程入口:只跑一个用例,把结果作为一行 JSON 打出来
if (import.meta.main) {
  const k = process.argv.indexOf("--case");
  const i = k >= 0 ? Number(process.argv[k + 1]) : Number.NaN;
  const c = CASES[i];
  if (!c) { console.log(`未知用例 ${process.argv[k + 1]}`); process.exit(2); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-selftest-"));
  let r: Run;
  try { r = runCase(tmp, c, i); } catch (e) { r = mk(c, { pass: false, kind: "error", why: `用例自身出错:${(e as Error).message}`, detail: `用例自身出错:${(e as Error).stack ?? e}` }); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(RESULT_MARK + JSON.stringify(r));
  process.exit(0);
}
