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
export interface Contact {
  readonly id: string;
  readonly name: string;
  readonly speakingModel: string;
  readonly tools: readonly NamedTool[];
  readonly computeAssets: readonly ComputeAsset[];
  readonly memory: string;
  readonly soul: string;
  readonly commitments: readonly Commitment[];
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

// ---------------------------------------------------------------- 入参规范化(普通数据对象合同)
// 领域层所有公开入口(联系人与 Helper)的对象参数都先经 normalize,包括调用方传回来的状态(Contact、Directory)。合同:只接受 JSON 能产生的普通数据对象,依次检查——
//   1. 不是 Proxy(node:util types.isProxy);
//   2. 对象原型为 Object.prototype 或 null,数组为原型 Array.prototype 的真数组;
//   3. 用 Reflect.ownKeys 逐个取全部自有属性(含不可枚举、Symbol 键)的描述符,描述符自己没有 value 就是访问器,直接拒绝,getter 永不调用。
// 只认自有属性:描述符的 value、schema 的 optional/of 标记都用 Object.hasOwn 判定,不读原型链。
// 通过后只从数据属性取值,读到立即复制成冻结纯数据;数组按 length 逐个下标取值,不走迭代器,空位或类型不对的项拒绝。
// 快照是空原型(Object.create(null))对象,字段与数组项用 defineProperty 写入,属性描述符本身也是空原型对象,
// 不会从 Object.prototype 继承 get/set/value 等字段,也不经过原型链上的同名 setter 或不可写属性。
// 之后的校验、判断、错误理由和存储/输出只用这份快照;输出的联系人只按声明字段重新构造,状态里多出来的字段(如旧版本的 focus)不会带出。
// schema 没声明的字段丢掉;可选字段只有缺省或 undefined 算缺省,显式 null 按类型不对拒绝。本层不承诺防御任意 JS 元编程对象。
type FieldKind = "string" | "stringOrNull" | "boolean" | "number" | "strings" | "schedule" | "objects";
interface FieldSpec { readonly kind: FieldKind; readonly optional?: true; readonly of?: Schema }
export type Schema = Readonly<Record<string, FieldSpec>>;
export type Normalized<T> = { ok: true; value: T } | { ok: false; reason: string };
type FieldResult = { ok: true; value: unknown } | { ok: false; reason: string };

/** 空原型的数据属性描述符:defineProperty 读描述符字段时不会读到 Object.prototype 上的同名属性。 */
const dataDesc = (value: unknown, writable: boolean): PropertyDescriptor => {
  const d = Object.create(null) as PropertyDescriptor;
  d.value = value;
  d.writable = writable;
  d.enumerable = true;
  d.configurable = writable;
  return d;
};
const isOptional = (s: FieldSpec): boolean => Object.hasOwn(s, "optional") && s.optional === true;

/** 普通数据检查(调用前已排除 Proxy):返回 null 表示通过,否则返回拒绝理由。不调用任何 getter。 */
function plainDataError(v: object, what: string, wantArray: boolean): string | null {
  const noun = wantArray ? "数组" : "对象";
  const proto: unknown = Object.getPrototypeOf(v);
  if (wantArray ? proto !== Array.prototype || !Array.isArray(v) : proto !== Object.prototype && proto !== null) return `${what} 只接受普通数据${noun}`;
  for (const key of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (d && !Object.hasOwn(d, "value")) return `${what} 只接受普通数据${noun}(${String(key)} 是访问器属性)`;
  }
  return null;
}

/** 复制一个普通数据数组:按 length 逐个下标取自有数据属性复制成本地数组,不走迭代器;空位取成 undefined,交给调用方按项类型拒绝。 */
const copyArray = (v: unknown, field: string, want: string): unknown[] | { reason: string } => {
  if (typeof v !== "object" || v === null) return { reason: `${field} 必须是${want}` };
  if (types.isProxy(v)) return { reason: `${field} 只接受普通数据数组` };
  if (!Array.isArray(v)) return { reason: `${field} 必须是${want}` };
  const bad = plainDataError(v, field, true);
  if (bad) return { reason: bad };
  const len = (Object.getOwnPropertyDescriptor(v, "length") as PropertyDescriptor).value as number;
  const out: unknown[] = [];
  for (let i = 0; i < len; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    Object.defineProperty(out, i, dataDesc(d !== undefined && Object.hasOwn(d, "value") ? d.value : undefined, true));
  }
  return out;
};

/** 读一个入参数组:必须是普通数据数组,每项都是原始字符串。 */
const readList = (v: unknown, field: string): string[] | { reason: string } => {
  const out = copyArray(v, field, "字符串数组");
  if (!Array.isArray(out)) return out;
  return out.every((x) => typeof x === "string") ? (out as string[]) : { reason: `${field} 里只能是字符串` };
};

/** 读一个对象数组:必须是普通数据数组,每项按 of 规范化成快照。 */
const readObjects = (v: unknown, field: string, of: Schema): FieldResult => {
  const arr = copyArray(v, field, "对象数组");
  if (!Array.isArray(arr)) return { ok: false, reason: arr.reason };
  const out: unknown[] = [];
  for (let i = 0; i < arr.length; i++) {
    const n = normalize(arr[i], of, `${field}[${i}]`);
    if (!n.ok) return n;
    Object.defineProperty(out, i, dataDesc(n.value, true));
  }
  return { ok: true, value: Object.freeze(out) };
};

const SCHEDULE_SCHEMA: Schema = { cron: { kind: "string" }, tz: { kind: "string" }, toleranceSec: { kind: "number" } };

function copyField(v: unknown, field: string, spec: FieldSpec): FieldResult {
  switch (spec.kind) {
    case "string": return typeof v === "string" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是字符串` };
    case "stringOrNull": return v === null || typeof v === "string" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是字符串或 null` };
    case "boolean": return typeof v === "boolean" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是布尔值` };
    case "number": return typeof v === "number" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是数字` };
    case "strings": { const l = readList(v, field); return Array.isArray(l) ? { ok: true, value: Object.freeze(l) } : { ok: false, reason: l.reason }; }
    case "schedule": return v === null ? { ok: true, value: null } : normalize(v, SCHEDULE_SCHEMA, field);
    case "objects": return readObjects(v, field, Object.hasOwn(spec, "of") ? (spec.of as Schema) : {});
  }
}

/** 把一个入参对象按 schema 规范化成冻结纯数据快照;不合普通数据合同或字段类型不对时给出理由。 */
export function normalize<T>(input: unknown, schema: Schema, what: string): Normalized<T> {
  throw new Error("未实现");
}

const ASSET_KINDS: ReadonlySet<string> = new Set<ComputeAsset["kind"]>(["mcp", "skill", "script"]);

// ---------------------------------------------------------------- 状态参数(CH-32)
// 调用方传回来的联系人与目录状态也是公开入口的对象参数,按同一合同规范化:Proxy、非普通原型、含访问器一律拒绝,
// 只取声明字段(旧版本留下的 focus 之类多余字段丢掉)。返回结果类型带失败分支的入口返回 { ok:false, reason };
// settleTask、confirmFinalReport 只返回 Contact,没有失败分支,状态不合法时抛 TypeError(带同样的理由)。
const TOOL_SCHEMA: Schema = { name: { kind: "string" }, bounded: { kind: "boolean" } };
const ASSET_SCHEMA: Schema = { name: { kind: "string" }, kind: { kind: "string" } };
const COMMITMENT_SCHEMA: Schema = {
  id: { kind: "string" }, sourceSeq: { kind: "number" }, text: { kind: "string" }, boundTaskIds: { kind: "strings" },
  awaitingReport: { kind: "strings" }, reportedTaskIds: { kind: "strings" }, schedule: { kind: "schedule" }, status: { kind: "string" },
};
const CONTACT_SCHEMA: Schema = {
  id: { kind: "string" }, name: { kind: "string" }, speakingModel: { kind: "string" },
  tools: { kind: "objects", of: TOOL_SCHEMA }, computeAssets: { kind: "objects", of: ASSET_SCHEMA },
  memory: { kind: "string" }, soul: { kind: "string" }, commitments: { kind: "objects", of: COMMITMENT_SCHEMA },
};
const readContact = (state: unknown): Normalized<Contact> => normalize<Contact>(state, CONTACT_SCHEMA, "联系人状态");
const mustContact = (state: unknown): Contact => {
  const n = readContact(state);
  if (!n.ok) throw new TypeError(n.reason);
  return n.value;
};

/** 目录状态:外层是普通数据对象,contacts 是真 Map(不是 Proxy、原型为 Map.prototype、无访问器自有属性),每个联系人按 CONTACT_SCHEMA 规范化。 */
function readDirectory(d: unknown): Normalized<Directory> {
  if (typeof d !== "object" || d === null) return { ok: false, reason: "目录 必须是对象" };
  if (types.isProxy(d)) return { ok: false, reason: "目录 只接受普通数据对象" };
  if (Array.isArray(d)) return { ok: false, reason: "目录 必须是对象" };
  const bad = plainDataError(d, "目录", false);
  if (bad) return { ok: false, reason: bad };
  const desc = Object.getOwnPropertyDescriptor(d, "contacts");
  const m: unknown = desc !== undefined && Object.hasOwn(desc, "value") ? desc.value : undefined;
  if (typeof m !== "object" || m === null || types.isProxy(m) || !types.isMap(m) || Object.getPrototypeOf(m) !== Map.prototype) return { ok: false, reason: "目录.contacts 必须是普通 Map" };
  for (const key of Reflect.ownKeys(m)) {
    const x = Object.getOwnPropertyDescriptor(m, key);
    if (x && !Object.hasOwn(x, "value")) return { ok: false, reason: `目录.contacts 只接受普通 Map(${String(key)} 是访问器属性)` };
  }
  const out = new Map<string, Contact>();
  const errs: string[] = [];
  Map.prototype.forEach.call(m, (v: unknown, k: unknown) => {
    if (errs.length) return;
    if (typeof k !== "string") { errs.push("目录.contacts 的键必须是字符串"); return; }
    const c = readContact(v);
    if (!c.ok) { errs.push(c.reason); return; }
    out.set(k, c.value);
  });
  if (errs.length) return { ok: false, reason: errs[0] as string };
  return { ok: true, value: Object.freeze({ contacts: out }) };
}

/** 输出联系人:只按声明字段重新构造(普通对象字面量,定义属性不经过原型链 setter),再逐层冻结。 */
const freezeContact = (c: Contact): Contact => Object.freeze({
  id: c.id,
  name: c.name,
  speakingModel: c.speakingModel,
  tools: Object.freeze(c.tools.map((t) => Object.freeze({ name: t.name, bounded: t.bounded }))),
  computeAssets: Object.freeze(c.computeAssets.map((a) => Object.freeze({ name: a.name, kind: a.kind }))),
  memory: c.memory,
  soul: c.soul,
  commitments: Object.freeze(c.commitments.map((k) => Object.freeze({
    id: k.id, sourceSeq: k.sourceSeq, text: k.text,
    boundTaskIds: Object.freeze([...k.boundTaskIds]), awaitingReport: Object.freeze([...k.awaitingReport]), reportedTaskIds: Object.freeze([...k.reportedTaskIds]),
    schedule: k.schedule ? Object.freeze({ cron: k.schedule.cron, tz: k.schedule.tz, toleranceSec: k.schedule.toleranceSec }) : null,
    status: k.status,
  }))),
});
const withContact = (d: Directory, c: Contact): Directory => {
  const m = new Map(d.contacts);
  m.set(c.id, freezeContact(c));
  return Object.freeze({ contacts: m });
};

export function emptyDirectory(): Directory {
  throw new Error("未实现");
}

export function addContact(dirState: Directory, input: { id: string; name: string; speakingModel: string }): DirectoryResult {
  throw new Error("未实现");
}

export function updateContact(dirState: Directory, id: string, input: Partial<Pick<Contact, "name" | "speakingModel" | "memory" | "soul">>): DirectoryResult {
  throw new Error("未实现");
}

export function grantTool(state: Contact, input: { name: string; bounded: boolean }): ContactResult {
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
export function grantComputeAsset(state: Contact, input: { name: string; kind: ComputeAsset["kind"] }): ContactResult {
  throw new Error("未实现");
}

/** 联系人本体能不能直接调用这个名字:只看直接工具清单,Compute 能力资产不算。 */
export function canCallDirectly(state: Contact, name: string): boolean {
  throw new Error("未实现");
}

type CommitInput = Omit<Commitment, "status" | "awaitingReport" | "reportedTaskIds">;
export function commit(state: Contact, input: CommitInput): ContactResult {
  throw new Error("未实现");
}

const retire = (k: Commitment): Commitment =>
  k.boundTaskIds.length === 0 && k.awaitingReport.length === 0 ? { ...k, status: "done" } : k;

/**
 * 任务进入终态:从绑定表挪出。它的末次汇报已先确认过,就直接消掉那条记录、按条件回收;
 * 否则挪进"等末次汇报"表,承诺仍有效。定时承诺不受影响。重放(任务已不在绑定表)不改任何东西。
 */
export function settleTask(state: Contact, taskId: string): Contact {
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
export function confirmFinalReport(state: Contact, input: FinalReportReceipt): Contact {
  throw new Error("未实现");
}

/** 用户撤销一条承诺:置为 revoked。 */
export function revokeCommitment(state: Contact, id: string): ContactResult {
  throw new Error("未实现");
}

export interface BriefRequest { readonly task: string; readonly rules: readonly string[]; readonly tools: readonly string[]; readonly credentialRefs: readonly string[]; readonly placement?: Placement }

/**
 * 派给 Compute 的说明:只带任务、群规切片、联系人已授权集合(直接工具 + Compute 能力资产)内的工具和凭据引用;不带记忆和性格(AC-33 ④)。
 * 入参经 normalize 变成冻结纯数据快照 r(每个字段只读一次、读到立即复制),之后的校验和输出都只用这份快照(CH-18/CH-21)。
 * placement 缺省或 undefined 时默认 local;显式 null 和其他值拒绝(CH-22)。
 */
export function briefFor(state: Contact, input: BriefRequest): BriefResult {
  throw new Error("未实现");
}
