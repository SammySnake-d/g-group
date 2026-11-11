// G6 分组:一组能不能跑只看机械条件(每片解析得到提交且带本片收据、没有未定开关);开关表必须注明 G3 是③④共同底座。
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASELINE, GROUPS, type GitQuery, receiptPath, resolveGroup, resolveSlice, switchTable } from "./groups.ts";
import { crashRecord, planRuns } from "./run.ts";

/** 假仓库:refs 里列出的引用能解析,files 里列出的「提交:路径」存在 */
const fakeGit = (refs: Record<string, string>, files: string[]): GitQuery => ({
  revParse: (ref) => refs[ref] ?? null,
  hasFile: (commit, file) => files.includes(`${commit}:${file}`),
});
const def = (id: string) => GROUPS.find((g) => g.id === id)!;

test("收据路径按分支名把非字母数字换成连字符", () => {
  assert.equal(receiptPath("feat/t177-g1-memory"), "receipts/feat-t177-g1-memory.json");
});

test("基线组只要基线能解析就可跑", () => {
  const s = resolveGroup(def("g1"), fakeGit({ [BASELINE]: BASELINE }, []));
  assert.deepEqual([s.state, s.reason, s.base, s.inputs.length], ["可跑", null, BASELINE, 0]);
  assert.equal(resolveGroup(def("g1"), fakeGit({}, [])).state, "未测(分支未就绪)");
});

test("某片分支不存在或还没有收据,该组记未测(分支未就绪)并写明是哪片", () => {
  const git = fakeGit({ [BASELINE]: BASELINE, "origin/feat/t177-g1-memory": "s1", "feat/t177-g2-config": "s2" }, ["s1:receipts/feat-t177-g1-memory.json"]);
  const g2 = resolveGroup(def("g2"), git);
  assert.equal(g2.state, "未测(分支未就绪)");
  assert.equal(g2.reason, "G2(feat/t177-g2-config 还没有收据 receipts/feat-t177-g2-config.json)");
  const g3 = resolveGroup(def("g3"), git);
  assert.match(g3.reason!, /G3\(feat\/t177-g3-bc-search 不存在\)/);
});

test("每片都有收据就可跑;预取关这组在 G4 开关名定之前记未测(开关未定)", () => {
  const refs: Record<string, string> = { [BASELINE]: BASELINE };
  const files: string[] = [];
  for (const [s, b] of [["G1", "feat/t177-g1-memory"], ["G2", "feat/t177-g2-config"], ["G3", "feat/t177-g3-bc-search"], ["G4", "feat/t177-g4-history-tools"], ["G5", "feat/t177-g5-two-stage"]] as const) {
    refs[`origin/${b}`] = `sha-${s}`;
    files.push(`sha-${s}:receipts/${b.replaceAll("/", "-")}.json`);
  }
  const git = fakeGit(refs, files);
  assert.equal(resolveGroup(def("g4on"), git).state, "可跑");
  assert.deepEqual(resolveGroup(def("g4on"), git).inputs.map((i) => i.sha), ["sha-G1", "sha-G2", "sha-G3", "sha-G5", "sha-G4"]);
  const off = resolveGroup(def("g4off"), git);
  assert.equal(off.state, "未测(开关未定)");
  assert.match(off.reason!, /^G4 的预取开关接口未定/);
});

test("同一片远端与本地都有时取带收据的那个,显式覆盖优先", () => {
  const git = fakeGit({ "origin/feat/t177-g2-config": "old", "feat/t177-g2-config": "new", pinned: "p" }, ["new:receipts/feat-t177-g2-config.json", "p:receipts/feat-t177-g2-config.json"]);
  assert.deepEqual(resolveSlice("G2", git), { slice: "G2", branch: "feat/t177-g2-config", ref: "feat/t177-g2-config", sha: "new", receipt: true });
  assert.equal(resolveSlice("G2", git, { G2: "pinned" }).sha, "p");
});

test("开关表逐组列开关,并注明 G3 是③④的共同底座", () => {
  const t = switchTable();
  assert.match(t, /^\| ①当前基线 \| \(无\) \| 关 \| 关 \| 关 \| 关 \| 关 \| 关 \|$/m);
  assert.match(t, /^\| ④消融:预取关 \| G1\+G2\+G3\+G5\+G4 \| 开 \| 开 \| 开 \| 开 \| 开 \| 关 \|$/m);
  assert.match(t, /历史查询工具:检索\+分页回读\(G4,一个内置工具\)/);
  assert.match(t, /③④都已合入 G3,记忆排序是 BC 检索接缝,不是旧的 overlap 算法;③与④的差只在 G4\(历史查询工具与预取\),④两行的差只在预取开关。$/);
});

test("只给可跑的组排运行,顺序为组、模型、题、次", () => {
  const ready = resolveGroup(def("g1"), fakeGit({ [BASELINE]: BASELINE }, []));
  const not = resolveGroup(def("g2"), fakeGit({ [BASELINE]: BASELINE }, []));
  const runs = planRuns([ready, not], ["强", "弱"], ["U1", "U2"], 2);
  assert.equal(runs.length, 8);
  assert.deepEqual(runs.slice(0, 3), [
    { group: "g1", model: "强", item: "U1", rep: 1 },
    { group: "g1", model: "强", item: "U1", rep: 2 },
    { group: "g1", model: "强", item: "U2", rep: 1 },
  ]);
});

test("driver 没交回记录时补一份运行出错的记录,留在分母里", () => {
  const r = crashRecord({ group: "g1", model: "m", item: "U1", rep: 3, commit: "c", mode: "real", fingerprint: "fp" }, "退出码 1", 42);
  assert.deepEqual([r.runId, r.status, r.error, r.startedAt, r.calls.length], ["g1/m/U1/3", "error", "退出码 1", 42, 0]);
});
