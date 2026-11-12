// G6 报告:未测的组写明原因;合同未守住单独标出;规则替身标明;不写验收结论。
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRecord, mergeContracts } from "./contracts.ts";
import { mkCall, mkItem, mkRecord, mkSet } from "./fixtures/build.ts";
import { GROUPS, resolveGroup } from "./groups.ts";
import { comparePairs, fmtRatio, renderReport, type ResultRow, type Summary } from "./report.ts";
import { scoreRecords } from "./score.ts";

const git = { revParse: (r: string) => (r.startsWith("4efdee0") ? "4efdee0be6d161060099b5ce488e3344c70305ee" : null), hasFile: () => false, isAncestor: () => false };
function summary(): Summary {
  const rec = mkRecord();
  const bad = { ...rec, runId: "g1/m/T/2", calls: [...rec.calls, mkCall({ model: "别的模型" })] };
  return {
    generatedAt: "2026-11-11T00:00:00.000Z",
    runner: { commit: "abc", node: "v22", platform: "darwin-arm64" },
    fixture: { id: "test-set", digest: "d".repeat(64), items: ["T"] },
    reps: 2,
    groups: GROUPS.map((g) => resolveGroup(g, git)),
    models: [{ mode: "standin", model: "m", endpoint: "进程内规则替身", endpointHash: "-", authRef: "(无)", settings: null, serial: false, fingerprint: "fp", group: "g1" }],
    modelStates: { m: { state: "已跑", attempts: [] }, hy: { state: "未测(上游 429 限流)", attempts: [{ at: "2026-11-11T14:00:00.000Z", status: 429, retryAfter: "819", note: "rate_limit_error" }] } },
    results: [{ group: "g1", label: "①当前基线", model: "m", mode: "standin", fingerprint: "fp", metrics: scoreRecords(mkSet(), [rec, bad]), contracts: mergeContracts([rec, bad].map((r) => ({ runId: r.runId, results: checkRecord(mkItem(), r) }))) }],
    notes: ["最后一条说明"],
  };
}

test("比率写成分子/分母(百分比),分母为 0 写不适用", () => {
  assert.equal(fmtRatio({ n: 1, d: 3 }), "1/3(33.3%)");
  assert.equal(fmtRatio({ n: 0, d: 0 }), "0/0(不适用)");
});

test("报告列出每组状态,未测的写明原因,已跑的写已跑", () => {
  const md = renderReport(summary());
  assert.match(md, /^\| ①当前基线 \| 已跑 \| `4efdee0be6d1` \| \(无\) \| {2}\|$/m);
  assert.match(md, /^\| ②G1\+G2 \| 未测\(分支未就绪\) \| `4efdee0be6d1` \| G1 \(无\)\(无收据\);G2 \(无\)\(无收据\) \| G1\(feat\/t177-g1-memory 不存在\);G2\(feat\/t177-g2-config 不存在\) \|$/m);
  assert.ok(md.endsWith("- 最后一条说明\n"));
});

test("合同有一条未守住就在组标题上标出,效果指标照常列但不抵消", () => {
  const md = renderReport(summary());
  assert.match(md, /^### ①当前基线 · m\(规则替身\):合同未全过\(K3\)$/m);
  assert.match(md, /^\| K3 对话与后台同模 \| \*\*未守住\*\* \| \d+ \| g1\/m\/T\/2:调用 \d+\(round\)用了 别的模型,应为 m \|$/m);
  assert.match(md, /^\| ①当前基线 · m\(规则替身\) \| 2 \| 6\/6\(100\.0%\) \|/m);
  assert.ok(md.endsWith("- 最后一条说明\n"));
});

test("报告不写验收结论,以说明结尾", () => {
  const md = renderReport(summary());
  assert.equal(/验收通过|通过验收/.test(md), false);
  assert.match(md, /不预设阈值,不给验收结论/);
  assert.ok(md.endsWith("## 8 说明\n\n- 最后一条说明\n"));
});

test("模型状态单列:429 到上限记未测并带探测记录", () => {
  const md = renderReport(summary());
  assert.match(md, /^\| hy \| 未测\(上游 429 限流\) \| 2026-11-11T14:00:00\.000Z HTTP 429 retry-after 819 rate_limit_error \|$/m);
  // 整份报告由 renderReport 算出:整串属性也判(返回值被换成错值时会带上后缀,这条会红)
  assert.ok(md.startsWith("# T-177 G6 同题对照报告\n") && md.endsWith("- 最后一条说明\n"));
});

test("指定对照:同模型两组都有结果才列,差值按后者减前者", () => {
  const s0 = summary();
  const a = s0.results[0]!;
  const g2: ResultRow = { ...a, group: "g2", label: "②G1+G2" };
  const g3: ResultRow = { ...a, group: "g3", label: "③", metrics: { ...a.metrics, missedWrites: { n: 1, d: 2 } } };
  const other: ResultRow = { ...a, group: "g3", label: "③", model: "别的" };
  assert.deepEqual(comparePairs([a, g2, g3, other]).map(([x, y]) => `${x.group}>${y.group}:${y.model}`), ["g1>g2:m", "g2>g3:m"]);
  const md = renderReport({ ...s0, results: [g2, g3] });
  assert.deepEqual(a.metrics.missedWrites, { n: 0, d: 2 });
  assert.match(md, /^\| 差值\(③ − ②G1\+G2\) \| 50\.0 个百分点 \| 0\.0 个百分点 \|/m);
  assert.match(md, /^\| ③ · m \| 1\/2\(50\.0%\) \|/m);
});
