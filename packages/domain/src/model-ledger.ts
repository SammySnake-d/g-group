// 任务的模型记录(需求文档 D07.4 规则 5「双层结构」、D27 第 4 节第 6 条,AC-32 ④、AC-51 ⑥,修复 A27-01):
//   - initial:任务首次启动时写入的不可变启动快照 {harness, model, effort, vendor},之后永不覆写(R-17);
//   - attempts:只追加的尝试账本,每次启动、每一轮输入、换备用模型重试、harness 回报的实际模型各追加一条;
//   - 累积生产厂商集合由账本派生(actual_producer_models[].vendor),供跨厂商审查门禁消费。
// 纯函数:不改入参,返回冻结的新记录。批量替换模型只改配置,不经过这里,所以在途与历史任务的记录不受影响。
import { type Vendor, vendorOf } from "./vendor.ts";

export interface ModelSnapshot {
  readonly harness: string;
  readonly model: string;
  readonly effort: string;
  readonly vendor: Vendor;
}
/** start:首次启动;turn:同一 Compute 的下一次输入;retry:失败后重试;switch-retry:换备用模型重试;observed:harness 回报这一轮实际用过的模型 */
export type AttemptReason = "start" | "turn" | "retry" | "switch-retry" | "observed";
export interface AttemptRecord extends ModelSnapshot {
  readonly seq: number;
  readonly computeId: string;
  readonly reason: AttemptReason;
  readonly at: string;
}
export interface TaskModelRecord {
  readonly initial: ModelSnapshot | null;
  readonly attempts: readonly AttemptRecord[];
}
export interface AttemptInput {
  readonly computeId: string;
  readonly harness: string;
  readonly model: string;
  readonly effort: string;
  readonly reason: AttemptReason;
  readonly at: string;
}

export const emptyModelRecord: TaskModelRecord = Object.freeze({ initial: null, attempts: Object.freeze([]) as readonly AttemptRecord[] });

const freezeRecord = (r: TaskModelRecord): TaskModelRecord =>
  Object.freeze({ initial: r.initial ? Object.freeze({ ...r.initial }) : null, attempts: Object.freeze(r.attempts.map((a) => Object.freeze({ ...a }))) });

/** 追加一条尝试;第一次追加时写入启动快照,之后快照保持原值。 */
export function recordAttempt(rec: TaskModelRecord, a: AttemptInput): TaskModelRecord {
  const vendor = vendorOf(a.model);
  const entry: AttemptRecord = { seq: rec.attempts.length + 1, computeId: a.computeId, harness: a.harness, model: a.model, effort: a.effort, vendor, reason: a.reason, at: a.at };
  const initial = rec.initial ?? { harness: a.harness, model: a.model, effort: a.effort, vendor };
  return freezeRecord({ initial, attempts: [...rec.attempts, entry] });
}

/** 账本里出现过的全部模型(去重,按首次出现顺序)。 */
export function producerModels(rec: TaskModelRecord): readonly string[] {
  return Object.freeze([...new Set(rec.attempts.map((a) => a.model))]);
}
/** 累积生产厂商集合;认不出的记 unknown(门禁据此阻断,不拿启动配置冒充实际执行身份)。 */
export function producerVendors(rec: TaskModelRecord): readonly Vendor[] {
  return Object.freeze([...new Set(rec.attempts.map((a) => a.vendor))]);
}

/** 校验新记录只是在旧记录后面追加:启动快照不变、旧条目逐字不变。用于落盘前的守卫。 */
export function isAppendOnly(prev: TaskModelRecord, next: TaskModelRecord): boolean {
  if (prev.initial && JSON.stringify(prev.initial) !== JSON.stringify(next.initial)) return false;
  if (next.attempts.length < prev.attempts.length) return false;
  return prev.attempts.every((a, i) => JSON.stringify(a) === JSON.stringify(next.attempts[i]));
}
