// G5 两段式记忆的纯规则(BC 定稿 v0.2 §7;G1→G5 写入切换规则与审查条件 S-2):粗筛出口分流、标记身份、精筛批次与触发。
// 术语:这里的「粗筛 / 精筛」指记忆的「粗筛打标(同一次 reflect 顺带)/ 精筛提炼(批处理)」,和需求文档 D06 找旧消息的「粗筛自动、精筛内置」(宿主预取 + 内置查询工具,归 G4)不是一回事。
// 不做 I/O:标记与租约的持久化、读原文、调模型、写 md 都归宿主(server/memory-marks.ts、host.ts)。
import { createHash } from "node:crypto";
import { type CaptureCheck, isLongTerm } from "./memory-capture.ts";
import type { CompactMemory, MarkKind } from "./runtime-ports.ts";

/**
 * 精筛参数。全部是待校准配置(v0.2 §7「时长/条数参数注入并待校准」,切换规则「阈值作为待校准配置,不写成用户拍板」),不是用户定值:
 * 单批最多 maxMarks 个标记、maxBytes 字节材料;对话安静 quietMs 后触发;积压条数到 maxPending 或最老一条等了 maxAgeMs 立即触发;
 * 租约 leaseMs 过期后可收回;每个标记读来源前后各 neighborRadius 条。
 */
export interface FineScreenPolicy {
  readonly maxMarks: number;
  readonly maxBytes: number;
  readonly quietMs: number;
  readonly maxPending: number;
  readonly maxAgeMs: number;
  readonly leaseMs: number;
  readonly neighborRadius: number;
}
export const DEFAULT_FINE_SCREEN: Readonly<FineScreenPolicy> = Object.freeze({
  maxMarks: 8,
  maxBytes: 24 * 1024,
  quietMs: 5 * 60_000,
  maxPending: 20,
  maxAgeMs: 60 * 60_000,
  leaseMs: 20 * 60_000,
  neighborRadius: 3,
});

const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const fold = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();

/** S-2:G5 自己粗筛产出的标记身份 = 房间 + seq + 消息版本(G1-a)+ kind + 规范化 evidence 的哈希;一条消息两件事是两个身份 */
export function markCandidateKey(roomId: string, seq: number, revision: number, kind: MarkKind, evidence: string) {
  return sha(JSON.stringify(["mark", roomId, seq, revision, kind, sha(fold(evidence))]));
}
/** 切换规则:接管的 G1 待复查项产出的标记身份 = coverageId + candidateKey + sourceRevision,保留原工作身份映射 */
export function takeoverMarkId(coverageId: string, candidateKey: string, revision: number) {
  return sha(JSON.stringify(["takeover", coverageId, candidateKey, revision]));
}

export type CaptureRoute = "direct" | "mark" | "debt";
/**
 * 粗筛候选只分到一个出口(切换规则「唯一写入分流」):
 *  - 来源校验没过(批次外、已编辑撤回、非本人、引用/问句/假设)→ debt:只留失败债务,不包装成合法标记;
 *  - 用户本人明确、长期生效的偏好,来源与原话校验通过,且不是缺目标的替代或冲突 → direct:走 G1 唯一幂等写入口,写下即生效;
 *  - 其余合法候选(事实、决定、结果、更正、不确定、非长期、缺 target、冲突)→ mark:交精筛,粗筛不先写记忆。
 */
export function routeCapture(m: CompactMemory, check: CaptureCheck): CaptureRoute {
  if (!check.ok) return "debt";
  if (check.source.senderKind !== "user" || m.kind !== "preference" || !isLongTerm(m.evidence ?? "")) return "mark";
  if (m.relation === "conflict" || (m.relation !== null && !m.target)) return "mark";
  return "direct";
}

export interface FineCandidate {
  readonly id: string;
  readonly bytes: number;
  readonly createdAt: number;
}
/** 精筛一批:最老的先,至多 maxMarks 个、材料至多 maxBytes;单个就超预算的单列(由宿主缩小前后文或记失败,不静默丢) */
export function selectFineBatch(items: readonly FineCandidate[], policy: Pick<FineScreenPolicy, "maxMarks" | "maxBytes">): { take: string[]; oversize: string[] } {
  const sorted = [...items].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const take: string[] = [];
  const oversize: string[] = [];
  let bytes = 0;
  for (const it of sorted) {
    if (it.bytes > policy.maxBytes) {
      oversize.push(it.id);
      continue;
    }
    if (take.length >= policy.maxMarks || bytes + it.bytes > policy.maxBytes) break;
    take.push(it.id);
    bytes += it.bytes;
  }
  return { take, oversize };
}

export type FineTrigger = "explicit" | "backlog" | "age" | "quiet";
/**
 * 精筛该不该现在跑(v0.2 §7 触发:安静期、任务结束/用户纠正或记住、积压条数/最老年龄上限)。没有待处理标记就不跑;
 * explicit 是宿主记下的任务结束、用户纠正/记住;quietSince 是联系人最后一次对话活动的时刻。
 */
export function fineTrigger(s: { readonly pending: number; readonly oldestAt: number | null; readonly quietSince: number; readonly now: number; readonly explicit: boolean }, policy: Pick<FineScreenPolicy, "maxPending" | "maxAgeMs" | "quietMs">): FineTrigger | null {
  if (s.pending <= 0 || s.oldestAt === null) return null;
  if (s.explicit) return "explicit";
  if (s.pending >= policy.maxPending) return "backlog";
  if (s.now - s.oldestAt >= policy.maxAgeMs) return "age";
  if (s.now - s.quietSince >= policy.quietMs) return "quiet";
  return null;
}
