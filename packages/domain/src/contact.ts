import { types } from "node:util";
import { type Normalized, normalize, plainDataError, type Schema } from "./plain.ts";

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

const ASSET_KINDS: ReadonlySet<string> = new Set<ComputeAsset["kind"]>(["mcp", "skill", "script"]);

// ---------------------------------------------------------------- 状态参数(CH-32 / CH-37 / CH-38)
// 调用方传回来的联系人与目录状态也是公开入口的对象参数,按同一合同规范化:Proxy、非普通原型、含访问器一律拒绝,
// 只取声明字段(旧版本留下的 focus 之类多余字段丢掉)。所有接受状态的入口都返回带失败分支的结果,状态不合法时返回 { ok:false, reason },不抛
// (canCallDirectly 返回 false)。形状通过后再查业务不变量:这些都是登记入口(grantTool、grantComputeAsset、commit、addContact)
// 本来就不可能产生的状态,出现就说明状态是伪造或损坏的,不能当授权依据(CH-38)。
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
const COMMITMENT_STATUSES: ReadonlySet<string> = new Set<Commitment["status"]>(["active", "done", "revoked"]);

/** 联系人状态的业务不变量(快照已是冻结纯数据):返回 null 表示通过,否则返回拒绝理由。 */
function contactInvariantError(c: Contact): string | null {
  for (let i = 0; i < c.tools.length; i++) {
    const t = c.tools[i] as NamedTool;
    const at = `联系人状态.tools[${i}]`;
    if (t.bounded !== true) return `${at} 不是有界工具,不能当直接工具`;
    if (!t.name.trim()) return `${at} 工具名为空`;
    if (FORBIDDEN_DIRECT_TOOLS.includes(t.name)) return `${at} ${t.name} 是通用能力,不能在直接工具清单里`;
    if (c.computeAssets.some((x) => x.name === t.name)) return `${at} ${t.name} 同时登记为 Compute 能力资产`;
  }
  for (let i = 0; i < c.computeAssets.length; i++) {
    const a = c.computeAssets[i] as ComputeAsset;
    const at = `联系人状态.computeAssets[${i}]`;
    if (!ASSET_KINDS.has(a.kind)) return `${at} 的类别 ${a.kind} 不认识`;
    if (!a.name.trim()) return `${at} 能力资产名为空`;
  }
  for (let i = 0; i < c.commitments.length; i++) {
    const k = c.commitments[i] as Commitment;
    const at = `联系人状态.commitments[${i}]`;
    if (!COMMITMENT_STATUSES.has(k.status)) return `${at} 的状态 ${k.status} 不认识`;
    if (!isSeq(k.sourceSeq)) return `${at} 的出处 ${k.sourceSeq} 不是合法的消息位置`;
    if (k.schedule) { const e = checkSchedule(k.schedule); if (e) return `${at} ${e}`; }
  }
  return null;
}

const readContact = (state: unknown): Normalized<Contact> => {
  const n = normalize<Contact>(state, CONTACT_SCHEMA, "联系人状态");
  if (!n.ok) return n;
  const bad = contactInvariantError(n.value);
  return bad ? { ok: false, reason: bad } : n;
};

/**
 * 目录对外给出的联系人表:运行时只读。只有读方法,没有 set/delete/clear;内部 Map 放在私有字段里,
 * 借 Map.prototype 的方法(如 Map.prototype.delete.call)也碰不到它;实例、原型和类本身都冻结。
 */
let tableMap: (x: object) => ReadonlyMap<string, unknown> | undefined = () => undefined;
class ContactTable implements ReadonlyMap<string, Contact> {
  readonly #m: Map<string, Contact>;
  static {
    tableMap = (x) => (#m in x ? (x as ContactTable).#m : undefined);
  }
  constructor(m: Map<string, Contact>) {
    this.#m = m;
    Object.freeze(this);
  }
  get size(): number { return this.#m.size; }
  get(key: string): Contact | undefined { return this.#m.get(key); }
  has(key: string): boolean { return this.#m.has(key); }
  forEach(fn: (value: Contact, key: string, map: ReadonlyMap<string, Contact>) => void, thisArg?: unknown): void {
    for (const [k, v] of this.#m) fn.call(thisArg, v, k, this);
  }
  keys(): MapIterator<string> { return this.#m.keys(); }
  values(): MapIterator<Contact> { return this.#m.values(); }
  entries(): MapIterator<[string, Contact]> { return this.#m.entries(); }
  [Symbol.iterator](): MapIterator<[string, Contact]> { return this.#m[Symbol.iterator](); }
}
Object.freeze(ContactTable.prototype);
Object.freeze(ContactTable);

/**
 * 目录状态:外层是普通数据对象;contacts 是本模块给出的只读联系人表,或调用方自己组的真 Map(不是 Proxy、原型为 Map.prototype、无访问器自有属性)。
 * 两种都只经内部 Map 逐项取值,每个联系人按 CONTACT_SCHEMA 规范化并查不变量,键必须是字符串且等于联系人自己的 id(CH-38)。
 */
function readDirectory(d: unknown): Normalized<{ contacts: Map<string, Contact> }> {
  if (typeof d !== "object" || d === null) return { ok: false, reason: "目录 必须是对象" };
  if (types.isProxy(d)) return { ok: false, reason: "目录 只接受普通数据对象" };
  if (Array.isArray(d)) return { ok: false, reason: "目录 必须是对象" };
  const bad = plainDataError(d, "目录", false);
  if (bad) return { ok: false, reason: bad };
  const desc = Object.getOwnPropertyDescriptor(d, "contacts");
  const raw: unknown = desc !== undefined && Object.hasOwn(desc, "value") ? desc.value : undefined;
  if (typeof raw !== "object" || raw === null || types.isProxy(raw)) return { ok: false, reason: "目录.contacts 必须是普通 Map" };
  const m: unknown = tableMap(raw) ?? raw;
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
    if (c.value.id !== k) { errs.push(`目录.contacts 的键 ${k} 与联系人 id ${c.value.id} 不一致`); return; }
    out.set(k, c.value);
  });
  if (errs.length) return { ok: false, reason: errs[0] as string };
  return { ok: true, value: { contacts: out } };
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
const directoryOf = (m: Map<string, Contact>): Directory => Object.freeze({ contacts: new ContactTable(m) });
const withContact = (d: { contacts: Map<string, Contact> }, c: Contact): Directory => {
  const m = new Map(d.contacts);
  m.set(c.id, freezeContact(c));
  return directoryOf(m);
};

export function emptyDirectory(): Directory {
  return directoryOf(new Map<string, Contact>());
}

export function addContact(dirState: Directory, input: { id: string; name: string; speakingModel: string }): DirectoryResult {
  const dir = readDirectory(dirState);
  if (!dir.ok) return dir;
  const d = dir.value;
  const n = normalize<{ id: string; name: string; speakingModel: string }>(input, { id: { kind: "string" }, name: { kind: "string" }, speakingModel: { kind: "string" } }, "联系人");
  if (!n.ok) return n;
  const c = n.value;
  if (!c.id) return { ok: false, reason: "联系人 id 不能为空" };
  if (d.contacts.has(c.id)) return { ok: false, reason: `联系人 ${c.id} 已存在,不能同 id 新建覆盖` };
  return { ok: true, dir: withContact(d, { id: c.id, name: c.name, speakingModel: c.speakingModel, tools: [], computeAssets: [], memory: "", soul: "", commitments: [] }) };
}

export function updateContact(dirState: Directory, id: string, input: Partial<Pick<Contact, "name" | "speakingModel" | "memory" | "soul">>): DirectoryResult {
  if (typeof id !== "string") return { ok: false, reason: "联系人 id 必须是字符串" };
  const dir = readDirectory(dirState);
  if (!dir.ok) return dir;
  const d = dir.value;
  const n = normalize<Partial<Pick<Contact, "name" | "speakingModel" | "memory" | "soul">>>(input, { name: { kind: "string", optional: true }, speakingModel: { kind: "string", optional: true }, memory: { kind: "string", optional: true }, soul: { kind: "string", optional: true } }, "联系人修改");
  if (!n.ok) return n;
  const patch = n.value;
  const cur = d.contacts.get(id);
  if (!cur) return { ok: false, reason: `联系人 ${id} 不存在` };
  const next: Contact = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.speakingModel !== undefined ? { speakingModel: patch.speakingModel } : {}),
    ...(patch.memory !== undefined ? { memory: patch.memory } : {}),
    ...(patch.soul !== undefined ? { soul: patch.soul } : {}),
  };
  return { ok: true, dir: withContact(d, next) };
}

export function grantTool(state: Contact, input: { name: string; bounded: boolean }): ContactResult {
  const s = readContact(state);
  if (!s.ok) return s;
  const c = s.value;
  const n = normalize<{ name: string; bounded: boolean }>(input, { name: { kind: "string" }, bounded: { kind: "boolean" } }, "直接工具");
  if (!n.ok) return n;
  const tool = n.value;
  if (!tool.name.trim()) return { ok: false, reason: "工具名不能为空" };
  if (FORBIDDEN_DIRECT_TOOLS.includes(tool.name)) return { ok: false, reason: `${tool.name} 是通用能力,只能在 Compute 里用` };
  if (!tool.bounded) return { ok: false, reason: `${tool.name} 不是有界工具,不能进联系人直接工具清单` };
  if (c.computeAssets.some((x) => x.name === tool.name)) return { ok: false, reason: `${tool.name} 已登记为只给 Compute 用的能力资产,不能再当直接工具` };
  if (c.tools.some((t) => t.name === tool.name)) return { ok: true, contact: freezeContact(c) };
  return { ok: true, contact: freezeContact({ ...c, tools: [...c.tools, { name: tool.name, bounded: true }] }) };
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
  const s = readContact(state);
  if (!s.ok) return s;
  const c = s.value;
  const n = normalize<{ name: string; kind: ComputeAsset["kind"] }>(input, { name: { kind: "string" }, kind: { kind: "string" } }, "能力资产");
  if (!n.ok) return n;
  const a = n.value;
  if (!ASSET_KINDS.has(a.kind)) return { ok: false, reason: `未知的能力资产类别 ${a.kind}` };
  if (!a.name.trim()) return { ok: false, reason: "能力资产名不能为空" };
  if (c.tools.some((t) => t.name === a.name)) return { ok: false, reason: `${a.name} 已是直接工具,不必再登记` };
  const same = c.computeAssets.find((x) => x.name === a.name);
  if (same && same.kind !== a.kind) return { ok: false, reason: `${a.name} 已登记为 ${same.kind} 类能力资产,不能再以 ${a.kind} 类同名登记` };
  if (same) return { ok: true, contact: freezeContact(c) };
  return { ok: true, contact: freezeContact({ ...c, computeAssets: [...c.computeAssets, { name: a.name, kind: a.kind }] }) };
}

/** 联系人本体能不能直接调用这个名字:只看直接工具清单,Compute 能力资产不算。 */
export function canCallDirectly(state: Contact, name: string): boolean {
  if (typeof name !== "string") return false;
  const s = readContact(state);
  if (!s.ok) return false;
  const c = s.value;
  return c.tools.some((t) => t.name === name);
}

type CommitInput = Omit<Commitment, "status" | "awaitingReport" | "reportedTaskIds">;
export function commit(state: Contact, input: CommitInput): ContactResult {
  const s = readContact(state);
  if (!s.ok) return s;
  const c = s.value;
  const n = normalize<CommitInput>(input, { id: { kind: "string" }, sourceSeq: { kind: "number" }, text: { kind: "string" }, boundTaskIds: { kind: "strings" }, schedule: { kind: "schedule" } }, "承诺");
  if (!n.ok) return n;
  const k = n.value;
  if (c.commitments.some((x) => x.id === k.id)) return { ok: false, reason: `承诺 ${k.id} 已存在` };
  if (!isSeq(k.sourceSeq)) return { ok: false, reason: `承诺出处 ${k.sourceSeq} 不是合法的消息位置(非负整数)` };
  if (k.schedule) { const e = checkSchedule(k.schedule); if (e) return { ok: false, reason: e }; }
  return { ok: true, contact: freezeContact({ ...c, commitments: [...c.commitments, { ...k, awaitingReport: [], reportedTaskIds: [], status: "active" }] }) };
}

const retire = (k: Commitment): Commitment =>
  k.boundTaskIds.length === 0 && k.awaitingReport.length === 0 ? { ...k, status: "done" } : k;

/**
 * 任务进入终态:从绑定表挪出。它的末次汇报已先确认过,就直接消掉那条记录、按条件回收;
 * 否则挪进"等末次汇报"表,承诺仍有效。定时承诺不受影响。重放(任务已不在绑定表)不改任何东西。
 * taskId 不是字符串(含 Proxy、带 Symbol.toPrimitive 的对象)或状态不合法时返回 { ok:false, reason },不抛;taskId 只用 typeof 判定,不插值、不调用它的任何方法(CH-36/CH-37)。
 */
export function settleTask(state: Contact, taskId: string): ContactResult {
  if (typeof taskId !== "string") return { ok: false, reason: "任务 id 必须是字符串" };
  const s = readContact(state);
  if (!s.ok) return s;
  const c = s.value;
  return { ok: true, contact: freezeContact({
    ...c,
    commitments: c.commitments.map((k) => {
      if (k.status !== "active" || k.schedule || !k.boundTaskIds.includes(taskId)) return k;
      const boundTaskIds = k.boundTaskIds.filter((t) => t !== taskId);
      if (k.reportedTaskIds.includes(taskId)) return retire({ ...k, boundTaskIds, reportedTaskIds: k.reportedTaskIds.filter((t) => t !== taskId) });
      return { ...k, boundTaskIds, awaitingReport: [...k.awaitingReport, taskId] };
    }),
  }) };
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
 * 回执没点名的承诺、已结束的承诺、与本承诺无关的任务、重复确认、依据位置不是非负整数或字段类型不对的畸形回执都不改状态({ ok:true } 原样返回)。
 * 状态不合法(含 JSON null)时返回 { ok:false, reason },不抛(CH-37)。
 */
export function confirmFinalReport(state: Contact, input: FinalReportReceipt): ContactResult {
  const s = readContact(state);
  if (!s.ok) return s;
  const c = s.value;
  const n = normalize<FinalReportReceipt>(input, { taskId: { kind: "string" }, commitmentIds: { kind: "strings" }, basedOnSeq: { kind: "number" } }, "回执");
  if (!n.ok) return { ok: true, contact: freezeContact(c) };
  const receipt = n.value;
  const { taskId } = receipt;
  if (!isSeq(receipt.basedOnSeq)) return { ok: true, contact: freezeContact(c) };
  return { ok: true, contact: freezeContact({
    ...c,
    commitments: c.commitments.map((k) => {
      if (k.status !== "active" || k.schedule) return k;
      if (!receipt.commitmentIds.includes(k.id) || k.sourceSeq > receipt.basedOnSeq) return k;
      if (k.awaitingReport.includes(taskId)) return retire({ ...k, awaitingReport: k.awaitingReport.filter((t) => t !== taskId) });
      if (k.boundTaskIds.includes(taskId) && !k.reportedTaskIds.includes(taskId)) return { ...k, reportedTaskIds: [...k.reportedTaskIds, taskId] };
      return k;
    }),
  }) };
}

/** 用户撤销一条承诺:置为 revoked。id 不是字符串时先拒绝,不插进理由、不遍历状态(CH-36)。 */
export function revokeCommitment(state: Contact, id: string): ContactResult {
  if (typeof id !== "string") return { ok: false, reason: "承诺 id 必须是字符串" };
  const s = readContact(state);
  if (!s.ok) return s;
  const c = s.value;
  if (!c.commitments.some((k) => k.id === id && k.status === "active")) return { ok: false, reason: `承诺 ${id} 不存在或已结束` };
  return { ok: true, contact: freezeContact({ ...c, commitments: c.commitments.map((k) => (k.id === id ? { ...k, status: "revoked" } : k)) }) };
}

export interface BriefRequest { readonly task: string; readonly rules: readonly string[]; readonly tools: readonly string[]; readonly credentialRefs: readonly string[]; readonly placement?: Placement }

/**
 * 派给 Compute 的说明:只带任务、群规切片、联系人已授权集合(直接工具 + Compute 能力资产)内的工具和凭据引用;不带记忆和性格(AC-33 ④)。
 * 入参经 normalize 变成冻结纯数据快照 r(每个字段只读一次、读到立即复制),之后的校验和输出都只用这份快照(CH-18/CH-21)。
 * placement 缺省或 undefined 时默认 local;显式 null 和其他值拒绝(CH-22)。
 */
export function briefFor(state: Contact, input: BriefRequest): BriefResult {
  const s = readContact(state);
  if (!s.ok) return s;
  const c = s.value;
  const n = normalize<{ task: string; rules: readonly string[]; tools: readonly string[]; credentialRefs: readonly string[]; placement?: string }>(input, { task: { kind: "string" }, rules: { kind: "strings" }, tools: { kind: "strings" }, credentialRefs: { kind: "strings" }, placement: { kind: "string", optional: true } }, "Compute 说明请求");
  if (!n.ok) return n;
  const r = n.value;
  const placement = r.placement ?? "local";
  if (!PLACEMENTS.has(placement)) return { ok: false, reason: `未知的运行位置 ${placement}` };
  if (r.tools.some((t) => !t.trim())) return { ok: false, reason: "派给 Compute 的工具名不能为空" };
  const allowed = new Set([...c.tools.map((t) => t.name), ...c.computeAssets.map((x) => x.name)]);
  const extra = r.tools.filter((t) => !allowed.has(t));
  if (extra.length) return { ok: false, reason: `工具 ${extra.join(", ")} 超出联系人 ${c.id} 的授权集合` };
  const bad = r.credentialRefs.filter((x) => !CREDENTIAL_REF.test(x));
  if (bad.length) return { ok: false, reason: "凭据只能给引用句柄(<scheme>://<path>),不能给明文" };
  return { ok: true, brief: Object.freeze({ task: r.task, rules: Object.freeze([...r.rules]), tools: Object.freeze([...r.tools]), credentialRefs: Object.freeze([...r.credentialRefs]), placement: placement as Placement }) };
}
