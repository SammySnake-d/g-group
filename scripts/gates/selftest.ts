// 门禁自检(R-05 双侧标定 / R-18 规则自身可信):
// 每个样例都是一个真实 git 仓库(main → 红提交 → 绿提交 → 收据),用子进程调用真实命令行入口 run-all.ts,
// 只看退出码和输出。合规样例必须放行,违规样例必须拦下且原因文字对。
// 跑的是 import.meta.dirname 下的那份门禁代码,所以 mutation.ts 改坏一份副本后跑它的自检,必须失败。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GIT_SAFE_ARGS, gitEnv, type Receipt } from "./lib.ts";
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

function runCase(tmp: string, c: Case, i: number): { pass: boolean; detail: string } {
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
  let res: { pass: boolean; detail: string };
  try { res = runCaseInner(tmp, c, i); }
  finally {
    for (const [k, v] of [["GIT_DIR", saved.d], ["GIT_WORK_TREE", saved.w], ["GIT_INDEX_FILE", saved.x]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const after = snapOf();
  if (after !== before) return { pass: false, detail: `GIT_DIR 指向的另一个仓库被改动了:\n${before}\n=====\n${after}` };
  return res;
}

function runCaseInner(tmp: string, c: Case, i: number): { pass: boolean; detail: string } {
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
  const side = c.postCheck?.(dir);
  if (side) return { pass: false, detail: `${side}\n${res.out}` };
  if (c.expect === null) {
    const allListed = (c.local === false ? GATE_IDS.slice(0, -1) : GATE_IDS).every((id) => res.out.includes(`✓ ${id} `));
    return { pass: res.code === 0 && allListed, detail: res.out };
  }
  return { pass: res.code === 1 && res.out.includes(c.expect), detail: res.out };
}

const R = (f: (r: Receipt) => void) => f;
const OWNER_UID = "usr_owner", OWNER_NAME = "39impacts.talent";
const user = (seq: number, text: string, by = OWNER_UID, name = OWNER_NAME) => ({ v: 1, seq, by, name, kind: "message", text });
const SAME = R((r) => { r.review!.model = "claude-sonnet-5-5"; r.waiver = { by: OWNER_NAME, reason: "g-group#900" }; });
const sameTurns = (h: string) => [{ model: "claude-sonnet-5-5", toolCalls: [{ input: "node scripts/gates/run-all.ts --hash", result: h }] }];
const WF = (y: string): Files => ({ ...HEAD_OK, ".github/workflows/x.yml": y });

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

  { name: "合规:仓库所有者对这个 PR 这一版结构化批准豁免", receipt: SAME, reviewerTurns: sameTurns, room: (h) => [user(900, `这次同厂商审查可以\n批准豁免 PR#7 ${h}`)], expect: null },
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
  { name: "RR-03 self-check.yml 自己产出 self-check(阴性对照)", head: { ...HEAD_OK, ".github/workflows/self-check.yml": "on: pull_request\npermissions: { contents: read }\njobs:\n  self-check:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n" }, expect: null },
  { name: "RR-03 只读权限的普通 workflow(阴性对照)", head: WF("on: pull_request\npermissions:\n  contents: read\njobs:\n  lint:\n    name: lint\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n"), expect: null },
  { name: "隔离:hook 环境的 GIT_DIR 指向别的仓库,门禁不碰它", hostileGit: true, expect: null },
  { name: "审查人 codex 放行(g-group#1531 默认审查人)", receipt: R((r) => { r.review!.agent = "codex"; }), room: () => [{ v: 1, seq: 50, by: "ai-claude", name: "Claude Code", kind: "message", text: "审查", card: { type: "dispatch", session: "codex:b", assistant: "ai-codex" } }], expect: null },
  { name: "审查人 astra 放行", room: () => [{ v: 1, seq: 50, by: "ai-claude", name: "Claude Code", kind: "message", text: "审查", card: { type: "dispatch", session: "codex:b", assistant: "ai-astra" } }], expect: null },
  { name: "审查人 grok 被拦", receipt: R((r) => { r.review!.agent = "grok"; r.review!.model = "grok-4.7"; }), reviewerTurns: (h) => [{ model: "grok-4.7", toolCalls: [{ input: "node scripts/gates/run-all.ts --hash", result: h }] }], expect: "审查人必须是 codex 或 astra" },
  { name: "审查人 argon 被拦", receipt: R((r) => { r.review!.agent = "argon"; r.review!.model = "gemini-4-argon"; }), reviewerTurns: (h) => [{ model: "gemini-4-argon", toolCalls: [{ input: "node scripts/gates/run-all.ts --hash", result: h }] }], expect: "审查人必须是 codex 或 astra" },
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
