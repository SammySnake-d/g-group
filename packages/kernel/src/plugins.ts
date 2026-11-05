// 插件注册表(AC-35 阶段 I 宿主契约桩)。类型见 plugin-contract.ts。
// 注册时深拷贝并冻结宿主快照,之后只读快照;调用方再改原对象不影响宿主。更新走 reregister 重新校验。
// 外部事件由宿主校验并盖章(来源、版本、事件类型、双时间、附件引用、不可信)。
// 外发按 action_id 记账:in-flight 后超时或异常记 DeliveryUnknown,B2 渠道拒绝盲重试。
import {
  type AttachmentRef, type ChannelIdempotency, type DeliveryState, type ExternalEnvelope, type ExternalEventType,
  type Plugin, type PluginKind, type PluginRegistry, type PullResult, type RegisterRejection, type RegisterResult,
  type RegistryOptions, type RejectedEvent, SCHEDULE_REASON, type SendReceipt, type SendResult,
} from "./plugin-contract.ts";

export * from "./plugin-contract.ts";

const KINDS: ReadonlySet<string> = new Set<PluginKind>(["data-source", "outbound-channel", "ui-extension"]);
const EVENT_TYPES: ReadonlySet<string> = new Set<ExternalEventType>(["create", "edit", "delete"]);
const IDEMPOTENCY: ReadonlySet<string> = new Set<ChannelIdempotency>(["action-id", "none"]);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const isStr = (x: unknown): x is string => typeof x === "string" && x !== "";
const isStrList = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);
const isThenable = (x: unknown): x is PromiseLike<unknown> => isObj(x) && typeof x.then === "function";
const reject = (reason: RegisterRejection, detail: string): RegisterResult => ({ ok: false, reason, detail });

type Checked = { ok: true; snapshot: Plugin } | { ok: false; reason: RegisterRejection; detail: string };

/** 校验并生成宿主快照:只拷贝契约字段,数组复制后冻结,函数在此刻取定。 */
function snapshotOf(c: unknown): Checked {
  if (!isObj(c) || typeof c.kind !== "string" || !KINDS.has(c.kind)) return { ok: false, reason: "invalid-kind", detail: `类型必须是 ${[...KINDS].join(" / ")}` };
  if (!isStr(c.id) || c.id.trim() === "") return { ok: false, reason: "invalid-contract", detail: "缺 id" };
  if ("schedule" in c || "cron" in c) return { ok: false, reason: "schedule-not-allowed", detail: SCHEDULE_REASON };
  if ("dependsOn" in c && !(Array.isArray(c.dependsOn) && c.dependsOn.length === 0)) return { ok: false, reason: "plugin-dependency-not-allowed", detail: "插件只能依赖宿主接口,不能依赖其他插件" };
  const id = c.id;
  if (c.kind === "data-source") {
    const pull = c.pull;
    if (!isStrList(c.sources) || c.sources.length === 0) return { ok: false, reason: "invalid-contract", detail: "DataSource 需要非空字符串数组 sources" };
    if (typeof pull !== "function") return { ok: false, reason: "invalid-contract", detail: "DataSource 需要 pull 函数" };
    const sources = Object.freeze([...c.sources]);
    return { ok: true, snapshot: Object.freeze({ kind: "data-source", id, sources, pull: (s: string) => pull.call(c, s) }) };
  }
  if (c.kind === "outbound-channel") {
    const send = c.send;
    if (typeof send !== "function") return { ok: false, reason: "invalid-contract", detail: "OutboundChannel 需要 send 函数" };
    if (typeof c.idempotency !== "string" || !IDEMPOTENCY.has(c.idempotency)) return { ok: false, reason: "invalid-contract", detail: "OutboundChannel 需要 idempotency: action-id | none" };
    const idempotency = c.idempotency as ChannelIdempotency;
    return { ok: true, snapshot: Object.freeze({ kind: "outbound-channel", id, idempotency, send: (r: { action_id: string; payload: string }) => send.call(c, r) }) };
  }
  if (!isStrList(c.mounts)) return { ok: false, reason: "invalid-contract", detail: "UIExtension 需要字符串数组 mounts" };
  return { ok: true, snapshot: Object.freeze({ kind: "ui-extension", id, mounts: Object.freeze([...c.mounts]) }) };
}

function attachmentOf(a: unknown): AttachmentRef | undefined {
  if (!isObj(a) || !isStr(a.ref)) return undefined;
  if (a.name !== undefined && typeof a.name !== "string") return undefined;
  if (a.mime !== undefined && typeof a.mime !== "string") return undefined;
  return Object.freeze({ ref: a.ref, ...(a.name !== undefined ? { name: a.name } : {}), ...(a.mime !== undefined ? { mime: a.mime } : {}) });
}

/** 单条外部事件校验与盖章:不合契约的给出原因,不进结果。receivedAt 取宿主时钟,trust 固定不可信。 */
function stamp(plugin: string, source: string, e: unknown, receivedAt: string): ExternalEnvelope | string {
  if (!isObj(e)) return "不是对象";
  if (!isStr(e.nativeId)) return "缺 nativeId";
  if (!isStr(e.sourceVersion)) return "缺 sourceVersion";
  if (typeof e.eventType !== "string" || !EVENT_TYPES.has(e.eventType)) return "eventType 必须是 create | edit | delete";
  if (typeof e.author !== "string") return "缺 author";
  if (typeof e.content !== "string") return "content 必须是字符串";
  if (e.eventType !== "delete" && e.content === "") return "create/edit 的 content 不能为空";
  if (typeof e.occurredAt !== "string" || !Number.isFinite(Date.parse(e.occurredAt))) return "occurredAt 必须是可解析的时间";
  if (!Array.isArray(e.attachments)) return "attachments 必须是数组";
  const attachments = e.attachments.map(attachmentOf);
  if (attachments.some((a) => a === undefined)) return "附件必须是 {ref, name?, mime?} 引用";
  return Object.freeze({
    origin: Object.freeze({ plugin, source, nativeId: e.nativeId }),
    sourceVersion: e.sourceVersion,
    eventType: e.eventType as ExternalEventType,
    author: e.author,
    content: e.content,
    occurredAt: new Date(e.occurredAt).toISOString(),
    receivedAt,
    attachments: Object.freeze(attachments as AttachmentRef[]),
    trust: "untrusted",
  });
}

const errText = (err: unknown): string => {
  try { return err instanceof Error ? err.message : String(err); } catch { return "无法转成文字的异常"; }
};

interface LedgerEntry { payload: string; state: DeliveryState; receipt?: SendReceipt; at: number }
const TIMEOUT = Symbol("timeout");

export function createRegistry(opts: RegistryOptions = {}): PluginRegistry {
  const now = opts.now ?? Date.now;
  const sendTimeoutMs = opts.sendTimeoutMs ?? 30_000;
  const receiptTtlMs = opts.receiptTtlMs ?? 24 * 3600_000;
  const plugins = new Map<string, Plugin>();
  const ledger = new Map<string, LedgerEntry>(); // `${plugin}\u0000${action_id}`

  async function deliver(p: Extract<Plugin, { kind: "outbound-channel" }>, key: string, actionId: string, payload: string): Promise<SendResult> {
    const entry: LedgerEntry = { payload, state: "in-flight", at: now() };
    ledger.set(key, entry);
    const unknown = (reason: "timeout" | "send-threw" | "invalid-receipt" | "non-promise-send", detail: string): SendResult => {
      entry.state = "delivery-unknown";
      return { ok: false, state: "delivery-unknown", reason, detail };
    };
    let pending: unknown;
    try { pending = p.send({ action_id: actionId, payload }); } catch (err) { return unknown("send-threw", errText(err)); }
    if (!isThenable(pending)) return unknown("non-promise-send", "这一片只支持返回 Promise 的 send;同步返回值不当作回执");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let got: unknown;
    try {
      got = await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), sendTimeoutMs); })]);
    } catch (err) {
      return unknown("send-threw", errText(err));
    } finally { clearTimeout(timer); }
    if (got === TIMEOUT) return unknown("timeout", `等待超过 ${sendTimeoutMs}ms`);
    if (!isObj(got) || got.action_id !== actionId || !isStr(got.receiptId)) return unknown("invalid-receipt", "回执必须是带同一 action_id 与非空 receiptId 的对象");
    const receipt = Object.freeze({ action_id: actionId, receiptId: got.receiptId });
    entry.state = "confirmed";
    entry.receipt = receipt;
    entry.at = now();
    return { ok: true, state: "confirmed", receipt, deduplicated: false };
  }

  return {
    register(candidate) {
      const r = snapshotOf(candidate);
      if (!r.ok) return reject(r.reason, r.detail);
      if (plugins.has(r.snapshot.id)) return reject("duplicate-id", r.snapshot.id);
      plugins.set(r.snapshot.id, r.snapshot);
      return { ok: true };
    },
    reregister(candidate) {
      const r = snapshotOf(candidate);
      if (!r.ok) return reject(r.reason, r.detail);
      const old = plugins.get(r.snapshot.id);
      if (!old) return reject("unknown-plugin", r.snapshot.id);
      if (old.kind !== r.snapshot.kind) return reject("kind-change-not-allowed", `${old.kind} → ${r.snapshot.kind}`);
      plugins.set(r.snapshot.id, r.snapshot);
      return { ok: true };
    },
    list: () => [...plugins.values()].map((p) => Object.freeze({ id: p.id, kind: p.kind })),
    async pull(pluginId, sourceId): Promise<PullResult> {
      const p = plugins.get(pluginId);
      if (p?.kind !== "data-source") return { ok: false, reason: "unknown-plugin", detail: pluginId };
      if (!p.sources.includes(sourceId)) return { ok: false, reason: "source-not-declared", detail: sourceId };
      let batch: unknown;
      try { batch = await p.pull(sourceId); } catch (err) { return { ok: false, reason: "pull-failed", detail: errText(err) }; }
      if (!Array.isArray(batch)) return { ok: false, reason: "invalid-batch", detail: "pull 必须给出事件数组" };
      const receivedAt = new Date(now()).toISOString();
      const events: ExternalEnvelope[] = [];
      const rejected: RejectedEvent[] = [];
      batch.forEach((e, index) => {
        const s = stamp(p.id, sourceId, e, receivedAt);
        if (typeof s === "string") rejected.push({ index, reason: s });
        else events.push(s);
      });
      return { ok: true, events, rejected };
    },
    async send(pluginId, req): Promise<SendResult> {
      const p = plugins.get(pluginId);
      if (p?.kind !== "outbound-channel") return { ok: false, state: "rejected", reason: "unknown-plugin", detail: pluginId };
      const actionId = req.action_id;
      if (!isStr(actionId)) return { ok: false, state: "rejected", reason: "missing-action-id", detail: "外发动作必须带 action_id,宿主按它幂等" };
      const payload = String(req.payload);
      const key = `${pluginId}\u0000${actionId}`;
      const prior = ledger.get(key);
      if (!prior) return deliver(p, key, actionId, payload);
      if (prior.payload !== payload) return { ok: false, state: "rejected", reason: "payload-mismatch", detail: "同一 action_id 的内容必须一致" };
      if (prior.state === "in-flight") return { ok: false, state: "rejected", reason: "in-flight", detail: "上一次发送还没有结果" };
      if (prior.state === "confirmed" && prior.receipt) {
        if (p.idempotency === "none" || now() - prior.at <= receiptTtlMs) return { ok: true, state: "confirmed", receipt: prior.receipt, deduplicated: true };
        return deliver(p, key, actionId, payload); // B1 回执过期:交给接收端按 action_id 去重
      }
      // 结果未知:B1 接收端按 action_id 去重,可以重试;B2 不去重,拒绝盲重发
      if (p.idempotency === "none") return { ok: false, state: "delivery-unknown", reason: "retry-refused", detail: "B2 渠道结果未知,禁止自动重发,需人工对账" };
      return deliver(p, key, actionId, payload);
    },
    delivery: (pluginId, actionId) => ledger.get(`${pluginId}\u0000${actionId}`)?.state,
    mounts: (point) => [...plugins.values()].filter((p) => p.kind === "ui-extension" && p.mounts.includes(point)).map((p) => p.id),
  };
}
