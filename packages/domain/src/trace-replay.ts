// TLC 反例转回归用例(AC-10):把 packages/domain/tla/ 下规格被 TLC 找到的行为(-dumpTrace json 存进 tla/traces/)
// 逐步回放到真实领域原语,记录模型这一步的结论和真实实现这一步的结论。规格里的提交点对应:
//   Publish.tla → cas.ts commitIn(会话版本单元,基于读到的版本提交);
//   Claim.tla   → task.ts apply(Claim) 推导新状态 + cas.ts commit(任务单元,基于读到的版本提交);
//   Lease.tla   → lease.ts acquireLease / releaseLease(每个资源一个 CAS 单元 + 全序 + epoch)。
// 模型里 conflict 动作在真实实现上就是一次「基于旧版本的提交」,真实实现应同样给出 version-conflict;
// 去掉 CAS 的反例里模型接受、真实实现拒绝的那一步就是分歧点(divergence)。测试只读仓库里存的 JSON,不需要 java。
import { type Store, type Versioned, cell, commit, commitIn } from "./cas.ts";
import { type LeaseTable, acquireLease, readLease, releaseLease } from "./lease.ts";
import { type Task, apply, newTask } from "./task.ts";

export type Verdict = "read" | "ok" | "conflict" | "rejected";
export interface TraceStep {
  /** TLC 状态序号(1 是初始状态,不回放) */
  readonly index: number;
  readonly act: Readonly<Record<string, unknown>>;
}
export interface StepVerdict {
  readonly index: number;
  readonly op: string;
  readonly who: string | null;
  /** 规格这一步的结论 */
  readonly model: Verdict;
  /** 真实实现这一步的结论 */
  readonly real: Verdict;
  /** 真实实现拒绝时的原因 */
  readonly reason: string | null;
}

const isRec = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (r: Readonly<Record<string, unknown>>, k: string): string => {
  const v = r[k];
  if (typeof v !== "string") throw new TypeError(`trace 动作缺少字符串字段 ${k}`);
  return v;
};

/** 解析 TLC -dumpTrace json 的输出:counterexample.state = [[序号, 状态], ...],每个状态带 act 记录。 */
export function traceStates(dump: unknown): readonly { readonly index: number; readonly vars: Readonly<Record<string, unknown>> }[] {
  if (!isRec(dump) || !isRec(dump.counterexample) || !Array.isArray(dump.counterexample.state)) throw new TypeError("不是 TLC -dumpTrace json 的输出");
  return dump.counterexample.state.map((e: unknown) => {
    if (!Array.isArray(e) || typeof e[0] !== "number" || !isRec(e[1])) throw new TypeError("TLC 状态条目格式不对");
    return { index: e[0], vars: e[1] };
  });
}

/** 反例最后一个状态的变量(用来核对存下的确实是那条违反性质的行为)。 */
export function finalState(dump: unknown): Readonly<Record<string, unknown>> {
  const s = traceStates(dump);
  const last = s.at(-1);
  if (!last) throw new TypeError("trace 是空的");
  return last.vars;
}

/** 每一步的动作记录(跳过初始状态)。 */
export function traceSteps(dump: unknown): readonly TraceStep[] {
  return traceStates(dump)
    .filter((s) => s.index > 1)
    .map((s) => {
      const act = s.vars.act;
      if (!isRec(act) || typeof act.op !== "string") throw new TypeError(`第 ${s.index} 个状态缺少 act.op`);
      return { index: s.index, act };
    });
}

const modelVerdict = (op: string): Verdict => (op === "read" ? "read" : op === "conflict" ? "conflict" : op === "rejected" ? "rejected" : "ok");

/** 第一处模型与真实实现结论不同的步骤;完全一致返回 null。 */
export function divergence(steps: readonly StepVerdict[]): StepVerdict | null {
  return steps.find((s) => s.model !== s.real) ?? null;
}

// ---------- 发言发布 ----------
export interface PublishReplay {
  readonly steps: readonly StepVerdict[];
  /** 真实实现里提交成功的发布:base 是起草时读到的版本,over 是提交瞬间的版本 */
  readonly published: readonly { readonly who: string; readonly base: number; readonly over: number }[];
  readonly ver: number;
}
const ROOM = "room";
export function replayPublish(dump: unknown): PublishReplay {
  let store: Store<string> = new Map();
  const verNow = () => store.get(ROOM)?.ver ?? 0;
  const base = new Map<string, number>();
  const published: { who: string; base: number; over: number }[] = [];
  const steps: StepVerdict[] = [];
  for (const { index, act } of traceSteps(dump)) {
    const op = act.op as string;
    if (op === "read") {
      const who = str(act, "who");
      base.set(who, verNow());
      steps.push({ index, op, who, model: "read", real: "read", reason: null });
    } else if (op === "msg") {
      const r = commitIn(store, ROOM, verNow(), "用户新消息");
      if (r.ok) store = r.store;
      steps.push({ index, op, who: null, model: "ok", real: r.ok ? "ok" : "conflict", reason: r.ok ? null : r.reason });
    } else if (op === "publish" || op === "conflict") {
      const who = str(act, "who");
      const b = base.get(who) ?? 0;
      const over = verNow();
      const r = commitIn(store, ROOM, b, `${who} 基于 v${b} 的草稿`);
      if (r.ok) {
        store = r.store;
        published.push({ who, base: b, over });
      }
      steps.push({ index, op, who, model: modelVerdict(op), real: r.ok ? "ok" : "conflict", reason: r.ok ? null : r.reason });
    } else throw new TypeError(`发布规格里没有动作 ${op}`);
  }
  return { steps, published, ver: verNow() };
}

// ---------- 排他认领 ----------
export interface ClaimReplay {
  readonly steps: readonly StepVerdict[];
  /** 真实实现里认领提交成功的联系人 */
  readonly winners: readonly string[];
  readonly owner: string | null;
  readonly state: Task["state"];
  readonly ver: number;
}
const CLAIM_OPS: ReadonlySet<string> = new Set(["read", "commit", "conflict", "rejected"]);
export function replayClaim(dump: unknown, taskId = "t1", requester = "u1"): ClaimReplay {
  let cur: Versioned<Task> = cell(newTask(taskId, requester));
  const seen = new Map<string, Versioned<Task>>();
  const winners: string[] = [];
  const steps: StepVerdict[] = [];
  for (const { index, act } of traceSteps(dump)) {
    const op = act.op as string;
    if (!CLAIM_OPS.has(op)) throw new TypeError(`认领规格里没有动作 ${op}`);
    const who = str(act, "who");
    if (op === "read") {
      seen.set(who, cur);
      steps.push({ index, op, who, model: "read", real: "read", reason: null });
    } else {
      const snap = seen.get(who) ?? cur;
      const out = apply(snap.value, { kind: "Claim", by: who });
      if (!out.ok) {
        steps.push({ index, op, who, model: modelVerdict(op), real: "rejected", reason: out.reason });
        continue;
      }
      const r = commit(cur, snap.ver, out.task);
      if (r.ok) {
        cur = r.cell;
        winners.push(who);
      }
      steps.push({ index, op, who, model: modelVerdict(op), real: r.ok ? "ok" : "conflict", reason: r.ok ? null : r.reason });
    }
  }
  return { steps, winners, owner: cur.value.owner, state: cur.value.state, ver: cur.ver };
}

// ---------- 多资源租约 ----------
export interface LeaseReplay {
  readonly steps: readonly StepVerdict[];
  readonly table: LeaseTable;
  /** 真实实现里各持有者手上的资源与授予时的 epoch */
  readonly held: Readonly<Record<string, Readonly<Record<string, number>>>>;
}
const LEASE_OPS: ReadonlySet<string> = new Set(["read", "grant", "conflict", "release"]);
/** order:资源全序(规格里的 ResSeq),下标就是 rank。 */
export function replayLease(dump: unknown, order: readonly string[]): LeaseReplay {
  let table: LeaseTable = new Map();
  const seen = new Map<string, { res: string; ver: number }>();
  const held = new Map<string, Map<string, number>>();
  const heldOf = (h: string): Map<string, number> => {
    const m = held.get(h) ?? new Map<string, number>();
    held.set(h, m);
    return m;
  };
  const steps: StepVerdict[] = [];
  for (const { index, act } of traceSteps(dump)) {
    const op = act.op as string;
    if (!LEASE_OPS.has(op)) throw new TypeError(`租约规格里没有动作 ${op}`);
    const who = str(act, "who");
    if (op === "read") {
      const res = str(act, "res");
      seen.set(who, { res, ver: readLease(table, res).ver });
      steps.push({ index, op, who, model: "read", real: "read", reason: null });
    } else if (op === "grant" || op === "conflict") {
      const s = seen.get(who) ?? { res: str(act, "res"), ver: readLease(table, str(act, "res")).ver };
      const mine = heldOf(who);
      const r = acquireLease(table, { resource: s.res, holder: who, expectedVer: s.ver, rank: order.indexOf(s.res), heldRanks: [...mine.keys()].map((x) => order.indexOf(x)) });
      if (r.ok) {
        table = r.table;
        mine.set(s.res, r.epoch);
      }
      steps.push({ index, op, who, model: modelVerdict(op), real: r.ok ? "ok" : r.reason === "version-conflict" ? "conflict" : "rejected", reason: r.ok ? null : r.reason });
    } else {
      const mine = heldOf(who);
      let reason: string | null = null;
      for (const [res, epoch] of mine) {
        const r = releaseLease(table, { resource: res, holder: who, epoch });
        if (r.ok) table = r.table;
        else reason ??= r.reason;
      }
      if (reason === null) mine.clear();
      steps.push({ index, op, who, model: "ok", real: reason === null ? "ok" : "rejected", reason });
    }
  }
  const heldOut: Record<string, Record<string, number>> = {};
  for (const [h, m] of held) heldOut[h] = Object.fromEntries(m);
  return { steps, table, held: heldOut };
}
