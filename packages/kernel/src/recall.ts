// 被引用消息的确定性 Page-in 规划(需求文档 D06.3 第 2–4 条;验收 AC-06、AC-37 ③)。
// 纯函数:输入本轮要换入的引用清单、联系人可读的会话、被引用消息的最新投影和单轮回读预算,输出逐条召回状态清单。
// 状态只有四种(D06.3 原名):
//   Full               —— 原文全部换入;
//   TruncatedSlice     —— 原文太长,只换入头部切片,带原长与续读游标 nextCursor(显式截断,不是静默);
//   DeletedOrWithdrawn —— 已撤回/删除:只给占位,不带原文、不报原长;
//   AccessDenied       —— 不在本会话(跨会话引用)、联系人不是该会话成员、或本会话里没有这条:机械拒绝,不带原文。
// 预算(D06.3 第 4 条「多条引用的公平预算分配」):先给每条有效引用保底切片 minSliceBytes(原文更短就按原文),
// 再优先补满主回复(primary),剩下的按引用顺序均分(水位法:短的拿够后余量继续分给还没拿够的)。
// 保底切片都装不下时显式失败 over-budget,不悄悄丢掉任何一条。预算单位是 UTF-8 字节,数值待决(需求文档 v3.20 §8.1 待决 13)。
// 输入先过统一的普通数据判定(plain.ts):getter 永不调用,Proxy、类实例、函数一律拒绝;之后只读冻结副本。
import { pushOwn } from "./own.ts";
import { plainData } from "./plain.ts";

export type RecallState = "Full" | "TruncatedSlice" | "DeletedOrWithdrawn" | "AccessDenied";
/** 一条引用:fromRoomId 是发出引用的那条消息所在会话,roomId/seq 是被引用的消息 */
export interface RecallRef {
  readonly fromRoomId: string;
  readonly roomId: string;
  readonly seq: number;
  /** 主回复 reply_to_seq:分预算时优先补满 */
  readonly primary?: boolean;
}
/** 被引用消息的最新投影(按最新编辑版本) */
export interface RecallSource {
  readonly roomId: string;
  readonly seq: number;
  readonly text: string;
  readonly retracted: boolean;
}
export interface RecallPlanInput {
  readonly refs: readonly RecallRef[];
  /** 联系人是成员、可以读的会话 */
  readonly readableRooms: readonly string[];
  readonly sources: readonly RecallSource[];
  /** 单轮回读预算 max_recall(UTF-8 字节) */
  readonly budgetBytes: number;
  /** 每条有效引用的保底切片 min_slice_per_quote(UTF-8 字节) */
  readonly minSliceBytes: number;
}
/** 续读游标:offset 是原文(JS 字符串下标)里还没换入部分的开头,remainingBytes 是剩下的字节数 */
export interface RecallCursor {
  readonly offset: number;
  readonly remainingBytes: number;
}
export interface RecallItem {
  readonly roomId: string;
  readonly seq: number;
  readonly primary: boolean;
  readonly state: RecallState;
  /** Full 为全文,TruncatedSlice 为头部切片,其余为 "" */
  readonly text: string;
  /** text 的 UTF-8 字节数 */
  readonly bytes: number;
  /** 原文 UTF-8 字节数;DeletedOrWithdrawn / AccessDenied 为 null(不泄露原文长度) */
  readonly totalBytes: number | null;
  readonly nextCursor: RecallCursor | null;
}
export type RecallPlanResult =
  | { readonly ok: true; readonly items: readonly RecallItem[]; readonly usedBytes: number; readonly budgetBytes: number }
  | { readonly ok: false; readonly reason: "invalid-input"; readonly detail: string }
  | { readonly ok: false; readonly reason: "over-budget"; readonly need: number; readonly budget: number; readonly quotes: number; readonly detail: string };

const bytesOf = (s: string) => Buffer.byteLength(s, "utf8");
const isRec = (x: unknown): x is Readonly<Record<string, unknown>> => typeof x === "object" && x !== null && !Array.isArray(x);
/** 单行非空字符串:会话 id 不能为空或换行 */
const isLine = (x: unknown): x is string => typeof x === "string" && x !== "" && !/[\r\n\u2028\u2029]/.test(x);
const isNat = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const isPos = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 1;
const invalid = (detail: string) => Object.freeze({ ok: false as const, reason: "invalid-input" as const, detail });
const keyOf = (roomId: string, seq: number) => `${roomId}\u0000${seq}`;

function checkInput(x: unknown): string | undefined {
  if (!isRec(x)) return "召回输入必须是对象";
  if (!Array.isArray(x.refs)) return "refs 必须是数组";
  for (const [i, r] of x.refs.entries()) {
    if (!isRec(r) || !isLine(r.fromRoomId) || !isLine(r.roomId) || !isPos(r.seq)) return `refs[${i}] 必须是 {fromRoomId, roomId: 非空单行字符串, seq: 正整数}`;
    if (r.primary !== undefined && typeof r.primary !== "boolean") return `refs[${i}].primary 必须是布尔值`;
  }
  if (!Array.isArray(x.readableRooms) || !x.readableRooms.every(isLine)) return "readableRooms 必须是非空单行字符串数组";
  if (!Array.isArray(x.sources)) return "sources 必须是数组";
  const seen = new Set<string>();
  for (const [i, s] of x.sources.entries()) {
    if (!isRec(s) || !isLine(s.roomId) || !isPos(s.seq) || typeof s.text !== "string" || typeof s.retracted !== "boolean") {
      return `sources[${i}] 必须是 {roomId, seq: 正整数, text: 字符串, retracted: 布尔}`;
    }
    const k = keyOf(s.roomId, s.seq);
    if (seen.has(k)) return `sources[${i}] 与前面的 ${s.roomId} #${s.seq} 重复`;
    seen.add(k);
  }
  if (!isNat(x.budgetBytes)) return "budgetBytes 必须是非负整数";
  if (!isNat(x.minSliceBytes)) return "minSliceBytes 必须是非负整数";
  return undefined;
}

/** 按 UTF-8 字节上限取头部切片,只在字符(码点)边界上切,不切坏多字节字符 */
function headSlice(text: string, maxBytes: number): { text: string; bytes: number } {
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const n = bytesOf(ch);
    if (used + n > maxBytes) break;
    used += n;
    end += ch.length;
  }
  return { text: text.slice(0, end), bytes: used };
}

interface Candidate {
  readonly primary: boolean;
  readonly text: string;
  readonly total: number;
  alloc: number;
}

/** 引用召回规划:逐条判权限与撤回,在单轮回读预算内给每条有效引用保底切片,主回复优先补满,其余按序均分 */
export function planRecall(input: RecallPlanInput): RecallPlanResult {
  const pl = plainData(input, "召回输入");
  if (!pl.ok) return invalid(`召回输入只接受普通数据对象:${pl.path} ${pl.why}`);
  const bad = checkInput(pl.value);
  if (bad) return invalid(bad);
  const x = pl.value as unknown as RecallPlanInput;
  const readable = new Set(x.readableRooms);
  const sources = new Map<string, RecallSource>();
  for (const s of x.sources) sources.set(keyOf(s.roomId, s.seq), s);

  // 保序去重:同一 (发出会话, 被引用会话, seq) 只出一项,任一重复项是主回复就按主回复算
  const refs: { fromRoomId: string; roomId: string; seq: number; primary: boolean }[] = [];
  for (const r of x.refs) {
    const dup = refs.find((y) => y.fromRoomId === r.fromRoomId && y.roomId === r.roomId && y.seq === r.seq);
    if (dup) dup.primary = dup.primary || r.primary === true;
    else pushOwn(refs, { fromRoomId: r.fromRoomId, roomId: r.roomId, seq: r.seq, primary: r.primary === true });
  }

  // 逐条定状态:先判权限(跨会话、非成员、本会话没有这条),再判撤回;都过了才是候选
  const states: (RecallState | Candidate)[] = [];
  const candidates: Candidate[] = [];
  for (const r of refs) {
    const src = sources.get(keyOf(r.roomId, r.seq));
    if (r.roomId !== r.fromRoomId || !readable.has(r.roomId) || !src) pushOwn(states, "AccessDenied");
    else if (src.retracted) pushOwn(states, "DeletedOrWithdrawn");
    else {
      const c: Candidate = { primary: r.primary, text: src.text, total: bytesOf(src.text), alloc: 0 };
      pushOwn(states, c);
      pushOwn(candidates, c);
    }
  }

  // 保底:每条有效引用先拿 min(原长, minSliceBytes);合计超过预算就显式失败,不丢任何一条
  let need = 0;
  for (const c of candidates) {
    c.alloc = Math.min(c.total, x.minSliceBytes);
    need += c.alloc;
  }
  if (need > x.budgetBytes) {
    return Object.freeze({
      ok: false as const, reason: "over-budget" as const, need, budget: x.budgetBytes, quotes: candidates.length,
      detail: `${candidates.length} 条有效引用的保底切片共 ${need} 字节,回读预算 ${x.budgetBytes} 字节;不悄悄丢掉任何一条,请减少引用或调大回读预算`,
    });
  }
  let left = x.budgetBytes - need;
  // 主回复优先补满
  for (const c of candidates) {
    if (!c.primary || left === 0) continue;
    const more = Math.min(c.total - c.alloc, left);
    c.alloc += more;
    left -= more;
  }
  // 其余按引用顺序均分(水位法):拿够的退出,余量继续分给没拿够的;分不到整份时按顺序每条 1 字节
  let pending = candidates.filter((c) => c.alloc < c.total);
  while (left > 0 && pending.length > 0) {
    const share = Math.floor(left / pending.length);
    for (const c of pending) {
      if (left === 0) break;
      const more = Math.min(c.total - c.alloc, share === 0 ? 1 : share);
      c.alloc += more;
      left -= more;
    }
    pending = pending.filter((c) => c.alloc < c.total);
  }

  const items: RecallItem[] = [];
  let used = 0;
  for (const [i, r] of refs.entries()) {
    const st = states[i]!;
    const base = { roomId: r.roomId, seq: r.seq, primary: r.primary };
    if (typeof st === "string") {
      pushOwn(items, Object.freeze({ ...base, state: st, text: "", bytes: 0, totalBytes: null, nextCursor: null }));
      continue;
    }
    if (st.alloc >= st.total) {
      used += st.total;
      pushOwn(items, Object.freeze({ ...base, state: "Full" as const, text: st.text, bytes: st.total, totalBytes: st.total, nextCursor: null }));
      continue;
    }
    const cut = headSlice(st.text, st.alloc);
    used += cut.bytes;
    const nextCursor = Object.freeze({ offset: cut.text.length, remainingBytes: st.total - cut.bytes });
    pushOwn(items, Object.freeze({ ...base, state: "TruncatedSlice" as const, text: cut.text, bytes: cut.bytes, totalBytes: st.total, nextCursor }));
  }
  return Object.freeze({ ok: true as const, items: Object.freeze(items), usedBytes: used, budgetBytes: x.budgetBytes });
}
