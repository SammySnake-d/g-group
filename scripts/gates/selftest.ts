// 门禁自检(R-05 双侧标定 / R-18 规则自身可信):
// 每个样例都是一个真实 git 仓库(main → 红提交 → 绿提交 → 收据),用子进程调用真实命令行入口 run-all.ts,
// 只看退出码和输出。合规样例必须放行,违规样例必须拦下且原因文字对。
// 跑的是 import.meta.dirname 下的那份门禁代码,所以 mutation.ts 改坏一份副本后跑它的自检,必须失败。
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GIT_SAFE_ARGS, gitEnv, type Receipt, sandboxPlan } from "./lib.ts";
import * as judge from "./judge.ts";
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
  redFn?: (dir: string) => Files; // 需要知道样例目录的红提交内容(优先于 red)
  env?: Record<string, string>;
  envFn?: (dir: string) => Record<string, string>; // 需要知道样例目录的环境(合并在 env 之后)
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
  return { name: c.name, direct: !!c.direct, expect: c.expect, exit: null, gates: {}, expectHit: [], gateErrors: [], complete: false, ...o };
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
  const red = c.redFn ? c.redFn(dir) : c.red === undefined ? RED_OK : c.red;
  if (red) { write(repo, red); redSha = commit(repo, "red"); }
  write(repo, c.headFn ? c.headFn(dir) : (c.head ?? HEAD_OK));
  commit(repo, "green");
  fs.mkdirSync(sessions, { recursive: true });
  const env = { MIRASIM_SESSIONS: sessions, MIRASIM_ROOMS: rooms, GATE_OWNER_UID: OWNER_UID, GATE_OWNER_NAME: OWNER_NAME, ...c.env, ...c.envFn?.(dir) };
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
  const seen = { exit: res.code, gates: g.gates, expectHit: g.expectHit, gateErrors: g.gateErrors, complete: g.complete };
  if (!g.header || (res.code !== 0 && res.code !== 1)) return mk(c, { ...seen, pass: false, kind: "crash", why: `门禁命令行没有正常跑完(退出 ${res.code})`, detail: res.out });
  const side = c.postCheck?.(dir);
  if (side) return mk(c, { ...seen, pass: false, kind: "side", why: side, detail: `${side}\n${res.out}` });
  const pass = c.expect === null
    ? res.code === 0 && (c.local === false ? GATE_IDS.slice(0, -1) : GATE_IDS).every((id) => res.out.includes(`✓ ${id} `))
    : res.code === 1 && res.out.includes(c.expect);
  return mk(c, { ...seen, pass, kind: pass ? "ok" : "verdict", detail: res.out, ...(pass ? {} : { why: c.expect === null ? "该放行的没放行" : `没有按「${c.expect}」拦下` }) });
}

const R = (f: (r: Receipt) => void) => f;
// 原则 68:作者是 Codex(OpenAI 模型、codex 会话);审查人是 Claude(Anthropic 模型、claude 会话)
const CODEX_AUTHOR = (r: Receipt) => { r.author = { agent: "codex", session: "codex:a", model: "gpt-6" }; };
const CODEX_AUTHOR_TURNS = (_repo: string) => [{ model: "ai-x/gpt-6", toolCalls: [{ name: "apply_patch", input: { path: "/x/deliverables/g-group/packages/core/src/add.ts" } }] }];
const CLAUDE_REVIEW = (r: Receipt) => { r.review = { ...r.review!, agent: "claude", model: "claude-opus-5-5", session: "claude:rv1" }; };
// g-group#3199:Argon 是 Google 模型、跑在 claude 会话里,派活卡片上的助手是 ai-argon
const ARGON_REVIEW = (r: Receipt) => { r.review = { ...r.review!, agent: "argon", model: "gemini-4-argon", session: "claude:argon1" }; };
const argonReviewTurns = (h: string) => [{ model: "ai-iisbo-2/[vertex]gemini-4-argon", toolCalls: [{ name: "Bash", input: { command: "node scripts/gates/run-all.ts --hash --branch=feat/x --base=main" }, result: h }] }];
const ARGON_ROOM = () => [{ v: 1, seq: 50, by: "ai-claude", name: "Claude Code", kind: "message", text: "审查", card: { type: "dispatch", session: "claude:argon1", assistant: "ai-argon" } }];
const claudeReviewTurns = (h: string) => [{ model: "ai-x/claude-opus-5-5", toolCalls: [{ name: "Bash", input: { command: "node scripts/gates/run-all.ts --hash --branch=feat/x --base=main" }, result: h }] }];
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
const BLOCKED = (o: Partial<CaseResult> = {}): CaseResult => ({ name: "改了代码没收据", pass: true, kind: "ok", direct: false, expect: "缺收据", exit: 1, gates: { ...ALL_OK, "G-TRACE": "✗" }, expectHit: ["G-TRACE"], gateErrors: [], complete: true, ...o });
const ALLOWED = (o: Partial<CaseResult> = {}): CaseResult => ({ name: "合规:先红后绿、跨厂商审查、来源核对通过", pass: true, kind: "ok", direct: false, expect: null, exit: 0, gates: { ...ALL_OK }, expectHit: [], gateErrors: [], complete: true, ...o });
const notKilled = (target: string[], base: CaseResult, mut: CaseResult) => { const ev = evidence(target, base, mut); return ev === undefined ? undefined : `不该算发现,却给出判因:${ev}`; };
// R5-02:外部结构化结果的陷阱对象;计数器记录 getter/setter/Proxy 回调次数
function traps() {
  let calls = 0;
  const getterObj = BLOCKED({ pass: false, kind: "verdict", exit: 0, gates: { ...ALL_OK }, expectHit: [] }) as unknown as Record<string, unknown>;
  Object.defineProperty(getterObj, "pass", { get: () => { calls++; return false; }, enumerable: true });
  const setterObj = { ...BLOCKED({ pass: false, kind: "verdict", exit: 0, gates: { ...ALL_OK }, expectHit: [] }) } as unknown as Record<string, unknown>;
  Object.defineProperty(setterObj, "why", { set: () => { calls++; }, enumerable: true });
  const proxyObj = new Proxy(BLOCKED({ pass: false, kind: "verdict", exit: 0, gates: { ...ALL_OK }, expectHit: [] }), { get: (t, k) => { calls++; return Reflect.get(t, k); }, ownKeys: (t) => { calls++; return Reflect.ownKeys(t); }, getOwnPropertyDescriptor: (t, k) => { calls++; return Reflect.getOwnPropertyDescriptor(t, k); }, has: (t, k) => { calls++; return Reflect.has(t, k); }, getPrototypeOf: (t) => { calls++; return Reflect.getPrototypeOf(t); } });
  const nestedGetter = BLOCKED({ pass: false, kind: "verdict", exit: 0, expectHit: [] }) as unknown as Record<string, unknown>;
  nestedGetter.gates = Object.defineProperty({}, "G-TRACE", { get: () => { calls++; return "✓"; }, enumerable: true });
  return { calls: () => calls, list: { getterObj, setterObj, proxyObj, nestedGetter } as Record<string, unknown> };
}
// 对外部结构化结果跑完整消费路径(evidence 当作变异结果、当作基线、killedBy),不得抛错、不得回调、不得给出判因
function rejects(bad: unknown): string | undefined {
  const asCase = bad as CaseResult;
  try {
    const a = evidence(["G-TRACE"], BLOCKED(), asCase);
    const b = evidence(["G-TRACE"], asCase, BLOCKED({ pass: false, kind: "verdict", exit: 0, gates: { ...ALL_OK }, expectHit: [] }));
    const c = killedBy(["G-TRACE"], new Map([["改了代码没收据", BLOCKED()]]), [asCase]);
    if (a !== undefined || b !== undefined || c !== undefined) return `非法结果被当成证据:${JSON.stringify([a, b, c])}`;
  } catch (e) { return `消费非法结果时抛错:${(e as Error).message}`; }
  return undefined;
}
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

// R7-01:沙箱读隔离按实际 HOME 与规范化路径核对。只用假 HOME 和中性内容的假文件,不碰真实账户文件。
const NEUTRAL = "NEUTRAL_FIXTURE_NO_CREDENTIALS";
// 前五项是已知位置;后两项是不在任何固定清单里的点文件位置,用来核对"HOME 下点文件默认拒读"本身生效
const R7_KNOWN = 5;
const R7_DENY = [".git-credentials", ".netrc", ".ssh/key-fixture", ".mirasim/sessions/fixture", ".config/gh/hosts.yml", ".docker/config.json", ".config/fixture-tool/token"];
const R7_DEP: Files = { "fixture-dep/package.json": JSON.stringify({ name: "fixture-dep", type: "module", main: "index.js" }), "fixture-dep/index.js": `export const v = ${JSON.stringify(NEUTRAL)};\n` };
/**
 * 假 HOME 是指向真目录的符号链接,真目录在 TMPDIR 下(macOS 上 /var → /private/var),同一个文件按三种写法各读一次:
 * 链接路径、未规范化的真目录路径、realpath。node 可执行文件和依赖放进 HOME 的点目录(和本机一样:node 在 ~/.nvm、
 * 仓库依赖在 ~/.mirasim/.../node_modules),用这份 node 调真实的 sandboxed;窄挂载只挂依赖,宽挂载挂到会话目录的上级,
 * 整个 HOME 挂载时已知位置的固定清单仍须生效(显式挂载盖过点文件默认拒读)。
 * 期望:拒读项(已知位置与未列出的点文件位置)每一项每种写法都 EPERM;工作副本文件、依赖文件可读,依赖能 import;沙箱进程退出 0。
 * docker 模式(GATE_SANDBOX_IMAGE)下假 HOME 不挂进容器,拒读项读不到即可(错误码不限),放行项只认真实路径;宽挂载只在 seatbelt 下核对。
 */
function sandboxReadProbe(): string | undefined {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-r701-"));
  try {
    const docker = !!process.env.GATE_SANDBOX_IMAGE;
    const real = path.join(tmp, "home-real"), link = path.join(tmp, "home-link"), work = path.join(tmp, "work");
    const nm = path.join(real, ".mirasim", "repo", "node_modules");
    write(real, Object.fromEntries(R7_DENY.map((f) => [f, NEUTRAL])));
    write(nm, R7_DEP);
    write(work, { "own.txt": NEUTRAL });
    fs.symlinkSync(real, link);
    let node = process.execPath;
    if (!docker) {
      node = path.join(real, ".nvm", "bin", "node");
      fs.mkdirSync(path.dirname(node), { recursive: true });
      fs.copyFileSync(process.execPath, node, fs.constants.COPYFILE_FICLONE);
      fs.chmodSync(node, 0o755);
    }
    const forms = (rel: string) => (docker ? [path.join(fs.realpathSync(real), rel)] : [path.join(link, rel), path.join(real, rel), path.join(fs.realpathSync(real), rel)]);
    const deny = R7_DENY.flatMap(forms);
    const dep = path.join(".mirasim", "repo", "node_modules", "fixture-dep", "index.js");
    const allow = [path.join(fs.realpathSync(work), "own.txt"), ...forms(dep)];
    const reader = `import fs from "node:fs";
const ps = JSON.parse(process.argv[1]);
const out = {};
for (const p of ps) { try { out[p] = fs.readFileSync(p, "utf8").includes(${JSON.stringify(NEUTRAL)}) ? "ok" : "wrong"; } catch (e) { out[p] = e.code ?? String(e); } }
try { const m = await import(${JSON.stringify(new URL(`file://${path.join(fs.realpathSync(real), dep)}`).href)}); out.import = m.v === ${JSON.stringify(NEUTRAL)} ? "ok" : "wrong"; } catch (e) { out.import = e.code ?? String(e); }
console.log(JSON.stringify(out));`;
    // 宽挂载:挂到会话目录的上级;整个 HOME 挂载:点文件默认拒读被放行盖过时,拒读清单本身仍须生效
    const probes: [string, string[]][] = [["窄挂载", [nm]], ...(docker ? [] : [["宽挂载", [path.join(real, ".mirasim")]], ["整个 HOME 挂载", [real]]] as [string, string[]][])];
    const driver = `const { sandboxed } = await import(${JSON.stringify(new URL(`file://${path.join(HERE, "lib.ts")}`).href)});
const out = {};
for (const [k, mounts] of ${JSON.stringify(probes)}) { const r = sandboxed(["--input-type=module", "-e", ${JSON.stringify(reader)}, ${JSON.stringify(JSON.stringify([...deny, ...allow]))}], ${JSON.stringify(work)}, mounts); out[k] = { status: r.status, stdout: r.stdout, stderr: r.stderr }; }
console.log(JSON.stringify(out));`;
    const r = spawnSync(node, ["--input-type=module", "-e", driver], { encoding: "utf8", timeout: 120_000, env: { ...gitEnv(), PATH: `${path.dirname(node)}:/usr/bin:/bin`, HOME: link } });
    const line = (r.stdout ?? "").trim().split("\n").pop() ?? "";
    let res: Record<string, { status: number | null; stdout: string; stderr: string }>;
    try { res = JSON.parse(line); } catch { return `探针没有给出结果(退出 ${r.status}):${(r.stdout ?? "").slice(-300)}${(r.stderr ?? "").slice(-300)}`; }
    const bad: string[] = [];
    for (const [k] of probes) {
      const x = res[k];
      if (x?.status !== 0) { bad.push(`${k}:沙箱进程退出 ${x?.status}:${(x?.stderr ?? "").split("\n").find((l) => l.trim()) ?? ""}`); continue; }
      let got: Record<string, string>;
      try { got = JSON.parse(x.stdout.trim().split("\n").pop() ?? ""); } catch { bad.push(`${k}:读取结果不是 JSON:${x.stdout.slice(-200)}`); continue; }
      // 整个 HOME 都被显式挂载时放行项盖过点文件默认拒读,只核对已知位置的固定清单仍生效
      const want = k === "整个 HOME 挂载" ? R7_DENY.slice(0, R7_KNOWN).flatMap(forms) : deny;
      for (const f of want) if (docker ? got[f] === "ok" || got[f] === undefined : got[f] !== "EPERM") bad.push(`${k}:${f} 应拒读(EPERM),实际 ${got[f]}`);
      for (const f of [...allow, "import"]) if (got[f] !== "ok") bad.push(`${k}:${f} 应可读,实际 ${got[f]}`);
    }
    return bad.length ? bad.join("\n") : undefined;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
/**
 * R7-01 跨平台核对 seatbelt 规则:CI 在 Linux 上走 docker,seatbelt 规则在那里不执行,上面的探针只能在 macOS 上发现规则被改坏。
 * 这里不调 sandbox-exec,直接核对 sandboxPlan 按 seatbelt 生成的规则文本,任何平台都能跑。只用假 HOME 与中性内容的假文件。
 * 假 HOME 是指向真目录的符号链接,规则须同时按原样路径和 realpath 写出。期望:
 *  1. HOME 下点文件默认拒读(原样与 realpath 各一条正则);
 *  2. 其后放行这次的工作副本与挂载的依赖(realpath);
 *  3. 最后一条是固定拒读清单,排在放行之后,已知位置按原样与 realpath 都在。
 */
function seatbeltPlanCheck(): string | undefined {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-r701p-"));
  const saved = { h: process.env.HOME, s: process.env.MIRASIM_SESSIONS, r: process.env.MIRASIM_ROOMS };
  try {
    const real = path.join(tmp, "home-real"), link = path.join(tmp, "home-link"), work = path.join(tmp, "work"), dep = path.join(tmp, "deps", "node_modules");
    const listed = R7_DENY.slice(0, 3);
    write(real, Object.fromEntries(listed.map((f) => [f, NEUTRAL])));
    write(work, { "own.txt": NEUTRAL });
    write(dep, R7_DEP);
    fs.symlinkSync(real, link);
    process.env.HOME = link;
    delete process.env.MIRASIM_SESSIONS;
    delete process.env.MIRASIM_ROOMS;
    const plan = sandboxPlan(["-e", "0"], work, [dep], "seatbelt");
    const rw = fs.realpathSync(work), rh = fs.realpathSync(real), rd = fs.realpathSync(dep);
    const lines = (plan.profile ?? "").split("\n");
    const bad: string[] = [];
    if (plan.cmd !== "/usr/bin/sandbox-exec" || plan.argv[0] !== "-f" || plan.argv[1] !== plan.profilePath || plan.profilePath !== path.join(rw, ".gate-sandbox.sb")) bad.push(`执行计划不是 sandbox-exec -f <副本里的规则文件>:${JSON.stringify([plan.cmd, ...plan.argv.slice(0, 2)])}`);
    const rx = (h: string) => `(regex #"^${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.")`;
    const sub = (d: string) => `(subpath "${d}")`;
    const dot = lines.findIndex((l) => l.startsWith("(deny file-read-data (regex"));
    const allow = lines.findIndex((l) => l.startsWith("(allow file-read-data"));
    const last = lines.length - 1;
    if (dot < 0) bad.push("没有 HOME 点文件默认拒读规则");
    else for (const h of [link, rh]) if (!lines[dot]!.includes(rx(h))) bad.push(`点文件默认拒读缺 ${h}`);
    if (allow < 0) bad.push("没有放行规则");
    else {
      if (allow < dot) bad.push("放行规则排在点文件拒读之前");
      for (const d of [rw, rd]) if (!lines[allow]!.includes(sub(d))) bad.push(`放行规则缺 ${d}`);
    }
    if (!lines[last]?.startsWith("(deny file-read-data (subpath") || last <= allow) bad.push(`最后一条不是排在放行之后的固定拒读清单:${lines[last]}`);
    else for (const f of listed) for (const h of [link, rh]) { const d = path.join(h, f.split("/")[0]!); if (!lines[last]!.includes(sub(d))) bad.push(`固定拒读清单缺 ${d}`); }
    return bad.length ? bad.join("\n") : undefined;
  } finally {
    for (const [k, v] of [["HOME", saved.h], ["MIRASIM_SESSIONS", saved.s], ["MIRASIM_ROOMS", saved.r]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
// 完整入口:假 HOME 在样例目录下(TMPDIR 里,macOS 上未规范化的 /var 路径),门禁命令行就用这个 HOME
const R7_HOME = (dir: string) => path.join(dir, "home");
const R7_READ_TEST = (dir: string) => T(`test("adds", () => { const a = fs.readFileSync(${JSON.stringify(path.join(R7_HOME(dir), ".git-credentials"))}, "utf8"); const b = fs.readFileSync(${JSON.stringify(path.join(R7_HOME(dir), ".netrc"))}, "utf8"); console.log(a.length + b.length); assert.equal(add(1, 2), 3); });\n`, `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport fs from "node:fs";\nimport { add } from "./add.ts";\n`);
const R7_OK_TEST = T(`test("adds", () => { const own = fs.readFileSync(new URL("./fixture.txt", import.meta.url), "utf8"); console.log(own.length + v.length); assert.equal(add(1, 2), 3); });\n`, `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport fs from "node:fs";\nimport { v } from "fixture-dep";\nimport { add } from "./add.ts";\n`);
const R7_SETUP = ({ dir, repo }: { dir: string; repo: string }) => {
  write(R7_HOME(dir), Object.fromEntries(R7_DENY.map((f) => [f, NEUTRAL])));
  const nm = path.join(R7_HOME(dir), ".mirasim", "deps", "node_modules");
  write(nm, R7_DEP);
  fs.symlinkSync(nm, path.join(repo, "node_modules"));
};

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
  { name: "R7-01 沙箱按实际 HOME 拒读 .git-credentials/.netrc 与未列出的点文件,.ssh/会话/gh 拒读不回退;工作副本与 HOME 点目录里的 node 和依赖可读(符号链接 HOME、/private/var 规范化路径、宽挂载与整个 HOME 挂载)", direct: sandboxReadProbe, expect: null },
  { name: "R7-01 seatbelt 读隔离规则跨平台核对:点文件默认拒读、放行副本与挂载、末尾固定拒读清单(原样与 realpath)", direct: seatbeltPlanCheck, expect: null },
  { name: "R7-01 完整入口:具名测试读假 HOME 的 .git-credentials/.netrc 被拒,门禁拦下", main: { ".gitignore": "node_modules\n" }, headFn: (dir) => ({ ...HEAD_OK, "packages/core/src/add.test.ts": R7_READ_TEST(dir) }), redFn: (dir) => ({ ...RED_OK, "packages/core/src/add.test.ts": R7_READ_TEST(dir) }), envFn: (dir) => ({ HOME: R7_HOME(dir) }), setup: R7_SETUP, expect: "现在没有恰好通过一次" },
  { name: "R7-01 完整入口对照:同一假 HOME 下,测试读工作副本文件、加载 HOME 点目录里的依赖照常放行", main: { ".gitignore": "node_modules\n" }, head: { ...HEAD_OK, "packages/core/src/add.test.ts": R7_OK_TEST, "packages/core/src/fixture.txt": NEUTRAL }, red: { ...RED_OK, "packages/core/src/add.test.ts": R7_OK_TEST, "packages/core/src/fixture.txt": NEUTRAL }, envFn: (dir) => ({ HOME: R7_HOME(dir) }), setup: R7_SETUP, expect: null },
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
  { name: "R5-01 目标门禁由预期拦下变为门禁自身出错不算发现", direct: () => notKilled(["G-TRACE"], BLOCKED(), BLOCKED({ pass: false, kind: "verdict", exit: 1, gates: { ...ALL_OK, "G-TRACE": "✗" }, expectHit: [], gateErrors: ["G-TRACE"] })), expect: null },
  { name: "R5-01 目标门禁没跑(观测缺失)不算发现", direct: () => (() => { const { "G-TRACE": _t, ...rest } = ALL_OK; return notKilled(["G-TRACE"], BLOCKED(), BLOCKED({ pass: false, kind: "verdict", exit: 0, gates: rest, expectHit: [], complete: false })); })(), expect: null },
  { name: "R5-01 目标门禁从完整运行的执行列表里消失算发现", direct: () => { const { "G-TRACE": _t, ...rest } = ALL_OK; const ev = evidence(["G-TRACE"], BLOCKED(), BLOCKED({ pass: false, kind: "verdict", exit: 0, gates: rest, expectHit: [], complete: true })); return ev?.includes("没有运行") ? undefined : `门禁被移出执行列表却没算发现(判因 ${ev})`; }, expect: null },
  { name: "R4-01 门禁输出解析:注册数与列出数一致且有 CONTENT_HASH 才算完整", direct: () => {
    const h = "base=main branch=x HEAD=y 受检文件 1 个 收据=无 门禁 2 个\n";
    const full = parseGateOutput(`${h}✓ G-TRACE  r\n✗ G-RED  r\n    - 缺收据\nCONTENT_HASH=${"a".repeat(64)}\n`, "缺收据");
    const cut = parseGateOutput(`${h}✓ G-TRACE  r\n`, "缺收据");
    return full.complete && !cut.complete && full.expectHit.join() === "G-RED" ? undefined : `解析不对:${JSON.stringify({ full, cut })}`; }, expect: null },
  { name: "R5-01 基线就是按预期以门禁自身出错拦下(fail-closed)、变异后放行算发现", direct: () => (evidence(["G-RED"], BLOCKED({ name: "RR-02 没有沙箱就停", expect: "没有可用沙箱", gates: { ...ALL_OK, "G-RED": "✗" }, expectHit: ["G-RED"], gateErrors: ["G-RED"] }), BLOCKED({ name: "RR-02 没有沙箱就停", expect: "没有可用沙箱", pass: false, kind: "verdict", exit: 0, gates: { ...ALL_OK }, expectHit: [], gateErrors: [] })) ? undefined : "预期的 fail-closed 拦下变成放行却没算发现"), expect: null },
  { name: "R5-01 目标门禁真实放行算发现(对照)", direct: () => (evidence(["G-TRACE"], BLOCKED(), BLOCKED({ pass: false, kind: "verdict", exit: 0, gates: { ...ALL_OK }, expectHit: [] })) ? undefined : "真实放行没算发现"), expect: null },
  { name: "R5-01 目标门禁真实拒绝算发现(对照)", direct: () => (evidence(["G-RED"], ALLOWED(), ALLOWED({ pass: false, kind: "verdict", exit: 1, gates: { ...ALL_OK, "G-RED": "✗" } })) ? undefined : "真实拒绝没算发现"), expect: null },
  { name: "R5-01 命令行与夹具异常不算发现(对照)", direct: () => notKilled(["G-TRACE"], BLOCKED(), BLOCKED({ pass: false, kind: "crash", exit: 2, gates: {}, expectHit: [] })) ?? notKilled(["G-TRACE"], BLOCKED(), BLOCKED({ pass: false, kind: "error", exit: null, gates: {}, expectHit: [] })), expect: null },
  { name: "R5-01 结构化判因与退出码不一致不算发现", direct: () => notKilled(["G-TRACE"], BLOCKED(), BLOCKED({ pass: false, kind: "verdict", exit: 1, gates: { ...ALL_OK }, expectHit: [] })), expect: null },
  { name: "R5-02 parseCases 遇到 null/数组/缺字段/错类型/非法枚举不抛错且全部拒收", direct: () => {
    const lines = ["null", "[]", "1", '"x"', '{"name":"a"}', JSON.stringify({ ...BLOCKED(), pass: "yes" }), JSON.stringify({ ...BLOCKED(), kind: "maybe" }), JSON.stringify({ ...BLOCKED(), gates: { "G-TRACE": "?" } }), JSON.stringify({ ...BLOCKED(), expectHit: "G-TRACE" }), JSON.stringify({ ...BLOCKED(), exit: "1" })].map((l) => CASE_MARK + l).join("\n");
    try { const r = judge.parseCases(lines); if (r.length !== 0) return `非法行被收下 ${r.length} 条:${JSON.stringify(r).slice(0, 200)}`; } catch (e) { return `parseCases 抛错:${(e as Error).message}`; }
    try { if (killedBy(["G-TRACE"], new Map([["改了代码没收据", BLOCKED()]]), judge.parseCases(lines)) !== undefined) return "非法行被当成证据"; } catch (e) { return `完整路径抛错:${(e as Error).message}`; }
    return undefined; }, expect: null },
  { name: "R5-02 parseCases 收下合法行(对照)", direct: () => { const r = judge.parseCases(CASE_MARK + JSON.stringify(BLOCKED())); return r.length === 1 && r[0]!.name === "改了代码没收据" ? undefined : `合法行没收下:${JSON.stringify(r)}`; }, expect: null },
  { name: "R5-02 evidence/killedBy 遇到 null、数组、缺字段、非法枚举不抛错且不给判因", direct: () => {
    for (const bad of [null, [], 1, {}, { ...BLOCKED(), expectHit: undefined }, { ...BLOCKED(), pass: false, kind: "maybe", exit: 0, gates: { ...ALL_OK }, expectHit: [] }, { ...BLOCKED(), pass: false, kind: "verdict", exit: 0, gates: { "G-TRACE": "?" }, expectHit: [] }]) { const why = rejects(bad); if (why) return `${JSON.stringify(bad)}:${why}`; }
    return undefined; }, expect: null },
  { name: "R5-02 getter/setter/Proxy 回调 0 次且被拒收", direct: () => {
    const t = traps();
    for (const [k, v] of Object.entries(t.list)) { const why = rejects(v); if (why) return `${k}:${why}`; }
    return t.calls() === 0 ? undefined : `外部对象的 getter/setter/Proxy 被回调了 ${t.calls()} 次`; }, expect: null },
  { name: "R6-01 目标门禁仍在但变异侧输出不完整(缺 CONTENT_HASH/少列表项/截断)不算发现", direct: () => {
    // 同输入双侧:complete 只差这一位;不完整的变异观测一律先排除,不论目标门禁是否还在、结论怎么变
    const variants: [string, CaseResult, CaseResult][] = [
      ["预期拦下→放行", BLOCKED(), BLOCKED({ pass: false, kind: "verdict", exit: 0, gates: { ...ALL_OK }, expectHit: [], complete: false })],
      ["预期拦下→放行(其他门禁仍拦,退出 1)", BLOCKED(), BLOCKED({ pass: false, kind: "verdict", exit: 1, gates: { ...ALL_OK, "G-RED": "✗" }, expectHit: [], complete: false })],
      ["仍拦下但原因变了", BLOCKED(), BLOCKED({ pass: false, kind: "verdict", exit: 1, expectHit: [], complete: false })],
      ["放行→拦下", ALLOWED(), ALLOWED({ pass: false, kind: "verdict", exit: 1, gates: { ...ALL_OK, "G-TRACE": "✗" }, complete: false })],
    ];
    for (const [k, base, mut] of variants) { const why = notKilled(["G-TRACE"], base, mut); if (why) return `${k}:${why}`; }
    return undefined; }, expect: null },
  { name: "R6-01 同输入输出完整时目标变化仍算发现(对照)", direct: () => {
    const variants: [string, CaseResult, CaseResult][] = [
      ["预期拦下→放行", BLOCKED(), BLOCKED({ pass: false, kind: "verdict", exit: 0, gates: { ...ALL_OK }, expectHit: [] })],
      ["预期拦下→放行(其他门禁仍拦,退出 1)", BLOCKED(), BLOCKED({ pass: false, kind: "verdict", exit: 1, gates: { ...ALL_OK, "G-RED": "✗" }, expectHit: [] })],
      ["仍拦下但原因变了", BLOCKED(), BLOCKED({ pass: false, kind: "verdict", exit: 1, expectHit: [] })],
      ["放行→拦下", ALLOWED(), ALLOWED({ pass: false, kind: "verdict", exit: 1, gates: { ...ALL_OK, "G-TRACE": "✗" } })],
    ];
    for (const [k, base, mut] of variants) if (!evidence(["G-TRACE"], base, mut)) return `${k}:完整输出的有效变化没算发现`;
    return undefined; }, expect: null },
  { name: "R6-02 killedBy 基线 Map 是 Proxy/撤销的 Proxy/伪 Map、结果数组是 Proxy 时 trap 回调 0 次、不抛错、不给判因", direct: () => {
    let calls = 0;
    const boom = () => { calls++; throw new Error("中性标记:trap 被调用"); };
    const handler: ProxyHandler<object> = { getPrototypeOf: boom, get: boom, has: boom, ownKeys: boom, getOwnPropertyDescriptor: boom, apply: boom, construct: boom, set: boom, defineProperty: boom, deleteProperty: boom, isExtensible: boom, preventExtensions: boom, setPrototypeOf: boom };
    const goodMap = () => new Map([["改了代码没收据", BLOCKED()]]);
    const mut = [BLOCKED({ pass: false, kind: "verdict", exit: 0, gates: { ...ALL_OK }, expectHit: [] })];
    const revokedMap = Proxy.revocable(goodMap(), handler); revokedMap.revoke();
    const revokedArr = Proxy.revocable([...mut], handler); revokedArr.revoke();
    const nested = new Map<string, CaseResult>([["改了代码没收据", Object.defineProperty({ ...BLOCKED() }, "pass", { get: () => { calls++; return true; }, enumerable: true })]]);
    const shapes: [string, unknown, unknown][] = [
      ["基线 Map Proxy", new Proxy(goodMap(), handler), mut],
      ["基线撤销的 Proxy", revokedMap.proxy, mut],
      ["基线伪 Map(原型是 Map.prototype 但不是 Map)", Object.create(Map.prototype), mut],
      ["基线 Map 的值带 getter", nested, mut],
      ["结果数组 Proxy", goodMap(), new Proxy([...mut], handler)],
      ["结果数组撤销的 Proxy", goodMap(), revokedArr.proxy],
    ];
    for (const [k, base, rs] of shapes) {
      try { const r = killedBy(["G-TRACE"], base as Map<string, CaseResult>, rs as CaseResult[]); if (r !== undefined) return `${k}:被当成证据 ${JSON.stringify(r)}`; }
      catch (e) { return `${k}:抛错 ${(e as Error).message}`; }
    }
    if (calls) return `trap/getter 被回调了 ${calls} 次`;
    return killedBy(["G-TRACE"], goodMap(), mut) ? undefined : "合法 Map 对照没给判因"; }, expect: null },
  { name: "R5-03 改导出的策略对象不改变后续门禁行为", direct: () => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const g = await import(${JSON.stringify(path.join(HERE, "gates.ts"))});
      const tries = [
        () => g.POLICY.allowedReviewers.push("unlisted"), () => { g.POLICY.allowedReviewers[0] = "unlisted"; }, () => { g.POLICY.allowedReviewers.length = 0; },
        () => { g.POLICY.reviewerHarnessOf.unlisted = "claude"; }, () => { delete g.POLICY.reviewerHarnessOf.codex; }, () => { g.POLICY.assistantIds.unlisted = "ai-x"; }, () => { g.POLICY.reviewerHarness = "claude"; },
        () => g.PROTECTED_CONTEXTS.pop(), () => { g.PROTECTED_CONTEXTS.length = 0; }, () => g.LAYERS.push("evil"), () => { g.REQUIRED_GATE_SCRIPTS.test = "true"; }, () => { delete g.REQUIRED_GATE_SCRIPTS["gates:mutation"]; }, () => { g.HARNESSES.add?.("evil"); g.HARNESSES.push?.("evil"); },
      ];
      for (const t of tries) { try { t(); } catch {} }
      const out = { allowed: [...g.POLICY.allowedReviewers], harness: g.harnessOf("unlisted"), codex: g.harnessOf("codex"), ctx: [...g.PROTECTED_CONTEXTS], layers: [...g.LAYERS], scripts: { ...g.REQUIRED_GATE_SCRIPTS } };
      const ctx = { changed: ["packages/core/src/a.ts"], receipt: { author: { agent: "claude", model: "claude-opus-5-5", session: "claude:a" }, review: { agent: "unlisted", model: "gpt-6", session: "codex:b", verdict: "approve", reviewed_hash: "h" }, waiver: null }, contentHash: () => "h" };
      out.review = g.review.run(ctx).map((x) => x.msg);
      out.harnesses = [...g.HARNESSES];
      console.log(JSON.stringify(out));`], { encoding: "utf8", timeout: 60_000 });
    let o: { allowed: string[]; harness: string; codex: string; ctx: string[]; layers: string[]; scripts: Record<string, string>; review: string[]; harnesses: string[] };
    try { o = JSON.parse(r.stdout.trim().split("\n").pop() ?? ""); } catch { return `探针没跑通:${r.stdout}${r.stderr}`; }
    const bad: string[] = [];
    if (o.allowed.join(",") !== "codex,astra,claude,argon") bad.push(`allowedReviewers 变成 ${o.allowed}`);
    if (o.harness !== "codex" || o.codex !== "codex") bad.push(`harnessOf 变成 ${o.harness}/${o.codex}`);
    if (o.ctx.join(",") !== "trusted-gates,provenance,self-check") bad.push(`PROTECTED_CONTEXTS 变成 ${o.ctx}`);
    if (o.layers.join(",") !== "domain,kernel,adapter,plugin,app") bad.push(`LAYERS 变成 ${o.layers}`);
    if (Object.keys(o.scripts).length !== 3 || o.scripts.test === "true") bad.push(`REQUIRED_GATE_SCRIPTS 变成 ${JSON.stringify(o.scripts)}`);
    if (o.harnesses.join(",") !== "claude,codex,pi") bad.push(`HARNESSES 变成 ${o.harnesses}`);
    if (!o.review.some((m) => m.includes("审查人必须是"))) bad.push(`改了导出名单后 unlisted 审查人被放行:${JSON.stringify(o.review)}`);
    return bad.length ? bad.join(";") : undefined; }, expect: null },
  { name: "R6-03 改 ALL_GATES/LOCAL_GATES 里的门禁对象(run/id/rule/加属性)不改变后续门禁行为", direct: () => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const g = await import(${JSON.stringify(path.join(HERE, "gates.ts"))});
      const ids0 = g.ALL_GATES.map((x) => x.id), local0 = g.LOCAL_GATES.map((x) => x.id), provRun = g.provenance.run, reviewRun = g.review.run;
      const rv = g.ALL_GATES.find((x) => x.id === "G-REVIEW");
      const tries = [
        () => { rv.run = () => []; }, () => { g.review.run = () => []; }, () => { g.ALL_GATES[0].run = () => []; }, () => { g.layers.run = () => []; },
        () => { rv.id = "G-X"; }, () => { g.trace.id = "G-Y"; }, () => { rv.rule = "改过"; }, () => { g.review.extra = 1; }, () => { g.ALL_GATES[2].extra = 1; },
        () => { Object.defineProperty(rv, "run", { value: () => [] }); }, () => { delete g.review.run; }, () => { Object.setPrototypeOf(g.review, { run: () => [] }); },
        () => { g.LOCAL_GATES[0].run = () => []; }, () => { g.provenance.id = "G-Z"; }, () => { g.LOCAL_GATES[0].extra = 1; },
      ];
      for (const t of tries) { try { t(); } catch {} }
      const ctx = { changed: ["packages/core/src/a.ts"], receipt: { author: { agent: "claude", model: "claude-opus-5-5", session: "claude:a" }, review: { agent: "unlisted", model: "gpt-6", session: "codex:b", verdict: "approve", reviewed_hash: "h" }, waiver: null }, contentHash: () => "h" };
      const out = {
        frozen: [...g.ALL_GATES, ...g.LOCAL_GATES].every((x) => Object.isFrozen(x)) && Object.isFrozen(g.ALL_GATES) && Object.isFrozen(g.LOCAL_GATES),
        ids: g.ALL_GATES.map((x) => x.id), ids0, local: g.LOCAL_GATES.map((x) => x.id), local0,
        extra: [...g.ALL_GATES, ...g.LOCAL_GATES].some((x) => "extra" in x), provSame: g.LOCAL_GATES[0].run === provRun && g.provenance.run === provRun, reviewSame: g.review.run === reviewRun,
        review: g.ALL_GATES.find((x) => x.id === "G-REVIEW")?.run(ctx).map((x) => x.msg) ?? [], review2: g.review.run(ctx).map((x) => x.msg),
      };
      console.log(JSON.stringify(out));`], { encoding: "utf8", timeout: 60_000 });
    let o: { frozen: boolean; ids: string[]; ids0: string[]; local: string[]; local0: string[]; extra: boolean; provSame: boolean; reviewSame: boolean; review: string[]; review2: string[] };
    try { o = JSON.parse(r.stdout.trim().split("\n").pop() ?? ""); } catch { return `探针没跑通:${r.stdout}${r.stderr}`; }
    const bad: string[] = [];
    if (!o.frozen) bad.push("门禁对象没有全部冻结");
    if (o.ids.join(",") !== "G-TRACE,G-REVIEW,G-RED,G-STUB,G-TAUTO,G-WORKFLOW,G-LAYER" || o.ids.join(",") !== o.ids0.join(",")) bad.push(`ALL_GATES 的 id 变成 ${o.ids}`);
    if (o.local.join(",") !== "G-PROVENANCE" || o.local.join(",") !== o.local0.join(",")) bad.push(`LOCAL_GATES 的 id 变成 ${o.local}`);
    if (o.extra) bad.push("门禁对象被加上了属性");
    if (!o.provSame || !o.reviewSame) bad.push("门禁的 run 被替换");
    if (!o.review.some((m) => m.includes("审查人必须是")) || !o.review2.some((m) => m.includes("审查人必须是"))) bad.push(`改了门禁对象后非法审查人被放行:${JSON.stringify([o.review, o.review2])}`);
    return bad.length ? bad.join(";") : undefined; }, expect: null },
  { name: "R5-04 正则注入点 0 次/多次在变异执行前拒绝,恰 1 次放行", direct: () => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const m = await import(${JSON.stringify(path.join(HERE, "mutation.ts"))});
      const src = "a MARK b MARK c ONE d";
      const res = [/MARK/, /MARK/g, /NONE/, /NONE/g, /ONE/, /ONE/g, "MARK", "NONE", "ONE"].map((f) => m.injectionCount(src, f));
      console.log(JSON.stringify(res));`], { encoding: "utf8", timeout: 60_000 });
    const got = (r.stdout ?? "").trim().split("\n").pop() ?? "";
    return got === "[2,2,0,0,1,1,2,0,1]" ? undefined : `injectionCount 结果 ${got || r.stderr.split("\n").find((l) => /Error/.test(l))}`; }, expect: null },
  { name: "R5-04 MUTATIONS 每个注入点(字符串与正则)恰好匹配 1 次", direct: () => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const m = await import(${JSON.stringify(path.join(HERE, "mutation.ts"))});
      const fs = await import("node:fs");
      // 变异副本里,被注入的那个文件已经改过,那条变异的注入点自然对不上;原样副本上逐条核对才有意义
      if (process.env.GATE_MUTANT_COPY === "1") { console.log("[]"); process.exit(0); }
      const bad = m.MUTATIONS.filter((x) => m.injectionCount(fs.readFileSync(${JSON.stringify(HERE)} + "/" + x.file, "utf8"), x.from) !== 1).map((x) => x.name);
      console.log(JSON.stringify(bad));`], { encoding: "utf8", timeout: 60_000 });
    const got = (r.stdout ?? "").trim().split("\n").pop() ?? "";
    return got === "[]" ? undefined : `注入点不唯一或检查不可用:${got || r.stderr.split("\n").find((l) => /Error/.test(l))}`; }, expect: null },
  { name: "R6-04 正则注入计数:零宽 /u 按码点前进不死循环,sticky 与普通搜索计数一致", direct: () => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const m = await import(${JSON.stringify(path.join(HERE, "mutation.ts"))});
      const E = "\\u{1F600}";
      const rows = [
        ["", /(?:)/u], [E, /(?:)/u], [E, /(?:)/gu], ["a" + E + "b", /(?:)/u], [E, /(?:)/], [E, /(?:)/v],
        ["a" + E + "b" + E, new RegExp(E, "u")], ["a" + E + "b" + E, new RegExp(E, "gu")], ["ab", new RegExp(E, "u")],
        ["MARK x MARK", /MARK/y], ["MARK x MARK", /MARK/gy], ["x MARK", /MARK/y], ["x MARK", /MARK/gy], ["x NONE", /MARK/y], ["MARKMARK", /MARK/y],
      ];
      console.log(JSON.stringify(rows.map(([s, f]) => m.injectionCount(s, f))));`], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
    const got = (r.stdout ?? "").trim().split("\n").pop() ?? "";
    const want = "[1,2,2,4,3,2,2,2,0,2,2,1,1,0,2]";
    return got === want ? undefined : `injectionCount 结果 ${got || (r.error ? `没返回(${(r.error as NodeJS.ErrnoException).code ?? r.signal})` : r.stderr.split("\n").find((l) => /Error/.test(l)))},应为 ${want}`; }, expect: null },
  { name: "R6-04 sticky 正则注入点按计数时的同一语义替换", direct: () => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const m = await import(${JSON.stringify(path.join(HERE, "mutation.ts"))});
      console.log(JSON.stringify([m.inject("x MARK y", /MARK/y, "DONE"), m.inject("x MARK y", /MARK/gy, "DONE"), m.inject("x MARK y", /MARK/, "DONE"), m.inject("x MARK y", "MARK", "DONE"), m.inject("a$b", "$", "$&$&")]));`], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
    const got = (r.stdout ?? "").trim().split("\n").pop() ?? "";
    const want = JSON.stringify(["x DONE y", "x DONE y", "x DONE y", "x DONE y", "a$$b"]);
    return got === want ? undefined : `inject 结果 ${got || r.stderr.split("\n").find((l) => /Error/.test(l))},应为 ${want}`; }, expect: null },
  { name: "磁盘:门禁命令行与一条自检用例跑完不在 TMPDIR 留下 gate-home/gate-run/gate-snap/gate-selftest 目录", direct: () => {
    const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), "gate-leakprobe-"));
    try {
      // 不继承本进程的 GATE_ISOLATED_HOME:要看子进程自己建的 HOME 退出时删没删
      const { GATE_ISOLATED_HOME: _h, ...rest } = gitEnv();
      const env = { ...rest, TMPDIR: tmpd };
      const i = CASES.findIndex((c) => c.name === "合规:先红后绿、跨厂商审查、来源核对通过");
      const r = spawnSync(process.execPath, [path.join(HERE, "selftest.ts"), "--case", String(i)], { encoding: "utf8", env, timeout: 600_000 });
      if (!(r.stdout ?? "").includes('"pass":true')) return `探针用例没通过:${(r.stdout ?? "").slice(-400)}${r.stderr}`;
      const left = fs.readdirSync(tmpd).filter((f) => /^(gate-home-|gate-run-|gate-snap-|gate-selftest-|gate-xform-|cc-marker)/.test(f));
      return left.length ? `留下了 ${left.length} 个临时目录:${left.slice(0, 6).join(", ")}` : undefined;
    } finally { fs.rmSync(tmpd, { recursive: true, force: true }); } }, expect: null },
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
  // 原则 68(g-group#2943、#3199):Claude 审 Codex 写的 PR;Argon(Google 模型、claude 会话、能执行命令)作备用审查人;
  // argon-chat 不能执行命令,不当审查人;跨厂商与禁止自审不变
  { name: "原则 68 claude 审 codex 作者放行(claude 会话)", authorTurns: CODEX_AUTHOR_TURNS, receipt: R((r) => { CODEX_AUTHOR(r); CLAUDE_REVIEW(r); }), reviewerTurns: claudeReviewTurns,
    room: () => [{ v: 1, seq: 50, by: "ai-claude", name: "Claude Code", kind: "message", text: "审查", card: { type: "dispatch", session: "claude:rv1", assistant: "ai-claude" } }], expect: null },
  { name: "原则 68 claude 审 claude 作者被拦(禁止自审)", receipt: R((r) => { CLAUDE_REVIEW(r); }), reviewerTurns: claudeReviewTurns, expect: "审查人与作者是同一个(claude)" },
  { name: "原则 68 claude 审查照样要跨研发厂商:作者用 Anthropic 模型", authorTurns: () => [{ model: "claude-opus-5-5", toolCalls: [{ name: "Write", input: { file_path: "/x/g-group/a.ts" } }] }], receipt: R((r) => { r.author.agent = "deepseek"; r.author.session = "pi:a"; CLAUDE_REVIEW(r); }), reviewerTurns: claudeReviewTurns, expect: "同为 anthropic" },
  { name: "原则 68 claude 审查会话必须是 claude 会话", authorTurns: CODEX_AUTHOR_TURNS, receipt: R((r) => { CODEX_AUTHOR(r); CLAUDE_REVIEW(r); r.review!.session = "codex:b"; }), reviewerTurns: claudeReviewTurns, expect: "必须是 claude 会话" },
  { name: "原则 68 argon 审 codex 作者放行(claude 会话,g-group#3199 备用审查人)", authorTurns: CODEX_AUTHOR_TURNS, receipt: R((r) => { CODEX_AUTHOR(r); ARGON_REVIEW(r); }), reviewerTurns: argonReviewTurns, room: ARGON_ROOM, expect: null },
  { name: "原则 68 argon 审 claude 作者放行(Google 审 Anthropic)", receipt: R((r) => { ARGON_REVIEW(r); }), reviewerTurns: argonReviewTurns, room: ARGON_ROOM, expect: null },
  { name: "原则 68 argon 审 Google 作者被拦(同为 google)", authorTurns: () => [{ model: "ai-x/gemini-4-argon", toolCalls: [{ name: "Write", input: { file_path: "/x/g-group/a.ts" } }] }], receipt: R((r) => { r.author.agent = "deepseek"; r.author.session = "pi:a"; r.author.model = "gemini-4-argon"; ARGON_REVIEW(r); }), reviewerTurns: argonReviewTurns, room: ARGON_ROOM, expect: "同为 google" },
  { name: "原则 68 argon 审查会话必须是 claude 会话", authorTurns: CODEX_AUTHOR_TURNS, receipt: R((r) => { CODEX_AUTHOR(r); ARGON_REVIEW(r); r.review!.session = "codex:b"; }), reviewerTurns: argonReviewTurns, expect: "必须是 claude 会话" },
  { name: "原则 68 argon-chat 当审查人被拦(不能执行命令)", authorTurns: CODEX_AUTHOR_TURNS, receipt: R((r) => { CODEX_AUTHOR(r); ARGON_REVIEW(r); r.review!.agent = "argon-chat"; }), reviewerTurns: argonReviewTurns, expect: "审查人必须是" },
  { name: "原则 68 astra 审 codex 作者被拦(同为 OpenAI)", authorTurns: CODEX_AUTHOR_TURNS, receipt: R((r) => { CODEX_AUTHOR(r); }), expect: "同为 openai" },
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
