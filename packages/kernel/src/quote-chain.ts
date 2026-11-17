// 引用链投递(需求文档 D24;验收 AC-41)。纯函数,不做 I/O。
//   buildQuoteChain:从新消息的直接引用(reply_to 与 quoted_seqs)出发按层广度优先走引用 DAG,同一 seq 只出现一次(via 记第一次走到它的那条);
//     默认带前 k 级(用户 #2115 定 K=3);会话上文已有的标 in_context、不贴原文,层数照算并继续往上;
//     撤回的标 deleted_or_withdrawn、看不见(不在本会话可读消息里)的标 not_visible,都不给原文,也不越过它往上走;
//     整条链往上扫到 scanCap 级为止给出 depthTotal(超过只写上限并标 depthCapped);
//     没带全时 truncated 为真,nextSeqs 指向没带进来的最近一级;
//     原文总字节超预算时从最远一级开始降成 id_only(只给编号与作者),近的级不被挤掉,降级的也进 nextSeqs。
//   quoteParent:read_quote_parent,只返回这条消息直接引用的那一级,字段与引用链相同。
//   引用只能指向更早的 seq:指向自己或更晚的当脏数据跳过,天然不成环。
export interface QuoteMsg { readonly seq: number; readonly author: string; readonly at: string; readonly text: string; readonly quoted: readonly number[]; readonly retracted: boolean }
export type QuoteStatus = "inline" | "in_context" | "deleted_or_withdrawn" | "not_visible" | "id_only";
export interface QuoteLevel { readonly seq: number; readonly author: string; readonly at: string; readonly depth: number; readonly via: number; readonly status: QuoteStatus; readonly text: string | null; readonly quotedSeqs: readonly number[]; readonly hasMoreAbove: boolean }
export interface QuoteChain { readonly levels: readonly QuoteLevel[]; readonly depthTotal: number; readonly depthCapped: boolean; readonly truncated: boolean; readonly nextSeqs: readonly number[] }
export interface QuoteChainInput { readonly fromSeq: number; readonly refs: readonly number[]; readonly messages: readonly QuoteMsg[]; readonly inContext: readonly number[]; readonly k: number; readonly scanCap: number; readonly budgetBytes: number }

interface Node { seq: number; depth: number; via: number; msg: QuoteMsg | undefined; parents: number[] }
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
/** 一条消息往上可走的引用:去重、只认比它早的 */
const parentsOf = (m: QuoteMsg) => [...new Set(m.quoted)].filter((q) => Number.isSafeInteger(q) && q > 0 && q < m.seq);
const traversable = (n: Node) => n.msg !== undefined && !n.msg.retracted;

function walk(fromSeq: number, refs: readonly number[], byseq: ReadonlyMap<number, QuoteMsg>, maxDepth: number): Node[] {
  const seen = new Map<number, Node>();
  let frontier: { seq: number; via: number }[] = [];
  for (const r of refs) if (Number.isSafeInteger(r) && r > 0 && r < fromSeq && !frontier.some((f) => f.seq === r)) frontier.push({ seq: r, via: fromSeq });
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: { seq: number; via: number }[] = [];
    for (const f of frontier) {
      if (seen.has(f.seq)) continue;
      const msg = byseq.get(f.seq);
      const n: Node = { seq: f.seq, depth, via: f.via, msg, parents: msg ? parentsOf(msg) : [] };
      seen.set(f.seq, n);
      if (traversable(n)) for (const p of n.parents) if (!seen.has(p) && !next.some((x) => x.seq === p)) next.push({ seq: p, via: f.seq });
    }
    frontier = next;
  }
  return [...seen.values()];
}

function level(n: Node, inContext: ReadonlySet<number>, included: ReadonlySet<number>): QuoteLevel {
  const m = n.msg;
  const status: QuoteStatus = m === undefined ? "not_visible" : m.retracted ? "deleted_or_withdrawn" : inContext.has(n.seq) ? "in_context" : "inline";
  const open = traversable(n);
  return {
    seq: n.seq, author: m?.author ?? "?", at: m?.at ?? "", depth: n.depth, via: n.via, status,
    text: status === "inline" ? (m as QuoteMsg).text : null,
    quotedSeqs: open ? n.parents : [],
    hasMoreAbove: open && n.parents.some((p) => !included.has(p)),
  };
}

function fitBudget(levels: QuoteLevel[], budget: number): { levels: QuoteLevel[]; dropped: number[] } {
  let used = levels.reduce((a, l) => a + (l.status === "inline" && l.text !== null ? bytes(l.text) : 0), 0);
  const out = [...levels];
  const dropped: number[] = [];
  // 从最远一级(层数最大,同层 seq 最小即最早)开始降级
  const order = out.map((l, i) => ({ l, i })).filter((x) => x.l.status === "inline").sort((a, b) => b.l.depth - a.l.depth || a.l.seq - b.l.seq);
  for (const { l, i } of order) {
    if (used <= budget) break;
    used -= bytes(l.text ?? "");
    out[i] = { ...l, status: "id_only", text: null };
    dropped.push(l.seq);
  }
  return { levels: out, dropped };
}

export function buildQuoteChain(input: QuoteChainInput): QuoteChain | null {
  const byseq = new Map(input.messages.map((m) => [m.seq, m] as const));
  const nodes = walk(input.fromSeq, input.refs, byseq, Math.max(input.k, input.scanCap) + 1);
  if (nodes.length === 0) return null;
  const maxDepth = nodes.reduce((a, n) => Math.max(a, n.depth), 0);
  const depthCapped = maxDepth > input.scanCap;
  const kept = nodes.filter((n) => n.depth <= input.k);
  const included = new Set(kept.map((n) => n.seq));
  const inCtx = new Set(input.inContext);
  const fitted = fitBudget(kept.map((n) => level(n, inCtx, included)), input.budgetBytes);
  const next = new Set<number>();
  for (const n of nodes) if (n.depth === input.k + 1) next.add(n.seq);
  for (const s of fitted.dropped) next.add(s);
  return {
    levels: fitted.levels,
    depthTotal: depthCapped ? input.scanCap : maxDepth,
    depthCapped,
    truncated: maxDepth > input.k || fitted.dropped.length > 0,
    nextSeqs: [...next].sort((a, b) => a - b),
  };
}

export function quoteParent(input: { seq: number; messages: readonly QuoteMsg[]; inContext: readonly number[]; budgetBytes: number }): QuoteLevel[] {
  const byseq = new Map(input.messages.map((m) => [m.seq, m] as const));
  const self = byseq.get(input.seq);
  if (!self || self.retracted) return [];
  const nodes = walk(input.seq, parentsOf(self), byseq, 2);
  const kept = nodes.filter((n) => n.depth === 1);
  const included = new Set(kept.map((n) => n.seq));
  return fitBudget(kept.map((n) => level(n, new Set(input.inContext), included)), input.budgetBytes).levels;
}

/** 呈现:一行总况,每级一行(编号、作者、时间、层数、来由、状态、有无上一级),inline 的下一行起附原文 */
export function renderQuoteChain(c: QuoteChain): string {
  const head = `引用链 depth_total=${c.depthCapped ? "≥" : ""}${c.depthTotal} · truncated=${c.truncated} · next_seqs=${c.nextSeqs.length ? c.nextSeqs.map((s) => `#${s}`).join(",") : "无"}\n`;
  return head + renderLevels(c.levels);
}
export function renderLevels(levels: readonly QuoteLevel[]): string {
  let t = "";
  for (const l of levels) {
    t += `L${l.depth} #${l.seq} · ${l.author} · ${l.at} · via #${l.via} · ${l.status}${l.hasMoreAbove ? " · has_more_above" : ""}\n`;
    if (l.text !== null) t += `${l.text}\n`;
  }
  return t;
}
