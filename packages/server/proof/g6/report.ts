// G6 报告:冻结清单、各组状态(已跑/未测及原因)、开关表、确定性合同、分开列的各项指标、失败与分母、成本延迟积压。
// 只写测量值:不预设阈值,不写验收结论;规则替身的结果标明只验证 runner。
import { GROUPS, type GroupState, switchTable } from "./groups.ts";
import type { ModelConfig } from "./manifest.ts";
import type { ContractResult, Metrics, Ratio } from "./types.ts";

export interface ResultRow {
  readonly group: string;
  readonly label: string;
  readonly model: string;
  readonly mode: "standin" | "real";
  readonly fingerprint: string;
  readonly metrics: Metrics;
  readonly contracts: readonly ContractResult[];
}
export interface Summary {
  readonly generatedAt: string;
  readonly runner: { readonly commit: string; readonly node: string; readonly platform: string };
  readonly fixture: { readonly id: string; readonly digest: string; readonly items: readonly string[] };
  readonly reps: number;
  readonly groups: readonly GroupState[];
  readonly models: readonly (ModelConfig & { readonly fingerprint: string; readonly group?: string })[];
  /** 各模型这次的状态(真实模式探测结果;429 到上限记未测) */
  readonly modelStates?: Readonly<Record<string, { readonly state: string; readonly attempts: readonly { readonly at: string; readonly status: number; readonly retryAfter: string | null; readonly note: string }[] }>>;
  readonly results: readonly ResultRow[];
  readonly notes: readonly string[];
}

/** 比率写成「分子/分母(百分比)」;分母为 0 写不适用。 */
/** 指定对照:①对②、②对③、③对④预取开、④预取开对预取关;同模型、两组都有结果才列 */
export const COMPARE: readonly (readonly [string, string])[] = Object.freeze([["g1", "g2"], ["g2", "g3"], ["g3", "g4on"], ["g4off", "g4on"]] as const);
export function comparePairs(results: readonly ResultRow[]): [ResultRow, ResultRow][] {
  const out: [ResultRow, ResultRow][] = [];
  for (const [x, y] of COMPARE) for (const a of results.filter((r) => r.group === x)) {
    const b = results.find((r) => r.group === y && r.model === a.model);
    if (b) out.push([a, b]);
  }
  return out;
}

export function fmtRatio(r: Ratio): string {
  if (r.d === 0) return "0/0(不适用)";
  return `${r.n}/${r.d}(${((100 * r.n) / r.d).toFixed(1)}%)`;
}
const ms = (x: number | null) => (x === null ? "—" : `${Math.round(x)}`);
const who = (r: Pick<ResultRow, "label" | "model" | "mode">) => `${r.label} · ${r.model}${r.mode === "standin" ? "(规则替身)" : ""}`;
const VERDICT: Readonly<Record<string, string>> = { pass: "守住", fail: "**未守住**", "n/a": "不适用" };

export function renderReport(s: Summary): string {
  const L: string[] = [];
  L.push("# T-177 G6 同题对照报告", "");
  L.push("> 只列测量值:不预设阈值,不给验收结论。规则替身组只验证 runner 自身(读回取决于宿主装配,不代表任何模型的效果)。确定性合同与效果指标分开列,合同有一条未守住,不能用效果指标的平均收益抵消。", "");
  L.push("## 1 冻结清单", "");
  L.push(`- runner 提交:\`${s.runner.commit}\`;Node ${s.runner.node};${s.runner.platform}`);
  L.push(`- 题集:\`${s.fixture.id}\`,摘要 \`${s.fixture.digest}\`,${s.fixture.items.length} 道(${s.fixture.items.join("、")});每组每模型重复 ${s.reps} 次`);
  L.push(`- 生成时间:${s.generatedAt}`, "");
  L.push("| 组 | 模型 | 方式 | 渠道 | 渠道摘要 | 认证引用 | 组级宿主选项 | 一次一个调用 | 配置指纹 |", "|---|---|---|---|---|---|---|---|---|");
  for (const m of s.models) L.push(`| ${m.group ?? "—"} | ${m.model} | ${m.mode === "standin" ? "规则替身" : "真实"} | ${m.endpoint} | ${m.endpointHash} | ${m.authRef} | ${m.settings ? JSON.stringify(m.settings).replace(/\|/g, "/") : "无"} | ${m.serial ? "是" : "否"} | \`${m.fingerprint}\` |`);
  if (s.modelStates && Object.keys(s.modelStates).length) {
    L.push("", "| 模型 | 本次状态 | 探测记录 |", "|---|---|---|");
    for (const [m, st] of Object.entries(s.modelStates)) L.push(`| ${m} | ${st.state} | ${st.attempts.map((a) => `${a.at} HTTP ${a.status}${a.retryAfter ? ` retry-after ${a.retryAfter}` : ""} ${a.note}`).join(";") || "—"} |`);
  }
  L.push("", "## 2 各组状态", "", "| 组 | 状态 | 基线 | 叠加的片(提交) | 说明 |", "|---|---|---|---|---|");
  for (const g of s.groups) {
    const inputs = g.inputs.length ? g.inputs.map((i) => `${i.slice} ${i.sha ? `\`${i.sha.slice(0, 12)}\`` : "(无)"}${i.receipt ? "" : "(无收据)"}`).join(";") : "(无)";
    const ran = s.results.some((r) => r.group === g.id);
    const state = g.state === "可跑" ? (ran ? "已跑" : "未跑(本次未选)") : g.state;
    L.push(`| ${g.label} | ${state} | ${g.base ? `\`${g.base.slice(0, 12)}\`` : "—"} | ${inputs} | ${g.reason ?? ""} |`);
  }
  L.push("", "## 3 开关表", "", switchTable(GROUPS.filter((d) => s.groups.some((g) => g.id === d.id))), "");
  L.push("## 4 确定性合同", "");
  if (!s.results.length) L.push("(本次没有可跑的组)");
  for (const r of s.results) {
    const bad = r.contracts.filter((c) => c.verdict === "fail");
    L.push(`### ${who(r)}${bad.length ? `:合同未全过(${bad.map((c) => c.id).join("、")})` : ""}`, "", "| 合同 | 结果 | 检查数 | 违例(节选) |", "|---|---|---|---|");
    for (const c of r.contracts) L.push(`| ${c.id} ${c.title} | ${VERDICT[c.verdict] ?? c.verdict} | ${c.checked} | ${c.violations.slice(0, 3).join(";").replace(/\|/g, "/") || "—"} |`);
    L.push("");
  }
  L.push("## 5 效果指标(分子/分母;分母按计划数,失败与超时的运行留在分母里)", "");
  L.push("| 组 · 模型 | 运行数 | 覆盖率 | 漏写 | 误写 | 来源与作用域正确 | 读回率 | 读后照做率 | 未打标追问正确 | 预取误导 | 追问总正确 | 正确但没走 reply |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of s.results) {
    const m = r.metrics;
    L.push(`| ${who(r)} | ${m.runs} | ${fmtRatio(m.coverage)} | ${fmtRatio(m.missedWrites)} | ${fmtRatio(m.wrongWrites)} | ${fmtRatio(m.sourceScope)} | ${fmtRatio(m.readBack)} | ${fmtRatio(m.followAfterRead)} | ${fmtRatio(m.untagged)} | ${fmtRatio(m.prefetchMisled)} | ${fmtRatio(m.probes)} | ${m.correctNoReply} |`);
  }
  L.push("", "## 6 失败与分母(单列,不从任何分母里删)", "");
  L.push("| 组 · 模型 | 调用数 | 超时 | 解析失败 | 配置不足(截断/缺配置) | HTTP 错误 | 网络错误 | 空输出 | 注入故障 | 运行出错 | 步骤超时 |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of s.results) {
    const f = r.metrics.failures;
    L.push(`| ${who(r)} | ${r.metrics.calls} | ${f.timeout} | ${f.parseFailure} | ${f.configInsufficient} | ${f.httpError} | ${f.networkError} | ${f.empty} | ${f.injected} | ${f.runErrors} | ${f.stepTimeouts} |`);
  }
  L.push("", "## 7 成本、延迟、积压(token 含后台维护与重试的每一次调用)", "");
  L.push("| 组 · 模型 | 输入 | 输出 | 缓存读 | 缓存写 | 对话轮 | 检查 | 补写笔记 | 精筛 | 其余后台 | 回复延迟 p50/p95 ms(n) | 写入延迟 p50/p95 ms(n) | 调用延迟 p50/p95 ms(n) | 历史查询工具调用 | 积压条数 | 最老积压 ms |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of s.results) {
    const m = r.metrics;
    const t = m.tokens;
    L.push(`| ${who(r)} | ${t.input} | ${t.output} | ${t.cacheRead} | ${t.cacheWrite} | ${t.byClass.round} | ${t.byClass.check} | ${t.byClass.compact} | ${t.byClass.refine} | ${t.byClass.background} | ${ms(m.roundLatencyMs.p50)}/${ms(m.roundLatencyMs.p95)}(${m.roundLatencyMs.n}) | ${ms(m.writeLatencyMs.p50)}/${ms(m.writeLatencyMs.p95)}(${m.writeLatencyMs.n}) | ${ms(m.callLatencyMs.p50)}/${ms(m.callLatencyMs.p95)}(${m.callLatencyMs.n}) | ${m.historyToolCalls} | ${m.backlog.count} | ${ms(m.backlog.maxAgeMs)} |`);
  }
  const pairs = comparePairs(s.results);
  if (pairs.length) {
    L.push("", "## 7.1 指定对照(同模型、同题集,只列测量值,差值 = 后者 − 前者)", "");
    L.push("| 对照 · 模型 | 漏写 | 误写 | 来源与作用域正确 | 读回率 | 未打标追问正确 | 追问总正确 | 覆盖率 | 写入延迟 p50/p95 ms(n) | 总 token | 合同未守住 |", "|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [a, b] of pairs) {
      for (const r of [a, b]) {
        const m = r.metrics;
        const total = m.tokens.input + m.tokens.output + m.tokens.cacheRead + m.tokens.cacheWrite;
        const bad = r.contracts.filter((c) => c.verdict === "fail").map((c) => c.id).join("、") || "无";
        L.push(`| ${r.label} · ${r.model} | ${fmtRatio(m.missedWrites)} | ${fmtRatio(m.wrongWrites)} | ${fmtRatio(m.sourceScope)} | ${fmtRatio(m.readBack)} | ${fmtRatio(m.untagged)} | ${fmtRatio(m.probes)} | ${fmtRatio(m.coverage)} | ${ms(m.writeLatencyMs.p50)}/${ms(m.writeLatencyMs.p95)}(${m.writeLatencyMs.n}) | ${total} | ${bad} |`);
      }
      const d = (x: Ratio, y: Ratio) => (x.d && y.d ? `${(100 * (y.n / y.d - x.n / x.d)).toFixed(1)} 个百分点` : "不适用");
      const am = a.metrics;
      const bm = b.metrics;
      const tok = (m: Metrics) => m.tokens.input + m.tokens.output + m.tokens.cacheRead + m.tokens.cacheWrite;
      L.push(`| 差值(${b.label} − ${a.label}) | ${d(am.missedWrites, bm.missedWrites)} | ${d(am.wrongWrites, bm.wrongWrites)} | ${d(am.sourceScope, bm.sourceScope)} | ${d(am.readBack, bm.readBack)} | ${d(am.untagged, bm.untagged)} | ${d(am.probes, bm.probes)} | ${d(am.coverage, bm.coverage)} | p50 ${am.writeLatencyMs.p50 !== null && bm.writeLatencyMs.p50 !== null ? Math.round(bm.writeLatencyMs.p50 - am.writeLatencyMs.p50) : "—"} | ${tok(bm) - tok(am)} | — |`);
    }
  }
  if (s.notes.length) L.push("", "## 8 说明", "", ...s.notes.map((n) => `- ${n}`));
  return `${L.join("\n")}\n`;
}
