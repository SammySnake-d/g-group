// 补充消息关联边 linked_msgs 与单条改挂 E5b(需求文档 1.2 不变量 I1/I3、第三台 E5b 列、C-US29;验收 AC-15、AC-16、AC-45)。
// 三种边:Received 只表示已送达负责人;Applied 必须指向含该要求的产物版本(送达不等于落实);Rebound 表示已改挂到别的任务。
// 改挂(E5b)不取消源任务:源任务推进单调递增的新版本,完整保留并重放 #m 之后仍有效的补充 #n;
// #m 已落实进工作区时,先等旧执行器停止确认(StoppedOrIsolatedConfirmed)才发恢复工作区的副作用,不边写边回滚。
// 纯函数:入参先过普通数据合同,返回冻结的新状态和要宿主执行的副作用;导出常量冻结(用户 #2662)。
import { type Effect as TaskEffect, type Task, apply as applyTask } from "./task.ts";
import { nestedPlainError, normalize } from "./plain.ts";

export const LINK_STATES = Object.freeze(["Received", "Applied", "Rebound"] as const);
export type LinkState = (typeof LINK_STATES)[number];

export interface Link {
  readonly roomId: string;
  readonly seq: number;
  /** 补充原文:改挂后重放给执行器用 */
  readonly text: string;
  readonly state: LinkState;
  /** 挂进本任务(或改挂进来)时任务的约束版本 */
  readonly ver: number;
  /** Applied 时:含这条要求的产物引用与产物版本;其余状态为 null */
  readonly appliedIn: string | null;
  readonly appliedVer: number | null;
  /** Rebound 时:改挂到的任务 */
  readonly reboundTo: string | null;
}
/** 已落实的 #m 被移走、旧执行器仍在:等它停止确认后再从 #m 之前恢复工作区 */
export interface Rollback {
  readonly roomId: string;
  readonly beforeSeq: number;
  readonly ver: number;
  readonly computeId: string;
}
export interface FollowUps {
  readonly taskId: string;
  /** 关联版本:每次改挂进出 +1;改挂请求必须带上当前值(expected_binding_ver),对不上按冲突拒绝 */
  readonly bindingVer: number;
  readonly links: readonly Link[];
  readonly pendingRollback: Rollback | null;
}
export interface Requirement { readonly roomId: string; readonly seq: number; readonly text: string }
export type FollowUpEffect =
  /** 按新版本把本任务仍有效的全部补充(含 #m 之后的 #n)重新交给执行器 */
  | { readonly kind: "replay"; readonly taskId: string; readonly ver: number; readonly requirements: readonly Requirement[] }
  /** 先停旧执行器(不是取消任务),停稳后才能回滚工作区 */
  | { readonly kind: "stop-for-rollback"; readonly taskId: string; readonly computeId: string }
  /** 旧执行器已确认停止(或本来就没有):从 #beforeSeq 之前的检查点恢复工作区,再按 ver 重放 requirements */
  | { readonly kind: "restore-workspace"; readonly taskId: string; readonly roomId: string; readonly beforeSeq: number; readonly ver: number; readonly requirements: readonly Requirement[] };
export type FollowUpResult = { readonly ok: true; readonly value: FollowUps; readonly effects: readonly FollowUpEffect[] } | { readonly ok: false; readonly reason: string };

const fail = (reason: string): FollowUpResult => ({ ok: false, reason });
const done = (value: FollowUps, effects: FollowUpEffect[] = []): FollowUpResult => ({ ok: true, value, effects: Object.freeze(effects.map((e) => Object.freeze(e))) });
const isNat = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const isPos = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1;
const isText = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

const freezeLink = (l: Link): Link => Object.freeze({
  roomId: l.roomId, seq: l.seq, text: l.text, state: l.state, ver: l.ver,
  appliedIn: l.appliedIn, appliedVer: l.appliedVer, reboundTo: l.reboundTo,
});
const build = (taskId: string, bindingVer: number, links: readonly Link[], pendingRollback: Rollback | null): FollowUps => Object.freeze({
  taskId, bindingVer, links: Object.freeze(links.map(freezeLink)),
  pendingRollback: pendingRollback ? Object.freeze({ ...pendingRollback }) : null,
});

export function emptyFollowUps(taskId: string): FollowUps {
  if (!isText(taskId)) throw new TypeError("taskId 必须是非空字符串");
  return build(taskId, 0, [], null);
}

const maxVer = (fu: FollowUps): number => fu.links.reduce((m, l) => Math.max(m, l.ver), -1);
const keyOf = (roomId: string, seq: number) => `${roomId}#${seq}`;
const own = (o: object, k: string): unknown => {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d !== undefined && Object.hasOwn(d, "value") ? d.value : undefined;
};
const isObj = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 调用方传回来的状态也是外部输入:先整体过普通数据检查(任何一层 Proxy、访问器、非普通原型都拒,不调用 getter),
 * 再只按声明字段读数据属性,并核对不变量——Applied 必须带产物引用与版本、Rebound 必须带去向且不指向自己、
 * 同一条消息只出现一次。不合格的状态不当作改挂或落实依据。
 */
function readState(input: unknown): { ok: true; fu: FollowUps } | { ok: false; reason: string } {
  const bad = nestedPlainError(input, "关联状态");
  if (bad) return { ok: false, reason: bad };
  if (!isObj(input)) return { ok: false, reason: "关联状态必须是对象" };
  const taskId = own(input, "taskId");
  const bindingVer = own(input, "bindingVer");
  const rawLinks = own(input, "links");
  const rbRaw = own(input, "pendingRollback") ?? null;
  if (!isText(taskId)) return { ok: false, reason: "关联状态缺任务 id" };
  if (!isNat(bindingVer)) return { ok: false, reason: "关联版本必须是非负整数" };
  if (!Array.isArray(rawLinks)) return { ok: false, reason: "关联边必须是数组" };
  let pendingRollback: Rollback | null = null;
  if (rbRaw !== null) {
    if (!isObj(rbRaw)) return { ok: false, reason: "待回滚记录必须是对象或 null" };
    const r = { roomId: own(rbRaw, "roomId"), beforeSeq: own(rbRaw, "beforeSeq"), ver: own(rbRaw, "ver"), computeId: own(rbRaw, "computeId") };
    if (!isText(r.roomId) || !isPos(r.beforeSeq) || !isNat(r.ver) || !isText(r.computeId)) return { ok: false, reason: "待回滚记录字段不合法" };
    pendingRollback = r as Rollback;
  }
  const links: Link[] = [];
  const keys = new Set<string>();
  const len = own(rawLinks, "length") as number;
  for (let i = 0; i < len; i++) {
    const raw = own(rawLinks, String(i));
    if (!isObj(raw)) return { ok: false, reason: `关联边 [${i}] 必须是对象` };
    const state = own(raw, "state");
    if (typeof state !== "string" || !(LINK_STATES as readonly string[]).includes(state)) return { ok: false, reason: "关联边状态只能是 Received / Applied / Rebound" };
    const l = {
      roomId: own(raw, "roomId"), seq: own(raw, "seq"), text: own(raw, "text"), state, ver: own(raw, "ver"),
      appliedIn: own(raw, "appliedIn") ?? null, appliedVer: own(raw, "appliedVer") ?? null, reboundTo: own(raw, "reboundTo") ?? null,
    } as Link;
    if (!isText(l.roomId) || !isPos(l.seq) || typeof l.text !== "string" || !isNat(l.ver)) return { ok: false, reason: "关联边字段不合法" };
    const key = keyOf(l.roomId, l.seq);
    if (keys.has(key)) return { ok: false, reason: `关联边 ${key} 重复` };
    keys.add(key);
    if (l.state === "Applied" && (!isText(l.appliedIn) || !isNat(l.appliedVer))) return { ok: false, reason: `关联边 ${key} 标为 Applied 却没有产物版本` };
    if (l.state !== "Applied" && (l.appliedIn !== null || l.appliedVer !== null)) return { ok: false, reason: `关联边 ${key} 未落实却带产物` };
    if (l.state === "Rebound" && (!isText(l.reboundTo) || l.reboundTo === taskId)) return { ok: false, reason: `关联边 ${key} 改挂去向不合法` };
    if (l.state !== "Rebound" && l.reboundTo !== null) return { ok: false, reason: `关联边 ${key} 未改挂却带去向` };
    links.push(l);
  }
  return { ok: true, fu: build(taskId, bindingVer, links, pendingRollback) };
}

const MSG_SCHEMA = { roomId: { kind: "string" }, seq: { kind: "number" }, text: { kind: "string" }, ver: { kind: "number" } } as const;
const find = (fu: FollowUps, roomId: string, seq: number): number => fu.links.findIndex((l) => l.roomId === roomId && l.seq === seq);
const active = (fu: FollowUps): Link[] => fu.links.filter((l) => l.state !== "Rebound");
const requirementsOf = (links: readonly Link[]): Requirement[] => links.filter((l) => l.state !== "Rebound").map((l) => Object.freeze({ roomId: l.roomId, seq: l.seq, text: l.text }));

/**
 * 一条补充送达负责人:登记为 Received,绑定挂入时的任务版本。送达只记 Received,永远不直接记 Applied(AC-16)。
 * 同一条重复登记幂等;已改挂走的消息不能被同一路径挂回(要挂回走改挂);版本不能比已登记的更旧。
 */
export function receiveFollowUp(state: FollowUps, input: { roomId: string; seq: number; text: string; ver: number }): FollowUpResult {
  const s = readState(state);
  if (!s.ok) return fail(s.reason);
  const n = normalize<{ roomId: string; seq: number; text: string; ver: number }>(input, MSG_SCHEMA, "补充消息");
  if (!n.ok) return fail(n.reason);
  const m = n.value;
  if (!isText(m.roomId) || !isPos(m.seq) || !isText(m.text) || !isNat(m.ver)) return fail("补充消息字段不合法");
  const fu = s.fu;
  const i = find(fu, m.roomId, m.seq);
  if (i >= 0) {
    const l = fu.links[i]!;
    if (l.state === "Rebound") return fail(`${keyOf(m.roomId, m.seq)} 已改挂到 ${l.reboundTo},不能直接挂回(请走改挂)`);
    return done(fu);
  }
  if (m.ver < maxVer(fu)) return fail(`补充版本 v${m.ver} 比已登记的 v${maxVer(fu)} 旧,版本不能倒退`);
  return done(build(fu.taskId, fu.bindingVer, [...fu.links, { roomId: m.roomId, seq: m.seq, text: m.text, state: "Received", ver: m.ver, appliedIn: null, appliedVer: null, reboundTo: null }], fu.pendingRollback));
}

/**
 * 产物落盘交付:只有产物版本 artifactVer 覆盖到的 Received 才标 Applied 并指向该产物;
 * 挂入版本比产物新的补充仍是 Received(新条件只送达、还没进产物,AC-45 ③)。等回滚期间不认任何产物。
 */
export function applyArtifact(state: FollowUps, input: { artifact: string; artifactVer: number }): FollowUpResult & { readonly pending?: readonly Requirement[] } {
  const s = readState(state);
  if (!s.ok) return fail(s.reason);
  const n = normalize<{ artifact: string; artifactVer: number }>(input, { artifact: { kind: "string" }, artifactVer: { kind: "number" } }, "产物");
  if (!n.ok) return fail(n.reason);
  if (!isText(n.value.artifact)) return fail("产物引用不能为空:Applied 必须指向具体产物");
  if (!isNat(n.value.artifactVer)) return fail("产物版本必须是非负整数");
  const fu = s.fu;
  if (fu.pendingRollback) return fail("等待旧执行器停止并回滚工作区,期间的产物不算落实");
  const { artifact, artifactVer } = n.value;
  const links = fu.links.map((l) => (l.state === "Received" && l.ver <= artifactVer ? { ...l, state: "Applied" as const, appliedIn: artifact, appliedVer: artifactVer } : l));
  const pending = requirementsOf(links.filter((l) => l.state === "Received"));
  const r = done(build(fu.taskId, fu.bindingVer, links, null));
  return r.ok ? Object.freeze({ ...r, pending: Object.freeze(pending) }) : r;
}

/** 还没落实的补充(Received,且挂入版本不晚于 uptoVer;不给就看全部)。完成判定只看它是否为空(AC-16)。 */
export function unappliedFollowUps(state: FollowUps, uptoVer?: number): readonly Requirement[] {
  const s = readState(state);
  if (!s.ok) throw new TypeError(s.reason);
  return Object.freeze(requirementsOf(s.fu.links.filter((l) => l.state === "Received" && (uptoVer === undefined || l.ver <= uptoVer))));
}

/** 源任务一侧改挂的前置校验:返回拒绝原因、"idempotent"(已改挂到同一去向)或 null(可以改挂)。不看版本。 */
function checkOut(fu: FollowUps, c: { roomId: string; seq: number; toTaskId: string; expectedBindingVer: number }): string | "idempotent" | null {
  if (c.toTaskId === fu.taskId) return "不能改挂到自己";
  const i = find(fu, c.roomId, c.seq);
  if (i < 0) return `${keyOf(c.roomId, c.seq)} 不在任务 ${fu.taskId} 上`;
  const m = fu.links[i]!;
  if (m.state === "Rebound") return m.reboundTo === c.toTaskId ? "idempotent" : `${keyOf(c.roomId, c.seq)} 已改挂到 ${m.reboundTo}`;
  if (c.expectedBindingVer !== fu.bindingVer) return `关联版本已变:期望 ${c.expectedBindingVer},当前 ${fu.bindingVer}`;
  return null;
}

const OUT_SCHEMA = { roomId: { kind: "string" }, seq: { kind: "number" }, toTaskId: { kind: "string" }, expectedBindingVer: { kind: "number" } } as const;
/**
 * 源任务一侧的改挂:#m 标 Rebound(去向),关联版本 +1;源任务不取消。
 * newVer 是源任务推进后的新约束版本(必须比所有已登记版本都新,严禁倒退或复用);源任务已到终态时传 null,只移走、不重放。
 * #m 只是 Received:直接按新版本重放其余有效补充(含 #n)。
 * #m 已 Applied(工作区里有它):#m 之后已落实的补充一并退回 Received(要随回滚重做);旧执行器还在就先发 stop-for-rollback,
 * 等 confirmRollbackStopped;没有执行器就直接发 restore-workspace。重复改挂到同一去向幂等。
 */
export function rebindOut(state: FollowUps, input: { roomId: string; seq: number; toTaskId: string; expectedBindingVer: number }, newVer: number | null, computeId: string | null): FollowUpResult {
  const s = readState(state);
  if (!s.ok) return fail(s.reason);
  const n = normalize<{ roomId: string; seq: number; toTaskId: string; expectedBindingVer: number }>(input, OUT_SCHEMA, "改挂请求");
  if (!n.ok) return fail(n.reason);
  const c = n.value;
  if (!isText(c.roomId) || !isPos(c.seq) || !isText(c.toTaskId) || !isNat(c.expectedBindingVer)) return fail("改挂请求字段不合法");
  if (newVer !== null && !isNat(newVer)) return fail("新版本必须是非负整数或 null");
  if (computeId !== null && !isText(computeId)) return fail("执行器 id 必须是非空字符串或 null");
  const fu = s.fu;
  const pre = checkOut(fu, c);
  if (pre === "idempotent") return done(fu);
  if (pre) return fail(pre);
  const i = find(fu, c.roomId, c.seq);
  const m = fu.links[i]!;
  if (newVer !== null && newVer <= maxVer(fu)) return fail(`新版本 v${newVer} 不比已登记的 v${maxVer(fu)} 新:改挂必须产生单调递增的新版本`);
  const wasApplied = m.state === "Applied";
  const links = fu.links.map((l, j): Link => {
    if (j === i) return { ...l, state: "Rebound", appliedIn: null, appliedVer: null, reboundTo: c.toTaskId };
    // 工作区要回到 #m 之前:#m 之后已落实的补充随回滚失效,退回 Received 按新版本重做
    if (wasApplied && j > i && l.state === "Applied" && newVer !== null) return { ...l, state: "Received", ver: newVer, appliedIn: null, appliedVer: null };
    return l;
  });
  const next = (rb: Rollback | null) => build(fu.taskId, fu.bindingVer + 1, links, rb);
  if (newVer === null) return done(next(null));
  const requirements = requirementsOf(links);
  if (!wasApplied) return done(next(null), [{ kind: "replay", taskId: fu.taskId, ver: newVer, requirements }]);
  if (computeId) return done(next({ roomId: m.roomId, beforeSeq: m.seq, ver: newVer, computeId }), [{ kind: "stop-for-rollback", taskId: fu.taskId, computeId }]);
  return done(next(null), [{ kind: "restore-workspace", taskId: fu.taskId, roomId: m.roomId, beforeSeq: m.seq, ver: newVer, requirements }]);
}

/** 旧执行器停止确认:只认待回滚记录里的那个执行器;对上了才发恢复工作区 + 重放,对不上(迟到或别的实例)幂等忽略。 */
export function confirmRollbackStopped(state: FollowUps, computeId: string): FollowUpResult {
  const s = readState(state);
  if (!s.ok) return fail(s.reason);
  if (!isText(computeId)) return fail("执行器 id 必须是非空字符串");
  const fu = s.fu;
  const rb = fu.pendingRollback;
  if (!rb || rb.computeId !== computeId) return done(fu);
  return done(build(fu.taskId, fu.bindingVer, fu.links, null), [{ kind: "restore-workspace", taskId: fu.taskId, roomId: rb.roomId, beforeSeq: rb.beforeSeq, ver: rb.ver, requirements: requirementsOf(fu.links) }]);
}

const IN_SCHEMA = { roomId: { kind: "string" }, seq: { kind: "number" }, text: { kind: "string" }, fromTaskId: { kind: "string" }, ver: { kind: "number" } } as const;
/** 目标任务一侧:#m 以目标任务的新版本登记为 Received(原来从这里改挂走的,重新激活),关联版本 +1,重放给目标执行器;重复幂等。 */
export function rebindIn(state: FollowUps, input: { roomId: string; seq: number; text: string; fromTaskId: string; ver: number }): FollowUpResult {
  const s = readState(state);
  if (!s.ok) return fail(s.reason);
  const n = normalize<{ roomId: string; seq: number; text: string; fromTaskId: string; ver: number }>(input, IN_SCHEMA, "改挂请求");
  if (!n.ok) return fail(n.reason);
  const c = n.value;
  if (!isText(c.roomId) || !isPos(c.seq) || !isText(c.text) || !isText(c.fromTaskId) || !isNat(c.ver)) return fail("改挂请求字段不合法");
  const fu = s.fu;
  if (c.fromTaskId === fu.taskId) return fail("不能从自己改挂到自己");
  const i = find(fu, c.roomId, c.seq);
  if (i >= 0 && fu.links[i]!.state !== "Rebound") return done(fu);
  if (c.ver < maxVer(fu)) return fail(`目标版本 v${c.ver} 比已登记的 v${maxVer(fu)} 旧,版本不能倒退`);
  const link: Link = { roomId: c.roomId, seq: c.seq, text: c.text, state: "Received", ver: c.ver, appliedIn: null, appliedVer: null, reboundTo: null };
  const links = i >= 0 ? fu.links.map((l, j) => (j === i ? link : l)) : [...fu.links, link];
  return done(build(fu.taskId, fu.bindingVer + 1, links, fu.pendingRollback), [{ kind: "replay", taskId: fu.taskId, ver: c.ver, requirements: requirementsOf(links) }]);
}

// ---------------------------------------------------------------- 与任务状态机合成
const NO_VERSION_STATES: ReadonlySet<string> = new Set(["T9_StopRequested", "T10_Cancelled", "T11_Failed"]);
export interface Side { readonly task: Task; readonly followUps: FollowUps }
export interface SideOut extends Side { readonly taskEffects: readonly TaskEffect[]; readonly effects: readonly FollowUpEffect[] }
export type RebindOutcome = { readonly ok: true; readonly from: SideOut; readonly to: SideOut; readonly idempotent: boolean } | { readonly ok: false; readonly reason: string };

/** 推进一次约束版本(Amend):必须恰好 +1。终态或停止中不推进,返回 null。 */
function bump(t: Task, by: string, computeResumable: boolean): { ok: true; task: Task; effects: readonly TaskEffect[]; ver: number | null } | { ok: false; reason: string } {
  if (NO_VERSION_STATES.has(t.state)) return { ok: true, task: t, effects: [], ver: null };
  const r = applyTask(t, { kind: "Amend", by, computeResumable });
  if (!r.ok) return r;
  if (r.task.constraintVer !== t.constraintVer + 1) return { ok: false, reason: `任务 ${t.id} 版本没有单调 +1(v${t.constraintVer} → v${r.task.constraintVer})` };
  return { ok: true, task: r.task, effects: r.effects, ver: r.task.constraintVer };
}

/**
 * E5b · RebindFollowUp(m, A → B, expected_binding_ver):在两个本来就合法的任务之间移走一条误挂的补充(AC-15)。
 * A 不取消:A 推进 v_A_new = 当前版本 + 1,保留并重放 #m 之后的 #n;B 推进自己的版本并收下 #m。
 * 重复改挂(#m 已在 A 上标为改挂到 B)整体幂等,两边版本都不再推进。B 已结束(停止中/终态)拒绝。
 */
export function rebindFollowUp(from: Side, to: Side, input: { roomId: string; seq: number; expectedBindingVer: number; by: string; computeResumable: boolean }): RebindOutcome {
  const n = normalize<{ roomId: string; seq: number; expectedBindingVer: number; by: string; computeResumable: boolean }>(
    input, { roomId: { kind: "string" }, seq: { kind: "number" }, expectedBindingVer: { kind: "number" }, by: { kind: "string" }, computeResumable: { kind: "boolean" } }, "改挂请求");
  if (!n.ok) return n;
  const c = n.value;
  if (!isText(c.by)) return { ok: false, reason: "改挂请求缺发起人" };
  const a = readState(from.followUps);
  if (!a.ok) return a;
  const b = readState(to.followUps);
  if (!b.ok) return b;
  if (a.fu.taskId !== from.task.id || b.fu.taskId !== to.task.id) return { ok: false, reason: "关联状态与任务对不上" };
  const cmd = { roomId: c.roomId, seq: c.seq, toTaskId: to.task.id, expectedBindingVer: c.expectedBindingVer };
  // 先做全部前置校验(不在 A 上、已改挂别处、关联版本冲突、B 已结束):不合格时两边任务状态一点都不动
  const pre = checkOut(a.fu, cmd);
  if (pre === "idempotent") {
    const same = (s: Side): SideOut => ({ task: s.task, followUps: s.followUps, taskEffects: [], effects: [] });
    return { ok: true, from: same(from), to: same(to), idempotent: true };
  }
  if (pre) return { ok: false, reason: pre };
  if (NO_VERSION_STATES.has(to.task.state)) return { ok: false, reason: `目标任务 ${to.task.id} 已结束(${to.task.state}),不能收补充` };
  const m = a.fu.links[find(a.fu, c.roomId, c.seq)]!;
  const ba = bump(from.task, c.by, c.computeResumable);
  if (!ba.ok) return ba;
  const ra = rebindOut(a.fu, cmd, ba.ver, ba.task.computeId);
  if (!ra.ok) return ra;
  const bb = bump(to.task, c.by, true);
  if (!bb.ok) return bb;
  const rb = rebindIn(b.fu, { roomId: c.roomId, seq: c.seq, text: m.text, fromTaskId: from.task.id, ver: bb.ver ?? to.task.constraintVer });
  if (!rb.ok) return rb;
  return {
    ok: true,
    idempotent: false,
    from: { task: ba.task, followUps: ra.value, taskEffects: ba.effects, effects: ra.effects },
    to: { task: bb.task, followUps: rb.value, taskEffects: bb.effects, effects: rb.effects },
  };
}

/**
 * E3 · 用户中途改条件(AC-45 ②):在途任务原位升版 v → v+1(同一任务、同一执行器,不新开任务),这条补充按新版本登记 Received。
 * 任务停止中或已结束时拒绝(要按新条件重做得新建任务)。
 */
export function amendWithFollowUp(side: Side, input: { roomId: string; seq: number; text: string; by: string; computeResumable: boolean }): { ok: true; task: Task; followUps: FollowUps; taskEffects: readonly TaskEffect[] } | { ok: false; reason: string } {
  const n = normalize<{ roomId: string; seq: number; text: string; by: string; computeResumable: boolean }>(
    input, { roomId: { kind: "string" }, seq: { kind: "number" }, text: { kind: "string" }, by: { kind: "string" }, computeResumable: { kind: "boolean" } }, "改条件");
  if (!n.ok) return n;
  const c = n.value;
  if (!isText(c.by)) return { ok: false, reason: "改条件缺发起人" };
  const s = readState(side.followUps);
  if (!s.ok) return s;
  if (s.fu.taskId !== side.task.id) return { ok: false, reason: "关联状态与任务对不上" };
  const i = find(s.fu, c.roomId, c.seq);
  if (i >= 0) {
    if (s.fu.links[i]!.state === "Rebound") return { ok: false, reason: `${keyOf(c.roomId, c.seq)} 已改挂到 ${s.fu.links[i]!.reboundTo}` };
    return { ok: true, task: side.task, followUps: s.fu, taskEffects: [] };
  }
  if (NO_VERSION_STATES.has(side.task.state)) return { ok: false, reason: `任务 ${side.task.id} 已结束(${side.task.state}),新条件要另起任务` };
  const b = bump(side.task, c.by, c.computeResumable);
  if (!b.ok) return b;
  const r = receiveFollowUp(s.fu, { roomId: c.roomId, seq: c.seq, text: c.text, ver: b.ver! });
  if (!r.ok) return r;
  return { ok: true, task: b.task, followUps: r.value, taskEffects: b.effects };
}

/** 本任务全部有效补充(重放 / 交接给执行器用),按挂入顺序。 */
export function activeRequirements(state: FollowUps): readonly Requirement[] {
  const s = readState(state);
  if (!s.ok) throw new TypeError(s.reason);
  return Object.freeze(requirementsOf(active(s.fu)));
}
