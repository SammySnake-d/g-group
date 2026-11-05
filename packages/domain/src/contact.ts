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
const isSeq = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
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
  return Object.freeze({ contacts: new Map<string, Contact>() });
}

export function addContact(d: Directory, c: { id: string; name: string; speakingModel: string }): DirectoryResult {
  if (!c.id) return { ok: false, reason: "联系人 id 不能为空" };
  if (d.contacts.has(c.id)) return { ok: false, reason: `联系人 ${c.id} 已存在,不能同 id 新建覆盖` };
  return { ok: true, dir: withContact(d, { id: c.id, name: c.name, speakingModel: c.speakingModel, tools: [], computeAssets: [], memory: "", soul: "", commitments: [], focus: null }) };
}

export function updateContact(d: Directory, id: string, patch: Partial<Pick<Contact, "name" | "speakingModel" | "memory" | "soul">>): DirectoryResult {
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

export function grantTool(c: Contact, tool: { name: string; bounded: boolean }): ContactResult {
  if (!tool.name.trim()) return { ok: false, reason: "工具名不能为空" };
  if (FORBIDDEN_DIRECT_TOOLS.includes(tool.name)) return { ok: false, reason: `${tool.name} 是通用能力,只能在 Compute 里用` };
  if (!tool.bounded) return { ok: false, reason: `${tool.name} 不是有界工具,不能进联系人直接工具清单` };
  if (c.computeAssets.some((x) => x.name === tool.name)) return { ok: false, reason: `${tool.name} 已登记为只给 Compute 用的能力资产,不能再当直接工具` };
  if (c.tools.some((t) => t.name === tool.name)) return { ok: true, contact: c };
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
export function grantComputeAsset(c: Contact, a: { name: string; kind: ComputeAsset["kind"] }): ContactResult {
  if (!a.name.trim()) return { ok: false, reason: "能力资产名不能为空" };
  if (c.tools.some((t) => t.name === a.name)) return { ok: false, reason: `${a.name} 已是直接工具,不必再登记` };
  const same = c.computeAssets.find((x) => x.name === a.name);
  if (same && same.kind !== a.kind) return { ok: false, reason: `${a.name} 已登记为 ${same.kind} 类能力资产,不能再以 ${a.kind} 类同名登记` };
  if (same) return { ok: true, contact: c };
  return { ok: true, contact: freezeContact({ ...c, computeAssets: [...c.computeAssets, { name: a.name, kind: a.kind }] }) };
}

/** 联系人本体能不能直接调用这个名字:只看直接工具清单,Compute 能力资产不算。 */
export function canCallDirectly(c: Contact, name: string): boolean {
  return c.tools.some((t) => t.name === name);
}

export function commit(c: Contact, k: Omit<Commitment, "status" | "awaitingReport" | "reportedTaskIds">): ContactResult {
  if (c.commitments.some((x) => x.id === k.id)) return { ok: false, reason: `承诺 ${k.id} 已存在` };
  if (!isSeq(k.sourceSeq)) return { ok: false, reason: `承诺出处 ${k.sourceSeq} 不是合法的消息位置(非负整数)` };
  if (k.schedule) { const e = checkSchedule(k.schedule); if (e) return { ok: false, reason: e }; }
  return { ok: true, contact: freezeContact({ ...c, commitments: [...c.commitments, { ...k, awaitingReport: [], reportedTaskIds: [], status: "active" }] }) };
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
  return freezeContact(dropStaleFocus({
    ...c,
    commitments: c.commitments.map((k) => {
      if (k.status !== "active" || k.schedule || !k.boundTaskIds.includes(taskId)) return k;
      const boundTaskIds = k.boundTaskIds.filter((t) => t !== taskId);
      if (k.reportedTaskIds.includes(taskId)) return retire({ ...k, boundTaskIds, reportedTaskIds: k.reportedTaskIds.filter((t) => t !== taskId) });
      return { ...k, boundTaskIds, awaitingReport: [...k.awaitingReport, taskId] };
    }),
  }));
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
 * 回执没点名的承诺、已结束的承诺、与本承诺无关的任务、重复确认、依据位置不是非负整数的畸形回执都不改状态。
 */
export function confirmFinalReport(c: Contact, receipt: FinalReportReceipt): Contact {
  const { taskId } = receipt;
  if (!isSeq(receipt.basedOnSeq)) return c;
  return freezeContact(dropStaleFocus({
    ...c,
    commitments: c.commitments.map((k) => {
      if (k.status !== "active" || k.schedule) return k;
      if (!receipt.commitmentIds.includes(k.id) || k.sourceSeq > receipt.basedOnSeq) return k;
      if (k.awaitingReport.includes(taskId)) return retire({ ...k, awaitingReport: k.awaitingReport.filter((t) => t !== taskId) });
      if (k.boundTaskIds.includes(taskId) && !k.reportedTaskIds.includes(taskId)) return { ...k, reportedTaskIds: [...k.reportedTaskIds, taskId] };
      return k;
    }),
  }));
}

/** 用户撤销一条承诺:置为 revoked,指向它的专职锁同时解除。 */
export function revokeCommitment(c: Contact, id: string): ContactResult {
  if (!c.commitments.some((k) => k.id === id && k.status === "active")) return { ok: false, reason: `承诺 ${id} 不存在或已结束` };
  return { ok: true, contact: freezeContact(dropStaleFocus({ ...c, commitments: c.commitments.map((k) => (k.id === id ? { ...k, status: "revoked" } : k)) })) };
}

export function setFocus(c: Contact, f: FocusPolicy | null): ContactResult {
  if (f && !c.commitments.some((k) => k.id === f.onlyCommitmentId && k.status === "active")) return { ok: false, reason: `专职锁指向的承诺 ${f.onlyCommitmentId} 不存在或已结束` };
  return { ok: true, contact: freezeContact({ ...c, focus: f }) };
}

export function decideUnderFocus(c: Contact, i: InboundIntent): FocusDecision {
  if (i.kind === "control") return "handle";
  if (i.kind === "chatter") return "ignore";
  if (!c.focus) return "handle";
  return i.commitmentId === c.focus.onlyCommitmentId ? "handle" : "decline-focused";
}

/** 派给 Compute 的说明:只带任务、群规切片、联系人已授权集合(直接工具 + Compute 能力资产)内的工具和凭据引用;不带记忆和性格(AC-33 ④)。 */
export function briefFor(c: Contact, r: { task: string; rules: readonly string[]; tools: readonly string[]; credentialRefs: readonly string[]; placement?: Placement }): BriefResult {
  const placement = r.placement ?? "local";
  if (!PLACEMENTS.has(placement)) return { ok: false, reason: `未知的运行位置 ${placement}` };
  if (r.tools.some((t) => !t.trim())) return { ok: false, reason: "派给 Compute 的工具名不能为空" };
  const allowed = new Set([...c.tools.map((t) => t.name), ...c.computeAssets.map((x) => x.name)]);
  const extra = r.tools.filter((t) => !allowed.has(t));
  if (extra.length) return { ok: false, reason: `工具 ${extra.join(", ")} 超出联系人 ${c.id} 的授权集合` };
  const bad = r.credentialRefs.filter((x) => !CREDENTIAL_REF.test(x));
  if (bad.length) return { ok: false, reason: "凭据只能给引用句柄(<scheme>://<path>),不能给明文" };
  return { ok: true, brief: Object.freeze({ task: r.task, rules: Object.freeze([...r.rules]), tools: Object.freeze([...r.tools]), credentialRefs: Object.freeze([...r.credentialRefs]), placement }) };
}
