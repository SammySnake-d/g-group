// 插件注册表(AC-35 阶段 I 宿主契约桩)。类型见 plugin-contract.ts。
// 注册时深拷贝并冻结宿主快照,之后只读快照;调用方再改原对象不影响宿主。更新走 reregister 重新校验。
// 外部事件由宿主校验并盖章(来源、版本、事件类型、双时间、附件引用、不可信)。
// 外发按 action_id 记账,每个动作绑定首次投递时的渠道版本、幂等能力与保留期:
//   已确认 → 永远复用已知回执,不重发;结果未知 → B2 拒绝重发,B1 只在首次尝试仍在服务商保留期内、
//   且渠道仍是同一版本、同一接收端时才重试;reregister 换不掉旧动作的绑定。
// 结果数组一律用 pushOwn 追加自有元素,不经过 Array.prototype 上的同名 setter 或只读下标。
// 注册入口只接受普通数据对象(与 PR #3/#4 的输入契约一致):非 Proxy,原型为 Object.prototype 或 null,
// 逐层用属性描述符检查,出现 getter/setter、Symbol 键、不可枚举属性、Map/Set/Date/类实例(含私有字段 #x)就拒绝并点名路径,
// 绝不调用 getter;整个入口外层兜底,检查时的任何异常都变成拒绝。不承诺防御任意 JS 元编程对象。
// 输入转成冻结纯数据(原型 null)后才读契约字段;send/pull 以这份纯数据为 this 调用,send 请求里拿到绑定的 endpoint。
// B1 保留期按单调时钟算,墙钟回拨不延长窗口;某个动作见到单调读数倒退后永久不再自动重试。账本按 渠道 → 动作 两层 Map 存,不拼接字符串。
// 插件交回的值只判定、不处理(第十四轮合同,用户 2026-11-09 按根因改,取代 #3140「能安全处理的都做」):只读属性描述判定是不是普通原生 Promise,
// 是才 await;不是就拒收,对它不再做任何引擎操作(不挂拒绝处理、不改写任何对象)。宿主进程会不会因插件的失败而退出,由插件隔离负责,不归内核。
import { createHash } from "node:crypto";
import { types } from "node:util";
import { pushOwn } from "./own.ts";
import { describeThrown, plainData, plainItems } from "./plain.ts";
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
/** Node 给 Promise 记异步追踪的两个内部符号的描述。await 时 Node 会读它们并转成数字(async_hooks 的 getOrSetAsyncId、
 *  C++ 的 PromiseRejectCallback;Node 22.22 / 25.8 源码)。按描述认:插件自造的同描述符号也当追踪键(偏保守)。 */
const TRACKING: ReadonlySet<string> = new Set(["async_id_symbol", "trigger_async_id_symbol"]);
const isTracking = (k: PropertyKey): boolean => typeof k === "symbol" && TRACKING.has(k.description ?? "");
/** 追踪符号上只有数字与 undefined 在转数字时不执行外部代码(对象会调用 valueOf / Symbol.toPrimitive,BigInt / Symbol 抛 TypeError) */
const safeId = (v: unknown): boolean => typeof v === "number" || v === undefined;
/** 插件交回的值是不是普通原生 Promise:只读属性描述判定,不读值、不调用任何东西
 *  (对非 Proxy 的对象,取原型、判可扩展、列自有键、读描述符按 ECMAScript 规范都不执行用户代码)。
 *  条件:不是 Proxy;原型就是 Promise.prototype;没有自有 then / constructor;可扩展(开着 async_hooks 时 await 要在它身上新建 async_id,
 *  不可扩展又没有就会在 Node 的钩子里抛错);自有属性都是数据属性;追踪符号上只有数字或 undefined。满足这些,await 它不执行插件代码。
 *  不满足就拒收(send 记 non-promise-send,pull 记 invalid-batch;同步返回值也一样,第十五轮 R14-01),对这个值不再做任何引擎操作、也不再读它:
 *  不挂拒绝处理、不改写任何对象。被拒收的已失败 Promise 与插件自己漏接的拒绝一样,宿主存活交插件隔离(worker 线程或子进程),不归内核。 */
function isPlainPromise(x: unknown): x is Promise<unknown> {
  if (!types.isPromise(x) || types.isProxy(x)) return false;
  if (Object.getPrototypeOf(x) !== Promise.prototype) return false;
  if (Object.hasOwn(x, "then") || Object.hasOwn(x, "constructor")) return false;
  if (!Object.isExtensible(x)) return false;
  for (const k of Reflect.ownKeys(x)) {
    const d = Object.getOwnPropertyDescriptor(x, k);
    if (d === undefined) continue;
    if (!("value" in d)) return false;
    if (isTracking(k) && !safeId(d.value)) return false;
  }
  return true;
}

/** 读宿主注入的时钟回调:只认有限数字。返回值只用 typeof 判断(不触发访问器、Proxy 陷阱或类型转换),
 *  非数字、非有限数、回调抛错都记作 NaN,由调用方按"时钟不可信"处理,绝不把外部值转换、存储或拿去比较。 */
function readClock(clock: () => unknown): number {
  let v: unknown;
  try { v = clock(); } catch { return Number.NaN; }
  return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
}

/** 墙钟读数转 ISO 时间;超出 Date 范围的有限数也算不可信 */
function isoOf(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
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
const NON_PROMISE_PULL = "pull 必须给出普通数据数组:pull 结果 不是普通原生 Promise;这一片只接受返回普通原生 Promise 的 pull,同步返回值、thenable 与改过的 Promise 都不读取、不处理";
/** Node 定时器能表示的最长等待(2^31-1 毫秒,约 24.8 天);更大的值会被 Node 缩成 1 毫秒并告警,所以注册表选项直接拒收(第十五轮 R14-03) */
const MAX_SEND_TIMEOUT_MS = 2_147_483_647;
const sha256 = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

/** 注册入口外层兜底:校验过程中任何异常都变成拒绝,不逃出注册入口 */
function safeSnapshot(candidate: unknown): Checked {
  try { return snapshotOf(candidate); } catch (err) {
    return { ok: false, reason: "unsupported-instance", detail: `插件只接受普通数据对象,检查时出错:${describeThrown(err)}` };
  }
}

/** 注册表选项也是对外入口:先过统一判定(不调 getter),再查字段类型;不合规抛受控的 TypeError,不返回半成品注册表 */
function registryOptions(input: unknown): { now: () => number; monotonic: () => number; sendTimeoutMs: number } {
  // JSON 的 null 选项按"没给"处理,用默认值;其它非对象值抛受控 TypeError
  const plain = plainData(input ?? {}, "注册表选项", { topFunctions: true });
  if (!plain.ok) throw new TypeError(`注册表选项只接受普通数据对象:${plain.path} ${plain.why}`);
  if (!isObj(plain.value) || Array.isArray(plain.value)) throw new TypeError("注册表选项必须是对象");
  const o = plain.value as { now?: unknown; monotonic?: unknown; sendTimeoutMs?: unknown };
  if (o.now !== undefined && typeof o.now !== "function") throw new TypeError("注册表选项 now 必须是函数");
  if (o.monotonic !== undefined && typeof o.monotonic !== "function") throw new TypeError("注册表选项 monotonic 必须是函数");
  // 上限是 Node 定时器能表示的最长等待;超过的值 Node 会缩成 1 毫秒,几乎立即判超时,详情却写成等了配置的时长
  if (o.sendTimeoutMs !== undefined && !(typeof o.sendTimeoutMs === "number" && o.sendTimeoutMs > 0 && o.sendTimeoutMs <= MAX_SEND_TIMEOUT_MS)) throw new TypeError(`注册表选项 sendTimeoutMs 必须是大于 0、不超过 ${MAX_SEND_TIMEOUT_MS} 的毫秒数(Node 定时器上限)`);
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
    // 不是普通原生 Promise 就拒收,不再碰它(不挂处理、不改写);宿主存活交插件隔离
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
      // 先判定返回值的形态再 await:只有普通原生 Promise(isPlainPromise 只看描述符,不读值)才 await;
      // 其它返回值(同步数组等同步值、thenable、带自有 then/constructor 或访问器的 Promise)一律 invalid-batch,
      // 不 await、不挂处理、不读取也不交给 plainItems(第十五轮 R14-01:合同只接受普通原生 Promise)。
      // 插件自己代码里(async 函数内部 return 一个 thenable)发生的 Promise 同化在交给宿主之前,宿主管不到。
      let returned: unknown;
      try { returned = p.pull(sourceId); } catch (err) { return { ok: false, reason: "pull-failed", detail: errText(err) }; }
      if (!isPlainPromise(returned)) return { ok: false, reason: "invalid-batch", detail: NON_PROMISE_PULL };
      let batch: unknown;
      try { batch = await returned; } catch (err) { return { ok: false, reason: "pull-failed", detail: errText(err) }; }
      const list = plainItems(batch, "pull 结果");
      if (!list.ok) return { ok: false, reason: "invalid-batch", detail: `pull 必须给出普通数据数组:${list.path} ${list.why}` };
      const receivedAt = isoOf(readClock(now));
      if (receivedAt === undefined) return { ok: false, reason: "clock-invalid", detail: "宿主墙钟 now() 没有给出有限数字时间,不给事件盖收到时间" };
      const events: ExternalEnvelope[] = [];
      const rejected: RejectedEvent[] = [];
      list.items.forEach((raw, index) => {
        const plain = plainData(raw, `事件[${index}]`);
        if (!plain.ok) { pushOwn(rejected, { index, reason: `只接受普通数据对象:${plain.path} ${plain.why}` }); return; }
        const s = stamp(p.id, sourceId, plain.value, receivedAt);
        if (typeof s === "string") pushOwn(rejected, { index, reason: s });
        else pushOwn(events, s);
      });
      return { ok: true, events, rejected };
    },
    async send(pluginId, req): Promise<SendResult> {
      const reg = plugins.get(pluginId);
      const p = reg?.plugin;
      if (!reg || p?.kind !== "outbound-channel") return { ok: false, state: "rejected", reason: "unknown-plugin", detail: pluginId };
      const plainReq = plainData(req, "发送请求");
      if (!plainReq.ok) return { ok: false, state: "rejected", reason: "invalid-payload", detail: `发送请求只接受普通数据对象:${plainReq.path} ${plainReq.why}` };
      if (!isObj(plainReq.value) || Array.isArray(plainReq.value)) return { ok: false, state: "rejected", reason: "invalid-payload", detail: "发送请求必须是对象" };
      const q = plainReq.value as { action_id?: unknown; payload?: unknown };
      const actionId = q.action_id;
      if (!isStr(actionId)) return { ok: false, state: "rejected", reason: "missing-action-id", detail: "外发动作必须带 action_id,宿主按它幂等" };
      const payload = q.payload;
      if (typeof payload !== "string") return { ok: false, state: "rejected", reason: "invalid-payload", detail: "payload 必须是字符串,宿主按原样字节比对" };
      const fingerprint = sha256(payload);
      const prior = entryOf(pluginId, actionId);
      if (!prior) {
        const firstAttemptAt = readClock(now);
        if (isoOf(firstAttemptAt) === undefined) return { ok: false, state: "rejected", reason: "clock-invalid", detail: "宿主墙钟 now() 没有给出有限数字时间,不记首次尝试、不发送" };
        // 单调读数不可信(非有限数字)时记 NaN:照常投递这一次,但该动作永久不自动重试
        const firstAttemptMonotonic = readClock(monotonic);
        const binding = Object.freeze({ pluginId, channelVersion: reg.version, idempotency: p.idempotency, windowMs: p.idempotencyWindowMs ?? 0, endpoint: p.endpoint, firstAttemptAt, firstAttemptMonotonic, payloadSha256: fingerprint });
        const entry: LedgerEntry = { binding, state: "in-flight", attempts: 0, maxMonotonic: firstAttemptMonotonic, clockTrusted: Number.isFinite(firstAttemptMonotonic) };
        putEntry(pluginId, actionId, entry);
        return attempt(p, entry, actionId, payload);
      }
      const b = prior.binding;
      // 每次调用都观测单调时钟:比已见最大值小(或非有限)就永久不可信,读数回升也不恢复
      // 读数只会是有限数字或 NaN;已存的最大值也是;NaN 与任何数比较都不成立,于是落到不可信
      const reading = readClock(monotonic);
      if (!(reading >= prior.maxMonotonic)) prior.clockTrusted = false;
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
