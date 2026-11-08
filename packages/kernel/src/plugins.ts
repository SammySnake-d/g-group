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
/** Node 给 Promise 记异步追踪的两个内部符号的描述(Node 22.22 / 25.8 源码:JS 的 getOrSetAsyncId,C++ 的 PromiseRejectCallback)。
 *  内置 then / await 给外部 Promise 挂处理时 Node 会碰它们(R12-01):
 *  ① 已拒绝且还没处理的 Promise 补挂处理时,C++ 的 PromiseRejectCallback 对两个符号各做一次 [[Get]](不论宿主开没开 async_hooks;
 *     沿原型链,访问器会被调用、Proxy 会进陷阱);
 *  ② 宿主开着 async_hooks(init / destroy 钩子)时,getOrSetAsyncId 读实例自有的 async_id(访问器会被调用),没有自有的就 [[Set]]
 *     一个新 id(沿原型链找 setter、进 Proxy 陷阱;实例不可扩展或链上只读会在钩子里抛 TypeError,按未捕获异常结束宿主;
 *     链上 setter 吞掉 id 时 Node 的异步上下文栈错乱,进程直接 abort)。
 *  按描述认:插件拿不到别的同名真符号,自造的同描述符号也一并当追踪键(偏保守)。 */
const TRACKING: ReadonlySet<string> = new Set(["async_id_symbol", "trigger_async_id_symbol"]);
const trackingKeys = (o: object): symbol[] => Object.getOwnPropertySymbols(o).filter((k) => TRACKING.has(k.description ?? ""));
const isTracking = (k: PropertyKey): boolean => typeof k === "symbol" && TRACKING.has(k.description ?? "");
/** Node 会把追踪符号上的值转成数字(写进内部 Float64Array 或 C++ NumberValue):只有数字与 undefined 不会执行外部代码;
 *  对象的 valueOf / Symbol.toPrimitive 会被调用,Symbol / BigInt 会抛 TypeError,都当不安全 */
const safeId = (v: unknown): boolean => typeof v === "number" || v === undefined;
/** 宿主现在是否开着会给 Promise 记 async_id 的钩子:新建一个内置 Promise,看 Node 有没有在它身上写 async_id(Node 自己写的数据属性)。
 *  开着就返回这个符号与刚分到的 id;没开返回 undefined(这时 Node 挂处理时不会新建 id)。 */
function liveAsyncId(): { key: symbol; id: unknown } | undefined {
  const probe = Promise.resolve();
  for (const key of trackingKeys(probe)) {
    const d = Object.getOwnPropertyDescriptor(probe, key);
    if (key.description === "async_id_symbol" && d !== undefined && "value" in d) return { key, id: d.value };
  }
  return undefined;
}
/** 发送结果只认原生 Promise:原型就是 Promise.prototype,没有自有的 then / constructor 属性,也没有任何自有访问器
 *  (R12-02:只看描述符,不调 getter;运行时给 Promise 记的异步追踪符号是数字数据属性,照常放行;追踪符号上的值不是数字或 undefined 的也不收,
 *  否则 await 时 Node 转数字会执行它的 valueOf)。
 *  R12-01:还必须可扩展 —— 宿主开着 async_hooks 时 await / Promise.race 要在它身上新建 async_id,不可扩展又还没有就会在 Node 的钩子里
 *  抛错(按未捕获异常结束宿主)。为了结果不随宿主开没开钩子而变,不可扩展的一律不收。
 *  子类、thenable、带自有 then 的 Promise 一律不算,按 non-promise-send 处理。 */
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
/** 用内置 Promise.prototype.then 挂一个空的拒绝处理。内置 then 不读实例的 then(哪怕它是 getter),
 *  只读 x.constructor 与它的 Symbol.species;Node 另外会碰两个异步追踪符号(见 TRACKING)。调用方(prepareQuiet)保证这些都不执行外部代码。 */
function attachQuiet(x: Promise<unknown>): void {
  Reflect.apply(Promise.prototype.then, x, [undefined, () => {}]);
}
/** 原生代码函数:Function.prototype.toString 在启动时抓一份,插件事后改 toString 也不影响这里的判断。
 *  取不到源码(抛错)按原生算 —— 方向是少改写,不是多改写。 */
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
  // ① globalThis 自己的值做闭包(值属性直接读描述符,再展开原型链与函数自己的 prototype 属性)。
  //    Array / Promise / Math / JSON / Reflect / Atomics / TypedArray 家族都在这里,不再另存一份手列清单。
  //    另有一小组内置是访问器(getter),只有读一次才拿得到:Buffer / process / performance / navigator / crypto 等。
  //    只读这一小组,不去读 globalThis 上其余访问器 —— Node 把 assert / fs / punycode 之类也做成 getter,
  //    读一次就会把那个模块真加载进宿主进程(还会打弃用警告),内核不该为了认内置对象去动宿主的模块图。
  //    这次读发生在内核模块加载时,插件代码还不会跑;读不到或抛错就跳过(方向仍是少改写)。
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
/** 这个对象是不是宿主的(判定见 INTRINSICS 注释;宁可多算,方向都是「少改写」)。
 *  Proxy 一律算宿主:读它的描述符要进陷阱,而改写目标本来就只从非 Proxy 的链上来,这道判断只是兜底。 */
function isIntrinsic(o: object): boolean {
  if (types.isProxy(o)) return true;
  if (INTRINSICS.has(o) || isNativeFn(o)) return true;
  const c = Object.getOwnPropertyDescriptor(o, "constructor");
  return c !== undefined && "value" in c && isNativeFn(c.value);
}
type Found = { chain: object[]; desc: PropertyDescriptor | undefined; blocked: boolean };
/** 沿原型链只读描述符找 key(不调用 getter):chain 是查过的对象(从近到远,含找到 key 的那一个);
 *  遇到 Proxy 就停下(不进陷阱),blocked 为 true。原型链上只对非 Proxy 对象调用 getPrototypeOf / getOwnPropertyDescriptor。 */
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
/** 内置 then 读到的 constructor 是 v 时,取 v[Symbol.species] 能否不执行外部代码、且结果是默认构造器或内置 Promise:
 *  v 为 undefined 或内置 Promise;或 v 是非 Proxy 对象,链上(无 Proxy)没有 species,或 species 是值为 undefined/null/内置 Promise 的数据属性。 */
function speciesSafe(v: unknown): boolean {
  if (v === undefined || v === Promise) return true;
  if (!isRef(v)) return false;
  const s = lookup(v, Symbol.species);
  if (s.blocked) return false;
  if (s.desc === undefined) return true;
  return "value" in s.desc && (s.desc.value === undefined || s.desc.value === null || s.desc.value === Promise);
}
/** 描述符对象一律用空原型,不经过 Object.prototype */
const descOf = (fields: PropertyDescriptor): PropertyDescriptor => Object.assign(Object.create(null), fields);
/** 在链上(从近到远,跳过内置对象)第一个能改的对象上让 key 临时读成内置 Promise,返回恢复函数;都改不了返回 undefined。
 *  可写数据属性只改值(不碰 enumerable / configurable,不可配置也能改),恢复也只写回原值;可配置属性临时换成数据属性,
 *  恢复原描述符;没有自有属性且可扩展就临时新建,恢复时删掉。改不了由 Reflect.defineProperty 返回 false 识别(不抛错)。 */
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
/** 原型链上 Node 读写追踪符号([[Get]] / [[Set]] 都沿链)与内置 then 读 constructor 都不会进 Proxy,也碰不到追踪符号的访问器或只读属性。
 *  链上追踪符号的值不查:挂处理时 Node 22.22 / 25.8 沿链读到的值只在 C++ 里按是否为数字取用、不做转换(实测带 valueOf 的对象 0 次调用),
 *  实例自己的 async_id 才会被抄进派生 Promise 的 triggerAsyncId、在之后的钩子里转成数字(见 prepareQuiet ①) */
function chainSafe(start: object | null): boolean {
  for (let o = start; o !== null; o = Object.getPrototypeOf(o)) {
    if (types.isProxy(o)) return false;
    for (const k of trackingKeys(o)) {
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (d !== undefined && !("value" in d && d.writable === true)) return false;
    }
  }
  return true;
}
/** 拒收外部 Promise 时让它不变成未处理拒绝,且不执行任何外部代码(用户 g-group#3140 选 A:能安全处理的都做)。
 *  挂处理前由 prepareQuiet 只读描述符准备,每处临时改写登记恢复函数,挂完(或做不到)在 finally 里逆序恢复。 */
function quietRefused(x: unknown): void {
  if (!types.isPromise(x) || types.isProxy(x)) return;
  const restores: (() => void)[] = [];
  try {
    if (prepareQuiet(x, restores)) attachQuiet(x);
  } finally {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]?.();
  }
}
/** 挂处理前的准备,做不到返回 false(不挂处理):
 *  ① 实例自有的追踪符号是访问器或值不安全(R12-01;见 safeId):临时换成安全的数据值 —— async_id 用 Node 刚给探针分到的新 id
 *     (读不到原值,也不去读),其余为 undefined(Node 当无效 id);可配置的整个换成数据属性、恢复原描述符,不可配置但可写的只改值、
 *     恢复原值;不可配置的访问器或只读值做不到;
 *  ② 原型链上有 Proxy,或有追踪符号的访问器 / 只读属性:临时把实例原型换成内置 Promise.prototype 再挂。换原型只检查新链,
 *     不进旧链的陷阱;这样内置 then 读 constructor、Node 读写异步 id 都只经过内置对象。实例不可扩展就做不到;
 *  ③ 宿主开着钩子、实例没有自有 async_id 又不可扩展:Node 新建 id 时会在钩子里抛错,做不到;
 *  ④ 内置 then 的 SpeciesConstructor(x.constructor → 其 Symbol.species),只读描述符推演:
 *     方案 1:推演结果本就是默认构造器或内置 Promise(含没有自有 constructor 的普通原生 Promise、constructor 为内置 Promise 的数据属性、
 *       constructor 指向没有 species 的函数),直接挂处理,不改任何对象;
 *     方案 2:在 x 的原型链上(x 自己优先,到找到 constructor 的那个对象为止,跳过内置对象)临时让 constructor 读成内置 Promise,
 *       覆盖可配置 getter、可写数据属性(含不可配置但可写)、可扩展子类实例,以及不可扩展/冻结实例而其类的 prototype 仍可改的情况;
 *     方案 3:constructor 是改不了的数据属性(不可配置且不可写,或实例不可扩展而链上都改不了)时,在该值(插件的类)的链上
 *       临时让 Symbol.species 读成内置 Promise。
 *  代价:改写期间同步、不运行插件代码,但插件若自装 async_hooks / promiseHooks,可能在挂处理那一瞬看到临时属性;
 *    改写对象从被拒 Promise 本身扩大到插件自己的类与其 prototype。插件自己稍后兑现 / 拒绝它时 Node 的 settled 钩子读到的是
 *    恢复后的原访问器,那发生在插件自己的调用里,宿主管不到(集成前由插件进程隔离兜底)。
 *  做不到的(不挂处理,也不调用其访问器或陷阱):Proxy 包装的 Promise、不可配置的追踪符号访问器或不可配置不可写的不安全值、原型链要换而实例不可扩展、
 *    开着钩子时不可扩展又没有自有 async_id、改不了的 constructor getter、constructor 推演到非 undefined 的原始值 / Proxy /
 *    内置构造器(要改写内置对象才能处理,未做)/ species 也改不了的类,见收据第 7 栏。 */
function prepareQuiet(x: Promise<unknown>, restores: (() => void)[]): boolean {
  const live = liveAsyncId();
  for (const k of trackingKeys(x)) {
    const d = Object.getOwnPropertyDescriptor(x, k);
    if (d === undefined || ("value" in d && safeId(d.value))) continue;
    const value = live !== undefined && live.key === k ? live.id : undefined;
    if ("value" in d && d.writable === true && d.configurable !== true) {
      if (!Reflect.defineProperty(x, k, descOf({ value }))) return false;
      pushOwn(restores, () => { Reflect.defineProperty(x, k, descOf({ value: d.value })); });
      continue;
    }
    if (!Reflect.defineProperty(x, k, descOf({ value, writable: true, enumerable: d.enumerable === true, configurable: true }))) return false;
    pushOwn(restores, () => { Reflect.defineProperty(x, k, descOf(d)); });
  }
  const proto = Object.getPrototypeOf(x);
  if (!chainSafe(proto)) {
    if (!Reflect.setPrototypeOf(x, Promise.prototype)) return false;
    pushOwn(restores, () => { Reflect.setPrototypeOf(x, proto); });
  }
  if (live !== undefined && !Object.hasOwn(x, live.key) && !Object.isExtensible(x)) return false;
  const ctor = lookup(x, "constructor");
  const known = ctor.desc === undefined || "value" in ctor.desc;
  const value = known && ctor.desc !== undefined ? ctor.desc.value : undefined;
  if (known && speciesSafe(value)) return true;
  const undo = shadow(ctor.chain, "constructor") ?? (known && isRef(value) && !types.isProxy(value) ? shadow(lookup(value, Symbol.species).chain, Symbol.species) : undefined);
  if (undo === undefined) return false;
  pushOwn(restores, undo);
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
      // 先判定返回值的形态再 await:只有原生 Promise(isPlainPromise 只看描述符,不读值)才 await;
      // 其它返回值(thenable、带自有 then/constructor 或访问器的 Promise、同步值)不 await,直接交给 plainItems 判定,非普通数组就拒绝。
      // 插件自己代码里(async 函数内部 return 一个 thenable)发生的 Promise 同化在交给宿主之前,宿主管不到。
      let returned: unknown;
      try { returned = p.pull(sourceId); } catch (err) { return { ok: false, reason: "pull-failed", detail: errText(err) }; }
      let batch: unknown;
      const native = isPlainPromise(returned);
      if (!native) quietRefused(returned);
      try { batch = native ? await returned : returned; } catch (err) { return { ok: false, reason: "pull-failed", detail: errText(err) }; }
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
