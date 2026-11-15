// 副本只改变依赖布局,不改变任何门禁判据。用不同目录与包名覆盖 scoped/unscoped workspace 别名。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copyTree, ctxFromGit, freshCopy, GIT_SAFE_ARGS, gitEnv } from "./lib.ts";

const SCOPED = "modules/number-source";
const PLAIN = "features/text-source";
const READER = `import { value as scoped, source as scopedSource } from "@fixture/number";
import { value as plain, source as plainSource } from "fixture-text";
import { value as external } from "fixture-external";
import { value as scopedExternal } from "@vendor/external";
import { fileURLToPath } from "node:url";
console.log(JSON.stringify({ scoped, plain, external, scopedExternal, sources: [scopedSource, plainSource].map(fileURLToPath) }));
`;
const source = (value: string) => `export const value = ${JSON.stringify(value)};\nexport const source = import.meta.url;\n`;
function write(root: string, file: string, text: string) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
function values(root: string, value: string) {
  write(root, `${SCOPED}/index.mjs`, source(value));
  write(root, `${PLAIN}/index.mjs`, source(value));
}
function fixture(root: string) {
  fs.mkdirSync(root, { recursive: true });
  write(root, "package.json", JSON.stringify({ type: "module", workspaces: ["modules/*", "features/*"] }));
  write(root, ".gitignore", "node_modules\n");
  for (const [dir, name] of [[SCOPED, "@fixture/number"], [PLAIN, "fixture-text"]]) {
    write(root, `${dir}/package.json`, JSON.stringify({ name, type: "module", exports: "./index.mjs" }));
  }
  values(root, "original");
  write(root, "read.mjs", READER);
  const nm = path.join(root, "node_modules");
  fs.mkdirSync(path.join(nm, "@fixture"), { recursive: true });
  fs.symlinkSync(`../../${SCOPED}`, path.join(nm, "@fixture/number"));
  fs.symlinkSync(`../${PLAIN}`, path.join(nm, "fixture-text"));
  for (const name of ["fixture-external", "@vendor/external"]) {
    write(nm, `${name}/package.json`, JSON.stringify({ name, type: "module", exports: "./index.mjs" }));
    write(nm, `${name}/index.mjs`, source("external-dependency"));
  }
}
const git = (root: string, ...args: string[]) => execFileSync("git", [...GIT_SAFE_ARGS, ...args], { cwd: root, encoding: "utf8", env: gitEnv() }).trim();
function commit(root: string, message: string) {
  git(root, "add", "-A");
  git(root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}
interface Loaded { scoped: string; plain: string; external: string; scopedExternal: string; sources: string[] }
function run(root: string) {
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
  return spawnSync(process.execPath, ["read.mjs"], { cwd: root, encoding: "utf8", env, timeout: 10_000 });
}
function expectOwn(root: string, expected: string) {
  const r = run(root);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const got = JSON.parse(r.stdout.trim()) as Loaded;
  assert.equal(got.scoped, expected);
  assert.equal(got.plain, expected);
  assert.equal(got.external, "external-dependency");
  assert.equal(got.scopedExternal, "external-dependency");
  assert.deepEqual(got.sources, [SCOPED, PLAIN].map((rel) => path.join(fs.realpathSync(root), rel, "index.mjs")));
}
function inTemp(body: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-workspace-test-"));
  try { body(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("普通副本经 scoped/unscoped workspace 别名加载自身冻结源码,不回读后来变化的原树,外部依赖仍可读", () => inTemp((dir) => {
  const root = path.join(dir, "repo");
  fixture(root);
  const work = freshCopy(root);
  try {
    values(root, "changed-after-copy");
    expectOwn(work, "original");
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}));

test("红快照再复制后 workspace 别名只加载红源码,不把候选源码混进先红证据", () => inTemp((dir) => {
  const root = path.join(dir, "repo");
  fixture(root);
  git(root, "init", "-qb", "main");
  const base = commit(root, "base");
  values(root, "red");
  const red = commit(root, "red");
  values(root, "green");
  commit(root, "green");
  const snap = ctxFromGit(root, base, "feat/workspace").snapshot(red);
  assert.ok(snap);
  try {
    const work = freshCopy(snap.dir);
    try { expectOwn(work, "red"); } finally { fs.rmSync(work, { recursive: true, force: true }); }
  } finally { snap.cleanup(); }
}));

test("变异副本再复制后 workspace 别名加载变异源码,不绕过 copyTree 中的实现变更", () => inTemp((dir) => {
  const root = path.join(dir, "repo"), transformed = path.join(dir, "transformed");
  fixture(root);
  git(root, "init", "-qb", "main");
  commit(root, "base");
  fs.mkdirSync(transformed);
  copyTree(root, transformed, git(root, "ls-files").split("\n"));
  values(transformed, "mutated");
  const work = freshCopy(transformed);
  try { expectOwn(work, "mutated"); } finally { fs.rmSync(work, { recursive: true, force: true }); }
}));

test("副本缺少的 workspace 包不能从原树偷载,必须保留模块加载失败", () => inTemp((dir) => {
  const root = path.join(dir, "repo"), incomplete = path.join(dir, "incomplete");
  fixture(root);
  fs.mkdirSync(incomplete);
  fs.cpSync(root, incomplete, { recursive: true, filter: (f) => !f.includes(`${path.sep}node_modules`) });
  fs.rmSync(path.join(incomplete, SCOPED), { recursive: true });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(incomplete, "node_modules"));
  const work = freshCopy(incomplete);
  try {
    const r = run(work);
    assert.notEqual(r.status, 0, "缺包不能用候选源码补齐");
    assert.match(r.stderr, /ERR_MODULE_NOT_FOUND|Cannot find/);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}));
