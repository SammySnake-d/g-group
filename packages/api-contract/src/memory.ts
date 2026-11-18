// 联系人长期记忆的对外视图与方法(需求文档 D25 第 4 节;验收 AC-42 ⑤⑧⑨、AC-54)。
// 只给用户本人看和改:list / get 读条目(来源消息被撤回的标 source-retracted,不进联系人上下文),
// revoke 按 D25 状态机标「已撤销」(不物理删除),rebuild 从 md 真源重建索引。条目原文只在这里给用户看,不经这些方法回到联系人上下文。
import { arr, bool, id, int, isoTime, nullable, obj, oneOf, opt, seq, str, type Infer } from "./schema.ts";

/** D25 第 4 节的条目状态:生效 / 已替代 / 已撤销 / 降级。 */
export const MEMORY_STATUSES = ["active", "superseded", "revoked", "degraded"] as const;
/** 对外状态:D25 状态;来源消息已撤回(复述佐证也都撤回)时为 source-retracted,这时不进任何上下文。 */
export const MEMORY_STATES = [...MEMORY_STATUSES, "source-retracted"] as const;
/** 准入:全局条目进第 1 块前缀(prefix);其余按锚点读进第 5 块(anchored)。 */
export const MEMORY_SCOPES = ["prefix", "anchored"] as const;

export const MemoryView = obj({
  id: id(),
  contactId: id(),
  version: int({ min: 1 }),
  status: oneOf(MEMORY_STATUSES),
  state: oneOf(MEMORY_STATES),
  scope: oneOf(MEMORY_SCOPES),
  title: str({ max: 2000 }),
  body: str({ max: 200000 }),
  anchors: arr(str({ max: 2000 })),
  /** 来源消息(只给位置与是否用户原话,不带原文)。 */
  source: nullable(obj({ roomId: id(), seq: seq(), userQuote: bool() })),
  /** 现在会不会进联系人上下文(生效或降级、在有效期内、没有因来源撤回被挡下);锚点型条目还要本轮锚点相交。 */
  effective: bool(),
  supersedes: arr(id()),
  supersededBy: nullable(id()),
  refines: arr(id()),
  conflictsWith: arr(id()),
  evidenceCount: int({ min: 0 }),
  uses: obj({ good: int({ min: 0 }), bad: int({ min: 0 }) }),
  validFrom: nullable(isoTime()),
  validTo: nullable(isoTime()),
  createdAt: isoTime(),
  updatedAt: isoTime(),
});
export type MemoryView = Infer<typeof MemoryView>;

const MemoryGroup = obj({ count: int({ min: 0 }), items: arr(MemoryView) });
/** 联系人资料里的长期记忆概览(AC-54):按准入分两类,给生效条目数与最近更新的前若干条;另计来源已撤回与已失效(已替代、已撤销)的条数。 */
export const LongTermMemoryView = obj({
  prefix: MemoryGroup,
  anchored: MemoryGroup,
  sourceRetracted: int({ min: 0 }),
  inactive: int({ min: 0 }),
});
export type LongTermMemoryView = Infer<typeof LongTermMemoryView>;

const one = obj({ contactId: id(), memoryId: id() });

/** 并进 api.ts 的方法表(新增只加不改)。 */
export const MEMORY_METHODS = {
  /** 一个联系人的全部长期记忆(不含「建议改人格」);可按准入与对外状态筛。 */
  "memory.list": { params: obj({ contactId: id(), scope: opt(oneOf(MEMORY_SCOPES)), status: opt(oneOf(MEMORY_STATES)) }), result: obj({ memories: arr(MemoryView) }) },
  "memory.get": { params: one, result: MemoryView },
  /** 用户撤销一条:状态改「已撤销」,md 与索引都保留;已撤销的再撤销原样返回;已替代的不能撤销(conflict)。 */
  "memory.revoke": { params: obj({ contactId: id(), memoryId: id(), clientActionId: id() }), result: MemoryView },
  /** 用户触发:删掉索引从 md 真源重建;不给 contactId 就重建全部联系人。 */
  "memory.rebuild": { params: obj({ contactId: opt(id()) }), result: obj({ contacts: arr(obj({ contactId: id(), entries: int({ min: 0 }) })) }) },
} as const;
