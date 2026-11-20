// 插件注册表(AC-35 阶段 I 宿主契约桩)。类型见 plugin-contract.ts。
// 外部事件由宿主校验并盖章(来源、版本、事件类型、双时间、附件引用、不可信)。
// 注册入口只接受普通数据对象(与 PR #3/#4 的输入契约一致):非 Proxy,原型为 Object.prototype 或 null,
// B1 保留期按单调时钟算,墙钟回拨不延长窗口;某个动作见到单调读数倒退后永久不再自动重试。账本按 渠道 → 动作 两层 Map 存,不拼接字符串。
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
function isPlainPromise(x: unknown): x is Promise<unknown> {
  if (!types.isPromise(x) || types.isProxy(x)) return false;
  if (Object.getPrototypeOf(x) !== Promise.prototype) return false;
  return !Object.hasOwn(x, "then") && !Object.hasOwn(x, "constructor");
}
function attachQuiet(x: Promise<unknown>): void {
  Reflect.apply(Promise.prototype.then, x, [undefined, () => {}]);
}
const FN_SOURCE = Function.prototype.toString;
const NATIVE_SRC = /\{\s*\[native code\]\s*\}\s*$/;
function isNativeFn(v: unknown): boolean {
  if (typeof v !== "function" || types.isProxy(v)) return false;
  try { return NATIVE_SRC.test(Reflect.apply(FN_SOURCE, v, [])); } catch { return true; }
}
/** 宿主内置对象:临时改写只落在插件自己的对象上,绝不改写这些。
 *  R11-01:原来是一张手列的构造器清单,漏掉了 Node 全局 Buffer(它在 globalThis 上是访问器属性),
 *  于是「方案 3」把 Buffer[Symbol.species] 临时改成了数据属性,同一观察窗口里正常的缓冲区切片会抛错。
 *  现在启动时按三条一起判定(只读描述符与宿主内置 getter,不执行插件代码):
 *  ① 从 globalThis 的自有条件做一次闭包(值、原型链、每个函数自己的 prototype 属性)—— Buffer / Math / JSON /
 *    Reflect / Atomics 这类非构造器的内置命名空间也一并收进来,不再靠手列清单;
 *  ② 原生代码函数([native code]),以及原型对象上 constructor 是原生函数的对象 —— 覆盖其它 realm(vm 上下文)里的内置对象;
 *  ③ 启动时只读一次的那一小份访问器内置清单(含 Buffer),它们不以数据属性出现在 globalThis 上。
 *  判定失败的方向是「少改写」:多算成内置只会让拒收退化成残余形态,绝不会去写一个可能共享的内置对象。 */
const INTRINSICS: ReadonlySet<unknown> = (() => {
  const s = new Set<unknown>();
  const add = (v: unknown): boolean => {
    if (!((typeof v === "object" && v !== null) || typeof v === "function") || types.isProxy(v) || s.has(v)) return false;
    s.add(v);
    return true;
  };
  //    Array / Promise / Math / JSON / Reflect / Atomics / TypedArray 家族都在这里,不再另存一份手列清单。
  //    读一次就会把那个模块真加载进宿主进程(还会打弃用警告),内核不该为了认内置对象去动宿主的模块图。
  const ACCESSOR_HOSTS = ["Buffer", "process", "performance", "navigator", "crypto", "localStorage", "sessionStorage", "SlowBuffer"];
  const queue: unknown[] = [];
  const g: object = globalThis;
  const take = (v: unknown) => { if (add(v)) queue.push(v); };
  for (const k of Reflect.ownKeys(g)) {
    const d = Reflect.getOwnPropertyDescriptor(g, k);
    if (d === undefined || !("value" in d)) continue;
    take(d.value);
  }
  for (const k of ACCESSOR_HOSTS) {
    try { take(Reflect.get(g, k)); } catch { /* 这个内置在当前运行时没有或读不到 */ }
  }
  take(g);
  for (let i = 0; i < queue.length; i++) {
    const o = queue[i] as object;
    take(Object.getPrototypeOf(o));
    const pd = Reflect.getOwnPropertyDescriptor(o, "prototype");
    if (pd !== undefined && "value" in pd) take(pd.value);
  }
  return s;
})();
function isIntrinsic(o: object): boolean {
  if (types.isProxy(o)) return true;
  if (INTRINSICS.has(o) || isNativeFn(o)) return true;
  const c = Object.getOwnPropertyDescriptor(o, "constructor");
  return c !== undefined && "value" in c && isNativeFn(c.value);
}
type Found = { chain: object[]; desc: PropertyDescriptor | undefined; blocked: boolean };
function lookup(o: object, key: PropertyKey): Found {
  const chain: object[] = [];
  for (let cur: object | null = o; cur !== null; cur = Object.getPrototypeOf(cur)) {
    if (types.isProxy(cur)) return { chain, desc: undefined, blocked: true };
    pushOwn(chain, cur);
    const desc = Object.getOwnPropertyDescriptor(cur, key);
    if (desc !== undefined) return { chain, desc, blocked: false };
  }
  return { chain, desc: undefined, blocked: false };
}
const isRef = (v: unknown): v is object => (typeof v === "object" && v !== null) || typeof v === "function";
function speciesSafe(v: unknown): boolean {
  if (v === undefined || v === Promise) return true;
  if (!isRef(v)) return false;
  const s = lookup(v, Symbol.species);
  if (s.blocked) return false;
  if (s.desc === undefined) return true;
  return "value" in s.desc && (s.desc.value === undefined || s.desc.value === null || s.desc.value === Promise);
}
const descOf = (fields: PropertyDescriptor): PropertyDescriptor => Object.assign(Object.create(null), fields);
function shadow(chain: readonly object[], key: PropertyKey): (() => void) | undefined {
  for (const o of chain) {
    if (isIntrinsic(o)) continue;
    const own = Object.getOwnPropertyDescriptor(o, key);
    if (own === undefined) {
      if (Reflect.defineProperty(o, key, descOf({ value: Promise, writable: true, enumerable: false, configurable: true }))) return () => { Reflect.deleteProperty(o, key); };
    } else if ("value" in own && own.writable === true) {
      if (Reflect.defineProperty(o, key, descOf({ value: Promise }))) return () => { Reflect.defineProperty(o, key, descOf({ value: own.value })); };
    } else if (own.configurable === true) {
      if (Reflect.defineProperty(o, key, descOf({ value: Promise, writable: true, enumerable: own.enumerable === true, configurable: true }))) return () => { Reflect.defineProperty(o, key, descOf(own)); };
    }
  }
  return undefined;
}
/** 拒收外部 Promise 时让它不变成未处理拒绝,且不执行任何外部代码(用户 g-group#3140 选 A:能安全处理的都做)。
 *  先只读描述符推演内置 then 的 SpeciesConstructor(x.constructor → 其 Symbol.species):
 *  方案 1:推演结果本就是默认构造器或内置 Promise(含没有自有 constructor 的普通原生 Promise、constructor 为内置 Promise 的数据属性、
 *    constructor 指向没有 species 的函数),直接挂处理,不改任何对象;
 *  方案 2:在 x 的原型链上(x 自己优先,到找到 constructor 的那个对象为止,跳过内置对象)临时让 constructor 读成内置 Promise,
 *    覆盖可配置 getter、可写数据属性(含不可配置但可写)、可扩展子类实例,以及不可扩展/冻结实例而其类的 prototype 仍可改的情况;
 *  方案 3:constructor 是改不了的数据属性(不可配置且不可写,或实例不可扩展而链上都改不了)时,在该值(插件的类)的链上
 *    临时让 Symbol.species 读成内置 Promise。
 *  原型链上有 Proxy(实例本身不是 Proxy、也没有自有 constructor)时,改为临时把实例原型换成内置 Promise.prototype 再挂:
 *    换原型只检查新链,不进旧链上的陷阱;这样内置 then 读 constructor、以及 Node 在已拒绝 Promise 上补挂处理时
 *    经原型链读内部异步 id(async_id_symbol / trigger_async_id_symbol)都不经过 Proxy。实例不可扩展就做不到。
 *  方案 2/3 与换原型挂处理后都在 finally 里恢复。代价:改写期间同步、不运行插件代码,但插件若自装 async_hooks / promiseHooks,
 *    可能在挂处理那一瞬看到临时属性;改写对象从被拒 Promise 本身扩大到插件自己的类与其 prototype。
 *  做不到的(不挂处理,也不调用其访问器或陷阱):Proxy 包装的 Promise、原型链上有 Proxy 且实例不可扩展、改不了的 constructor getter、constructor 推演到
 *    非 undefined 的原始值 / Proxy / 内置构造器(要改写内置对象才能处理,未做)/ species 也改不了的类,见收据第 7 栏。 */
function quietRefused(x: unknown): void {
  if (!types.isPromise(x) || types.isProxy(x)) return;
  const ctor = lookup(x, "constructor");
  if (ctor.blocked) {
    const proto = Object.getPrototypeOf(x);
    if (!Reflect.setPrototypeOf(x, Promise.prototype)) return;
    try { attachQuiet(x); } finally { Reflect.setPrototypeOf(x, proto); }
    return;
  }
  const known = ctor.desc === undefined || "value" in ctor.desc;
  const value = known && ctor.desc !== undefined ? ctor.desc.value : undefined;
  if (known && speciesSafe(value)) { attachQuiet(x); return; }
  const undo = shadow(ctor.chain, "constructor") ?? (known && isRef(value) && !types.isProxy(value) ? shadow(lookup(value, Symbol.species).chain, Symbol.species) : undefined);
  if (undo === undefined) return;
  try { attachQuiet(x); } finally { undo(); }
}

function readClock(clock: () => unknown): number {
  let v: unknown;
  try { v = clock(); } catch { return Number.NaN; }
  return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
}

function isoOf(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
const reject = (reason: RegisterRejection, detail: string): RegisterResult => ({ ok: false, reason, detail });

function dataSelf(c: Record<string, unknown>): object {
  const self: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(c)) if (typeof c[k] !== "function") self[k] = c[k];
  return Object.freeze(self);
}

type Checked = { ok: true; snapshot: Plugin } | { ok: false; reason: RegisterRejection; detail: string };

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
  maxMonotonic: number;
  clockTrusted: boolean;
}
type Channel = Extract<Plugin, { kind: "outbound-channel" }>;
const TIMEOUT = Symbol("timeout");
const sha256 = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

function safeSnapshot(candidate: unknown): Checked {
  try { return snapshotOf(candidate); } catch (err) {
    return { ok: false, reason: "unsupported-instance", detail: `插件只接受普通数据对象,检查时出错:${describeThrown(err)}` };
  }
}

function registryOptions(input: unknown): { now: () => number; monotonic: () => number; sendTimeoutMs: number } {
  const plain = plainData(input ?? {}, "注册表选项", { topFunctions: true });
  if (!plain.ok) throw new TypeError(`注册表选项只接受普通数据对象:${plain.path} ${plain.why}`);
  if (!isObj(plain.value) || Array.isArray(plain.value)) throw new TypeError("注册表选项必须是对象");
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
  const ledger = new Map<string, Map<string, LedgerEntry>>();
  const entryOf = (pluginId: string, actionId: string) => ledger.get(pluginId)?.get(actionId);
  const putEntry = (pluginId: string, actionId: string, e: LedgerEntry) => {
    let m = ledger.get(pluginId);
    if (!m) { m = new Map(); ledger.set(pluginId, m); }
    m.set(actionId, e);
  };

  /** 投递一次:entry 已在账本里且标为 in-flight;只改 entry 的状态,不动首次尝试时间与绑定。 */
  async function attempt(p: Channel, entry: LedgerEntry, actionId: string, payload: string): Promise<SendResult> {
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
    if (!isPlainPromise(pending)) { quietRefused(pending); return unknown("non-promise-send", "这一片只支持返回原生 Promise 的 send;同步返回值、thenable 与改过 then 的 Promise 都不当作回执"); }
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
      let returned: unknown;
      try { returned = p.pull(sourceId); } catch (err) { return { ok: false, reason: "pull-failed", detail: errText(err) }; }
      let batch: unknown;
      if (!isPlainPromise(returned)) quietRefused(returned);
      try { batch = isPlainPromise(returned) ? await returned : returned; } catch (err) { return { ok: false, reason: "pull-failed", detail: errText(err) }; }
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
        const firstAttemptMonotonic = readClock(monotonic);
        const binding = Object.freeze({ pluginId, channelVersion: reg.version, idempotency: p.idempotency, windowMs: p.idempotencyWindowMs ?? 0, endpoint: p.endpoint, firstAttemptAt, firstAttemptMonotonic, payloadSha256: fingerprint });
        const entry: LedgerEntry = { binding, state: "in-flight", attempts: 0, maxMonotonic: firstAttemptMonotonic, clockTrusted: Number.isFinite(firstAttemptMonotonic) };
        putEntry(pluginId, actionId, entry);
        return attempt(p, entry, actionId, payload);
      }
      const b = prior.binding;
      const reading = readClock(monotonic);
      if (!(reading >= prior.maxMonotonic)) prior.clockTrusted = false;
      else prior.maxMonotonic = reading;
      if (b.payloadSha256 !== fingerprint) return { ok: false, state: "rejected", reason: "payload-mismatch", detail: "同一 action_id 的内容必须逐字节一致" };
      if (prior.state === "in-flight") return { ok: false, state: "rejected", reason: "in-flight", detail: "上一次发送还没有结果" };
      if (prior.state === "confirmed" && prior.receipt) return { ok: true, state: "confirmed", receipt: prior.receipt, deduplicated: true };
      if (b.idempotency === "none") return { ok: false, state: "delivery-unknown", reason: "retry-refused", detail: "B2 渠道结果未知,禁止自动重发,需人工对账" };
      if (reg.version !== b.channelVersion || p.endpoint !== b.endpoint) return { ok: false, state: "delivery-unknown", reason: "channel-changed", detail: `首次投递在渠道版本 ${b.channelVersion},现在是 ${reg.version};新接收端不知道旧投递,需人工对账` };
      if (!prior.clockTrusted) return { ok: false, state: "delivery-unknown", reason: "clock-untrusted", detail: "这个动作见到过单调时钟倒退,无法确认离首次尝试过了多久,永久停止自动重试,需人工对账" };
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
