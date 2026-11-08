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

  throw new Error("未实现");
}

/** 按群规收紧执行器工具:要先问且这一版没拿到授权,就去掉全部写工具;否则原样。返回冻结的新数组。 */
export function gateTools(tools: readonly string[], askFirst: boolean, granted: boolean): readonly string[] {

  throw new Error("未实现");
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

  throw new Error("未实现");
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

  throw new Error("未实现");
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

  throw new Error("未实现");
}

/** 任务当前的绑定快照:用来核对答复是否仍然有效(前提没变、没取消、版本没变)。 */
export interface TaskBinding { readonly taskId: string; readonly state: string; readonly constraintVer: number; readonly pendingQId: string | null }

/**
 * 了结一次待授权:答复必须对上请求的 (task_id, q_id, constraint_ver) 与授权人,且任务此刻仍停在这张卡上
 * (T4b、待答问题就是它、版本没变)。前提失效就把请求记为 expired(卡标「已过期·未执行」),不放行。
 * 已了结的请求再收到同一条答复幂等;收到另一条答复不改结论。
 */
export function settleRequest(req: AuthRequest, binding: Binding, decision: "approve" | "reject", task: TaskBinding): { ok: true; request: AuthRequest; effective: boolean } | { ok: false; reason: string } {

  throw new Error("未实现");
}

/** 任务前提变了(改条件、取消、版本推进、卡被替换):把还 pending 的请求记为 expired。返回新数组,不改入参。 */
export function expireStale(requests: readonly AuthRequest[], task: TaskBinding): readonly AuthRequest[] {

  throw new Error("未实现");
}

/** 这一版有没有本人给过的写授权(granted 且版本等于当前版本)。 */
export function hasGrant(requests: readonly AuthRequest[], taskId: string, constraintVer: number): boolean {

  throw new Error("未实现");
}
