// 插件注册表(AC-35 阶段 I 宿主契约桩)。类型见 plugin-contract.ts。
// 注册时深拷贝并冻结宿主快照,之后只读快照;调用方再改原对象不影响宿主。更新走 reregister 重新校验。
// 外部事件由宿主校验并盖章(来源、版本、事件类型、双时间、附件引用、不可信)。
// 外发按 action_id 记账,每个动作绑定首次投递时的渠道版本、幂等能力与保留期:
//   已确认 → 永远复用已知回执,不重发;结果未知 → B2 拒绝重发,B1 只在首次尝试仍在服务商保留期内、
//   且渠道仍是同一版本、同一接收端时才重试;reregister 换不掉旧动作的绑定。
// 结果数组一律用 appendOwn 追加自有元素,不经过 Array.prototype 上的同名 setter 或只读下标。
// 注册入口只接受普通数据对象(与 PR #3/#4 的输入契约一致):非 Proxy,原型为 Object.prototype 或 null,
// 逐层用属性描述符检查,出现 getter/setter、Symbol 键、不可枚举属性、Map/Set/Date/类实例(含私有字段 #x)就拒绝并点名路径,
// 绝不调用 getter;整个入口外层兜底,检查时的任何异常都变成拒绝。不承诺防御任意 JS 元编程对象。
// 输入转成冻结纯数据(原型 null)后才读契约字段;send/pull 以这份纯数据为 this 调用,send 请求里拿到绑定的 endpoint。
// B1 保留期按单调时钟算,墙钟回拨不延长窗口;某个动作见到单调读数倒退后永久不再自动重试。账本按 渠道 → 动作 两层 Map 存,不拼接字符串。
import { createHash } from "node:crypto";
import { types } from "node:util";
import { appendOwn, describeThrown, plainData, plainItems } from "./plain.ts";
import {
  type AttachmentRef, type ChannelIdempotency, type DeliveryBinding, type DeliveryState, type ExternalEnvelope, type ExternalEventType,
  type Plugin, type PluginKind, type PluginRegistry, type PullResult, type RegisterRejection, type RegisterResult,
  type RegistryOptions, type RejectedEvent, SCHEDULE_REASON, type SendReceipt, type SendRequest, type SendResult,
} from "./plugin-contract.ts";

export * from "./plugin-contract.ts";

const KINDS: ReadonlySet<string> = new Set<PluginKind>(["data-source", "outbound-channel", "ui-extension"]);
const EVENT_TYPES: ReadonlySet<string> = new Set<ExternalEventType>(["create", "edit", "delete"]);
const IDEMPOTENCY: ReadonlySet<string> = new Set<ChannelIdempotency>(["action-id", "none"]);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const isStr = (x: unknown): x is string => typeof x === "string" && x !== "";
const isStrList = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);
/** 发送结果只认原生 Promise:原型就是 Promise.prototype,且没有自有的 then / constructor 属性。
 *  只用 Object.hasOwn 看键在不在,不读任何属性值(不碰 then getter);子类、thenable、带自有 then 的 Promise
 *  一律不算,按 non-promise-send 处理。(运行时可能给 Promise 挂 Symbol 键的异步追踪字段,所以不要求自有键为空。) */
function isPlainPromise(x: unknown): x is Promise<unknown> {
  if (!types.isPromise(x) || types.isProxy(x)) return false;
  if (Object.getPrototypeOf(x) !== Promise.prototype) return false;
  return !Object.hasOwn(x, "then") && !Object.hasOwn(x, "constructor");
}
const reject = (reason: RegisterRejection, detail: string): RegisterResult => ({ ok: false, reason, detail });

/** 插件 this:去掉函数字段后的冻结纯数据,原型为 null。c 已经是 plainData 的结果。 */
function dataSelf(c: Record<string, unknown>): object {
  const self: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(c)) if (typeof c[k] !== "function") self[k] = c[k];
  return Object.freeze(self);
}

type Checked = { ok: true; snapshot: Plugin } | { ok: false; reason: RegisterRejection; detail: string };

/** 校验并生成宿主快照:先把整个输入转成冻结纯数据(不调 getter),之后只读这份副本。 */
function snapshotOf(raw: unknown): Checked {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "invalid-kind", detail: `类型必须是 ${[...KINDS].join(" / ")}` };
  const plain = plainData(raw, "插件", { topFunctions: true });
  if (!plain.ok) return { ok: false, reason: "unsupported-instance", detail: `插件只接受普通数据对象:${plain.path} ${plain.why}` };
  const c = plain.value as Record<string, unknown>;
  if (typeof c.kind !== "string" || !KINDS.has(c.kind)) return { ok: false, reason: "invalid-kind", detail: `类型必须是 ${[...KINDS].join(" / ")}` };
  if (!isStr(c.id) || c.id.trim() === "") return { ok: false, reason: "invalid-contract", detail: "缺 id" };
  if ("schedule" in c || "cron" in c) return { ok: false, reason: "schedule-not-allowed", detail: SCHEDULE_REASON };
  if ("dependsOn" in c && !(Array.isArray(c.dependsOn) && c.dependsOn.length === 0)) return { ok: false, reason: "plugin-dependency-not-allowed", detail: "插件只能依赖宿主接口,不能依赖其他插件" };
  const id = c.id;
  if (c.kind === "data-source") {
    const pull = c.pull;
    if (!isStrList(c.sources) || c.sources.length === 0) return { ok: false, reason: "invalid-contract", detail: "DataSource 需要非空字符串数组 sources" };
    if (typeof pull !== "function") return { ok: false, reason: "invalid-contract", detail: "DataSource 需要 pull 函数" };
    const sources = Object.freeze([...c.sources]);
    const self = dataSelf(c);
    return { ok: true, snapshot: Object.freeze({ kind: "data-source", id, sources, pull: (s: string) => pull.call(self, s) }) };
  }
  if (c.kind === "outbound-channel") {
    const send = c.send;
    if (typeof send !== "function") return { ok: false, reason: "invalid-contract", detail: "OutboundChannel 需要 send 函数" };
    if (typeof c.idempotency !== "string" || !IDEMPOTENCY.has(c.idempotency)) return { ok: false, reason: "invalid-contract", detail: "OutboundChannel 需要 idempotency: action-id | none" };
    const idempotency = c.idempotency as ChannelIdempotency;
    const w = c.idempotencyWindowMs;
    if (idempotency === "action-id" && !(typeof w === "number" && Number.isFinite(w) && w > 0)) return { ok: false, reason: "invalid-contract", detail: "B1 渠道需要正数 idempotencyWindowMs(服务商幂等保留期)" };
    if (idempotency === "none" && w !== undefined) return { ok: false, reason: "invalid-contract", detail: "B2 渠道不去重,不能声明 idempotencyWindowMs" };
    const idempotencyWindowMs = idempotency === "action-id" ? (w as number) : 0;
    if (!isStr(c.endpoint)) return { ok: false, reason: "invalid-contract", detail: "OutboundChannel 需要非空字符串 endpoint(接收端身份)" };
    const self = dataSelf(c);
    const endpoint = c.endpoint;
    // send 以冻结纯数据为 this 调用,接收端只从请求里的 endpoint 取:插件实例之后怎么改都不影响已注册的这一版
    return { ok: true, snapshot: Object.freeze({ kind: "outbound-channel", id, idempotency, idempotencyWindowMs, endpoint, send: (r: SendRequest) => send.call(self, r) }) };
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

/** 异常文字:与分类器共用的安全格式化,自身不会抛错 */
const errText = (err: unknown): string => describeThrown(err);

interface LedgerEntry {
  binding: DeliveryBinding; state: DeliveryState; receipt?: SendReceipt; attempts: number;
  /** 这个动作见过的最大单调读数 */
  maxMonotonic: number;
  /** 一旦见到读数倒退或非有限读数就永久为 false */
  clockTrusted: boolean;
}
type Channel = Extract<Plugin, { kind: "outbound-channel" }>;
const TIMEOUT = Symbol("timeout");
const sha256 = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

/** 注册入口外层兜底:校验过程中任何异常都变成拒绝,不逃出注册入口 */
function safeSnapshot(candidate: unknown): Checked {
  try { return snapshotOf(candidate); } catch (err) {
    return { ok: false, reason: "unsupported-instance", detail: `插件只接受普通数据对象,检查时出错:${describeThrown(err)}` };
  }
}

/** 注册表选项也是对外入口:先过统一判定(不调 getter),再查字段类型;不合规抛受控的 TypeError,不返回半成品注册表 */
function registryOptions(input: unknown): { now: () => number; monotonic: () => number; sendTimeoutMs: number } {
  const plain = plainData(input ?? {}, "注册表选项", { topFunctions: true });
  if (!plain.ok) throw new TypeError(`注册表选项只接受普通数据对象:${plain.path} ${plain.why}`);
  const o = plain.value as { now?: unknown; monotonic?: unknown; sendTimeoutMs?: unknown };
  if (o.now !== undefined && typeof o.now !== "function") throw new TypeError("注册表选项 now 必须是函数");
  if (o.monotonic !== undefined && typeof o.monotonic !== "function") throw new TypeError("注册表选项 monotonic 必须是函数");
  if (o.sendTimeoutMs !== undefined && !(typeof o.sendTimeoutMs === "number" && Number.isFinite(o.sendTimeoutMs) && o.sendTimeoutMs > 0)) throw new TypeError("注册表选项 sendTimeoutMs 必须是正数");
  return {
    now: (o.now as (() => number) | undefined) ?? Date.now,
    monotonic: (o.monotonic as (() => number) | undefined) ?? (() => performance.now()),
    sendTimeoutMs: (o.sendTimeoutMs as number | undefined) ?? 30_000,
  };
}

export function createRegistry(opts: RegistryOptions = {}): PluginRegistry {
  const { now, monotonic, sendTimeoutMs } = registryOptions(opts);
  const plugins = new Map<string, { plugin: Plugin; version: number }>();
  let versions = 0;
  const ledger = new Map<string, Map<string, LedgerEntry>>(); // 渠道 id → action_id → 账目
  const entryOf = (pluginId: string, actionId: string) => ledger.get(pluginId)?.get(actionId);
  const putEntry = (pluginId: string, actionId: string, e: LedgerEntry) => {
    let m = ledger.get(pluginId);
    if (!m) { m = new Map(); ledger.set(pluginId, m); }
    m.set(actionId, e);
  };

  /** 投递一次:entry 已在账本里且标为 in-flight;只改 entry 的状态,不动首次尝试时间与绑定。 */
  async function attempt(p: Channel, entry: LedgerEntry, actionId: string, payload: string): Promise<SendResult> {
    // 外层兜底:投递过程里任何没预料到的异常都让账本落到 delivery-unknown,不留在 in-flight
    try { return await attemptOnce(p, entry, actionId, payload); } catch (err) {
      entry.state = "delivery-unknown";
      return { ok: false, state: "delivery-unknown", reason: "send-threw", detail: errText(err) };
    }
  }

  async function attemptOnce(p: Channel, entry: LedgerEntry, actionId: string, payload: string): Promise<SendResult> {
    const endpoint = entry.binding.endpoint;
    entry.state = "in-flight";
    entry.attempts++;
    const unknown = (reason: "timeout" | "send-threw" | "invalid-receipt" | "non-promise-send", detail: string): SendResult => {
      entry.state = "delivery-unknown";
      return { ok: false, state: "delivery-unknown", reason, detail };
    };
    let pending: unknown;
    try { pending = p.send(Object.freeze({ action_id: actionId, payload, endpoint })); } catch (err) { return unknown("send-threw", errText(err)); }
    if (!isPlainPromise(pending)) return unknown("non-promise-send", "这一片只支持返回原生 Promise 的 send;同步返回值、thenable 与改过 then 的 Promise 都不当作回执");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let got: unknown;
    try {
      got = await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), sendTimeoutMs); })]);
    } catch (err) {
      return unknown("send-threw", errText(err));
    } finally { clearTimeout(timer); }
    if (got === TIMEOUT) return unknown("timeout", `等待超过 ${sendTimeoutMs}ms`);
    const plainGot = plainData(got, "回执");
    if (!plainGot.ok) return unknown("invalid-receipt", `回执只接受普通数据对象:${plainGot.path} ${plainGot.why}`);
    const rc = plainGot.value as { action_id?: unknown; receiptId?: unknown };
    if (!isObj(rc) || rc.action_id !== actionId || !isStr(rc.receiptId)) return unknown("invalid-receipt", "回执必须是带同一 action_id 与非空 receiptId 的对象");
    entry.state = "confirmed";
    entry.receipt = Object.freeze({ action_id: actionId, receiptId: rc.receiptId });
    return { ok: true, state: "confirmed", receipt: entry.receipt, deduplicated: false };
  }

  return {
    register(candidate) {
      const r = safeSnapshot(candidate);
      if (!r.ok) return reject(r.reason, r.detail);
      if (plugins.has(r.snapshot.id)) return reject("duplicate-id", r.snapshot.id);
      plugins.set(r.snapshot.id, { plugin: r.snapshot, version: ++versions });
      return { ok: true };
    },
    reregister(candidate) {
      const r = safeSnapshot(candidate);
      if (!r.ok) return reject(r.reason, r.detail);
      const old = plugins.get(r.snapshot.id);
      if (!old) return reject("unknown-plugin", r.snapshot.id);
      if (old.plugin.kind !== r.snapshot.kind) return reject("kind-change-not-allowed", `${old.plugin.kind} → ${r.snapshot.kind}`);
      plugins.set(r.snapshot.id, { plugin: r.snapshot, version: ++versions });
      return { ok: true };
    },
    list: () => [...plugins.values()].map(({ plugin: p }) => Object.freeze({ id: p.id, kind: p.kind })),
    async pull(pluginId, sourceId): Promise<PullResult> {
      const p = plugins.get(pluginId)?.plugin;
      if (p?.kind !== "data-source") return { ok: false, reason: "unknown-plugin", detail: pluginId };
      if (!p.sources.includes(sourceId)) return { ok: false, reason: "source-not-declared", detail: sourceId };
      let batch: unknown;
      try { batch = await p.pull(sourceId); } catch (err) { return { ok: false, reason: "pull-failed", detail: errText(err) }; }
      const list = plainItems(batch, "pull 结果");
      if (!list.ok) return { ok: false, reason: "invalid-batch", detail: `pull 必须给出普通数据数组:${list.path} ${list.why}` };
      const receivedAt = new Date(now()).toISOString();
      const events: ExternalEnvelope[] = [];
      const rejected: RejectedEvent[] = [];
      list.items.forEach((raw, index) => {
        const plain = plainData(raw, `事件[${index}]`);
        if (!plain.ok) { appendOwn(rejected, { index, reason: `只接受普通数据对象:${plain.path} ${plain.why}` }); return; }
        const s = stamp(p.id, sourceId, plain.value, receivedAt);
        if (typeof s === "string") appendOwn(rejected, { index, reason: s });
        else appendOwn(events, s);
      });
      return { ok: true, events, rejected };
    },
    async send(pluginId, req): Promise<SendResult> {
      const reg = plugins.get(pluginId);
      const p = reg?.plugin;
      if (!reg || p?.kind !== "outbound-channel") return { ok: false, state: "rejected", reason: "unknown-plugin", detail: pluginId };
      const plainReq = plainData(req, "发送请求");
      if (!plainReq.ok) return { ok: false, state: "rejected", reason: "invalid-payload", detail: `发送请求只接受普通数据对象:${plainReq.path} ${plainReq.why}` };
      const q = plainReq.value as { action_id?: unknown; payload?: unknown };
      const actionId = q.action_id;
      if (!isStr(actionId)) return { ok: false, state: "rejected", reason: "missing-action-id", detail: "外发动作必须带 action_id,宿主按它幂等" };
      const payload = q.payload;
      if (typeof payload !== "string") return { ok: false, state: "rejected", reason: "invalid-payload", detail: "payload 必须是字符串,宿主按原样字节比对" };
      const fingerprint = sha256(payload);
      const prior = entryOf(pluginId, actionId);
      if (!prior) {
        const binding = Object.freeze({ pluginId, channelVersion: reg.version, idempotency: p.idempotency, windowMs: p.idempotencyWindowMs ?? 0, endpoint: p.endpoint, firstAttemptAt: now(), firstAttemptMonotonic: monotonic(), payloadSha256: fingerprint });
        const entry: LedgerEntry = { binding, state: "in-flight", attempts: 0, maxMonotonic: binding.firstAttemptMonotonic, clockTrusted: Number.isFinite(binding.firstAttemptMonotonic) };
        putEntry(pluginId, actionId, entry);
        return attempt(p, entry, actionId, payload);
      }
      const b = prior.binding;
      // 每次调用都观测单调时钟:比已见最大值小(或非有限)就永久不可信,读数回升也不恢复
      const reading = monotonic();
      if (!Number.isFinite(reading) || reading < prior.maxMonotonic) prior.clockTrusted = false;
      else prior.maxMonotonic = reading;
      if (b.payloadSha256 !== fingerprint) return { ok: false, state: "rejected", reason: "payload-mismatch", detail: "同一 action_id 的内容必须逐字节一致" };
      if (prior.state === "in-flight") return { ok: false, state: "rejected", reason: "in-flight", detail: "上一次发送还没有结果" };
      // 已确认:复用已知结果,不因服务端缓存过期而重新产生副作用
      if (prior.state === "confirmed" && prior.receipt) return { ok: true, state: "confirmed", receipt: prior.receipt, deduplicated: true };
      // 结果未知:按首次投递时绑定的渠道判断,不看当前注册的版本
      if (b.idempotency === "none") return { ok: false, state: "delivery-unknown", reason: "retry-refused", detail: "B2 渠道结果未知,禁止自动重发,需人工对账" };
      if (reg.version !== b.channelVersion || p.endpoint !== b.endpoint) return { ok: false, state: "delivery-unknown", reason: "channel-changed", detail: `首次投递在渠道版本 ${b.channelVersion},现在是 ${reg.version};新接收端不知道旧投递,需人工对账` };
      if (!prior.clockTrusted) return { ok: false, state: "delivery-unknown", reason: "clock-untrusted", detail: "这个动作见到过单调时钟倒退,无法确认离首次尝试过了多久,永久停止自动重试,需人工对账" };
      // 走到这里时读数从没倒退过(否则上面已按时钟不可信返回),elapsed 一定 ≥ 0
      const elapsed = reading - b.firstAttemptMonotonic;
      if (!(elapsed < b.windowMs)) return { ok: false, state: "delivery-unknown", reason: "retry-window-expired", detail: `首次尝试已过服务商幂等保留期 ${b.windowMs}ms,需人工对账` };
      return attempt(p, prior, actionId, payload);
    },
    delivery(pluginId, actionId) {
      const e = entryOf(pluginId, actionId);
      return e ? Object.freeze({ state: e.state, binding: e.binding, attempts: e.attempts, maxMonotonic: e.maxMonotonic, clockTrusted: e.clockTrusted }) : undefined;
    },
    mounts: (point) => [...plugins.values()].map((x) => x.plugin).filter((p) => p.kind === "ui-extension" && p.mounts.includes(point)).map((p) => p.id),
  };
}
