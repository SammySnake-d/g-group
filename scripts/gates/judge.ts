// 变异判定(R4-01):一个变异算"被发现",必须是某条自检用例在正常执行下、因为目标门禁的结论变了而失败。
// 自检对每条用例输出一行结构化结果(CASE_MARK + JSON);用例自身出错、超时、没给结果、命令行崩溃都单独分类,不算发现。
// 本文件只做解析与判定,不依赖 selftest.ts / mutation.ts。
import { types } from "node:util";

/** ok=通过;verdict=正常执行但门禁结论与预期不符;side=副作用检查失败;其余是执行故障,不算发现 */
export type Kind = "ok" | "verdict" | "side" | "error" | "timeout" | "no-result" | "crash";
export interface CaseResult {
  name: string;
  pass: boolean;
  kind: Kind;
  /** 直接判定的用例(不建夹具仓库、不跑门禁命令行) */
  direct: boolean;
  expect: string | null;
  /** 门禁命令行退出码;直接判定的用例为 null */
  exit: number | null;
  /** 每个门禁的结论 */
  gates: Record<string, "✓" | "✗">;
  /** ✗ 的问题里出现了预期原因文字的门禁 */
  expectHit: string[];
  /** ✗ 的问题是"门禁自身出错"的门禁 */
  gateErrors: string[];
  /** 门禁命令行完整跑完:列出的门禁数等于头部注册数,且打印了 CONTENT_HASH。不完整 = 观测缺失 */
  complete: boolean;
  why?: string;
}
export const CASE_MARK = "__GATE_CASE__";
/** 目标:门禁 id(G-RED 等);RUNNER = 执行器/命令行本身;DIRECT = 直接判定的用例(测试入口、判定函数) */
export const RUNNER = "RUNNER";
export const DIRECT = "DIRECT";

/** 从 run-all.ts 的输出读每个门禁的结论,以及哪些门禁的问题里出现了预期原因 */
export function parseGateOutput(out: string, expect: string | null): { gates: Record<string, "✓" | "✗">; expectHit: string[]; gateErrors: string[]; header: boolean; complete: boolean } {
  const gates: Record<string, "✓" | "✗"> = {};
  const hit: string[] = [], errs: string[] = [];
  let cur: string | undefined;
  for (const line of out.split("\n")) {
    const m = /^(✓|✗) (G-[A-Z]+) /.exec(line);
    if (m) { cur = m[2]!; gates[cur] = m[1] as "✓" | "✗"; continue; }
    if (!cur || gates[cur] !== "✗" || !line.startsWith("    - ")) continue;
    if (expect && line.includes(expect) && !hit.includes(cur)) hit.push(cur);
    if (line.includes("门禁自身出错") && !errs.includes(cur)) errs.push(cur);
  }
  const n = /受检文件 \d+ 个.* 门禁 (\d+) 个/.exec(out);
  return { gates, expectHit: hit, gateErrors: errs, header: !!n, complete: !!n && Number(n[1]) === Object.keys(gates).length && /^CONTENT_HASH=[0-9a-f]{64}$/m.test(out) };
}

// ---------------------------------------------------------------- 信任边界(R5-02)
// 结构化结果来自子进程输出,属于外部输入。先用不触发用户代码的宿主原语检查:Proxy(util.types.isProxy)、
// 原型不是 Object.prototype / Array.prototype、属性是访问器(只读描述符,不读值);再核对字段、类型与枚举。
// 不合格一律 fail-closed:不收、不当证据、不抛错。只保证内置原型未被改的环境(g-group#2662)。
const KINDS = new Set<string>(["ok", "verdict", "side", "error", "timeout", "no-result", "crash"]);
const FIELDS = ["name", "pass", "kind", "direct", "expect", "exit", "gates", "expectHit", "gateErrors", "complete"] as const;
/** 普通数据对象:非 Proxy、原型是 Object.prototype 或 null、所有自有属性都是可枚举的数据属性(不读 getter) */
function plainData(x: unknown): Record<string, unknown> | undefined {
  if (x === null || typeof x !== "object" || types.isProxy(x) || Array.isArray(x)) return undefined;
  const proto = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const ds = Object.getOwnPropertyDescriptors(x);
  for (const k of Reflect.ownKeys(ds)) { const d = ds[k as string]!; if (typeof k !== "string" || !("value" in d) || !d.enumerable) return undefined; }
  return Object.fromEntries(Object.entries(ds).map(([k, d]) => [k, d.value]));
}
function plainArray(x: unknown): unknown[] | undefined {
  return undefined; // R11 红:空壳
  // 先判 Proxy:撤销的 Proxy 上 Array.isArray 会抛错(R6-02)
  if (types.isProxy(x) || !Array.isArray(x) || Object.getPrototypeOf(x) !== Array.prototype) return undefined;
  const ds = Object.getOwnPropertyDescriptors(x);
  const len = (Object.getOwnPropertyDescriptor(x, "length") as PropertyDescriptor).value as number;
  const keys = Reflect.ownKeys(ds);
  // 长度以外只能有 0..length-1 的自有数据属性;先比数量,避免巨型稀疏数组逐项扫描。
  if (keys.length !== len + 1) return undefined;
  for (const k of keys) {
    if (k === "length") continue;
    if (typeof k !== "string" || !/^(0|[1-9]\d*)$/.test(k)) return undefined;
    const n = Number(k), d = ds[k]!;
    if (!Number.isInteger(n) || n < 0 || n >= len || String(n) !== k || !("value" in d)) return undefined;
  }
  const out: unknown[] = [];
  for (let i = 0; i < len; i++) {
    const d = ds[String(i)];
    if (!d || !("value" in d)) return undefined;
    out.push(d.value);
  }
  return out;
}
const strArray = (x: unknown) => { const a = plainArray(x); return a?.every((v) => typeof v === "string") ? (a as string[]) : undefined; };
/** 校验并复制成全新的普通对象;不合格返回 undefined。不会调用 getter/setter/Proxy trap。 */
export function validCase(x: unknown): CaseResult | undefined {
  const o = plainData(x);
  if (!o || FIELDS.some((f) => !(f in o))) return undefined;
  const g = plainData(o.gates), hit = strArray(o.expectHit), errs = strArray(o.gateErrors);
  if (typeof o.complete !== "boolean") return undefined;
  if (typeof o.name !== "string" || typeof o.pass !== "boolean" || typeof o.kind !== "string" || !KINDS.has(o.kind) || typeof o.direct !== "boolean") return undefined;
  if (!(o.expect === null || typeof o.expect === "string") || !(o.exit === null || (typeof o.exit === "number" && Number.isInteger(o.exit)))) return undefined;
  if (!g || !hit || !errs || Object.values(g).some((v) => v !== "✓" && v !== "✗")) return undefined;
  if (o.why !== undefined && typeof o.why !== "string") return undefined;
  if ((o.pass === true) !== (o.kind === "ok")) return undefined;
  return { name: o.name, pass: o.pass, kind: o.kind as Kind, direct: o.direct, expect: o.expect as string | null, exit: o.exit as number | null, gates: { ...(g as Record<string, "✓" | "✗">) }, expectHit: [...hit], gateErrors: [...errs], complete: o.complete, ...(typeof o.why === "string" ? { why: o.why } : {}) };
}

export function parseCases(out: string): CaseResult[] {
  const res: CaseResult[] = [];
  if (typeof out !== "string") return res;
  for (const line of out.split("\n")) {
    const i = line.indexOf(CASE_MARK);
    if (i < 0) continue;
    let v: unknown;
    try { v = JSON.parse(line.slice(i + CASE_MARK.length)); } catch { continue; /* 残缺行不算 */ }
    const c = validCase(v);
    if (c) res.push(c);
  }
  return res;
}

/** 这条用例结果能不能作为"目标被发现"的证据;能就返回判因,不能返回 undefined */
const fmt = (g: Record<string, string>) => Object.entries(g).map(([k, v]) => `${v}${k.slice(2)}`).join(" ") || "(无)";
/**
 * 这条用例结果能不能作为"目标被发现"的证据;能就返回判因,不能返回 undefined。
 * 前提:用例正常执行(kind 为 verdict/side,不是出错/超时/没结果/崩溃),且原样副本上同一条用例通过(有可比基线)。
 * - 门禁目标:目标门禁不再按预期原因拦下,或由放行变为拦下且不是"门禁自身出错";
 * - RUNNER:退出码或门禁结论集合变了,或副作用检查失败;
 * - DIRECT:直接判定用例在变异下判失败。
 */
export function evidence(target: string[], baseIn: CaseResult | undefined, mutIn: CaseResult): string | undefined {
  // 进门先校验并复制(R5-02):之后只读自己的副本,外部对象不再被访问
  const tg = strArray(target), base = validCase(baseIn), mut = validCase(mutIn);
  if (!tg || !base || !mut) return undefined;
  return judgeValid(tg, base, mut);
}
function judgeValid(target: string[], base: CaseResult, mut: CaseResult): string | undefined {
  if (mut.pass || (mut.kind !== "verdict" && mut.kind !== "side")) return undefined;
  if (!base.pass) return undefined;
  if (mut.direct) return target.includes(DIRECT) && mut.kind === "verdict" ? `直接判定用例在变异下判失败:${(mut.why ?? "").split("\n")[0]!.slice(0, 120)}` : undefined;
  if (target.includes(RUNNER) && (mut.kind === "side" || mut.exit !== base.exit || fmt(mut.gates) !== fmt(base.gates)))
    return `执行器:退出码 ${base.exit}→${mut.exit},门禁 ${fmt(base.gates)} → ${fmt(mut.gates)}${mut.kind === "side" ? `;副作用检查失败:${mut.why ?? ""}` : ""}`;
  for (const g of target) {
    if (g === RUNNER || g === DIRECT) continue;
    // R5-01/R6-01:先排除目标门禁的执行故障与观测缺失,再判有效变化。观测缺失包括基线或变异侧任何一侧输出不完整
    // (缺 CONTENT_HASH、列出门禁数与注册数不符、截断):不论目标门禁是否还在输出里、结论怎么变,都不算发现。
    // 基线里的"门禁自身出错"如果就是预期原因(例如"没有可用沙箱"按 fail-closed 设计成抛错拦下),它是被测行为本身,不排除。
    const expectedError = base.expectHit.includes(g) && base.gateErrors.includes(g);
    if (mut.gateErrors.includes(g) || (base.gateErrors.includes(g) && !expectedError)) continue;
    const before = base.gates[g], after = mut.gates[g];
    if (!base.complete || !mut.complete || (before !== "✓" && before !== "✗")) continue;
    if (after !== "✓" && after !== "✗") {
      // 目标门禁没出现在完整跑完(注册数与列出数一致、有 CONTENT_HASH)的输出里:它根本没被注册执行,是有效变化
      if (after === undefined && mut.exit === (Object.values(mut.gates).includes("✗") ? 1 : 0)) return `${g} 从完整运行的执行列表里消失(没有运行)`;
      continue;
    }
    // 结构化判因要和总退出码一致:任何门禁 ✗ ⇔ 退出 1
    const anyFail = Object.values(mut.gates).includes("✗");
    if (mut.exit !== (anyFail ? 1 : 0)) continue;
    if (base.expectHit.includes(g) && before === "✗" && after === "✓") return `${g} 不再按预期原因「${base.expect}」拦下(✗ → ✓)`;
    if (base.expectHit.includes(g) && after === "✗" && !mut.expectHit.includes(g)) return `${g} 仍拦下但不再是预期原因「${base.expect}」`;
    if (before === "✓" && after === "✗") return `${g} 由放行变为拦下(不是门禁自身出错)`;
  }
  return undefined;
}

export function killedBy(target: string[], base: Map<string, CaseResult>, results: CaseResult[]): { case: string; ev: string } | undefined {
  // R6-02:先用不触发用户代码的宿主原语判 Proxy 与 Map 内部槽(不用 instanceof,它会调用 getPrototypeOf trap);
  // 伪 Map(原型是 Map.prototype 但没有内部槽)也拒收,否则 Map.prototype.get.call 会抛错
  if (types.isProxy(base) || !types.isMap(base)) return undefined;
  const rs = plainArray(results);
  if (!rs) return undefined;
  for (const raw of rs) {
    const r = validCase(raw);
    if (!r) continue;
    const ev = evidence(target, Map.prototype.get.call(base, r.name) as CaseResult | undefined, r);
    if (ev) return { case: r.name, ev };
  }
  return undefined;
}
