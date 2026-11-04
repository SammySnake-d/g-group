// 门禁自检(R-05 双侧标定 / R-18 规则自身可信):
// 每个门禁至少一个合规样例(必须放行)和若干违规样例(必须拦下,且拦下的原因文字要对)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALL_GATES, LOCAL_GATES, layers, provenance, red, review, stub, tautology, trace } from "./gates.ts";
import { type Ctx, type Gate, type Receipt, ctxFromDir, runGates } from "./lib.ts";
import { vendorOf } from "./vendor.ts";

const SPEC = "# 验收\n| AC-01 示例 |\n| AC-02 示例 |\n";
const ADD = "export function add(a: number, b: number): number { return a + b; }\n";
const ADD_BROKEN = "export function add(a: number, b: number): number { return 0; }\n";
const TEST = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./add.ts";\ntest("adds", () => { assert.equal(add(1, 2), 3); });\n`;
const PKG = (name: string, layer: string) => JSON.stringify({ name, gGroup: { layer } });

const baseFiles = (): Record<string, string> => ({
  "docs/spec/验收文档-v0.1.md": SPEC,
  "packages/core/package.json": PKG("@g-group/core", "domain"),
  "packages/core/src/add.ts": ADD,
  "packages/core/src/add.test.ts": TEST,
  "packages/core/proof/adds.txt": "adds ok\n",
});
const CHANGED = ["packages/core/src/add.ts", "packages/core/src/add.test.ts"];
const baseReceipt = (): Receipt => ({
  slice: "selftest",
  acceptance: [{ id: "AC-01", status: "通过", evidence: "packages/core/proof/adds.txt" }, { id: "AC-02", status: "未测", reason: "本片不涉及" }],
  author: { agent: "claude", session: "claude:a", model: "claude-opus-5-5" },
  review: { agent: "astra", session: "codex:b", model: "gpt-6-astra", verdict: "approve", reviewed_hash: "", notes: "ok" },
  red: { commit: "red1", tests: ["adds"] },
  unverifiable: "AC-01 只验了整数相加",
  waiver: null,
});

interface Case { files?: Record<string, string>; changed?: string[]; receipt?: Receipt | null; snaps?: Record<string, Record<string, string>>; afterHash?: Record<string, string>; pinHash?: boolean }

let tmpRoot = "";
function build(c: Case): Ctx {
  const caseDir = fs.mkdtempSync(path.join(tmpRoot, "c-"));
  const repo = path.join(caseDir, "repo");
  const write = (root: string, files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); }
  };
  write(repo, c.files ?? baseFiles());
  for (const [ref, files] of Object.entries(c.snaps ?? { red1: { ...baseFiles(), "packages/core/src/add.ts": ADD_BROKEN } })) write(path.join(caseDir, "_snap", ref), files);
  const rcpt = c.receipt === undefined ? baseReceipt() : c.receipt;
  const meta: { changed: string[]; receipt?: string } = { changed: c.changed ?? CHANGED };
  if (rcpt) { meta.receipt = "receipts/x.json"; write(repo, { "receipts/x.json": JSON.stringify(rcpt) }); }
  fs.writeFileSync(path.join(repo, "_ctx.json"), JSON.stringify(meta));
  if (rcpt?.review && c.pinHash !== false) {
    rcpt.review.reviewed_hash = ctxFromDir(repo).contentHash();
    fs.writeFileSync(path.join(repo, "receipts/x.json"), JSON.stringify(rcpt));
  }
  if (c.afterHash) write(repo, c.afterHash);
  return ctxFromDir(repo);
}

const R = (f: (r: Receipt) => void) => { const r = baseReceipt(); f(r); return r; };

const CASES: [Gate, string, Case, string | null][] = [
  // [门禁, 名称, 样例, 期望拦下的原因片段(null = 必须放行)]
  [trace, "合规收据", {}, null],
  [trace, "只改文档不需要收据", { changed: ["docs/spec/验收文档-v0.1.md"], receipt: null }, null],
  [trace, "改了代码没收据", { receipt: null }, "缺收据"],
  [trace, "条目不在验收文档", { receipt: R((r) => { r.acceptance[0]!.id = "AC-99"; }) }, "不在验收文档"],
  [trace, "通过但无证据", { receipt: R((r) => { delete r.acceptance[0]!.evidence; }) }, "没写证据"],
  [trace, "状态不在四种之内", { receipt: R((r) => { (r.acceptance[1] as { status: string }).status = "基本通过"; }) }, "不是 通过/失败/未测/不适用"],
  [trace, "第 7 栏没点到条目", { receipt: R((r) => { r.unverifiable = "应该没问题"; }) }, "第 7 栏"],

  [review, "跨厂商审查", {}, null],
  [review, "同厂商但有用户豁免", { receipt: R((r) => { r.review!.model = "claude-sonnet-5-5"; r.waiver = { by: "39impacts.talent", reason: "g-group#999 同意" }; }) }, null],
  [review, "作者自审", { receipt: R((r) => { r.review!.agent = "claude"; r.review!.model = "gpt-6"; }) }, "同一个"],
  [review, "同厂商审查", { receipt: R((r) => { r.review!.model = "claude-sonnet-5-5"; }) }, "同为 anthropic"],
  [review, "审查模型认不出", { receipt: R((r) => { r.review!.model = "stealth/crouton-alpha"; }) }, "认不出"],
  [review, "审后又改代码", { afterHash: { "packages/core/src/add.ts": ADD + "// changed\n" } }, "需要重审"],
  [review, "审后改了收据的验收结论", { afterHash: { "receipts/x.json": JSON.stringify(R((r) => { r.acceptance[1]!.status = "通过"; r.acceptance[1]!.evidence = "packages/core/proof/adds.txt"; })) } }, "需要重审"],
  [review, "没有审查", { receipt: R((r) => { r.review = null; }) }, "还没有独立审查"],

  [red, "红提交上失败、现在通过", {}, null],
  [red, "红提交上本来就绿", { snaps: { red1: baseFiles() } }, "没有按名字失败"],
  [red, "收据没写红提交", { receipt: R((r) => { r.red = null; }) }, "缺 red"],
  [red, "红提交不存在", { receipt: R((r) => { r.red!.commit = "nope"; }) }, "不存在"],
  [red, "改源码不改测试", { changed: ["packages/core/src/add.ts"] }, "没有改动任何测试"],

  [stub, "测试真的调用了实现", {}, null],
  [stub, "吞掉异常的假测试", { files: { ...baseFiles(), "packages/core/src/add.test.ts": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./add.ts";\ntest("adds", () => { let v = 3; try { v = add(1, 2); } catch {} assert.equal(v, 3); });\n` } }, "仍通过"],

  [tautology, "正常测试", {}, null],
  [tautology, "恒真断言", { files: { ...baseFiles(), "packages/core/src/add.test.ts": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./add.ts";\ntest("adds", () => { add(1, 2); assert.equal(1, 1); });\n` } }, "恒真"],
  [tautology, "不碰源码", { files: { ...baseFiles(), "packages/core/src/add.test.ts": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nconst add = (a: number, b: number) => a + b;\ntest("adds", () => { assert.equal(add(1, 2), 3); });\n` } }, "没用到任何从源码导入"],
  [tautology, "没有断言", { files: { ...baseFiles(), "packages/core/src/add.test.ts": `import { test } from "node:test";\nimport { add } from "./add.ts";\ntest("adds", () => { add(1, 2); });\n` } }, "没有任何断言"],

  [layers, "向下依赖", { files: { ...baseFiles(), "packages/kern/package.json": PKG("@g-group/kern", "kernel"), "packages/kern/src/k.ts": `import { add } from "@g-group/core";\nexport const k = add;\n` }, changed: ["packages/kern/src/k.ts"] }, null],
  [layers, "领域层反向依赖内核", { files: { ...baseFiles(), "packages/kern/package.json": PKG("@g-group/kern", "kernel"), "packages/kern/src/k.ts": "export const k = 1;\n", "packages/core/src/bad.ts": `import { k } from "@g-group/kern";\nexport const b = k;\n` }, changed: ["packages/core/src/bad.ts"] }, "不能依赖 kernel"],
  [layers, "插件依赖另一个插件", { files: { ...baseFiles(), "packages/p1/package.json": PKG("@g-group/plugin-a", "plugin"), "packages/p2/package.json": PKG("@g-group/plugin-b", "plugin"), "packages/p2/src/x.ts": "export const x = 1;\n", "packages/p1/src/y.ts": `import { x } from "@g-group/plugin-b";\nexport const y = x;\n` }, changed: ["packages/p1/src/y.ts"] }, "不能依赖 plugin"],
  [layers, "相对路径跨包", { files: { ...baseFiles(), "packages/kern/package.json": PKG("@g-group/kern", "kernel"), "packages/kern/src/k.ts": `import { add } from "../../core/src/add.ts";\nexport const k = add;\n` }, changed: ["packages/kern/src/k.ts"] }, "跨出了包"],
  [layers, "依赖声明里反向引用", { files: { ...baseFiles(), "packages/kern/package.json": PKG("@g-group/kern", "kernel"), "packages/core/package.json": JSON.stringify({ name: "@g-group/core", gGroup: { layer: "domain" }, dependencies: { "@g-group/kern": "*" } }) }, changed: ["packages/core/package.json"] }, "依赖声明里引用了 kernel"],
  [trace, "删掉源码文件也要收据", { changed: ["packages/core/src/gone.ts"], receipt: null }, "缺收据"],
  [tautology, "只调 expect 不算断言", { files: { ...baseFiles(), "packages/core/src/add.test.ts": `import { test } from "node:test";\nimport { add } from "./add.ts";\ndeclare const expect: (v: unknown) => unknown;\ntest("adds", () => { expect(add(1, 2)); });\n` } }, "没有任何断言"],

  [provenance, "会话记录与自报一致", {}, null],
  [provenance, "自报模型与会话记录不符", { receipt: R((r) => { r.review!.model = "gpt-6-astra"; r.review!.session = "codex:fake"; }) }, "实际是"],
  [provenance, "审查会话没见过被审 hash", { receipt: R((r) => { r.review!.session = "codex:nohash"; }) }, "没出现过 reviewed_hash"],
  [provenance, "会话不存在", { receipt: R((r) => { r.author.session = "claude:missing"; }) }, "会话记录不存在"],
  [provenance, "真实用户豁免", { receipt: R((r) => { r.waiver = { by: "39impacts.talent", reason: "g-group#900" }; }) }, null],
  [provenance, "伪造豁免出处", { receipt: R((r) => { r.waiver = { by: "39impacts.talent", reason: "g-group#901" }; }) }, "不是 39impacts.talent 本人"],
  [provenance, "豁免出处不存在", { receipt: R((r) => { r.waiver = { by: "39impacts.talent", reason: "g-group#99999" }; }) }, "找不到"],
  [layers, "包没声明层级", { files: { ...baseFiles(), "packages/core/package.json": JSON.stringify({ name: "@g-group/core" }) } }, "gGroup.layer"],
];

// 假的 mirasim 会话与群聊记录,供 G-PROVENANCE 自检
function fakeMirasim(): void {
  const sess = path.join(tmpRoot, "_sessions"), rooms = path.join(tmpRoot, "_rooms");
  const put = (f: string, t: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
  put(path.join(sess, "claude/a/turns.jsonl"), `{"model":"ai-x/claude-opus-5-5"}\n`);
  put(path.join(sess, "codex/fake/turns.jsonl"), `{"model":"claude-sonnet-5-5"}\n`);
  put(path.join(sess, "codex/nohash/turns.jsonl"), `{"model":"gpt-6-astra"}\n`);
  put(path.join(rooms, "g-group/md/2026-11-05.md"), [
    "- 02:18 **39impacts.talent**: 这次同厂商审查我同意 <!-- #900 -->",
    "- 02:19 **Claude Code** (agent · for 39impacts.talent): **39impacts.talent** 同意了 <!-- #901 -->",
  ].join("\n") + "\n");
  process.env.MIRASIM_SESSIONS = sess;
  process.env.MIRASIM_ROOMS = rooms;
}

export function selfTest(): boolean {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gate-selftest-"));
  const env = { s: process.env.MIRASIM_SESSIONS, r: process.env.MIRASIM_ROOMS };
  fakeMirasim();
  let ok = true;
  try {
    for (const [gate, name, c, expect] of CASES) {
      const ctx = build(c);
      if (gate === provenance) {
        // 审查会话里写入被审 hash(nohash 样例除外),模拟审查人确实看过这一版
        const rv = ctx.receipt?.review;
        if (rv && rv.session === "codex:b") {
          const f = path.join(process.env.MIRASIM_SESSIONS!, "codex/b/turns.jsonl");
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, `{"model":"gpt-6-astra","text":"审查 ${rv.reviewed_hash}"}\n`);
        }
      }
      const probs = runGates(ctx, [gate])[0]!.problems.map((x) => x.msg);
      const pass = expect === null ? probs.length === 0 : probs.some((m) => m.includes(expect));
      if (!pass) ok = false;
      console.log(`${pass ? "✓" : "✗"} ${gate.id} ${expect === null ? "放行" : "拦下"}:${name}${pass ? "" : `  实际=${JSON.stringify(probs)}`}`);
    }
    // 执行器层:CI 跑的 ALL_GATES 与本机的 LOCAL_GATES 必须覆盖所有门禁,删掉任何一个都要红(R-18)
    const registered = new Set([...ALL_GATES, ...LOCAL_GATES].map((g) => g.id));
    const all = [trace, review, red, stub, tautology, layers, provenance];
    for (const g of all) if (!registered.has(g.id)) { ok = false; console.log(`✗ ${g.id} 没有注册进执行器`); }
    if (LOCAL_GATES.some((g) => ALL_GATES.includes(g)) || !LOCAL_GATES.includes(provenance)) { ok = false; console.log("✗ 执行器注册表不对"); }
    // 一个违规样例走完整执行器也必须被拦下
    const full = runGates(build({ receipt: null }), ALL_GATES);
    if (!full.some((r) => r.problems.length)) { ok = false; console.log("✗ 完整执行器放行了没收据的改动"); } else console.log("✓ 执行器 拦下:完整门禁集对违规改动不放行");
    for (const [m, v] of [["o1", "openai"], ["gpt-6-astra", "openai"], ["claude-opus-5-5", "anthropic"], ["grok-4.7", "xai"], ["gemini-4-argon", "google"], ["stealth/crouton-alpha", "unknown"]] as const) {
      const pass = vendorOf(m) === v; if (!pass) ok = false;
      console.log(`${pass ? "✓" : "✗"} vendorOf(${m}) = ${vendorOf(m)}`);
    }
    const covered = new Set(CASES.map(([g]) => g.id));
    for (const g of all) {
      const kinds = CASES.filter(([x]) => x.id === g.id);
      if (!covered.has(g.id) || !kinds.some(([, , , e]) => e === null) || !kinds.some(([, , , e]) => e !== null)) { ok = false; console.log(`✗ ${g.id} 缺合规或违规样例`); }
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (env.s === undefined) delete process.env.MIRASIM_SESSIONS; else process.env.MIRASIM_SESSIONS = env.s;
    if (env.r === undefined) delete process.env.MIRASIM_ROOMS; else process.env.MIRASIM_ROOMS = env.r;
  }
  console.log(ok ? "自检通过" : "自检失败");
  return ok;
}
