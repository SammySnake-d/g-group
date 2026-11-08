// TLC 反例转回归用例(AC-10):把 packages/domain/tla/ 下规格被 TLC 找到的行为(-dumpTrace json 存进 tla/traces/)
// 逐步回放到真实领域原语,记录模型这一步的结论和真实实现这一步的结论。规格里的提交点对应:
//   Publish.tla → cas.ts commitIn(会话版本单元,基于读到的版本提交);
//   Claim.tla   → task.ts apply(Claim) 推导新状态 + cas.ts commit(任务单元,基于读到的版本提交);
//   Lease.tla   → lease.ts acquireLease / releaseLease(每个资源一个 CAS 单元 + 全序 + epoch)。
// 模型里 conflict 动作在真实实现上就是一次「基于旧版本的提交」,真实实现应同样给出 version-conflict;
// 去掉 CAS 的反例里模型接受、真实实现拒绝的那一步就是分歧点(divergence)。测试只读仓库里存的 JSON,不需要 java。
import type { LeaseTable } from "./lease.ts";
import type { Task } from "./task.ts";

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

// 空壳(红):尚未实现。
export function traceStates(_dump: unknown): readonly { readonly index: number; readonly vars: Readonly<Record<string, unknown>> }[] {
  return [];
}
export function finalState(_dump: unknown): Readonly<Record<string, unknown>> {
  return {};
}
export function traceSteps(_dump: unknown): readonly TraceStep[] {
  return [];
}
export function divergence(_steps: readonly StepVerdict[]): StepVerdict | null {
  return null;
}
export interface PublishReplay {
  readonly steps: readonly StepVerdict[];
  readonly published: readonly { readonly who: string; readonly base: number; readonly over: number }[];
  readonly ver: number;
}
export function replayPublish(_dump: unknown): PublishReplay {
  return { steps: [], published: [], ver: 0 };
}
export interface ClaimReplay {
  readonly steps: readonly StepVerdict[];
  readonly winners: readonly string[];
  readonly owner: string | null;
  readonly state: Task["state"];
  readonly ver: number;
}
export function replayClaim(_dump: unknown, _taskId = "t1", _requester = "u1"): ClaimReplay {
  return { steps: [], winners: [], owner: null, state: "T1_Open", ver: 0 };
}
export interface LeaseReplay {
  readonly steps: readonly StepVerdict[];
  readonly table: LeaseTable;
  readonly held: Readonly<Record<string, Readonly<Record<string, number>>>>;
}
export function replayLease(_dump: unknown, _order: readonly string[]): LeaseReplay {
  return { steps: [], table: new Map(), held: {} };
}
