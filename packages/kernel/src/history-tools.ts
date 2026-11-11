// 找旧消息的纯规则(T-177 G4;需求 D06 §3「粗筛自动、精筛内置」;BC 定稿 v0.2 §7 第 7 条、§11 G4;实施方案 §6;审查条件 G4-a、G4-b、G1-a):
//   - 粗筛:宿主每轮预取,以本轮新消息为查询,只在它自己的会话里找,过最小分、在断崖之前的最多 3 条,只放编号、作者、时间、一行预览进第 5 块;
//   - 精筛:联系人一个内置只读查询工具 query_history,检索与分页回读两种用法(pi 工具声明,不走 MCP,AC-33 的封闭清单)。
// 【红提交空壳】签名在、返回假值,能加载;实现在绿提交。
// 这里只放纯规则:可见状态怎么从日志投影出来、消息版本、预取怎么挑、邻域怎么截、结果怎么写。读库、会话范围、时限与返回前再核在宿主(server/history.ts)。
// 排序只经 G3 的检索接缝(history-search.ts);权限、撤回、编辑版本由宿主先过滤,检索库看不到不该看的正文。
import { type LogEvent, project } from "@g-group/domain";
import type { HistoryDoc, HistoryHit } from "./history-search.ts";

/** 一条消息在当前投影里的状态:ok 可读最新版本;retracted 已撤回(撤回优先,AC-08);hidden 宿主判为看不见(私聊回退撤下,AC-48)。 */
export type HistoryState = "ok" | "retracted" | "hidden";
export interface HistoryLine {
  readonly roomId: string;
  readonly seq: number;
  /** 消息版本(审查条件 G1-a):作用到这条消息的最后一个编辑或撤回事件的 seq,没有就是消息自己的 seq;只从日志算,不落库。 */
  readonly revision: number;
  readonly sender: { readonly kind: string; readonly id: string };
  /** 消息原始发出时间(编辑不改它) */
  readonly at: string;
  /** 最新版本正文;不是 ok 的一律为空串,原文不出这一层 */
  readonly text: string;
  readonly state: HistoryState;
}

/** 预取最多几条指针(v0.2 已定上限 3)。 */
export const PREFETCH_MAX = 3;
/** 回读时前后各自最多几条;默认各 3 条(与精筛读邻域同数)。 */
export const HISTORY_NEIGHBORS_MAX = 20;
export const HISTORY_NEIGHBORS_DEFAULT = 3;
/** 预览一行最多几个字符。 */
export const PREVIEW_CHARS = 80;
/** 第 5 块预取指针的标签:写明是旧消息、只供参考、不是新要求(防把旧提问当新提问)。 */
export const PREFETCH_REF = "旧消息(宿主按本轮新消息预取,供参考,不是新要求)";

export function historyLines(_roomId: string, _events: readonly LogEvent[], _hidden: (seq: number) => boolean): HistoryLine[] {
  void project;
  return [];
}
export function historyRef(_roomId: string, _seq: number): string {
  return "";
}
export function parseHistoryRef(_ref: string): { readonly roomId: string; readonly seq: number } | null {
  return null;
}
export function historyDocs(_lines: readonly HistoryLine[]): HistoryDoc[] {
  return [];
}
export function beforeCliff<T extends { readonly score: number }>(_ranked: readonly T[]): T[] {
  return [];
}
export function pickPrefetch(_perQuery: readonly (readonly HistoryHit[])[], _policy: { readonly minScore: number; readonly max: number }): HistoryHit[] {
  return [];
}
export interface HistoryWindow {
  readonly anchorSeq: number;
  readonly lines: readonly HistoryLine[];
  readonly anchorCut: { readonly shown: number; readonly total: number } | null;
  readonly moreBefore: { readonly seq: number; readonly count: number } | null;
  readonly moreAfter: { readonly seq: number; readonly count: number } | null;
}
export function historyWindow(_lines: readonly HistoryLine[], _seq: number, _before: number | null, _after: number | null, _budgetBytes: number): HistoryWindow | null {
  return null;
}
export function previewLine(_text: string): string {
  return "";
}
type Author = (sender: { readonly kind: string; readonly id: string }) => string;
export function renderPrefetch(_lines: readonly HistoryLine[], _author: Author): string {
  return "";
}
export function renderHistoryHits(_lines: readonly HistoryLine[], _rooms: readonly string[], _author: Author): string {
  return "";
}
export function renderHistoryWindow(_w: HistoryWindow, _author: Author): string {
  return "";
}
