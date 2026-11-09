// 联系人每轮五块重拼(需求文档 D06 第 2 小节、D22 第 3 节、D23 第 9 小节;验收 AC-39 ①②、AC-40 坏实现⑪)。
// 纯函数:输入一轮要用的全部材料,输出 runtime-ports.ts 的 RoundRequest。不做 I/O,不留模块级状态,不调用模型。
// 块顺序固定 1→5,每轮都输出全部五块(空块写占位):
//   1 固定前缀      :系统提示词 → 工具声明 → 人设(SOUL.md)→ 群公告 → 当前作用域已确认规矩与用户纠正(原文,带来源 #seq)。
//                    只由 prefix 输入决定;账本、状态笔记、新消息、指针一律不进这里,所以前缀输入相同的两轮逐字节相同。
//                    规矩按 (sourceSeq, id) 排序后输出,规矩表的存储顺序变化不会打破缓存前缀。
//                    系统提示词、工具声明、人设、群公告这四段是配置文本,段内出现日期、时刻、#序号、任务号、「最近 N 条」就报错
//                    (与 assemble.ts 同一套判据)。规矩与纠正是来源消息的原文,天然会引用 #seq、时刻(「#2063 那条作废」
//                    「22:00 后别 @ 我」),它们随规矩表变化而变化,不是每轮会变的内容,所以不扫;规矩变更时前缀如实跟着变(D22 规则 2)。
//   2 承诺账本      :未了结承诺由代码按原文复制,不改写;本轮绑定的放详情原文,其余只放一行索引(id、短名、状态、来源 #seq、任务)。
//   3 状态笔记      :唯一由模型写的部分,按版本号原样放入。
//   4 新消息        :processed_seq 之后的全部输入(消息、所属 Compute 事件、定时触发),按到达顺序、原文,消息带 #seq 与发送人。
//                    同一会话的消息 seq 必须严格递增;seq 不大于该会话 processed_seq 的旧消息显式拒绝(不在五块之外夹带旧消息)。
//   5 指针与按需换入:调用方取回的原文(引用链 D24 的最小版:被引用消息原文由调用方作为 pointers 给出),text 为空时只给指针。
// 只有第 1 块末尾标 cacheBreakpoint。basedOnSeq 按会话记第 4 块里消息的最大 seq(Compute 事件与定时触发没有 seq,不计)。
// 超预算显式失败并说明超出多少字节,不静默截掉任何要求。
// 输入先过统一的普通数据判定(plain.ts):getter 永不调用,Proxy、类实例、函数一律拒绝;之后只读冻结副本。
import { dataDesc, pushOwn } from "./own.ts";
import { plainData } from "./plain.ts";
import { BLOCK_LABELS, type BlockNo, type ComputeSignal, type Inbound, type InboundSenderKind, type RoundBlock, type RoundRequest } from "./runtime-ports.ts";

/** 第 1 块里的一条规矩或用户纠正:当前作用域内已确认(Confirmed)的条目,text 是来源消息里的原文 */
export interface PrefixRule {
  readonly id: string;
  readonly kind: "rule" | "correction";
  readonly sourceSeq: number;
  readonly text: string;
}
export interface RoundPrefix {
  /** 系统提示词,不能为空 */
  readonly system: string;
  /** 工具声明文本;没有给 "" */
  readonly tools: string;
  /** 人设(SOUL.md)原文;没有给 "" */
  readonly persona: string;
  /** 群公告原文;私聊或没有公告给 "" */
  readonly roomNotice: string;
  readonly rules: readonly PrefixRule[];
  /** 联系人的全局记忆(D25 第 6 节:每轮都适用的才进前缀,按会话快照放入,中途变化走第 5 块);不给即没有 */
  readonly memories?: readonly { readonly id: string; readonly title: string; readonly text: string }[];
}
/** 一条未了结承诺。text 是账本里的原文,代码原样复制 */
export interface LedgerEntry {
  readonly id: string;
  readonly sourceSeq: number;
  readonly taskId: string | null;
  /** 短名(D23 第 7 小节,候选);没有时索引行只显示 id */
  readonly shortName?: string;
  readonly text: string;
  readonly status: string;
}
export interface RoundLedger {
  readonly open: readonly LedgerEntry[];
  /** 本轮绑定的承诺 id:放详情原文;其余只放一行索引 */
  readonly boundIds: readonly string[];
}
export interface RoundStateNote {
  readonly version: number;
  readonly text: string;
}
/** 按需换入的一段原文。ref 是取回它用的指针(如 "g-group#2063"、"T-3 交接快照");text 为 "" 表示只给指针、没换入原文 */
export interface RoundPointer {
  readonly ref: string;
  readonly text: string;
}
export interface RoundAssembleInput {
  readonly prefix: RoundPrefix;
  readonly ledger: RoundLedger;
  readonly stateNote: RoundStateNote | null;
  /** 各会话已处理到的 seq(processed_seq);没列出的会话按 0 算。第 4 块里的消息 seq 必须大于它 */
  readonly processedSeq: Readonly<Record<string, number>>;
  /** processed_seq 之后的全部输入,按到达顺序 */
  readonly fresh: readonly Inbound[];
  readonly pointers: readonly RoundPointer[];
  /** 整个请求(五块文本之和)的 UTF-8 字节上限 */
  readonly budgetBytes: number;
}

/** 第 1 块里要扫会变内容的配置文本段 */
export type PrefixTextPart = "system" | "tools" | "persona" | "roomNotice";
export type AssembleRoundResult =
  | { readonly ok: true; readonly request: RoundRequest; readonly totalBytes: number }
  | { readonly ok: false; readonly reason: "invalid-input"; readonly detail: string }
  | { readonly ok: false; readonly reason: "volatile-in-prefix"; readonly part: PrefixTextPart; readonly match: string; readonly detail: string }
  | { readonly ok: false; readonly reason: "stale-fresh"; readonly roomId: string; readonly seq: number; readonly processedSeq: number; readonly detail: string }
  | { readonly ok: false; readonly reason: "over-budget"; readonly need: number; readonly budget: number; readonly over: number; readonly blockBytes: readonly number[]; readonly detail: string };

/** 固定前缀里不许出现的会变内容:与 assemble.ts 的 stable 段同一套可判定格式(日期、时刻、#序号、任务号、带数字的最近 N 条) */
const VOLATILE_PATTERNS: readonly [string, RegExp][] = [
  ["日期", /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/],
  ["时刻", /\b\d{1,2}:\d{2}(?::\d{2})?\b/],
  ["消息序号", /#\d+/],
  ["任务号", /\bT-\d+\b/],
  ["最近 N 条", /最近\s*\d+\s*条/],
];
const PREFIX_TEXT_PARTS: readonly PrefixTextPart[] = ["system", "tools", "persona", "roomNotice"];
const SENDER_KINDS: readonly InboundSenderKind[] = ["user", "contact", "helper", "system"];
const SIGNALS: readonly ComputeSignal[] = ["started", "milestone", "blocked", "completed", "failed", "stopped"];

const bytesOf = (s: string) => Buffer.byteLength(s, "utf8");
const isRec = (x: unknown): x is Readonly<Record<string, unknown>> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string";
/** 单行非空字符串:进标签行的字段(id、短名、状态、会话、发送人)不能换行,否则一行索引会被拆开 */
const isLine = (x: unknown): x is string => typeof x === "string" && x !== "" && !/[\r\n\u2028\u2029]/.test(x);
const isNat = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const isPos = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 1;
const invalid = (detail: string) => ({ ok: false as const, reason: "invalid-input" as const, detail });

function volatileIn(text: string) {
  for (const [name, re] of VOLATILE_PATTERNS) {
    const m = re.exec(text);
    if (m) return `${name}:${m[0]}`;
  }
  return undefined;
}

function checkPrefix(p: unknown): string | undefined {
  if (!isRec(p)) return "prefix 必须是对象";
  if (!isStr(p.system) || p.system === "") return "prefix.system 必须是非空字符串";
  for (const k of ["tools", "persona", "roomNotice"] as const) if (!isStr(p[k])) return `prefix.${k} 必须是字符串(没有就给 "")`;
  if (!Array.isArray(p.rules)) return "prefix.rules 必须是数组";
  const ids = new Set<string>();
  for (let i = 0; i < p.rules.length; i++) {
    const r: unknown = p.rules[i];
    const at = `prefix.rules[${i}]`;
    if (!isRec(r)) return `${at} 必须是对象`;
    if (!isLine(r.id)) return `${at}.id 必须是单行非空字符串`;
    if (r.kind !== "rule" && r.kind !== "correction") return `${at}.kind 只能是 rule 或 correction`;
    if (!isPos(r.sourceSeq)) return `${at}.sourceSeq 必须是正整数(来源消息 seq)`;
    if (!isStr(r.text) || r.text === "") return `${at}.text 必须是非空字符串(来源消息原文)`;
    if (ids.has(r.id)) return `规矩 id ${r.id} 重复`;
    ids.add(r.id);
  }
  if (p.memories !== undefined) {
    if (!Array.isArray(p.memories)) return "prefix.memories 必须是数组";
    for (let i = 0; i < p.memories.length; i++) {
      const m: unknown = p.memories[i];
      if (!isRec(m) || !isLine(m.id) || !isLine(m.title) || !isStr(m.text) || m.text === "") return `prefix.memories[${i}] 必须是 {id, title: 单行非空, text: 非空}`;
    }
  }
  return undefined;
}

function checkLedger(l: unknown): string | undefined {
  if (!isRec(l)) return "ledger 必须是对象";
  if (!Array.isArray(l.open)) return "ledger.open 必须是数组";
  if (!Array.isArray(l.boundIds)) return "ledger.boundIds 必须是数组";
  const ids = new Set<string>();
  for (let i = 0; i < l.open.length; i++) {
    const e: unknown = l.open[i];
    const at = `ledger.open[${i}]`;
    if (!isRec(e)) return `${at} 必须是对象`;
    if (!isLine(e.id)) return `${at}.id 必须是单行非空字符串`;
    if (!isPos(e.sourceSeq)) return `${at}.sourceSeq 必须是正整数`;
    if (e.taskId !== null && !isLine(e.taskId)) return `${at}.taskId 必须是单行非空字符串或 null`;
    if (e.shortName !== undefined && !isLine(e.shortName)) return `${at}.shortName 必须是单行非空字符串`;
    if (!isStr(e.text) || e.text === "") return `${at}.text 必须是非空字符串(账本原文)`;
    if (!isLine(e.status)) return `${at}.status 必须是单行非空字符串`;
    if (ids.has(e.id)) return `承诺 id ${e.id} 重复`;
    ids.add(e.id);
  }
  const bound = new Set<string>();
  for (let i = 0; i < l.boundIds.length; i++) {
    const id: unknown = l.boundIds[i];
    if (!isLine(id)) return `ledger.boundIds[${i}] 必须是单行非空字符串`;
    if (!ids.has(id)) return `本轮绑定的承诺 ${id} 不在未了结承诺列表里`;
    if (bound.has(id)) return `本轮绑定的承诺 ${id} 重复`;
    bound.add(id);
  }
  return undefined;
}

function checkSeqList(xs: unknown, seq: number, at: string): string | undefined {
  if (!Array.isArray(xs)) return `${at} 必须是数组`;
  for (let i = 0; i < xs.length; i++) if (!isPos(xs[i]) || (xs[i] as number) >= seq) return `${at}[${i}] 必须是小于本条 seq ${seq} 的正整数(引用只能指向更早的消息)`;
  return undefined;
}

/** 一条输入的形状(runtime-ports.ts 的 Inbound) */
function checkInbound(x: unknown, at: string): string | undefined {
  if (!isRec(x)) return `${at} 必须是对象`;
  if (!isLine(x.roomId)) return `${at}.roomId 必须是单行非空字符串`;
  if (!isLine(x.at)) return `${at}.at 必须是单行非空字符串`;
  if (x.kind === "message") {
    if (!isPos(x.seq)) return `${at}.seq 必须是正整数`;
    const s = x.sender;
    if (!isRec(s) || !SENDER_KINDS.includes(s.kind as InboundSenderKind) || !isLine(s.id) || !isLine(s.name)) return `${at}.sender 必须是 {kind: ${SENDER_KINDS.join("|")}, id, name}(单行非空)`;
    if (!isStr(x.text)) return `${at}.text 必须是字符串`;
    if (x.replyToSeq !== null && (!isPos(x.replyToSeq) || x.replyToSeq >= x.seq)) return `${at}.replyToSeq 必须是 null 或小于本条 seq 的正整数`;
    const q = checkSeqList(x.quotedSeqs, x.seq, `${at}.quotedSeqs`);
    if (q) return q;
    if (!Array.isArray(x.mentions) || !x.mentions.every(isLine)) return `${at}.mentions 必须是单行非空字符串数组`;
    if (x.command !== null && (!isRec(x.command) || !isLine(x.command.name))) return `${at}.command 必须是 null 或 {name, args}`;
    return undefined;
  }
  if (x.kind === "compute") {
    if (!isLine(x.taskId) || !isLine(x.computeId)) return `${at}.taskId 与 computeId 必须是单行非空字符串`;
    if (!SIGNALS.includes(x.signal as ComputeSignal)) return `${at}.signal 只能是 ${SIGNALS.join("|")}`;
    if (!isStr(x.summary)) return `${at}.summary 必须是字符串`;
    return undefined;
  }
  if (x.kind === "schedule") {
    if (!isLine(x.scheduleId)) return `${at}.scheduleId 必须是单行非空字符串`;
    if (!isStr(x.prompt)) return `${at}.prompt 必须是字符串`;
    return undefined;
  }
  return `${at}.kind 只能是 message、compute 或 schedule`;
}

function checkPointers(ps: unknown): string | undefined {
  if (!Array.isArray(ps)) return "pointers 必须是数组";
  const refs = new Set<string>();
  for (let i = 0; i < ps.length; i++) {
    const p: unknown = ps[i];
    if (!isRec(p) || !isLine(p.ref) || !isStr(p.text)) return `pointers[${i}] 必须是 {ref: 单行非空字符串, text: 字符串}`;
    if (refs.has(p.ref)) return `指针 ${p.ref} 重复`;
    refs.add(p.ref);
  }
  return undefined;
}

// ---------------------------------------------------------------- 渲染:只拼接,原文一律原样放入

function renderPrefix(p: RoundPrefix) {
  const rules: PrefixRule[] = [];
  for (const r of p.rules) pushOwn(rules, r);
  rules.sort((a, b) => a.sourceSeq - b.sourceSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let t = `[系统提示词]\n${p.system}\n`;
  if (p.tools !== "") t += `[工具声明]\n${p.tools}\n`;
  if (p.persona !== "") t += `[人设]\n${p.persona}\n`;
  if (p.roomNotice !== "") t += `[群公告]\n${p.roomNotice}\n`;
  if (rules.length > 0) {
    t += "[已确认规矩与用户纠正(原文)]\n";
    for (const r of rules) t += `〔${r.kind === "rule" ? "规矩" : "纠正"} ${r.id} · 来源 #${r.sourceSeq}〕\n${r.text}\n`;
  }
  const mems = p.memories ?? [];
  if (mems.length > 0) {
    t += "[联系人记忆(全局,每轮适用)]\n";
    for (const m of mems) t += `〔记忆 ${m.id} · ${m.title}〕\n${m.text}\n`;
  }
  return t;
}

function ledgerTag(e: LedgerEntry) {
  const name = e.shortName === undefined ? "" : ` · ${e.shortName}`;
  const task = e.taskId === null ? "" : ` · 任务 ${e.taskId}`;
  return `承诺 ${e.id}${name} · ${e.status} · 来源 #${e.sourceSeq}${task}`;
}

function renderLedger(l: RoundLedger) {
  if (l.open.length === 0) return "[承诺账本]\n(无未了结承诺)\n";
  const bound = new Set(l.boundIds);
  let detail = "";
  let index = "";
  for (const e of l.open) {
    if (bound.has(e.id)) detail += `〔${ledgerTag(e)}〕\n${e.text}\n`;
    else index += `- ${ledgerTag(e)}\n`;
  }
  let t = "[承诺账本]\n";
  if (detail !== "") t += `本轮绑定(详情,账本原文):\n${detail}`;
  if (index !== "") t += `其余未了结(一行索引,详情按 id 取):\n${index}`;
  return t;
}

function renderStateNote(n: RoundStateNote | null) {
  return n === null ? "[状态笔记]\n(尚无)\n" : `[状态笔记 v${n.version}]\n${n.text}\n`;
}

/** 一条输入在第 4 块里的呈现(消息带 #seq、会话、发送人、时刻与引用;Compute 事件与定时触发各有标签),压缩材料也用它 */
export function renderInboundText(x: Inbound): string {
  if (x.kind === "message") {
    const s = x.sender;
    let head = `#${x.seq} · ${x.roomId} · ${s.name}(${s.kind}:${s.id}) · ${x.at}`;
    if (x.replyToSeq !== null) head += ` · ↩ #${x.replyToSeq}`;
    if (x.quotedSeqs.length > 0) head += ` · 引 ${x.quotedSeqs.map((q) => `#${q}`).join(",")}`;
    if (x.mentions.length > 0) head += ` · ${x.mentions.map((m) => `@${m}`).join(" ")}`;
    if (x.command !== null) head += ` · /${x.command.name}${x.command.args === undefined ? "" : ` ${JSON.stringify(x.command.args)}`}`;
    return `${head}\n${x.text}\n`;
  }
  if (x.kind === "compute") return `〔Compute ${x.computeId} · 任务 ${x.taskId} · ${x.signal}〕 · ${x.roomId} · ${x.at}\n${x.summary}\n`;
  return `〔定时 ${x.scheduleId}〕 · ${x.roomId} · ${x.at}\n${x.prompt}\n`;
}

function renderFresh(fresh: readonly Inbound[]) {
  if (fresh.length === 0) return "[新消息]\n(无)\n";
  let t = "[新消息](processed_seq 之后,按到达顺序,原文)\n";
  for (const x of fresh) t += renderInboundText(x);
  return t;
}

function renderPointers(ps: readonly RoundPointer[]) {
  if (ps.length === 0) return "[指针与按需换入]\n(无)\n";
  let t = "[指针与按需换入]\n";
  for (const p of ps) t += p.text === "" ? `〔${p.ref}〕(未换入,可按指针取原文)\n` : `〔${p.ref}〕\n${p.text}\n`;
  return t;
}

/** 联系人一轮的五块重拼。纯函数:同样的输入得到逐字节相同的输出;失败时给出原因,不返回半截请求 */
export function assembleRound(input: RoundAssembleInput): AssembleRoundResult {
  const pl = plainData(input, "五块装配输入");
  if (!pl.ok) return invalid(`五块装配输入只接受普通数据对象:${pl.path} ${pl.why}`);
  const x = pl.value;
  if (!isRec(x)) return invalid("五块装配输入必须是对象");

  const prefixBad = checkPrefix(x.prefix);
  if (prefixBad) return invalid(prefixBad);
  const prefix = x.prefix as RoundPrefix;
  for (const part of PREFIX_TEXT_PARTS) {
    const hit = volatileIn(prefix[part]);
    if (hit) return { ok: false, reason: "volatile-in-prefix", part, match: hit, detail: `固定前缀的 ${part} 段出现会变内容(${hit});会变的内容只能放第 2–5 块` };
  }
  const ledgerBad = checkLedger(x.ledger);
  if (ledgerBad) return invalid(ledgerBad);
  const ledger = x.ledger as RoundLedger;
  const note = x.stateNote;
  if (note !== null && (!isRec(note) || !isNat(note.version) || !isStr(note.text))) return invalid("stateNote 必须是 null 或 {version: 非负整数, text: 字符串}");
  const processed = x.processedSeq;
  if (!isRec(processed)) return invalid("processedSeq 必须是对象(会话 id → 已处理到的 seq)");
  for (const k of Object.keys(processed)) if (!isNat(processed[k])) return invalid(`processedSeq.${k} 必须是非负整数`);
  if (!Array.isArray(x.fresh)) return invalid("fresh 必须是数组");
  const fresh = x.fresh as readonly Inbound[];
  const lastSeq = new Map<string, number>();
  for (let i = 0; i < fresh.length; i++) {
    const bad = checkInbound(fresh[i], `fresh[${i}]`);
    if (bad) return invalid(bad);
    const m = fresh[i] as Inbound;
    if (m.kind !== "message") continue;
    const done = Object.hasOwn(processed, m.roomId) ? (processed[m.roomId] as number) : 0;
    if (m.seq <= done) {
      return { ok: false, reason: "stale-fresh", roomId: m.roomId, seq: m.seq, processedSeq: done, detail: `会话 ${m.roomId} 的 #${m.seq} 不在 processed_seq(${done})之后;旧消息只能经第 5 块按需换入,不进第 4 块` };
    }
    const prev = lastSeq.get(m.roomId);
    if (prev !== undefined && m.seq <= prev) return invalid(`fresh[${i}]:会话 ${m.roomId} 的消息 seq 必须严格递增,#${m.seq} 排在 #${prev} 之后`);
    lastSeq.set(m.roomId, m.seq);
  }
  const pointersBad = checkPointers(x.pointers);
  if (pointersBad) return invalid(pointersBad);
  const pointers = x.pointers as readonly RoundPointer[];
  if (!isNat(x.budgetBytes)) return invalid("budgetBytes 必须是非负整数");
  const budget = x.budgetBytes;

  const texts: [BlockNo, string][] = [
    [1, renderPrefix(prefix)],
    [2, renderLedger(ledger)],
    [3, renderStateNote(note as RoundStateNote | null)],
    [4, renderFresh(fresh)],
    [5, renderPointers(pointers)],
  ];
  const blockBytes: number[] = [];
  for (const [, t] of texts) pushOwn(blockBytes, bytesOf(t));
  const need = blockBytes.reduce((a, b) => a + b, 0);
  if (need > budget) {
    const over = need - budget;
    const each = blockBytes.map((b, i) => `第 ${i + 1} 块 ${b}`).join(",");
    return {
      ok: false, reason: "over-budget", need, budget, over, blockBytes: Object.freeze(blockBytes),
      detail: `五块共 ${need} 字节,预算 ${budget} 字节,超出 ${over} 字节(${each});不截断任何要求,请分批处理新消息或减少按需换入`,
    };
  }

  const blocks: RoundBlock[] = [];
  for (const [block, text] of texts) pushOwn(blocks, Object.freeze({ block, label: BLOCK_LABELS[block], text, cacheBreakpoint: block === 1 }));
  const basedOnSeq: Record<string, number> = Object.create(null);
  for (const [room, seq] of lastSeq) Object.defineProperty(basedOnSeq, room, dataDesc(seq));
  const request: RoundRequest = Object.freeze({ blocks: Object.freeze(blocks), basedOnSeq: Object.freeze(basedOnSeq) });
  return { ok: true, request, totalBytes: need };
}
