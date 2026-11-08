// 跨研发厂商独立审查(AC-26 / R-01):挑审查人、拼审查说明、读审查结论。纯函数,不做 I/O;宿主(host.ts)负责起审查 Compute 和推进状态机。
// 门禁本身在 @g-group/domain 的 T5 守卫里(审查人≠作者、审查厂商∉累积生产厂商、unknown 一律拒);这里挑人只是不去起注定被拒的审查。

/** 审查 Compute 只给只读工具:看产物,不改产物。 */
export const REVIEW_TOOLS: readonly string[] = Object.freeze([]);

export interface ReviewCandidate {
  readonly contactId: string;
  /** 这位联系人起审查 Compute 时实际用的模型(它的 Compute 模型)。 */
  readonly model: string;
  /** 是不是任务所在会话的成员。 */
  readonly inRoom: boolean;
}

/** 挑审查人(红:空壳)。 */
export function pickReviewer(_candidates: readonly ReviewCandidate[], _producerModels: readonly string[], _ownerId: string | null): ReviewCandidate | null {
  return null;
}

/** 读审查结论(红:空壳)。 */
export function parseVerdict(_text: string): { verdict: "approve" | "reject"; notes: string } | null {
  return null;
}

/** 审查说明(红:空壳)。 */
export function reviewBrief(_input: { title: string; requirement: string; delivery: string }): string {
  return "";
}
