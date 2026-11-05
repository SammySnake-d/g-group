// biome-ignore-all lint/correctness/noUnusedVariables lint/correctness/noUnusedFunctionParameters lint/correctness/noUnusedImports: 红提交空壳,绿提交恢复实现
import { types } from "node:util";

// 联系人(AC-01 / AC-33 / 概念卡第 1、11 张)。
// 联系人是持久的 AI 同事:身份(id)一旦建立不随改名、换模型改变;直接工具只收具名有界工具;
// 定时是它自己记下的承诺(带时区与允许误差),插件只提供数据源和输出渠道,不拥有定时。
// 纯函数,不改入参。

/** 联系人本体能直接调用的工具:必须是宿主注册的具名、有界工具(效果可知、返回短)。 */
export interface NamedTool { readonly name: string; readonly bounded: true }
/**
 * 联系人名下、可以授给它手下 Compute 用的能力资产(需求文档 74-79 行的 U66 白名单)。
 * 和直接工具清单是两个集合:shell 类 MCP、跑脚本的 Skill 只能登记在这里,联系人本体永远调不到。
 * Harness 自带的 shell/文件系统是 Compute 的底子,不经这里继承。
 */
export interface ComputeAsset { readonly name: string; readonly kind: "mcp" | "skill" | "script" }
/** Compute 在哪跑:首版只有 local,字段先留好,以后接云端不改状态机(#1186)。 */
export type Placement = "local" | "byom_daemon" | "cloud_sandbox";
export interface Schedule { readonly cron: string; readonly tz: string; readonly toleranceSec: number }
export interface Commitment {
  readonly id: string;
  readonly sourceSeq: number;
  readonly text: string;
  /** 还没进终态的绑定任务。定时承诺不随任务回收。 */
  readonly boundTaskIds: readonly string[];
  /** 已进终态、末次汇报还没确认发出的任务。两张表都空了承诺才回收(AC-31⑤)。 */
  readonly awaitingReport: readonly string[];
  /** 末次汇报确认先于终态到达的任务:记下这个事实,等它终态时直接放行,不再进等待表(乱序、重放都幂等)。 */
  readonly reportedTaskIds: readonly string[];
  readonly schedule: Schedule | null;
  readonly status: "active" | "done" | "revoked";
}
/** 专职锁:只做某条承诺这件事。和工具白名单是两回事;专职时仍必须响应停止和撤销(AC-35①)。 */
export interface FocusPolicy { readonly onlyCommitmentId: string }
export interface Contact {
  readonly id: string;
  readonly name: string;
  readonly speakingModel: string;
  readonly tools: readonly NamedTool[];
  readonly computeAssets: readonly ComputeAsset[];
  readonly memory: string;
  readonly soul: string;
  readonly commitments: readonly Commitment[];
  readonly focus: FocusPolicy | null;
}
export type ContactResult = { ok: true; contact: Contact } | { ok: false; reason: string };
export interface Directory { readonly contacts: ReadonlyMap<string, Contact> }
export type DirectoryResult = { ok: true; dir: Directory } | { ok: false; reason: string };

/** 永远不能进联系人直接工具清单的通用能力;要用就开 Compute(AC-33 ①)。 */
export const FORBIDDEN_DIRECT_TOOLS: readonly string[] = Object.freeze([
  "bash", "shell", "exec", "run_command", "write_file", "edit_file", "apply_patch", "browser", "computer_use", "run_script",
]);
const PLACEMENTS: ReadonlySet<string> = new Set<Placement>(["local", "byom_daemon", "cloud_sandbox"]);
/** 凭据引用句柄的形状:<scheme>://<path>;其余一律当作可能的明文拒绝。 */
const CREDENTIAL_REF = /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/;
/** 群消息位置合法值:非负安全整数(与 log.ts 的单调 seq 一致)。NaN/Infinity/小数/负数一律不是位置。 */
export const isSeq = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;

export interface ComputeBrief {
  readonly task: string;
  readonly rules: readonly string[];
  readonly tools: readonly string[];
  readonly credentialRefs: readonly string[];
  readonly placement: Placement;
}
export type BriefResult = { ok: true; brief: ComputeBrief } | { ok: false; reason: string };
export type InboundIntent =
  | { kind: "control"; action: "stop" | "revoke" | "reschedule"; commitmentId: string }
  /** commitmentId:上游判定这件活属于哪条承诺的职责;不属于任何承诺给 null。本层不做自然语言理解。 */
  | { kind: "work"; text: string; commitmentId: string | null }
  | { kind: "chatter"; text: string };
export type FocusDecision = "handle" | "decline-focused" | "ignore";

// ---------------------------------------------------------------- 入参规范化(普通数据对象合同)
// 领域层所有公开入口(联系人与 Helper)的对象入参都先经 normalize。合同:只接受 JSON 能产生的普通数据对象,依次检查——
//   1. 不是 Proxy(node:util types.isProxy);
//   2. 对象原型为 Object.prototype 或 null,数组为原型 Array.prototype 的真数组;
//   3. 逐个取自有属性描述符,出现任何访问器属性(getter/setter)直接拒绝,getter 永不调用。
// 通过后只从数据属性描述符取值,读到立即复制成冻结纯数据;数组按 length 逐个下标取数据属性,不走迭代器,空位或非字符串项拒绝。
// 快照是空原型(Object.create(null))对象,字段用 defineProperty 写入,数组项同样用 defineProperty,不经过原型链上的同名 setter/不可写属性。
// 之后的校验、判断、错误理由和存储/输出只用这份快照。只认自有属性,schema 没声明的字段丢掉;
// 可选字段只有缺省或 undefined 算缺省,显式 null 按类型不对拒绝。本层不承诺防御任意 JS 元编程对象。
type FieldKind = "string" | "stringOrNull" | "boolean" | "number" | "strings" | "schedule";
interface FieldSpec { readonly kind: FieldKind; readonly optional?: true }
export type Schema = Readonly<Record<string, FieldSpec>>;
export type Normalized<T> = { ok: true; value: T } | { ok: false; reason: string };
type FieldResult = { ok: true; value: unknown } | { ok: false; reason: string };

/** 普通数据检查(调用前已排除 Proxy):返回 null 表示通过,否则返回拒绝理由。不调用任何 getter。 */
function plainDataError(v: object, what: string, wantArray: boolean): string | null {
  const noun = wantArray ? "数组" : "对象";
  const proto: unknown = Object.getPrototypeOf(v);
  if (wantArray ? proto !== Array.prototype || !Array.isArray(v) : proto !== Object.prototype && proto !== null) return `${what} 只接受普通数据${noun}`;
  for (const key of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (d && !("value" in d)) return `${what} 只接受普通数据${noun}(${String(key)} 是访问器属性)`;
  }
  return null;
}

/** 读一个入参数组:必须是普通数据数组;按 length 逐个下标取数据属性复制成本地数组,逐项检查是原始字符串。 */
const readList = (v: unknown, field: string): string[] | { reason: string } => {
  if (typeof v !== "object" || v === null) return { reason: `${field} 必须是字符串数组` };
  if (types.isProxy(v)) return { reason: `${field} 只接受普通数据数组` };
  if (!Array.isArray(v)) return { reason: `${field} 必须是字符串数组` };
  const bad = plainDataError(v, field, true);
  if (bad) return { reason: bad };
  const len = (Object.getOwnPropertyDescriptor(v, "length") as PropertyDescriptor).value as number;
  const out: unknown[] = [];
  for (let i = 0; i < len; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    if (!d) return { reason: `${field} 里只能是字符串` };
    Object.defineProperty(out, i, { value: d.value, writable: true, enumerable: true, configurable: true });
  }
  return out.every((x) => typeof x === "string") ? (out as string[]) : { reason: `${field} 里只能是字符串` };
};

const SCHEDULE_SCHEMA: Schema = { cron: { kind: "string" }, tz: { kind: "string" }, toleranceSec: { kind: "number" } };

function copyField(v: unknown, field: string, kind: FieldKind): FieldResult {
  switch (kind) {
    case "string": return typeof v === "string" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是字符串` };
    case "stringOrNull": return v === null || typeof v === "string" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是字符串或 null` };
    case "boolean": return typeof v === "boolean" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是布尔值` };
    case "number": return typeof v === "number" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是数字` };
    case "strings": { const l = readList(v, field); return Array.isArray(l) ? { ok: true, value: Object.freeze(l) } : { ok: false, reason: l.reason }; }
    case "schedule": return v === null ? { ok: true, value: null } : normalize(v, SCHEDULE_SCHEMA, field);
  }
}

/** 把一个入参对象按 schema 规范化成冻结纯数据快照;不合普通数据合同或字段类型不对时给出理由。 */
export function normalize<T>(input: unknown, schema: Schema, what: string): Normalized<T> {
  throw new Error("未实现");
}

const ASSET_KINDS: ReadonlySet<string> = new Set<ComputeAsset["kind"]>(["mcp", "skill", "script"]);

const freezeContact = (c: Contact): Contact => Object.freeze({
  ...c,
  tools: Object.freeze(c.tools.map((t) => Object.freeze({ ...t }))),
  computeAssets: Object.freeze(c.computeAssets.map((a) => Object.freeze({ ...a }))),
  commitments: Object.freeze(c.commitments.map((k) => Object.freeze({ ...k, boundTaskIds: Object.freeze([...k.boundTaskIds]), awaitingReport: Object.freeze([...k.awaitingReport]), reportedTaskIds: Object.freeze([...k.reportedTaskIds]), schedule: k.schedule ? Object.freeze({ ...k.schedule }) : null }))),
  focus: c.focus ? Object.freeze({ ...c.focus }) : null,
});
const withContact = (d: Directory, c: Contact): Directory => {
  const m = new Map(d.contacts);
  m.set(c.id, freezeContact(c));
  return Object.freeze({ contacts: m });
};

export function emptyDirectory(): Directory {
  throw new Error("未实现");
}

export function addContact(d: Directory, input: { id: string; name: string; speakingModel: string }): DirectoryResult {
  throw new Error("未实现");
}

export function updateContact(d: Directory, id: string, input: Partial<Pick<Contact, "name" | "speakingModel" | "memory" | "soul">>): DirectoryResult {
  throw new Error("未实现");
}

export function grantTool(c: Contact, input: { name: string; bounded: boolean }): ContactResult {
  throw new Error("未实现");
}

function checkSchedule(s: Schedule): string | null {
  const fields = s.cron.trim().split(/\s+/);
  if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) return `定时表达式 "${s.cron}" 不是 5 段 cron`;
  if (!s.tz) return "定时承诺必须写明时区";
  try { new Intl.DateTimeFormat("en-US", { timeZone: s.tz }); } catch { return `时区 "${s.tz}" 不认识`; }
  if (!Number.isFinite(s.toleranceSec) || s.toleranceSec < 0) return "允许误差必须是非负秒数";
  return null;
}

/** 登记一项只给 Compute 用的能力资产。它不会因此进入联系人直接工具清单。 */
export function grantComputeAsset(c: Contact, input: { name: string; kind: ComputeAsset["kind"] }): ContactResult {
  throw new Error("未实现");
}

/** 联系人本体能不能直接调用这个名字:只看直接工具清单,Compute 能力资产不算。 */
export function canCallDirectly(c: Contact, name: string): boolean {
  throw new Error("未实现");
}

type CommitInput = Omit<Commitment, "status" | "awaitingReport" | "reportedTaskIds">;
export function commit(c: Contact, input: CommitInput): ContactResult {
  throw new Error("未实现");
}

/** 承诺结束(回收或撤销)后,指向它的专职锁一起解除,不拦后续新工作。 */
const dropStaleFocus = (c: Contact): Contact =>
  c.focus && !c.commitments.some((k) => k.id === c.focus?.onlyCommitmentId && k.status === "active") ? { ...c, focus: null } : c;

const retire = (k: Commitment): Commitment =>
  k.boundTaskIds.length === 0 && k.awaitingReport.length === 0 ? { ...k, status: "done" } : k;

/**
 * 任务进入终态:从绑定表挪出。它的末次汇报已先确认过,就直接消掉那条记录、按条件回收;
 * 否则挪进"等末次汇报"表,承诺仍有效。定时承诺不受影响。重放(任务已不在绑定表)不改任何东西。
 */
export function settleTask(c: Contact, taskId: string): Contact {
  throw new Error("未实现");
}

/**
 * 一条末次汇报的入库确认(需求文档 1043-1046 行:每条承诺有自己的出处 source_seq 和绑定范围)。
 * commitmentIds:宿主判定这条汇报履行了哪几条承诺,一条汇报可以明确覆盖多条;
 * basedOnSeq:这条汇报依据的处理位置。出处晚于它的承诺是汇报发出后才立的,这条汇报替它作不了数。
 */
export interface FinalReportReceipt { readonly taskId: string; readonly commitmentIds: readonly string[]; readonly basedOnSeq: number }

/**
 * 末次汇报已确认发出(宿主拿到入库回执后调用)。只作用于回执点名、且出处不晚于汇报依据位置的有效承诺:
 * 任务已终态就从等待表消掉并按条件回收;还没终态就记下"已确认",不丢(AC-31⑤ 两项条件都满足才回收,不规定先后)。
 * 回执没点名的承诺、已结束的承诺、与本承诺无关的任务、重复确认、依据位置不是非负整数或字段类型不对的畸形回执都不改状态。
 */
export function confirmFinalReport(c: Contact, input: FinalReportReceipt): Contact {
  throw new Error("未实现");
}

/** 用户撤销一条承诺:置为 revoked,指向它的专职锁同时解除。 */
export function revokeCommitment(c: Contact, id: string): ContactResult {
  throw new Error("未实现");
}

export function setFocus(c: Contact, input: FocusPolicy | null): ContactResult {
  throw new Error("未实现");
}

/** 入站意图按 kind 分变体校验(CH-24):每个变体只取自己声明的字段,别的字段丢掉、不影响判定。 */
const INTENT_SCHEMAS: ReadonlyMap<string, Schema> = new Map<string, Schema>([
  ["control", { action: { kind: "string" }, commitmentId: { kind: "string" } }],
  ["work", { text: { kind: "string" }, commitmentId: { kind: "stringOrNull" } }],
  ["chatter", { text: { kind: "string" } }],
]);
const CONTROL_ACTIONS: ReadonlySet<string> = new Set(["stop", "revoke", "reschedule"]);

/**
 * 入站意图不合变体形状(不是普通数据对象、kind 不认识、必填字段缺失或类型不对、control 的 action 不在 stop/revoke/reschedule、
 * control 的 commitmentId 为空)一律 ignore,不当成工作也不当成控制。kind 与各变体字段都只读一次。
 */
export function decideUnderFocus(c: Contact, input: InboundIntent): FocusDecision {
  throw new Error("未实现");
}

export interface BriefRequest { readonly task: string; readonly rules: readonly string[]; readonly tools: readonly string[]; readonly credentialRefs: readonly string[]; readonly placement?: Placement }

/**
 * 派给 Compute 的说明:只带任务、群规切片、联系人已授权集合(直接工具 + Compute 能力资产)内的工具和凭据引用;不带记忆和性格(AC-33 ④)。
 * 入参经 normalize 变成冻结纯数据快照 r(每个字段只读一次、读到立即复制),之后的校验和输出都只用这份快照(CH-18/CH-21)。
 * placement 缺省或 undefined 时默认 local;显式 null 和其他值拒绝(CH-22)。
 */
export function briefFor(c: Contact, input: BriefRequest): BriefResult {
  throw new Error("未实现");
}
