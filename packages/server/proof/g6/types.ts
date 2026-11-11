// T-177 G6 同题对照实验的数据形状(方案 t177-g-d-implementation §9;bc 定稿 v0.2 §8)。
// 只有类型,不含逻辑。原始记录(RawRecord)由 driver 在被测提交的工作树里产出,评分、合同、报告只读它,不回头读宿主。

/** 题集里的一位联系人。marker 是人设里独一无二的短语,用来把模型请求归到这位联系人(请求里不带联系人 id)。 */
export interface FixtureContact {
  readonly key: string;
  readonly name: string;
  readonly persona: string;
  readonly marker: string;
}
export interface FixtureRoom {
  readonly key: string;
  readonly kind: "dm" | "group";
  /** dm:对面的联系人;group:成员联系人(用户自动在群里) */
  readonly contacts: readonly string[];
  readonly title?: string;
}
/** 一步用户操作。send/batch 发完默认等宿主安静;edit/retract 指向前面某一步发出的消息(batch 用 index 选第几条)。 */
export type FixtureStep =
  | { readonly op: "send"; readonly room: string; readonly text: string; readonly to?: readonly string[]; readonly probe?: string }
  | { readonly op: "batch"; readonly room: string; readonly texts: readonly string[]; readonly to?: readonly string[] }
  | { readonly op: "filler"; readonly room: string; readonly count: number; readonly to?: readonly string[] }
  | { readonly op: "edit"; readonly room: string; readonly step: number; readonly index?: number; readonly text: string }
  | { readonly op: "retract"; readonly room: string; readonly step: number; readonly index?: number };

export type ProbeCategory = "untagged-detail" | "negation" | "ambiguity" | "old-instruction" | "recall" | "cross-room" | "retract" | "edit";
/** 追问:expect 必须命中(null:只要有回复)、reject 不能命中(都是正则源码,i 标志);needs 是答对必须看到的原文片段(读回判定)。 */
export interface FixtureProbe {
  readonly id: string;
  readonly step: number;
  readonly category: ProbeCategory;
  readonly expect: string | null;
  readonly reject: string | null;
  readonly needs: string | null;
  /** 预取误导:回复命中它即算被旧消息带偏(旧指令重现、已否定的旧值)。 */
  readonly misled: string | null;
  /** 规则替身用:看得到 needs 时的回答;看不到时替身答「看不到」。 */
  readonly standin: { readonly answer: string; readonly plainText?: boolean };
}
export interface ExpectedMemory {
  readonly id: string;
  readonly contact: string;
  readonly match: string;
  /** any:作用域不判(原话本身两可时) */
  readonly scope: "global" | "room" | "any";
  /** 来源:第几步发出的消息(batch 用 index)。 */
  readonly sourceStep: number;
  readonly sourceIndex?: number;
}
/** 不该写成生效记忆的:命中 match 且(给了 scope 时)作用域相同即算误写。 */
export interface ForbiddenMemory {
  readonly id: string;
  readonly contact: string;
  readonly match: string;
  readonly scope?: "global" | "room";
}
/** 确定性合同:这段原文在 afterStep 那步之后不能再出现在 contact 的任何模型请求里(撤回、编辑前旧文、别的会话)。 */
export interface ForbiddenText {
  readonly text: string;
  readonly contact: string;
  readonly afterStep: number;
  readonly why: string;
  /** true:状态笔记(第 3 块)与模型自己的工具回显里出现不算(笔记是联系人自己的摘要,编辑前旧文不在宿主清理范围内) */
  readonly exceptNote?: boolean;
}
export type FaultKind = "http-400" | "http-529" | "truncated" | "malformed" | "empty" | "network";
/** 故障注入:这位联系人第 nth 次 cls 类调用替换成 fault(不发上游,不花钱)。 */
export interface FixtureFault {
  readonly contact: string;
  readonly cls: CallClass;
  readonly nth: number;
  readonly fault: FaultKind;
}
export interface FixtureItem {
  readonly id: string;
  readonly title: string;
  readonly contacts: readonly FixtureContact[];
  readonly rooms: readonly FixtureRoom[];
  readonly steps: readonly FixtureStep[];
  readonly probes: readonly FixtureProbe[];
  readonly memories: { readonly expect: readonly ExpectedMemory[]; readonly forbid: readonly ForbiddenMemory[] };
  readonly forbidden: readonly ForbiddenText[];
  readonly faults: readonly FixtureFault[];
  /** 规则替身的题级开关:noNote 时替身本轮不写状态笔记(让宿主走补写路径) */
  readonly standin?: { readonly noNote?: boolean };
}
export interface FixtureSet {
  readonly schema: "g6-fixtures/v1";
  readonly id: string;
  readonly note: string;
  readonly fillers: readonly string[];
  readonly items: readonly FixtureItem[];
}

// ---------------------------------------------------------------- 原始记录
/** round 联系人一轮;check 每轮记忆检查;compact 补写/缩写笔记;refine G5 精筛;background 其余后台 */
export type CallClass = "round" | "check" | "compact" | "refine" | "background";
export type CallOutcome = "ok" | "timeout" | "network_error" | "http_error" | "truncated" | "parse_failure" | "empty";
export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}
/** 一次模型 HTTP 调用(含 SDK 自己的重试,每次都单独记)。请求头不记,密钥不落盘。 */
export interface CallRecord {
  readonly n: number;
  /** 真正发出的时刻(一次一个调用时,排队之后) */
  readonly at: number;
  /** 一次一个调用时在 runner 里排队等了多久 */
  readonly queuedMs: number;
  readonly ms: number;
  readonly contact: string | null;
  readonly cls: CallClass;
  readonly model: string | null;
  readonly maxTokens: number | null;
  readonly status: number;
  readonly outcome: CallOutcome;
  readonly stopReason: string | null;
  readonly usage: Usage;
  readonly tools: readonly { readonly name: string; readonly input: unknown }[];
  readonly text: string;
  readonly system: string;
  readonly request: string;
  readonly fault: FaultKind | null;
}
export interface SentMessage {
  readonly step: number;
  readonly index: number;
  readonly room: string;
  readonly roomId: string;
  readonly seq: number;
  readonly text: string;
  readonly at: number;
}
/** 消息版本冻结:按 runner 的操作日志记(发、改、撤回的先后),与宿主 G1-a 的事件 seq 定义同向单调。 */
export interface MessageOp {
  readonly order: number;
  readonly op: "send" | "edit" | "retract";
  readonly room: string;
  readonly seq: number;
  readonly step: number;
  readonly at: number;
}
export interface StepRecord {
  readonly step: number;
  readonly op: FixtureStep["op"];
  readonly startedAt: number;
  readonly settledAt: number;
  readonly timedOut: boolean;
}
export interface ReplyRecord {
  readonly room: string;
  readonly seq: number;
  readonly contact: string;
  readonly text: string;
  readonly at: number;
}
export interface MemoryRecord {
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly body: string;
  readonly anchors: readonly string[];
  readonly source: { readonly roomId: string; readonly seq: number } | null;
  /** 宿主写下这一条的时刻(毫秒);读不出为 null */
  readonly createdAt: number | null;
}
/** 组级的宿主选项覆盖(start.ts 不暴露、但宿主已有的选项):opts 并进宿主选项,fineScreen 并进 G5 精筛参数 */
export interface HostPatch {
  readonly opts?: Readonly<Record<string, unknown>>;
  readonly fineScreen?: Readonly<Record<string, unknown>>;
}
export type RunStatus = "ok" | "error" | "timeout" | "config_insufficient";
export interface RawRecord {
  readonly schema: "g6-raw/v1";
  readonly runId: string;
  readonly group: string;
  readonly commit: string;
  readonly mode: "standin" | "real";
  readonly model: string;
  readonly item: string;
  readonly rep: number;
  readonly fingerprint: string;
  /** 续跑身份:模型、方式、认证引用、组级选项、一次一个调用、runner 驱动代码摘要;不含每次会话都变的网关端口与路径 */
  readonly reuseKey: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly status: RunStatus;
  readonly error: string | null;
  readonly roomIds: Readonly<Record<string, string>>;
  readonly contactIds: Readonly<Record<string, string>>;
  readonly steps: readonly StepRecord[];
  readonly sent: readonly SentMessage[];
  readonly ops: readonly MessageOp[];
  readonly replies: readonly ReplyRecord[];
  readonly memories: Readonly<Record<string, readonly MemoryRecord[]>>;
  readonly notes: Readonly<Record<string, string | null>>;
  readonly reports: readonly { readonly what: string; readonly at: number; readonly detail: string }[];
  /** 宿主自报的检查欠账(有接口才有,如 G1 的 memoryCoverage);没有接口为 null */
  readonly hostDebt: Readonly<Record<string, { readonly counts: Readonly<Record<string, number>>; readonly refs: readonly { readonly roomId: string; readonly seq: number; readonly state: string }[] }>> | null;
  /** 组级宿主选项覆盖实际落到了哪些字段、哪些在被测提交里不存在 */
  readonly hostPatch: { readonly applied: readonly string[]; readonly missing: readonly string[] } | null;
  readonly calls: readonly CallRecord[];
}

// ---------------------------------------------------------------- 评分与合同
/** 一个比率:分子、分母都按计划数算,失败/超时留在分母里。 */
export interface Ratio {
  readonly n: number;
  readonly d: number;
}
export interface FailureTally {
  readonly timeout: number;
  readonly parseFailure: number;
  readonly configInsufficient: number;
  readonly httpError: number;
  readonly networkError: number;
  readonly empty: number;
  /** 题集注入的故障(不是模型或网关的失败,单列) */
  readonly injected: number;
  readonly runErrors: number;
  readonly stepTimeouts: number;
}
export interface Metrics {
  readonly runs: number;
  readonly coverage: Ratio;
  readonly missedWrites: Ratio;
  readonly wrongWrites: Ratio;
  readonly sourceScope: Ratio;
  readonly readBack: Ratio;
  readonly followAfterRead: Ratio;
  readonly untagged: Ratio;
  readonly prefetchMisled: Ratio;
  readonly probes: Ratio;
  readonly correctNoReply: number;
  readonly tokens: Usage & { readonly byClass: Readonly<Record<CallClass, number>> };
  readonly calls: number;
  readonly roundLatencyMs: { readonly p50: number | null; readonly p95: number | null; readonly n: number };
  /** 期望记忆从来源消息发出到宿主写下的时间(只算写到了的) */
  readonly writeLatencyMs: { readonly p50: number | null; readonly p95: number | null; readonly n: number };
  /** 联系人调用历史查询工具 query_history 的次数(G4) */
  readonly historyToolCalls: number;
  readonly callLatencyMs: { readonly p50: number | null; readonly p95: number | null; readonly n: number };
  readonly backlog: { readonly count: number; readonly maxAgeMs: number | null };
  readonly failures: FailureTally;
}
export type ContractVerdict = "pass" | "fail" | "n/a";
export interface ContractResult {
  readonly id: string;
  readonly title: string;
  readonly verdict: ContractVerdict;
  readonly checked: number;
  readonly violations: readonly string[];
}
