// 少问与少错同时成立(AC-18,R-13):回放报两个数——「补充还是另开」类追问次数、挂错且无人纠正的条数。
// P0 只验两个数都能测出来;阈值待定(验收文档第 9 节),judgeRouting 的阈值全是参数,不给就不判。
// routeFollowUp 是第一台 E1 TaskFollowUp 的机械兜底(需求文档第一台表 M1 行):有引用锚点直达;只有一件在途直通;
// 两件以上在途又没锚点时,ask-when-ambiguous 顺口问一句,never-ask 按猜测直接挂(对照用的坏实现)。
export const ROUTE_POLICIES = Object.freeze(["ask-when-ambiguous", "never-ask"] as const);
export type RoutePolicy = (typeof ROUTE_POLICIES)[number];
export type RouteDecision =
  | { readonly kind: "attach"; readonly taskId: string }
  | { readonly kind: "ask"; readonly candidates: readonly string[] }
  | { readonly kind: "none" };
export interface RouteInput {
  /** 消息回复/引用到的任务(引用锚点);没有为 null */
  readonly anchorTaskId: string | null;
  /** 同一会话里这位联系人在途的任务 */
  readonly liveTaskIds: readonly string[];
  /** 联系人(模型)的猜测;never-ask 时按它挂,没有就挂第一件 */
  readonly guess: string | null;
}

const isText = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
const texts = (xs: unknown): xs is readonly string[] => Array.isArray(xs) && xs.every(isText);

export function routeFollowUp(input: RouteInput, policy: RoutePolicy): RouteDecision {

  throw new Error("未实现");
}

/** 回放里的一条补充:系统怎么处理的、标注的正确归属、事后有没有被纠正(E5 改挂/撤销)。 */
export interface RoutingRecord {
  readonly msgKey: string;
  readonly decision: RouteDecision;
  /** 标注的正确归属;null 表示不属于任何任务(闲聊) */
  readonly truth: string | null;
  /** 挂错之后有没有人用 E5 纠正过来 */
  readonly corrected: boolean;
}
export interface RoutingReport {
  readonly total: number;
  /** 「补充还是另开」类追问次数 */
  readonly clarifyAsks: number;
  /** 挂错(挂到的不是标注归属)的条数,不论是否被纠正 */
  readonly misattached: number;
  /** 挂错且无人纠正的条数(R-13) */
  readonly misattachedUncorrected: number;
}

/** 这条补充算不算挂错:挂到的不是标注归属;没挂(none)而标注属于某任务也算(该挂没挂);问过就由用户答复定归属,不算。 */
export function misattachedOf(d: RouteDecision, truth: string | null): boolean {

  throw new Error("未实现");
}

export function routingReport(records: readonly RoutingRecord[]): RoutingReport {

  throw new Error("未实现");
}

export interface RoutingThresholds {
  readonly maxClarifyAsks?: number;
  readonly maxMisattachedUncorrected?: number;
}
/** 按给定阈值判;阈值待用户拍板,没给的那个数只报不判。 */
export function judgeRouting(report: RoutingReport, thresholds: RoutingThresholds = {}): { readonly pass: boolean; readonly violations: readonly string[] } {

  throw new Error("未实现");
}
