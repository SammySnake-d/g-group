// 【红提交空壳】签名在、返回假值,能加载;实现在绿提交。
// 找旧消息的宿主一侧(T-177 G4;需求 D06 §3「粗筛自动、精筛内置」):每轮预取(粗筛,主机自动有界带入第 5 块)与本轮查询口 query_history
// (精筛:一个宿主注册的查询工具,检索与分页回读两种用法)。规则在 kernel/history-tools.ts,这里管读库、范围、时限与返回前再核。
// 「当前会话」= 这一轮新输入所在的会话集合(审查条件 G4-a):预取、检索、回读都只在这个集合里;联系人在别的群或私聊里的历史这一版不搜。
// 先形成可见语料再交检索(G4-01):只收联系人此刻仍是成员(且不在移出中)的会话里、没撤回、没被私聊回退撤下的消息,正文取最新版本。
// 返回前再核(G4-02):检索之后按当前日志重新投影,已撤回、已回退、已移出的命中去掉,编辑过的改读当前版本;正文只从当前投影读,不用交给检索时的副本。
// 预取有时限(G4-b):超时或出错不挡这一轮,只留诊断;每条新消息只搜它自己的会话,不改前缀、不动 read_seq / processed_seq。
import type { HistoryDoc, HistoryHit, Inbound, RoundTools } from "@g-group/kernel";
import type { Db } from "./db.ts";

/** 检索实现:默认是 G3 的接缝 searchHistory;可同步可异步。 */
export type HistorySearchFn = (docs: readonly HistoryDoc[], query: string, limit: number) => readonly HistoryHit[] | Promise<readonly HistoryHit[]>;

/** 预取参数。时限与最小分都是待校准的占位(实施方案 §6:检索最小分 / 断崖参数待校准;3 条是 v0.2 已定上限)。 */
export interface HistoryPrefetchOptions {
  readonly timeoutMs?: number;
  readonly minScore?: number;
}
export const PREFETCH_TIMEOUT_MS = 1500;
export const PREFETCH_MIN_SCORE = 0;
/** 检索默认与最多返回几条 */
export const SEARCH_LIMIT_DEFAULT = 5;
export const SEARCH_LIMIT_MAX = 10;

export interface HistoryDeps {
  readonly db: Db;
  /** 联系人此刻还能读的会话:是成员、且不在移出中 */
  readonly readableRooms: (contactId: string) => ReadonlySet<string>;
  readonly author: (sender: { readonly kind: string; readonly id: string }) => string;
  readonly search: HistorySearchFn;
  /** 单轮回读预算(回读的正文字节上限) */
  readonly recallBudgetBytes: () => number;
  readonly report: (what: string, detail: unknown) => void;
}

/** 预取结果:要放进第 5 块的指针(没有就空),状态进诊断。 */
export interface PrefetchOutcome {
  readonly pointers: readonly { readonly ref: string; readonly text: string }[];
  readonly status: "ok" | "empty" | "timeout" | "error";
}

export class HistoryAccess {
  private readonly d: HistoryDeps;
  constructor(deps: HistoryDeps) {
    this.d = deps;
  }
  tools(_contactId: string, _scope: ReadonlySet<string>): Required<Pick<RoundTools, "queryHistory">> {
    void this.d;
    return { queryHistory: async () => null };
  }
  async prefetch(_contactId: string, _fresh: readonly Inbound[], _inContext: ReadonlySet<string>, _opts: HistoryPrefetchOptions): Promise<PrefetchOutcome> {
    return { pointers: [], status: "empty" };
  }
}
