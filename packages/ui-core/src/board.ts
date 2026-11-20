// 进展全景看板的纯逻辑(需求 U83、D21.3 第 9 项、D26 §3 / §8.4–8.6;用户 #806、#872、#877)。
// 台账字段 → 状态分组 → 过滤 → 分组排序 → 自适应布局 → 悬停血缘。零依赖,渲染层只负责画。
// 按我们的概念加一级(#806):
// 不含花费 / 额度(#877)。

/** D26 §3 固定状态集合 */
export type UnitState = "queued" | "running" | "waiting_user" | "done" | "failed" | "interrupted" | "orphaned";

/** D26 §8.4 原因类别 */
export type ReasonClass =
  | "upstream_unavailable" | "rate_limited" | "no_response" | "stream_dropped" | "stalled"
  | "context_overflow" | "auth_or_quota" | "invalid_request" | "harness_crashed" | "session_lost"
  | "platform_refused" | "user_stopped" | "unknown";

/** mirasim 的 wait / run / failed / done,加上和失败分开的「已停止」(D26 §8.5) */
export type Bucket = "wait" | "run" | "failed" | "stopped" | "done";
export type BucketFilter = Bucket | "all";
/** 顶部状态块的顺序 */
export const BUCKET_TILES: readonly BucketFilter[] = ["all", "wait", "run", "failed", "stopped", "done"];
const RANK: Record<Bucket, number> = { wait: 0, run: 1, failed: 2, stopped: 3, done: 4 };
/** 子任务列里的顺序:在跑的在最上面 */
const SUB_RANK: Record<Bucket, number> = { run: 0, failed: 1, wait: 2, stopped: 3, done: 4 };

export interface BoardConv { readonly id: string; readonly kind: "group" | "dm"; readonly name: string; readonly members: readonly string[] }
export interface Threshold { readonly minutes: number; readonly custom: boolean; readonly by?: string }

export interface ComputeUnit {
  readonly id: string;
  readonly conv: string;
  readonly owner: string;
  readonly title: string;
  readonly model: string;
  readonly upstream: string;
  readonly state: UnitState;
  readonly reason?: ReasonClass;
  readonly reasonRaw?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly lastProgressAt: number;
  readonly turns: number;
  /** 来源消息 #seq(D21#3) */
  readonly seq: number;
  readonly asking?: string;
  readonly askMsg?: string;
  readonly queuedBehind?: string;
  readonly threshold?: Threshold;
}

export type SubKind = "subagent" | "subchat" | "job";
export interface SubUnit {
  readonly id: string;
  readonly parent: string;
  readonly kind: SubKind;
  readonly title: string;
  readonly state: UnitState;
  readonly reason?: ReasonClass;
  readonly reasonRaw?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly lastProgressAt: number;
}

export interface BoardWorld {
  readonly now: number;
  readonly people: Readonly<Record<string, { readonly name: string }>>;
  readonly convs: readonly BoardConv[];
  readonly computes: readonly ComputeUnit[];
  readonly subs: readonly SubUnit[];
}

export function bucketOf(u: { readonly state: UnitState; readonly reason?: ReasonClass | undefined }): Bucket {
  switch (u.state) {
    case "waiting_user": return "wait";
    case "failed": case "orphaned": return "failed";
    case "interrupted": return u.reason === "user_stopped" ? "stopped" : "failed";
    case "running": case "queued": return "run";
    case "done": return "done";
  }
}


export const minutesOf = (ms: number) => Math.max(0, Math.round(ms / 60000));

export function formatSpan(ms: number): string {
  const m = minutesOf(ms);
  if (m < 1) return "不到 1 分";
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}

export function formatClock(t: number, now: number): string {
  const d = new Date(t), n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86400000);
  return diff === 0 ? hm : diff === 1 ? `昨天 ${hm}` : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}

export const STALL_MINUTES = 15;
/** D26 §8.5:在跑但超过阈值一半没进展,返回已无进展的分钟数;否则 null */
export function stallMinutes(u: { readonly state: UnitState; readonly lastProgressAt: number }, now: number, threshold = STALL_MINUTES): number | null {
  if (u.state !== "running") return null;
  const idle = minutesOf(now - u.lastProgressAt);
  return idle >= threshold / 2 ? idle : null;
}


export type BoardRange = "today" | "7d" | "30d" | "all";
export type BoardGroupBy = "room" | "contact";
export interface BoardFilter { readonly groupBy: BoardGroupBy; readonly bucket: BucketFilter; readonly range: BoardRange; readonly query: string }

export function rangeStart(r: BoardRange, now: number): number | null {
  if (r === "all") return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (r === "today" ? 0 : r === "7d" ? 6 : 29));
  return d.getTime();
}

export interface BoardFact { readonly unit: ComputeUnit; readonly group: Bucket; readonly lastAt: number; readonly subs: readonly SubUnit[]; readonly conv: BoardConv }

/** 台账 → 事实:带上状态分组、最近活动时刻、排好序的子任务;找不到所属对话的单元丢弃 */
export function boardFacts(w: BoardWorld): BoardFact[] {
  const convs = new Map(w.convs.map((c) => [c.id, c]));
  const out: BoardFact[] = [];
  for (const u of w.computes) {
    const conv = convs.get(u.conv);
    if (!conv) continue;
    const subs = w.subs
      .filter((s) => s.parent === u.id)
      .sort((a, b) => SUB_RANK[bucketOf(a)] - SUB_RANK[bucketOf(b)] || b.startedAt - a.startedAt);
    out.push({ unit: u, group: bucketOf(u), lastAt: u.endedAt ?? Math.max(u.lastProgressAt, u.startedAt), conv, subs });
  }
  return out;
}

/** 时间和搜索(不含状态):顶部统计用这一层。在跑和等你的永远算在时间范围内 */
export function filterFacts(all: readonly BoardFact[], f: BoardFilter, w: BoardWorld): BoardFact[] {
  const from = rangeStart(f.range, w.now);
  const q = f.query.trim().toLowerCase();
  return all.filter((x) => {
    if (from !== null && x.lastAt < from && x.group !== "run" && x.group !== "wait") return false;
    if (!q) return true;
    const hay = [x.unit.title, x.unit.model, x.unit.upstream, w.people[x.unit.owner]?.name ?? "", x.conv.name, ...x.subs.map((s) => s.title)];
    return hay.join("\n").toLowerCase().includes(q);
  });
}

export interface BoardCounts { all: number; wait: number; run: number; failed: number; stopped: number; done: number; turns: number; subsRunning: number }
export function countFacts(list: readonly BoardFact[]): BoardCounts {
  const c: BoardCounts = { all: list.length, wait: 0, run: 0, failed: 0, stopped: 0, done: 0, turns: 0, subsRunning: 0 };
  for (const x of list) {
    c[x.group]++;
    c.turns += x.unit.turns;
    for (const s of x.subs) if (s.kind !== "subchat" && s.state === "running") c.subsRunning++;
  }
  return c;
}

/** 同一群里同一上游同一原因失败 ≥2 个,合成一条群级提示(D26 §8.5、AC-36 共享熔断)。owner 只在都是同一个人时保留 */
export interface GroupHint { readonly conv: string; readonly owner?: string; readonly reason: ReasonClass; readonly upstream: string; readonly count: number }
export function groupHints(list: readonly BoardFact[]): GroupHint[] {
  const out = new Map<string, { conv: string; owner: string | null; reason: ReasonClass; upstream: string; count: number }>();
  for (const x of list) {
    if (x.group !== "failed" || !x.unit.reason || x.conv.kind !== "group") continue;
    const k = `${x.conv.id}|${x.unit.reason}|${x.unit.upstream}`;
    const h = out.get(k);
    if (h) {
      h.count++;
      if (h.owner !== x.unit.owner) h.owner = null;
    } else out.set(k, { conv: x.conv.id, owner: x.unit.owner, reason: x.unit.reason, upstream: x.unit.upstream, count: 1 });
  }
  return [...out.values()]
    .filter((h) => h.count >= 2)
    .map(({ owner, ...h }) => (owner === null ? h : { ...h, owner }));
}


export const LEAF_FOLD = 8;
const byRank = (a: BoardFact, b: BoardFact) => RANK[a.group] - RANK[b.group] || b.lastAt - a.lastAt;
const best = (xs: readonly BoardFact[]) => Math.min(...xs.map((x) => RANK[x.group]));
const latest = (xs: readonly BoardFact[]) => Math.max(...xs.map((x) => x.lastAt));

export interface BoardLeaf { readonly key: string; readonly person: string; readonly facts: readonly BoardFact[]; readonly hidden: number; readonly overflow: boolean }
export interface BoardRoot {
  readonly key: string;
  readonly by: BoardGroupBy;
  readonly conv?: BoardConv;
  readonly person?: string;
  readonly leaves: readonly BoardLeaf[];
  readonly all: readonly BoardFact[];
  readonly hints: readonly GroupHint[];
}
export type Unfolded = (key: string) => boolean;

function leaf(key: string, person: string, xs: readonly BoardFact[], unfolded: Unfolded): BoardLeaf {
  const sorted = [...xs].sort(byRank);
  const shown = unfolded(`cp:${key}`) ? sorted : sorted.slice(0, LEAF_FOLD);
  return { key, person, facts: shown, hidden: sorted.length - shown.length, overflow: sorted.length > LEAF_FOLD };
}

function bucketize(list: readonly BoardFact[], key: (x: BoardFact) => string): [string, BoardFact[]][] {
  const m = new Map<string, BoardFact[]>();
  for (const x of list) {
    const k = key(x);
    const arr = m.get(k);
    if (arr) arr.push(x);
    else m.set(k, [x]);
  }
  return [...m.entries()];
}

/** 按对话:群聊下面再按联系人分;私聊只有一个叶子。按联系人:每人一个根。组之间按「最急的状态 → 最近活动 → 数量」排 */
export function groupBoard(list: readonly BoardFact[], by: BoardGroupBy, unfolded: Unfolded, hints: readonly GroupHint[]): BoardRoot[] {
  return bucketize(list, (x) => (by === "room" ? x.conv.id : x.unit.owner))
    .sort(([, a], [, b]) => best(a) - best(b) || (by === "room" ? latest(b) - latest(a) : 0) || b.length - a.length || latest(b) - latest(a))
    .map(([k, xs]): BoardRoot => {
      if (by === "contact") return { key: `p:${k}`, by, person: k, all: xs, hints: [], leaves: [leaf(`p:${k}`, k, xs, unfolded)] };
      const conv = xs[0]!.conv;
      if (conv.kind === "dm") return { key: `r:${k}`, by, conv, all: xs, hints: [], leaves: [leaf(`r:${k}`, conv.members[0] ?? xs[0]!.unit.owner, xs, unfolded)] };
      const leaves = bucketize(xs, (x) => x.unit.owner)
        .sort(([, a], [, b]) => best(a) - best(b) || latest(b) - latest(a) || b.length - a.length)
        .map(([p, ys]) => leaf(`c:${k}:${p}`, p, ys, unfolded));
      return { key: `r:${k}`, by, conv, all: xs, hints: hints.filter((h) => h.conv === k), leaves };
    });
}

export function aggregate(xs: readonly BoardFact[]) {
  const a = { all: xs.length, run: 0, wait: 0, failed: 0 };
  for (const x of xs) if (x.group === "run" || x.group === "wait" || x.group === "failed") a[x.group]++;
  return a;
}


export const BOARD_SIZES = { padX: 20, padY: 18, pW: 196, g1: 60, g2: 44, iW: 236, card: 68, cardGap: 10, inH: 26, inGap: 4, moreH: 30, groupGap: 28, pH: 52, insideMax: 6 } as const;
export const CONTACT_SIZES = { cW: 196, g0: 44, contactGap: 18, hintH: 26, hintGap: 6 } as const;
const CARDS_MIN = 300, CARDS_MAX = 560, CARDS_MAX_WIDE = 760;

export function elbowPath(x1: number, y1: number, spine: number, x2: number, y2: number): string {
  const dy = y2 - y1;
  if (Math.abs(dy) < 1) return `M ${x1} ${y1} H ${x2}`;
  const r = Math.min(8, Math.abs(dy) / 2, (spine - x1) / 1.5, (x2 - spine) / 1.5);
  const s = dy > 0 ? 1 : -1;
  return `M ${x1} ${y1} H ${spine - r} Q ${spine} ${y1} ${spine} ${y1 + s * r} V ${y2 - s * r} Q ${spine} ${y2} ${spine + r} ${y2} H ${x2}`;
}

export interface BoardBox { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface LayoutRoot { readonly id: string; readonly root: BoardRoot; readonly box: BoardBox }
export interface LayoutContact { readonly id: string; readonly root: BoardRoot; readonly leaf: BoardLeaf; readonly box: BoardBox }
export interface LayoutCard { readonly id: string; readonly fact: BoardFact; readonly box: BoardBox }
export interface LayoutInside { readonly id: string; readonly owner: string; readonly item: SubUnit; readonly box: BoardBox }
export interface LayoutMore { readonly key: string; readonly n: number; readonly box: BoardBox; readonly unfold: boolean; readonly from: number }
export interface LayoutHint { readonly id: string; readonly hint: GroupHint; readonly box: BoardBox }
export interface BoardLink { readonly id: string; readonly from: string; readonly to: string; readonly d: string; readonly group: Bucket | "idle"; readonly more?: boolean }
export interface BoardLayout {
  width: number;
  height: number;
  readonly insideColumn: boolean;
  readonly roots: LayoutRoot[];
  readonly contacts: LayoutContact[];
  readonly cards: LayoutCard[];
  readonly inside: LayoutInside[];
  readonly more: LayoutMore[];
  readonly hints: LayoutHint[];
  readonly links: BoardLink[];
  /** 节点的深度优先顺序(根 → 群级提示 → 联系人 → 卡片 → 子任务 → 折叠条):渲染按它排,键盘 Tab 顺着层级走 */
  readonly order: string[];
  readonly columns: { readonly root: number; readonly contact: number | null; readonly cards: number; readonly inside: number | null; readonly cardsW: number };
}

const topOf = (xs: readonly BoardFact[]): Bucket => xs.reduce<Bucket>((b, x) => (RANK[x.group] < RANK[b] ? x.group : b), "done");

export function layoutBoard(roots: readonly BoardRoot[], width: number, unfolded: Unfolded, pin: (s: SubUnit) => boolean = () => false): BoardLayout {
  const S = BOARD_SIZES, C = CONTACT_SIZES;
  const byRoom = roots[0]?.by === "room";
  const hasContact = byRoom && roots.some((r) => r.conv?.kind === "group");
  const extra = hasContact ? C.g0 + C.cW : 0;
  const hasSubs = roots.some((r) => r.all.some((x) => x.subs.length > 0));
  const insideColumn = hasSubs && width >= S.padX * 2 + S.pW + extra + S.g1 + CARDS_MIN + S.g2 + S.iW;
  const free = width - S.padX * 2 - S.pW - extra - S.g1 - (insideColumn ? S.g2 + S.iW : 0);
  const r = Math.max(CARDS_MIN, Math.min(insideColumn ? CARDS_MAX : CARDS_MAX_WIDE, free));
  const x0 = S.padX, x1 = x0 + S.pW + C.g0, l = x0 + S.pW + extra + S.g1, c = l + r + S.g2;
  const L: BoardLayout = {
    width: Math.max(width, l + r + (insideColumn ? S.g2 + S.iW : 0) + S.padX), height: 0, insideColumn,
    roots: [], contacts: [], cards: [], inside: [], more: [], hints: [], links: [], order: [],
    columns: { root: x0, contact: hasContact ? x1 : null, cards: l, inside: insideColumn ? c : null, cardsW: r },
  };

  const placeInside = (h: BoardFact, id: string, u: number, k: number): number => {
    const over = h.subs.length > S.insideMax;
    const open = unfolded(`in:${h.unit.id}`);
    const shown = over && !open ? [...h.subs.slice(0, S.insideMax), ...h.subs.slice(S.insideMax).filter(pin)] : h.subs;
    const rows = shown.length + (over ? 1 : 0);
    const total = rows * S.inH + (rows - 1) * S.inGap;
    let y = total <= S.card ? u + (S.card - total) / 2 : u;
    const first = y, spine = l + r + S.g2 / 2;
    for (const s of shown) {
      const iid = `i:${h.unit.id}:${s.id}`;
      L.inside.push({ id: iid, owner: h.unit.id, item: s, box: { x: c, y, w: S.iW, h: S.inH } });
      L.order.push(iid);
      L.links.push({ id: `${id}>${iid}`, from: id, to: iid, d: elbowPath(l + r, k, spine, c, y + S.inH / 2), group: bucketOf(s) });
      y += S.inH + S.inGap;
    }
    if (over) {
      const mid = `m:in:${h.unit.id}`;
      const hidden = h.subs.length - shown.length;
      L.more.push({ key: `in:${h.unit.id}`, n: hidden, box: { x: c, y, w: S.iW, h: S.inH }, unfold: hidden > 0, from: first });
      L.order.push(mid);
      L.links.push({ id: `${id}>${mid}`, from: id, to: mid, d: elbowPath(l + r, k, spine, c, y + S.inH / 2), group: "idle", more: true });
      y += S.inH + S.inGap;
    }
    return Math.max(S.card, y - S.inGap - u);
  };

  const placeLeaf = (lf: BoardLeaf, from: string, fromX: number, fromY: number, spine: number, start: number): number => {
    let u = start;
    for (const h of lf.facts) {
      const id = `s:${h.unit.id}`, k = u + S.card / 2;
      L.cards.push({ id, fact: h, box: { x: l, y: u, w: r, h: S.card } });
      L.order.push(id);
      L.links.push({ id: `${from}>${id}`, from, to: id, d: elbowPath(fromX, fromY, spine, l, k), group: h.group });
      const used = insideColumn && h.subs.length ? placeInside(h, id, u, k) : S.card;
      u += used + S.cardGap;
    }
    if (lf.overflow) {
      const mid = `m:cp:${lf.key}`;
      L.more.push({ key: `cp:${lf.key}`, n: lf.hidden, box: { x: l, y: u, w: r, h: S.moreH }, unfold: lf.hidden > 0, from: start });
      L.order.push(mid);
      L.links.push({ id: `${from}>${mid}`, from, to: mid, d: elbowPath(fromX, fromY, spine, l, u + S.moreH / 2), group: "idle", more: true });
      u += S.moreH + S.cardGap;
    }
    return u;
  };

  let u: number = S.padY;
  for (const root of roots) {
    const top = u, port = top + S.card / 2, rid = root.key;
    L.roots.push({ id: rid, root, box: { x: x0, y: port - S.pH / 2, w: S.pW, h: S.pH } });
    L.order.push(rid);
    let bottom = top + S.pH;
    root.hints.forEach((h, i) => {
      const y = port + S.pH / 2 + C.hintGap + i * (C.hintH + C.hintGap);
      const hid = `h:${rid}:${i}`;
      L.hints.push({ id: hid, hint: h, box: { x: x0, y, w: S.pW, h: C.hintH } });
      L.order.push(hid);
      bottom = y + C.hintH;
    });
    if (byRoom && root.conv?.kind === "group") {
      for (const lf of root.leaves) {
        const ctop = u, cport = ctop + S.card / 2, cid = lf.key;
        L.contacts.push({ id: cid, root, leaf: lf, box: { x: x1, y: cport - S.pH / 2, w: C.cW, h: S.pH } });
        L.order.push(cid);
        L.links.push({ id: `${rid}>${cid}`, from: rid, to: cid, d: elbowPath(x0 + S.pW, port, x0 + S.pW + C.g0 / 2, x1, cport), group: topOf(lf.facts) });
        u = placeLeaf(lf, cid, x1 + C.cW, cport, x1 + C.cW + S.g1 / 2, ctop);
        u = Math.max(u - S.cardGap, ctop + S.pH) + C.contactGap;
      }
      u -= C.contactGap;
    } else {
      const lf = root.leaves[0];
      u = lf ? placeLeaf(lf, rid, x0 + S.pW, port, x0 + S.pW + (hasContact ? C.g0 : S.g1) / 2, top) - S.cardGap : top + S.pH;
    }
    u = Math.max(u, bottom) + S.groupGap;
  }
  L.height = Math.max(u - S.groupGap + S.padY, 120);
  return L;
}

export function lineage(links: readonly BoardLink[], start: string | null): Set<string> | null {
  if (!start) return null;
  const into = new Map<string, BoardLink[]>(), out = new Map<string, BoardLink[]>();
  for (const k of links) {
    into.set(k.to, [...(into.get(k.to) ?? []), k]);
    out.set(k.from, [...(out.get(k.from) ?? []), k]);
  }
  const lit = new Set([start]);
  const walk = (id: string, m: Map<string, BoardLink[]>, next: (k: BoardLink) => string) => {
    for (const k of m.get(id) ?? []) {
      lit.add(k.id);
      const n = next(k);
      if (!lit.has(n)) {
        lit.add(n);
        walk(n, m, next);
      }
    }
  };
  walk(start, into, (k) => k.from);
  walk(start, out, (k) => k.to);
  return lit;
}
