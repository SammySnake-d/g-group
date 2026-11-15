// 授权:归入任务不等于获授权(不变量 I3、U99、D28.6;验收 AC-17、AC-19、AC-20)。
// ① 群规「改代码前先问我」生效时,执行器拿不到写工具,写之前必须先问;
// ② 用户本人在对话里直接说「同意」即可授权,不要求点卡片;按钮只是可选交互;
// ③ 答复绑定 (task_id, q_id, constraint_ver)、动作和授权人;前提失效、取消、版本已变的迟到同意不放行;
// ④ 只有用户本人的直接表态算数:联系人/Helper 的话、转发、引用块或引号里的旧同意、外部材料都不产生授权;
//    同时有多个待授权动作又没指明是哪一个,不猜,追问。
// 这里全是机械规则(能由规则判定的不调模型,需求文档 1.2 语义判断层);拿不准一律不放行。纯函数,导出常量冻结(#2662)。
import { normalize } from "./plain.ts";

/** 能改工作区的内置工具:群规要求先问时,未获授权的执行器一律拿不到。Bash 能写文件,同样收走。 */
export const WRITE_TOOLS: readonly string[] = Object.freeze(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);

// 「改代码前先问我」这一类群规:动作词(改/写/动/提交/合并/删/修改)+「前/之前」+「先问」,或「先问(我)再/才 + 动作词」,或英文 ask before。
const ASK_BEFORE: readonly RegExp[] = Object.freeze([
  /(改|写|动|提交|合并|删|修改|编辑|推送|部署)[^。\n]{0,8}(前|之前|以前)[^。\n]{0,4}(先|要|必须|得)?(问|征求|确认)/,
  /先(问|征求|确认)[^。\n]{0,4}(再|才|然后)[^。\n]{0,4}(改|写|动|提交|合并|删|修改|编辑|推送|部署)/,
  /(没有|未经|不经)[^。\n]{0,4}(我|本人)?[^。\n]{0,2}(同意|批准|允许)[^。\n]{0,6}(不|别|不要|不准|禁止)[^。\n]{0,2}(改|写|动|提交|合并|删|修改)/,
  /\bask (me )?(first )?before (you )?(edit|writ|chang|modif|commit)/i,
]);

/** 群规里生效的「改前先问」那一行原文;没有返回 null。群规是用户写的自由文本,按行查。 */
export function askBeforeWriteRule(rules: string): string | null {
  if (typeof rules !== "string") throw new TypeError("群规必须是字符串");
  for (const raw of rules.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && ASK_BEFORE.some((re) => re.test(line))) return line;
  }
  return null;
}

/** 按群规收紧执行器工具:要先问且这一版没拿到授权,就去掉全部写工具;否则原样。返回冻结的新数组。 */
export function gateTools(tools: readonly string[], askFirst: boolean, granted: boolean): readonly string[] {
  if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string")) throw new TypeError("tools 必须是字符串数组");
  if (typeof askFirst !== "boolean" || typeof granted !== "boolean") throw new TypeError("askFirst/granted 必须是布尔值");
  return Object.freeze(askFirst && !granted ? tools.filter((t) => !WRITE_TOOLS.includes(t)) : [...tools]);
}

// ---------------------------------------------------------------- 表态识别
export type Intent = "approve" | "reject" | "unclear";
const APPROVE_WORDS: ReadonlySet<string> = new Set([
  "同意", "同意了", "我同意", "同意的", "可以", "可以的", "可以了", "可以改", "可以写", "可以做", "可以动", "行", "行吧", "行的", "好", "好的", "好吧", "好啊",
  "嗯", "嗯嗯", "没问题", "批准", "允许", "放行", "确认", "改吧", "写吧", "做吧", "动手吧", "开始吧", "去吧", "去做吧", "干吧", "继续", "继续吧",
  "ok", "okay", "yes", "y", "approve", "approved", "goahead", "lgtm",
]);
const REJECT_WORDS: ReadonlySet<string> = new Set([
  "不同意", "不行", "不可以", "不要", "不用", "不用了", "别", "别改", "别动", "别写", "先别", "先别改", "先不", "不改", "算了", "不", "不了", "拒绝", "不批准", "不允许", "否",
  "取消", "no", "nope", "reject", "deny", "stop",
]);
const CONSENT_VERB = /同意|批准|允许|授权/;
// 分句里出现任何否定词,含同意动词的整句都不算同意(「不要同意」「我没同意」「别批准」);短句白名单(如「没问题」)先于这条判
const NEGATOR = /不|未|没|别|拒绝|否|\bno\b|\bnot\b|don'?t/;
// 条件、保留、反问:有这些就不是干脆的同意,追问
const HEDGE = /但|不过|除了|只能|只许|仅限|前提|如果|要是|假如|等等|等一下|稍等|暂停|再说|考虑|想想|[?？]|吗$|么$|呢$/;

/** 去掉引用块(> 开头的行)、代码块与引号里的话:那是别人或过去说的,不是本人此刻的表态(AC-20)。 */
function ownWords(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .filter((l) => !/^\s*[>＞]/.test(l))
    .join("\n")
    .replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|‘[^’]*’/g, " ");
}
const clauses = (s: string): string[] =>
  s.toLowerCase().split(/[，,。.!！;；、\n~～…]+/).map((c) => c.replace(/[\s\p{Extended_Pictographic}]/gu, "").replace(/(呀|啊|哈|嘛|啦|哦|噢)+$/u, "")).filter(Boolean);

/**
 * 一条消息里本人此刻的表态:每个分句都是同意(短句白名单,或含未被否定的「同意/批准/允许/授权」)才算 approve;
 * 每个分句都是拒绝才算 reject;混合、带条件、反问、或只有别的内容一律 unclear(不放行,交给追问)。
 */
export function consentIntent(text: string): Intent {
  if (typeof text !== "string") throw new TypeError("text 必须是字符串");
  const own = ownWords(text);
  if (HEDGE.test(own.trim())) return "unclear";
  const cs = clauses(own);
  if (cs.length === 0) return "unclear";
  const isApprove = (c: string) => APPROVE_WORDS.has(c) || (!NEGATOR.test(c) && CONSENT_VERB.test(c));
  const isReject = (c: string) => REJECT_WORDS.has(c) || (NEGATOR.test(c) && CONSENT_VERB.test(c));
  if (cs.every(isApprove)) return "approve";
  if (cs.every(isReject)) return "reject";
  return "unclear";
}

// ---------------------------------------------------------------- 待授权请求与答复绑定
export const REQUEST_STATES = Object.freeze(["pending", "granted", "denied", "expired"] as const);
export type RequestState = (typeof REQUEST_STATES)[number];
/** 一次待授权:宿主在任务进 T4b 时登记,绑定任务、提问号、当时的约束版本、要做的动作、谁能授权(提出者本人)、提问消息位置。 */
export interface AuthRequest {
  readonly qId: string;
  readonly taskId: string;
  readonly constraintVer: number;
  readonly action: string;
  readonly principal: string;
  readonly roomId: string;
  readonly askedSeq: number;
  readonly state: RequestState;
  /** 了结它的那条答复(granted/denied 时);expired 时为 null */
  readonly decidedBy: { readonly roomId: string; readonly seq: number } | null;
  readonly reason: string | null;
}
export interface ConsentMessage {
  readonly roomId: string;
  readonly seq: number;
  readonly sender: { readonly kind: string; readonly id: string };
  readonly text: string;
  readonly replyToSeq: number | null;
  readonly quotedSeqs: readonly number[];
  /** 转发来的消息(不是本人此刻写的) */
  readonly forwarded: boolean;
  /** 来自外部数据源插件的不可信内容(R-10) */
  readonly external: boolean;
}
export interface Binding {
  readonly taskId: string;
  readonly qId: string;
  readonly constraintVer: number;
  readonly action: string;
  readonly authorizer: string;
  readonly roomId: string;
  readonly seq: number;
}
export type Resolution =
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[]; readonly decision: "approve" | "reject" }
  | { readonly kind: "decision"; readonly decision: "approve" | "reject"; readonly binding: Binding };

const isText = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
const isNat = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const isPos = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1;
const freeze = <T extends object>(o: T): T => Object.freeze(o);

const REQ_INPUT = {
  qId: { kind: "string" }, taskId: { kind: "string" }, constraintVer: { kind: "number" }, action: { kind: "string" },
  principal: { kind: "string" }, roomId: { kind: "string" }, askedSeq: { kind: "number" },
} as const;
/** 登记一次待授权。字段不合格抛 TypeError(宿主内部调用,不是用户输入)。 */
export function openRequest(input: { qId: string; taskId: string; constraintVer: number; action: string; principal: string; roomId: string; askedSeq: number }): AuthRequest {
  const n = normalize<typeof input>(input, REQ_INPUT, "待授权请求");
  if (!n.ok) throw new TypeError(n.reason);
  const r = n.value;
  if (!isText(r.qId) || !isText(r.taskId) || !isNat(r.constraintVer) || !isText(r.action) || !isText(r.principal) || !isText(r.roomId) || !isPos(r.askedSeq)) throw new TypeError("待授权请求字段不合法");
  return freeze({ ...r, state: "pending" as const, decidedBy: null, reason: null });
}

/** 取答复消息的纯数据快照:sender 与 replyToSeq/quotedSeqs 单独核对类型,不合格返回 null。 */
function readMessage(msg: unknown): ConsentMessage | null {
  const n = normalize<{ roomId: string; seq: number; text: string; forwarded: boolean; external: boolean }>(
    msg, { roomId: { kind: "string" }, seq: { kind: "number" }, text: { kind: "string" }, forwarded: { kind: "boolean" }, external: { kind: "boolean" } }, "答复消息");
  if (!n.ok) return null;
  const d = (k: string) => {
    const x = Object.getOwnPropertyDescriptor(msg as object, k);
    return x && Object.hasOwn(x, "value") ? x.value : undefined;
  };
  const sender = d("sender");
  const s = normalize<{ kind: string; id: string }>(sender, { kind: { kind: "string" }, id: { kind: "string" } }, "答复消息.sender");
  if (!s.ok) return null;
  const replyToSeq = d("replyToSeq") ?? null;
  if (replyToSeq !== null && !isPos(replyToSeq)) return null;
  const quotedRaw = d("quotedSeqs") ?? [];
  if (!Array.isArray(quotedRaw) || !quotedRaw.every(isPos)) return null;
  if (!isText(n.value.roomId) || !isPos(n.value.seq)) return null;
  return freeze({ ...n.value, sender: s.value, replyToSeq: replyToSeq as number | null, quotedSeqs: freeze([...(quotedRaw as number[])]) });
}

/**
 * 把一条消息对到待授权请求上(AC-17/19/20)。顺序固定:
 * 1. 只认用户本人(sender.kind = user);联系人、Helper、宿主的话不产生授权;
 * 2. 转发、外部材料不产生授权;
 * 3. 本人此刻的表态(去掉引用块与引号)必须是干脆的同意或拒绝;
 * 4. 候选 = 同一会话里、授权人就是发话人、提问在这条消息之前、仍 pending 的请求;
 * 5. 回复/引用了某次提问的,就是那一次(那次已了结或过期 → 不放行);没指明时只有一个候选才绑定,多个就追问。
 */
export function resolveConsent(requests: readonly AuthRequest[], msg: ConsentMessage): Resolution {
  if (!Array.isArray(requests)) throw new TypeError("requests 必须是数组");
  const m = readMessage(msg);
  if (!m) return freeze({ kind: "none", reason: "答复消息字段不合法" });
  if (m.sender.kind !== "user") return freeze({ kind: "none", reason: "只有用户本人能授权,联系人、Helper 或宿主的话不算" });
  if (m.forwarded) return freeze({ kind: "none", reason: "转发的内容不是本人当前的授权" });
  if (m.external) return freeze({ kind: "none", reason: "外部材料不产生授权" });
  const intent = consentIntent(m.text);
  if (intent === "unclear") return freeze({ kind: "none", reason: "没有干脆的同意或拒绝" });
  const inRoom = requests.filter((r) => r.roomId === m.roomId);
  const anchors = new Set<number>([...(m.replyToSeq !== null ? [m.replyToSeq] : []), ...m.quotedSeqs]);
  const anchored = inRoom.filter((r) => anchors.has(r.askedSeq));
  const live = (r: AuthRequest) => r.state === "pending" && r.principal === m.sender.id && r.askedSeq < m.seq;
  const bind = (r: AuthRequest): Resolution => freeze({
    kind: "decision", decision: intent,
    binding: freeze({ taskId: r.taskId, qId: r.qId, constraintVer: r.constraintVer, action: r.action, authorizer: m.sender.id, roomId: m.roomId, seq: m.seq }),
  });
  if (anchored.length) {
    const ok = anchored.filter(live);
    if (ok.length === 1) return bind(ok[0]!);
    if (ok.length > 1) return freeze({ kind: "ambiguous", candidates: freeze(ok.map((r) => r.qId)), decision: intent });
    const any = anchored[0]!;
    if (any.principal !== m.sender.id) return freeze({ kind: "none", reason: `只有 ${any.principal} 本人能答这次授权` });
    return freeze({ kind: "none", reason: `所答的提问 ${any.qId} 已${any.state === "pending" ? "不在有效期" : any.state === "expired" ? "过期·未执行" : "处理过"}` });
  }
  const mine = inRoom.filter(live);
  if (mine.length === 1) return bind(mine[0]!);
  if (mine.length > 1) return freeze({ kind: "ambiguous", candidates: freeze(mine.map((r) => r.qId)), decision: intent });
  if (inRoom.some((r) => r.state === "pending" && r.askedSeq < m.seq)) return freeze({ kind: "none", reason: "不是这次授权的授权人本人" });
  return freeze({ kind: "none", reason: "没有待授权的动作" });
}

/** 任务当前的绑定快照:用来核对答复是否仍然有效(前提没变、没取消、版本没变)。 */
export interface TaskBinding { readonly taskId: string; readonly state: string; readonly constraintVer: number; readonly pendingQId: string | null }

/**
 * 了结一次待授权:答复必须对上请求的 (task_id, q_id, constraint_ver) 与授权人,且任务此刻仍停在这张卡上
 * (T4b、待答问题就是它、版本没变)。前提失效就把请求记为 expired(卡标「已过期·未执行」),不放行。
 * 已了结的请求再收到同一条答复幂等;收到另一条答复不改结论。
 */
export function settleRequest(req: AuthRequest, binding: Binding, decision: "approve" | "reject", task: TaskBinding): { ok: true; request: AuthRequest; effective: boolean } | { ok: false; reason: string } {
  if (decision !== "approve" && decision !== "reject") return { ok: false, reason: "decision 只能是 approve/reject" };
  if (binding.qId !== req.qId || binding.taskId !== req.taskId) return { ok: false, reason: "答复绑定的不是这次授权" };
  if (binding.authorizer !== req.principal) return { ok: false, reason: `只有 ${req.principal} 本人能答这次授权` };
  if (req.state !== "pending") {
    const same = req.decidedBy !== null && req.decidedBy.roomId === binding.roomId && req.decidedBy.seq === binding.seq;
    return same ? { ok: true, request: req, effective: false } : { ok: false, reason: `这次授权已${req.state === "expired" ? "过期·未执行" : "处理过"}` };
  }
  const expired = (reason: string) => ({ ok: true as const, effective: false, request: freeze({ ...req, state: "expired" as const, decidedBy: null, reason }) });
  if (binding.constraintVer !== req.constraintVer) return expired(`答复针对 v${binding.constraintVer},请求是 v${req.constraintVer}`);
  if (task.taskId !== req.taskId) return { ok: false, reason: "任务对不上" };
  if (task.state !== "T4b_BlockedOnHuman") return expired(`任务已在 ${task.state},前提失效`);
  if (task.pendingQId !== req.qId) return expired("任务当前等的不是这张卡");
  if (task.constraintVer !== req.constraintVer) return expired(`任务已升到 v${task.constraintVer},这次授权针对 v${req.constraintVer}`);
  return {
    ok: true,
    effective: true,
    request: freeze({ ...req, state: decision === "approve" ? "granted" as const : "denied" as const, decidedBy: freeze({ roomId: binding.roomId, seq: binding.seq }), reason: null }),
  };
}

/** 任务前提变了(改条件、取消、版本推进、卡被替换):把还 pending 的请求记为 expired。返回新数组,不改入参。 */
export function expireStale(requests: readonly AuthRequest[], task: TaskBinding): readonly AuthRequest[] {
  return Object.freeze(requests.map((r) => {
    if (r.state !== "pending" || r.taskId !== task.taskId) return r;
    if (task.state === "T4b_BlockedOnHuman" && task.pendingQId === r.qId && task.constraintVer === r.constraintVer) return r;
    return freeze({ ...r, state: "expired" as const, reason: "前提已变,过期·未执行" });
  }));
}

/** 这一版有没有本人给过的写授权(granted 且版本等于当前版本)。 */
export function hasGrant(requests: readonly AuthRequest[], taskId: string, constraintVer: number): boolean {
  return requests.some((r) => r.taskId === taskId && r.state === "granted" && r.constraintVer === constraintVer);
}
