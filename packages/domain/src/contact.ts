// 联系人(AC-01 / AC-33 / 概念卡第 1、11 张)。
// 联系人是持久的 AI 同事:身份(id)一旦建立不随改名、换模型改变;直接工具只收具名有界工具;
// 定时是它自己记下的承诺(带时区与允许误差),插件只提供数据源和输出渠道,不拥有定时。
// 纯函数,不改入参。

/** 联系人本体能直接调用的工具:必须是宿主注册的具名、有界工具(效果可知、返回短)。 */
export interface NamedTool { readonly name: string; readonly bounded: true }
/** Compute 在哪跑:首版只有 local,字段先留好,以后接云端不改状态机(#1186)。 */
export type Placement = "local" | "byom_daemon" | "cloud_sandbox";
export interface Schedule { readonly cron: string; readonly tz: string; readonly toleranceSec: number }
export interface Commitment {
  readonly id: string;
  readonly sourceSeq: number;
  readonly text: string;
  /** 绑定的任务;全部结束后承诺自动回收(AC-31⑤)。定时承诺不随任务回收。 */
  readonly boundTaskIds: readonly string[];
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
  | { kind: "work"; text: string }
  | { kind: "chatter"; text: string };
export type FocusDecision = "handle" | "decline-focused" | "ignore";

const freezeContact = (c: Contact): Contact => Object.freeze({
  ...c,
  tools: Object.freeze(c.tools.map((t) => Object.freeze({ ...t }))),
  commitments: Object.freeze(c.commitments.map((k) => Object.freeze({ ...k, boundTaskIds: Object.freeze([...k.boundTaskIds]), schedule: k.schedule ? Object.freeze({ ...k.schedule }) : null }))),
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
  return { ok: true, dir: withContact(d, { id: c.id, name: c.name, speakingModel: c.speakingModel, tools: [], memory: "", soul: "", commitments: [], focus: null }) };
}

export function updateContact(d: Directory, id: string, patch: Partial<Pick<Contact, "name" | "speakingModel" | "memory">>): DirectoryResult {
  const cur = d.contacts.get(id);
  if (!cur) return { ok: false, reason: `联系人 ${id} 不存在` };
  const next: Contact = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.speakingModel !== undefined ? { speakingModel: patch.speakingModel } : {}),
    ...(patch.memory !== undefined ? { memory: patch.memory } : {}),
  };
  return { ok: true, dir: withContact(d, next) };
}

export function grantTool(c: Contact, tool: { name: string; bounded: boolean }): ContactResult {
  if (FORBIDDEN_DIRECT_TOOLS.includes(tool.name)) return { ok: false, reason: `${tool.name} 是通用能力,只能在 Compute 里用` };
  if (!tool.bounded) return { ok: false, reason: `${tool.name} 不是有界工具,不能进联系人直接工具清单` };
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

export function commit(c: Contact, k: Omit<Commitment, "status">): ContactResult {
  if (c.commitments.some((x) => x.id === k.id)) return { ok: false, reason: `承诺 ${k.id} 已存在` };
  if (k.schedule) { const e = checkSchedule(k.schedule); if (e) return { ok: false, reason: e }; }
  return { ok: true, contact: freezeContact({ ...c, commitments: [...c.commitments, { ...k, status: "active" }] }) };
}

/** 一个任务进入终态时调用:非定时承诺的绑定任务全部结束,承诺自动置为 done。 */
export function settleTask(c: Contact, taskId: string): Contact {
  return freezeContact({
    ...c,
    commitments: c.commitments.map((k) => {
      if (k.status !== "active" || k.schedule || !k.boundTaskIds.includes(taskId)) return k;
      const left = k.boundTaskIds.filter((t) => t !== taskId);
      return { ...k, boundTaskIds: left, status: left.length === 0 ? "done" : "active" };
    }),
  });
}

export function setFocus(c: Contact, f: FocusPolicy | null): ContactResult {
  if (f && !c.commitments.some((k) => k.id === f.onlyCommitmentId && k.status === "active")) return { ok: false, reason: `专职锁指向的承诺 ${f.onlyCommitmentId} 不存在或已结束` };
  return { ok: true, contact: freezeContact({ ...c, focus: f }) };
}

export function decideUnderFocus(c: Contact, i: InboundIntent): FocusDecision {
  if (i.kind === "control") return "handle";
  if (!c.focus) return i.kind === "work" ? "handle" : "ignore";
  return i.kind === "work" ? "decline-focused" : "ignore";
}

/** 派给 Compute 的说明:只带任务、群规切片、联系人白名单内的工具和凭据引用;不带记忆和性格(AC-33 ④)。 */
export function briefFor(c: Contact, r: { task: string; rules: readonly string[]; tools: readonly string[]; credentialRefs: readonly string[]; placement?: Placement }): BriefResult {
  const placement = r.placement ?? "local";
  if (!PLACEMENTS.has(placement)) return { ok: false, reason: `未知的运行位置 ${placement}` };
  const allowed = new Set(c.tools.map((t) => t.name));
  const extra = r.tools.filter((t) => !allowed.has(t));
  if (extra.length) return { ok: false, reason: `工具 ${extra.join(", ")} 超出联系人 ${c.id} 的白名单` };
  const bad = r.credentialRefs.filter((x) => !CREDENTIAL_REF.test(x));
  if (bad.length) return { ok: false, reason: "凭据只能给引用句柄(<scheme>://<path>),不能给明文" };
  return { ok: true, brief: Object.freeze({ task: r.task, rules: Object.freeze([...r.rules]), tools: Object.freeze([...r.tools]), credentialRefs: Object.freeze([...r.credentialRefs]), placement }) };
}
