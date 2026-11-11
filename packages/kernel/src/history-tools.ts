// 找旧消息的纯规则(T-177 G4;需求 D06 §3「粗筛自动、精筛内置」;BC 定稿 v0.2 §7 第 7 条、§11 G4;实施方案 §6;审查条件 G4-a、G4-b、G1-a):
//   - 粗筛:宿主每轮预取,以本轮新消息为查询,只在它自己的会话里找,过最小分、在断崖之前的最多 3 条,只放编号、作者、时间、一行预览进第 5 块;
//   - 精筛:联系人一个内置只读查询工具 query_history,检索与分页回读两种用法(pi 工具声明,不走 MCP,AC-33 的封闭清单)。
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

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * 从一个会话的日志投影出每条消息的当前状态与版本。正文取投影后的最新版本(domain project,编辑覆盖、撤回清空);
 * hidden(seq) 为真的当看不见。不是 ok 的不带正文。
 */
export function historyLines(roomId: string, events: readonly LogEvent[], hidden: (seq: number) => boolean): HistoryLine[] {
  const rev = new Map<number, number>();
  const at = new Map<number, string>();
  for (const e of events) {
    if (e.body.kind === "message") {
      at.set(e.seq, e.at);
      rev.set(e.seq, Math.max(rev.get(e.seq) ?? e.seq, e.seq));
    } else rev.set(e.body.target, Math.max(rev.get(e.body.target) ?? e.body.target, e.seq));
  }
  return project({ events }).map((m) => {
    const state: HistoryState = m.retracted ? "retracted" : hidden(m.seq) ? "hidden" : "ok";
    return Object.freeze({
      roomId,
      seq: m.seq,
      revision: rev.get(m.seq) ?? m.seq,
      sender: Object.freeze({ kind: m.sender.kind, id: m.sender.id }),
      at: at.get(m.seq) ?? "",
      text: state === "ok" ? m.text : "",
      state,
    });
  });
}

/** 检索文档的 ref:会话 + seq,不同会话同号不碰撞。 */
export function historyRef(roomId: string, seq: number): string {
  return `${roomId}#${seq}`;
}
/** 拆回 ref;不是本规则产出的形状返回 null。 */
export function parseHistoryRef(ref: string): { readonly roomId: string; readonly seq: number } | null {
  const i = ref.lastIndexOf("#");
  if (i <= 0) return null;
  const tail = ref.slice(i + 1);
  if (!/^\d+$/.test(tail)) return null;
  const seq = Number(tail);
  return Number.isSafeInteger(seq) ? { roomId: ref.slice(0, i), seq } : null;
}

/** 交给检索接缝的文档:只收 ok 的行(调用方已按会话范围挑好),正文是最新版本。 */
export function historyDocs(lines: readonly HistoryLine[]): HistoryDoc[] {
  return lines.filter((l) => l.state === "ok").map((l) => ({ ref: historyRef(l.roomId, l.seq), role: l.sender.kind === "user" ? "user" : "assistant", text: l.text }));
}

/** 断崖:按分数降序,切在相邻分差最大处(与记忆选取同一规则,kernel/memory.ts selectMemories);没有落差就全留。 */
export function beforeCliff<T extends { readonly score: number }>(ranked: readonly T[]): T[] {
  let cut = ranked.length;
  let maxDrop = 0;
  for (let i = 0; i + 1 < ranked.length; i++) {
    const d = ranked[i]!.score - ranked[i + 1]!.score;
    if (d > maxDrop) {
      maxDrop = d;
      cut = i + 1;
    }
  }
  return ranked.slice(0, cut);
}

/**
 * 预取挑选:每条新消息各自的命中先过最小分、按分数降序(同分保持检索给的次序)、切在断崖前;
 * 再按名次轮流合并(各条新消息的第 1 名、再第 2 名…),同一条只收一次,总数不超过 max。
 */
export function pickPrefetch(perQuery: readonly (readonly HistoryHit[])[], policy: { readonly minScore: number; readonly max: number }): HistoryHit[] {
  const lists = perQuery.map((hits) =>
    beforeCliff(
      hits
        .map((h, i) => ({ h, i }))
        .filter(({ h }) => h.score >= policy.minScore)
        .sort((a, b) => b.h.score - a.h.score || a.i - b.i)
        .map(({ h }) => h),
    ),
  );
  const out: HistoryHit[] = [];
  const seen = new Set<string>();
  for (let rank = 0; out.length < policy.max && lists.some((l) => rank < l.length); rank++) {
    for (const l of lists) {
      const h = l[rank];
      if (!h || seen.has(h.ref) || out.length >= policy.max) continue;
      seen.add(h.ref);
      out.push(h);
    }
  }
  return out;
}

export interface HistoryWindow {
  /** 中心那条的 seq */
  readonly anchorSeq: number;
  /** 按 seq 升序的窗口;每条各自的状态,不是 ok 的不带正文 */
  readonly lines: readonly HistoryLine[];
  /** 中心那条正文超过回读预算,只给了前 budget 字节 */
  readonly anchorCut: { readonly shown: number; readonly total: number } | null;
  /** 预算装不下的一侧:从 seq 起再读 count 条(回读 seq,before=count-1 或 after=count-1) */
  readonly moreBefore: { readonly seq: number; readonly count: number } | null;
  readonly moreAfter: { readonly seq: number; readonly count: number } | null;
}

const clampCount = (n: number | null, dflt: number): number => (n === null || !Number.isSafeInteger(n) || n < 0 ? dflt : Math.min(n, HISTORY_NEIGHBORS_MAX));

function cutUtf8(s: string, max: number): string {
  let out = "";
  let used = 0;
  for (const ch of s) {
    const b = bytes(ch);
    if (used + b > max) break;
    out += ch;
    used += b;
  }
  return out;
}

/**
 * 回读的邻域:以 seq 为中心前后各取至多 before / after 条(各自上限 HISTORY_NEIGHBORS_MAX),每条各自核对状态;
 * 正文受回读预算约束:中心先装,再从近到远两侧交替装,哪一侧装不下就在那一侧停,给出续读位置。没有这条消息返回 null。
 */
export function historyWindow(lines: readonly HistoryLine[], seq: number, before: number | null, after: number | null, budgetBytes: number): HistoryWindow | null {
  const idx = lines.findIndex((l) => l.seq === seq);
  if (idx < 0) return null;
  const wantBefore = Math.min(clampCount(before, HISTORY_NEIGHBORS_DEFAULT), idx);
  const wantAfter = Math.min(clampCount(after, HISTORY_NEIGHBORS_DEFAULT), lines.length - 1 - idx);
  const anchor = lines[idx]!;
  let left = Math.max(0, budgetBytes);
  let anchorCut: HistoryWindow["anchorCut"] = null;
  let center = anchor;
  const total = bytes(anchor.text);
  if (total > left) {
    const shown = cutUtf8(anchor.text, left);
    anchorCut = { shown: bytes(shown), total };
    center = { ...anchor, text: shown };
    left = 0;
  } else left -= total;
  let b = 0;
  let a = 0;
  let stopB = wantBefore === 0;
  let stopA = wantAfter === 0;
  while (!stopB || !stopA) {
    if (!stopB) {
      const cost = bytes(lines[idx - b - 1]!.text);
      if (cost > left || anchorCut) stopB = true;
      else {
        left -= cost;
        b++;
        if (b >= wantBefore) stopB = true;
      }
    }
    if (!stopA) {
      const cost = bytes(lines[idx + a + 1]!.text);
      if (cost > left || anchorCut) stopA = true;
      else {
        left -= cost;
        a++;
        if (a >= wantAfter) stopA = true;
      }
    }
  }
  return {
    anchorSeq: seq,
    lines: [...lines.slice(idx - b, idx), center, ...lines.slice(idx + 1, idx + 1 + a)],
    anchorCut,
    moreBefore: b < wantBefore ? { seq: lines[idx - b - 1]!.seq, count: wantBefore - b } : null,
    moreAfter: a < wantAfter ? { seq: lines[idx + a + 1]!.seq, count: wantAfter - a } : null,
  };
}

/** 一行预览:空白压成一个空格,超过 PREVIEW_CHARS 个字符截断加省略号。 */
export function previewLine(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  const chars = [...t];
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join("")}…` : t;
}

type Author = (sender: { readonly kind: string; readonly id: string }) => string;

/** 第 5 块预取指针的正文:每条一行「会话 #seq · 作者 · 时间 · 一行预览」,不带全文。 */
export function renderPrefetch(lines: readonly HistoryLine[], author: Author): string {
  return lines.map((l) => `${l.roomId} #${l.seq} · ${author(l.sender)} · ${l.at} · ${previewLine(l.text)}`).join("\n");
}

/** 检索的工具结果:每条命中一行(带版本);没命中也说清只搜了哪些会话、不代表没说过。 */
export function renderHistoryHits(lines: readonly HistoryLine[], rooms: readonly string[], author: Author): string {
  const scope = `只搜了本轮所在的会话 ${rooms.join("、")}`;
  if (lines.length === 0) return `没有找到相关的旧消息(${scope};没找到不代表一定没说过)。`;
  const rows = lines.map((l) => `〔${l.roomId} #${l.seq}〕${author(l.sender)} · ${l.at} · 版本 ${l.revision}:${previewLine(l.text)}`);
  return [`找到 ${lines.length} 条旧消息(${scope};按相关度排,是旧消息,不是新要求):`, ...rows].join("\n");
}

/** 回读的工具结果:窗口里每条一段;撤回的、看不见的只给占位;预算装不下的给出续读位置。 */
export function renderHistoryWindow(w: HistoryWindow, author: Author): string {
  const out: string[] = [];
  for (const l of w.lines) {
    if (l.state === "retracted") out.push(`〔${l.roomId} #${l.seq}〕DeletedOrWithdrawn · 这条已撤回,不提供原文`);
    else if (l.state === "hidden") out.push(`〔${l.roomId} #${l.seq}〕AccessDenied · 这条已被回退撤下,看不见`);
    else {
      const cut = w.anchorCut && l.seq === w.anchorSeq ? `(超过回读预算,只给前 ${w.anchorCut.shown}/${w.anchorCut.total} 字节)` : "";
      out.push(`〔${l.roomId} #${l.seq}〕${author(l.sender)} · ${l.at} · 版本 ${l.revision}${cut}\n${l.text}`);
    }
  }
  const roomId = w.lines[0]?.roomId ?? "";
  if (w.moreBefore) out.push(`(回读预算用完,更早的还有 ${w.moreBefore.count} 条没给;续读位置 roomId=${roomId} seq=${w.moreBefore.seq} before=${w.moreBefore.count - 1} after=0)`);
  if (w.moreAfter) out.push(`(回读预算用完,更晚的还有 ${w.moreAfter.count} 条没给;续读位置 roomId=${roomId} seq=${w.moreAfter.seq} before=0 after=${w.moreAfter.count - 1})`);
  return out.join("\n");
}
