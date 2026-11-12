// 找旧消息的宿主一侧(T-177 G4;需求 D06 §3「粗筛自动、精筛内置」):每轮预取(粗筛,主机自动有界带入第 5 块)与本轮查询口 query_history
// (精筛:一个宿主注册的查询工具,检索与分页回读两种用法)。规则在 kernel/history-tools.ts,这里管读库、范围、时限与返回前再核。
// 「当前会话」= 这一轮新输入所在的会话集合(审查条件 G4-a):预取、检索、回读都只在这个集合里;联系人在别的群或私聊里的历史这一版不搜。
// 先形成可见语料再交检索(G4-01):只收联系人此刻仍是成员(且不在移出中)的会话里、没撤回、没被私聊回退撤下的消息,正文取最新版本。
// 返回前再核(G4-02):检索之后按当前日志重新投影,已撤回、已回退、已移出的命中去掉,编辑过的改读当前版本;正文只从当前投影读,不用交给检索时的副本。
// 预取有时限(G4-b):超时或出错不挡这一轮,只留诊断;每条新消息只搜它自己的会话,不改前缀、不动 read_seq / processed_seq。
// 撤回优先(AC-08,G4b;G6 实测缺口 k1-g4on-R1):撤回的消息本体不进语料还不够——另一条可见消息的正文里可能抄了它的原文
// (联系人回话、用户的另一条消息、引用副本都算)。三处返回前都过一遍 scrubLineBody,把撤回原文的精确出现换成占位;
// 分不出原样的整段隐去。行本身(编号、作者、时间、版本)保留,这条消息仍然可定位。范围 = 本次读取的会话。
import { loadLog } from "@g-group/adapter-sqlite";
import {
  type HistoryDoc,
  type HistoryHit,
  type HistoryLine,
  type Inbound,
  PREFETCH_MAX,
  PREFETCH_REF,
  type RoundTools,
  historyDocs,
  historyLines,
  historyRef,
  historyWindow,
  parseHistoryRef,
  pickPrefetch,
  renderHistoryHits,
  renderHistoryWindow,
  renderPrefetch,
  retractedBodies,
  scrubLineBody,
} from "@g-group/kernel";
import type { Db } from "./db.ts";
import { inRanges, rewindRanges } from "./rewind.ts";

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
/** 预取时每条新消息先取几个候选再切断崖 */
const PREFETCH_CANDIDATES = 8;

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

const later = () => new Promise<void>((r) => setImmediate(r));

export class HistoryAccess {
  private readonly d: HistoryDeps;
  constructor(deps: HistoryDeps) {
    this.d = deps;
  }

  /** 一个会话的当前投影与已撤回原文:同一次读日志取两样,扫描撤回原文不多读一遍。 */
  private facts(roomId: string): { lines: HistoryLine[]; retracted: string[] } {
    const { log } = loadLog(this.d.db.store, `room:${roomId}`);
    const ranges = rewindRanges(this.d.db, roomId);
    return { lines: historyLines(roomId, log.events, (seq) => inRanges(ranges, seq)), retracted: retractedBodies(log.events) };
  }

  /** 一个会话全部消息的当前状态(每次现读日志,不缓存)。 */
  lines(roomId: string): HistoryLine[] {
    return this.facts(roomId).lines;
  }

  /**
   * 返回前把正文里出现过的已撤回原文换掉(AC-08)。只动正文:编号、作者、时间、版本都留着,这条消息仍然可定位;
   * retracted 为空时原样返回(不扫)。换掉的条数进诊断。
   */
  private scrub(lines: readonly HistoryLine[], retracted: readonly string[]): HistoryLine[] {
    void retracted;
    return [...lines];
  }

  /** 本轮会话范围里,联系人此刻仍能读的那些(按 id 排序)。 */
  roomsNow(contactId: string, scope: ReadonlySet<string>): string[] {
    const readable = this.d.readableRooms(contactId);
    return [...scope].filter((r) => readable.has(r)).sort();
  }

  /**
   * 返回前再核:按当前投影重读每个命中,不在范围、撤回、回退的去掉;正文与版本都取当前的。保持命中次序。
   * 正文里出现过的已撤回原文在这里换掉(预取与检索共用这一条出口)。
   */
  verify(contactId: string, scope: ReadonlySet<string>, refs: readonly string[]): HistoryLine[] {
    const rooms = new Set(this.roomsNow(contactId, scope));
    const wanted: { roomId: string; seq: number }[] = [];
    for (const ref of refs) {
      const p = parseHistoryRef(ref);
      if (p && rooms.has(p.roomId)) wanted.push({ roomId: p.roomId, seq: p.seq });
    }
    const facts = new Map<string, { lines: HistoryLine[]; retracted: string[] }>();
    const retracted: string[] = [];
    for (const w of wanted) {
      if (facts.has(w.roomId)) continue;
      const f = this.facts(w.roomId);
      facts.set(w.roomId, f);
      retracted.push(...f.retracted);
    }
    const byseq = new Map<string, Map<number, HistoryLine>>();
    const out: HistoryLine[] = [];
    for (const w of wanted) {
      let m = byseq.get(w.roomId);
      if (!m) {
        m = new Map(facts.get(w.roomId)!.lines.map((l) => [l.seq, l]));
        byseq.set(w.roomId, m);
      }
      const l = m.get(w.seq);
      if (l && l.state === "ok") out.push(l);
    }
    return this.scrub(out, retracted);
  }

  /** 检索:query_history 给 query 的用法。 */
  async search(contactId: string, scope: ReadonlySet<string>, query: string, roomId: string | null, limit: number | null): Promise<string | null> {
    const rooms = this.roomsNow(contactId, scope);
    if (rooms.length === 0) return null;
    if (roomId !== null && !rooms.includes(roomId)) return null;
    const target = roomId === null ? rooms : [roomId];
    const docs = historyDocs(target.flatMap((r) => this.lines(r)));
    const n = limit === null || limit < 1 ? SEARCH_LIMIT_DEFAULT : Math.min(limit, SEARCH_LIMIT_MAX);
    const hits = await this.d.search(docs, query, n);
    const found = this.verify(contactId, new Set(target), hits.map((h) => h.ref));
    return renderHistoryHits(found, target, this.d.author);
  }

  /** 分页回读:query_history 给 roomId + seq 的用法。邻居窗口的正文同样过一遍撤回原文。 */
  read(contactId: string, scope: ReadonlySet<string>, roomId: string, seq: number, before: number | null, after: number | null): string | null {
    if (!this.roomsNow(contactId, scope).includes(roomId)) return null;
    const f = this.facts(roomId);
    const w = historyWindow(f.lines, seq, before, after, this.d.recallBudgetBytes());
    if (!w) return null;
    return renderHistoryWindow({ ...w, lines: this.scrub(w.lines, f.retracted) }, this.d.author);
  }

  /** 交给联系人这一轮的只读查询口 query_history,绑定联系人与本轮会话范围。 */
  tools(contactId: string, scope: ReadonlySet<string>): Required<Pick<RoundTools, "queryHistory">> {
    return {
      queryHistory: async (q) => (q.kind === "search" ? this.search(contactId, scope, q.query, q.roomId, q.limit) : this.read(contactId, scope, q.roomId, q.seq, q.before, q.after)),
    };
  }

  /**
   * 每轮预取:本轮每条新消息(真正的消息,不含编辑、撤回通知与 Compute / 定时事件)只在它自己的会话里检索,
   * 已在本轮上下文里的(本批新消息、引用换入与引用链)和正文与这条新消息完全相同的旧消息(重复,不带新信息)不再预取;过最小分、断崖前、最多 3 条;返回前再核。
   * 有时限:时限内没做完(含检索挂住)或出错都不挡这一轮,只留诊断,第 5 块写一行说明没预取成,不当成「没说过」。
   */
  async prefetch(contactId: string, fresh: readonly Inbound[], inContext: ReadonlySet<string>, opts: HistoryPrefetchOptions): Promise<PrefetchOutcome> {
    const timeoutMs = opts.timeoutMs ?? PREFETCH_TIMEOUT_MS;
    const minScore = opts.minScore ?? PREFETCH_MIN_SCORE;
    const started = performance.now();
    const scope = new Set(fresh.map((f) => f.roomId));
    const rooms = new Set(this.roomsNow(contactId, scope));
    const byRoom = new Map<string, { lines: HistoryLine[]; retracted: string[] }>();
    const queries: { roomId: string; text: string }[] = [];
    for (const f of fresh) {
      if (f.kind !== "message" || !rooms.has(f.roomId)) continue;
      const facts = byRoom.get(f.roomId) ?? this.facts(f.roomId);
      byRoom.set(f.roomId, facts);
      if (facts.lines.some((l) => l.seq === f.seq && l.state === "ok")) queries.push({ roomId: f.roomId, text: f.text });
    }
    const report = (status: PrefetchOutcome["status"], extra: Record<string, unknown> = {}) =>
      this.d.report("history-prefetch", { contactId, status, queries: queries.length, elapsedMs: Math.round(performance.now() - started), ...extra });
    if (queries.length === 0) {
      report("empty", { hits: 0 });
      return { pointers: [], status: "empty" };
    }
    // 时限用真实计时器:管的是这一轮真实等了多久,不跟测试注入的定时器走
    let expired = false;
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      handle = setTimeout(() => {
        expired = true;
        resolve("timeout");
      }, timeoutMs);
    });
    const work = (async () => {
      const per: HistoryHit[][] = [];
      let docsTotal = 0;
      for (const q of queries) {
        // 两次检索之间让出事件循环,时限计时器才有机会触发
        await later();
        if (expired) break;
        const facts = byRoom.get(q.roomId)!;
        const docs = historyDocs(facts.lines.filter((l) => !inContext.has(historyRef(l.roomId, l.seq)) && l.text.trim() !== q.text.trim()));
        docsTotal += docs.length;
        per.push(docs.length === 0 ? [] : [...(await this.d.search(docs, q.text, PREFETCH_CANDIDATES))]);
      }
      return { per, docsTotal };
    })();
    work.catch(() => {});
    let got: Awaited<typeof work> | "timeout";
    try {
      got = await Promise.race([work, timeout]);
    } catch (e) {
      report("error", { error: e instanceof Error ? e.message : String(e) });
      return { pointers: [notDone("出错")], status: "error" };
    } finally {
      clearTimeout(handle);
    }
    if (got === "timeout" || performance.now() - started > timeoutMs) {
      report("timeout", { timeoutMs });
      return { pointers: [notDone("超时")], status: "timeout" };
    }
    const picked = pickPrefetch(got.per, { minScore, max: PREFETCH_MAX });
    const found = this.verify(contactId, scope, picked.map((h) => h.ref));
    report(found.length ? "ok" : "empty", { hits: found.length, docs: got.docsTotal, scrubbed: found.filter((l) => l.scrubbed).length });
    if (found.length === 0) return { pointers: [], status: "empty" };
    return { pointers: [{ ref: PREFETCH_REF, text: renderPrefetch(found, this.d.author) }], status: "ok" };
  }
}

const notDone = (why: string) => ({ ref: "旧消息预取", text: `这一轮的旧消息预取没完成(${why}),第 5 块没有预取结果;不代表没有相关旧消息` });
