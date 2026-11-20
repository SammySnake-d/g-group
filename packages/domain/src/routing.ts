// 少问与少错同时成立(AC-18,R-13):回放报两个数——「补充还是另开」类追问次数、挂错且无人纠正的条数。
// P0 只验两个数都能测出来;阈值待定(验收文档第 9 节),judgeRouting 的阈值全是参数,不给就不判。
export const ROUTE_POLICIES = Object.freeze(["ask-when-ambiguous", "never-ask"] as const);
export type RoutePolicy = (typeof ROUTE_POLICIES)[number];
export type RouteDecision =
  | { readonly kind: "attach"; readonly taskId: string }
  | { readonly kind: "ask"; readonly candidates: readonly string[] }
  | { readonly kind: "none" };
export interface RouteInput {
  readonly anchorTaskId: string | null;
  readonly liveTaskIds: readonly string[];
  /** 联系人(模型)的猜测;never-ask 时按它挂,没有就挂第一件 */
  readonly guess: string | null;
}

const isText = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
const texts = (xs: unknown): xs is readonly string[] => Array.isArray(xs) && xs.every(isText);

export function routeFollowUp(input: RouteInput, policy: RoutePolicy): RouteDecision {
  if (!ROUTE_POLICIES.includes(policy)) throw new TypeError(`未知策略 ${String(policy)}`);
  if (typeof input !== "object" || input === null || !texts(input.liveTaskIds)) throw new TypeError("liveTaskIds 必须是非空字符串数组");
  const live = [...new Set(input.liveTaskIds)];
  if (input.anchorTaskId !== null && live.includes(input.anchorTaskId)) return Object.freeze({ kind: "attach", taskId: input.anchorTaskId });
  if (live.length === 0) return Object.freeze({ kind: "none" });
  if (live.length === 1) return Object.freeze({ kind: "attach", taskId: live[0]! });
  if (policy === "ask-when-ambiguous") return Object.freeze({ kind: "ask", candidates: Object.freeze(live) });
  const pick = input.guess !== null && live.includes(input.guess) ? input.guess : live[0]!;
  return Object.freeze({ kind: "attach", taskId: pick });
}

export interface RoutingRecord {
  readonly msgKey: string;
  readonly decision: RouteDecision;
  readonly truth: string | null;
  readonly corrected: boolean;
}
export interface RoutingReport {
  readonly total: number;
  readonly clarifyAsks: number;
  readonly misattached: number;
  readonly misattachedUncorrected: number;
}

export function misattachedOf(d: RouteDecision, truth: string | null): boolean {
  if (d.kind === "attach") return d.taskId !== truth;
  if (d.kind === "none") return truth !== null;
  return false;
}

export function routingReport(records: readonly RoutingRecord[]): RoutingReport {
  if (!Array.isArray(records)) throw new TypeError("records 必须是数组");
  let clarifyAsks = 0;
  let misattached = 0;
  let misattachedUncorrected = 0;
  const seen = new Set<string>();
  for (const r of records) {
    if (!isText(r.msgKey)) throw new TypeError("msgKey 必须是非空字符串");
    if (seen.has(r.msgKey)) throw new TypeError(`回放里 ${r.msgKey} 重复`);
    seen.add(r.msgKey);
    const d = r.decision;
    if (d.kind === "ask") clarifyAsks++;
    if (misattachedOf(d, r.truth)) {
      misattached++;
      if (!r.corrected) misattachedUncorrected++;
    }
  }
  return Object.freeze({ total: records.length, clarifyAsks, misattached, misattachedUncorrected });
}

export interface RoutingThresholds {
  readonly maxClarifyAsks?: number;
  readonly maxMisattachedUncorrected?: number;
}
export function judgeRouting(report: RoutingReport, thresholds: RoutingThresholds = {}): { readonly pass: boolean; readonly violations: readonly string[] } {
  const v: string[] = [];
  const { maxClarifyAsks, maxMisattachedUncorrected } = thresholds;
  if (maxClarifyAsks !== undefined && report.clarifyAsks > maxClarifyAsks) v.push(`追问 ${report.clarifyAsks} 次,超过阈值 ${maxClarifyAsks}`);
  if (maxMisattachedUncorrected !== undefined && report.misattachedUncorrected > maxMisattachedUncorrected) v.push(`挂错且未纠正 ${report.misattachedUncorrected} 条,超过阈值 ${maxMisattachedUncorrected}`);
  return Object.freeze({ pass: v.length === 0, violations: Object.freeze(v) });
}
