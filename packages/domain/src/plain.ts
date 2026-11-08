import { types } from "node:util";

// 领域层内部模块:普通数据对象合同的规范化工具。只供 contact.ts、helper.ts 内部使用,
// 包入口(src/index.ts,package.json exports 只有 ".")不导出本模块,schema 参数只来自本包源码里的常量,不是公开入口的参数(CH-36)。

// ---------------------------------------------------------------- 入参规范化(普通数据对象合同)
// 领域层所有公开入口(联系人与 Helper)的对象参数都先经 normalize,包括调用方传回来的状态(Contact、Directory)。合同:只接受 JSON 能产生的普通数据对象,依次检查——
//   1. 不是 Proxy(node:util types.isProxy);
//   2. 对象原型为 Object.prototype 或 null,数组为原型 Array.prototype 的真数组;
//   3. 用 Reflect.ownKeys 逐个取全部自有属性(含不可枚举、Symbol 键)的描述符,描述符自己没有 value 就是访问器,直接拒绝,getter 永不调用。
// 只认自有属性:描述符的 value、schema 的 optional/of 标记都用 Object.hasOwn 判定,不读原型链。
// 通过后只从数据属性取值,读到立即复制成冻结纯数据;数组按 length 逐个下标取值,不走迭代器,空位或类型不对的项当场拒绝(R19-01:不先按声明长度物化)。
// 快照是空原型(Object.create(null))对象,字段与数组项用 defineProperty 写入,属性描述符本身也是空原型对象,
// 不会从 Object.prototype 继承 get/set/value 等字段,也不经过原型链上的同名 setter 或不可写属性。
// 之后的校验、判断、错误理由和存储/输出只用这份快照;输出的联系人只按声明字段重新构造,状态里多出来的字段(如旧版本的 focus)不会带出。
// schema 没声明的字段丢掉,但丢掉之前先查(CH-41):从它的值出发,沿全部自有数据属性走遍可达的对象,任何一层出现 Proxy、
// 非普通原型的对象或访问器属性,整个入参拒绝;数组字段里下标以外的自有属性(如 foo、includes、Symbol.iterator)同样查。
// 可选字段只有缺省或 undefined 算缺省,显式 null 按类型不对拒绝。本层不承诺防御任意 JS 元编程对象。
type FieldKind = "string" | "stringOrNull" | "boolean" | "number" | "strings" | "schedule" | "objects";
interface FieldSpec { readonly kind: FieldKind; readonly optional?: true; readonly of?: Schema }
export type Schema = Readonly<Record<string, FieldSpec>>;
export type Normalized<T> = { ok: true; value: T } | { ok: false; reason: string };
type FieldResult = { ok: true; value: unknown } | { ok: false; reason: string };

/** 空原型的数据属性描述符:defineProperty 读描述符字段时不会读到 Object.prototype 上的同名属性。 */
const dataDesc = (value: unknown, writable: boolean): PropertyDescriptor => {
  const d = Object.create(null) as PropertyDescriptor;
  d.value = value;
  d.writable = writable;
  d.enumerable = true;
  d.configurable = writable;
  return d;
};
const isOptional = (s: FieldSpec): boolean => Object.hasOwn(s, "optional") && s.optional === true;

/** 普通数据检查(调用前已排除 Proxy):返回 null 表示通过,否则返回拒绝理由。不调用任何 getter。skipProtoCheck 为 true 时跳过原型检查但仍检查访问器。 */
export function plainDataError(v: object, what: string, wantArray: boolean, skipProtoCheck = false): string | null {
  const noun = wantArray ? "数组" : "对象";
  if (!skipProtoCheck) {
    const proto: unknown = Object.getPrototypeOf(v);
    if (wantArray ? proto !== Array.prototype || !Array.isArray(v) : proto !== Object.prototype && proto !== null) return `${what} 只接受普通数据${noun}`;
  }
  for (const key of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (d && !Object.hasOwn(d, "value")) return `${what} 只接受普通数据${noun}(${String(key)} 是访问器属性)`;
  }
  return null;
}

/** 引擎自带的生成器原型层的上一层(模块加载时抓取,调用方读不到这份对比基准;g-group#2662 只保证内置原型未被改写)。 */
const ENGINE_GENERATOR_PROTO: object = Object.getPrototypeOf((function* () {}).prototype) as object;
const ENGINE_ASYNC_GENERATOR_PROTO: object = Object.getPrototypeOf((async function* () {}).prototype) as object;

/**
 * 函数 fn 的自有 prototype 值 value 是否与引擎生成器原型同层(CH-47):
 * ① fn 是生成器函数(异步生成器另比一层);② value 的原型正好是引擎给出的那一层。
 * 同层的空对象无法区分是否由调用方替换,因此可以放行;有自有属性时先逐个检查,再拒绝非普通原型(R20-01)。
 * 同层的访问器、Proxy 和嵌套非普通对象仍在 nestedPlainError 中拒绝,不会调用 getter 或 trap。
 * value 是 Proxy(含已撤销)时不读它的原型,直接不认(R18-01:不调用即拒,trap 0 次)。
 */
function engineGeneratorPrototype(fn: unknown, value: unknown): boolean {
  if (typeof fn !== "function" || typeof value !== "object" || value === null) return false;
  // R18-01:value 是外来值,读它的原型之前先无 trap 地排除 Proxy(含已撤销的);排除后它回到待查栈,由 isProxy 拒收
  if (types.isProxy(value)) return false;
  if (!types.isGeneratorFunction(fn)) return false;
  return Object.getPrototypeOf(value) === (types.isAsyncFunction(fn) ? ENGINE_ASYNC_GENERATOR_PROTO : ENGINE_GENERATOR_PROTO);
}

/** nestedPlainError 的待查项:值、它在入参里的位置、它是不是引擎为生成器函数生成的 prototype 对象、下一项。 */
interface Pending { readonly x: unknown; readonly at: string; readonly engineProto: boolean; readonly next: Pending | null }

/**
 * 被丢弃或不按项类型读取的位置上的值(CH-41):从 v 出发,用显式栈(链表)沿全部自有数据属性(含不可枚举键、Symbol 键)走遍可达的对象与函数,
 * 任何一层是 Proxy、对象原型不是 Object.prototype/null(数组不是 Array.prototype 的真数组)、或有访问器属性,返回拒绝理由;否则 null。
 * 不调用任何 getter、setter 或 Proxy trap(先 types.isProxy 再取描述符)。原始值放行。函数值本身放行(数组自带的 includes、
 * Symbol.iterator 数据属性函数这类旧输入照常接受,见 CY06/CH-34),但它自己不能是 Proxy、自有属性里不能有访问器,
 * 自有数据属性的值同样往下查;只有与引擎生成器 prototype 同层且自身为空的对象可免查原型(CH-47、R20-01)。
 * 已访问集合防环,不递归,深层嵌套不爆栈。confirmFinalReport 也用它对整个回执先做一遍检查(CH-42)。
 */
export function nestedPlainError(v: unknown, what: string): string | null {
  // 待查栈用对象字面量串成链表,不用数组 push:数组按下标写入会经过原型链上的同名 setter(CH-30 的污染对照)
  let top: Pending | null = { x: v, at: what, engineProto: false, next: null };
  const seen = new Set<unknown>();
  while (top !== null) {
    const { x, at, engineProto } = top;
    top = top.next;
    if (typeof x !== "function" && (typeof x !== "object" || x === null)) continue;
    if (types.isProxy(x)) return `${at} 只接受普通数据(不能是 Proxy)`;
    // CH-44:即使对象已在 seen 中(防循环引用),也要检查它本身是否普通,因为它可能同时以不同上下文出现(如别名+prototype)
    // 已在 seen 中只豁免遍历其属性,不豁免检查对象本身。
    const alreadySeen = seen.has(x);
    if (!alreadySeen) seen.add(x);

    // 对象的访问器必须被检查,即使它作为函数的 prototype;engineProto 只豁免原型检查。
    if (typeof x === "object") {
      const bad = plainDataError(x, at, Array.isArray(x), engineProto);
      if (bad) return bad;
    }
    // 如果已经访问过此对象,不再遍历其属性以防循环
    if (alreadySeen) continue;

    // 只有无自有属性的同层生成器原型可免查原型(R20-01)。先检查属性值,保留对嵌套 Proxy、非普通对象的具体拒绝理由;
    // 再以非豁免上下文重查本对象,使普通自有数据也不能让非普通原型通过。此时 seen 不跳过对象本身的原型检查。
    if (engineProto && typeof x === "object" && Reflect.ownKeys(x).length > 0) {
      top = { x, at, engineProto: false, next: top };
    }

    for (const key of Reflect.ownKeys(x)) {
      const d = Object.getOwnPropertyDescriptor(x, key);
      if (d === undefined) continue;
      if (!Object.hasOwn(d, "value")) return `${at} 只接受普通数据(${String(key)} 是访问器属性)`;
      // CH-47:先识别生成器 prototype 的引擎同层候选;只有自身为空才可免查原型,上面会排除带自有属性的候选。
      top = { x: d.value, at: `${at}.${String(key)}`, engineProto: key === "prototype" && engineGeneratorPrototype(x, d.value), next: top };
    }
  }
  return null;
}

const INDEX = /^(0|[1-9]\d*)$/;

/**
 * 复制一个普通数据数组:按下标从 0 到 length-1 逐个取自有数据属性,不走迭代器;每一项取到就交给 item 当场判定并复制,
 * 空位(没有这个自有下标)、访问器下标、item 判为无效的项立即拒绝,不先按声明长度物化整份数组再判(R19-01)。
 * 拒绝前对该数组的工作量不超过调用方实际给出的连续自有下标数 + 1,声明长度很大但下标缺失的稀疏数组在第一个空位就停。
 * 下标全部通过后再查下标以外的自有属性:不能是访问器,其值按 nestedPlainError 走一遍(CH-41)。
 */
const copyArray = (v: unknown, field: string, want: string, item: (x: unknown, i: number) => FieldResult): readonly unknown[] | { reason: string } => {
  if (typeof v !== "object" || v === null) return { reason: `${field} 必须是${want}` };
  if (types.isProxy(v)) return { reason: `${field} 只接受普通数据数组` };
  if (!Array.isArray(v)) return { reason: `${field} 必须是${want}` };
  if (Object.getPrototypeOf(v) !== Array.prototype) return { reason: `${field} 只接受普通数据数组` };
  const len = (Object.getOwnPropertyDescriptor(v, "length") as PropertyDescriptor).value as number;
  const out: unknown[] = [];
  for (let i = 0; i < len; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    if (d !== undefined && !Object.hasOwn(d, "value")) return { reason: `${field} 只接受普通数据数组(${i} 是访问器属性)` };
    const r = item(d === undefined ? undefined : d.value, i);
    if (!r.ok) return { reason: r.reason };
    Object.defineProperty(out, i, dataDesc(r.value, true));
  }
  const bad = plainDataError(v, field, true, true);
  if (bad) return { reason: bad };
  for (const key of Reflect.ownKeys(v)) {
    if (key === "length" || (typeof key === "string" && INDEX.test(key) && Number(key) < len)) continue;
    const extra = nestedPlainError((Object.getOwnPropertyDescriptor(v, key) as PropertyDescriptor).value, `${field}.${String(key)}`);
    if (extra) return { reason: extra };
  }
  return Object.freeze(out);
};

/** 读一个入参数组:必须是普通数据数组,每项都是原始字符串;空位或第一项非字符串当场拒绝。 */
const readList = (v: unknown, field: string): FieldResult => {
  const out = copyArray(v, field, "字符串数组", (x) => (typeof x === "string" ? { ok: true, value: x } : { ok: false, reason: `${field} 里只能是字符串` }));
  return Array.isArray(out) ? { ok: true, value: out } : { ok: false, reason: (out as { reason: string }).reason };
};

/** 读一个对象数组:必须是普通数据数组,每项按 of 规范化成快照;空位或第一个不合 of 的项当场拒绝。 */
const readObjects = (v: unknown, field: string, of: Schema): FieldResult => {
  const out = copyArray(v, field, "对象数组", (x, i) => normalize(x, of, `${field}[${i}]`));
  return Array.isArray(out) ? { ok: true, value: out } : { ok: false, reason: (out as { reason: string }).reason };
};

const SCHEDULE_SCHEMA: Schema = { cron: { kind: "string" }, tz: { kind: "string" }, toleranceSec: { kind: "number" } };

function copyField(v: unknown, field: string, spec: FieldSpec): FieldResult {
  switch (spec.kind) {
    case "string": return typeof v === "string" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是字符串` };
    case "stringOrNull": return v === null || typeof v === "string" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是字符串或 null` };
    case "boolean": return typeof v === "boolean" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是布尔值` };
    case "number": return typeof v === "number" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是数字` };
    case "strings": return readList(v, field);
    case "schedule": return v === null ? { ok: true, value: null } : normalize(v, SCHEDULE_SCHEMA, field);
    case "objects": return readObjects(v, field, Object.hasOwn(spec, "of") ? (spec.of as Schema) : {});
  }
}

/** 把一个入参对象按 schema 规范化成冻结纯数据快照;不合普通数据合同或字段类型不对时给出理由。 */
export function normalize<T>(input: unknown, schema: Schema, what: string): Normalized<T> {
  if (typeof input !== "object" || input === null) return { ok: false, reason: `${what} 必须是对象` };
  if (types.isProxy(input)) return { ok: false, reason: `${what} 只接受普通数据对象` };
  if (Array.isArray(input)) return { ok: false, reason: `${what} 必须是对象` };
  const bad = plainDataError(input, what, false);
  if (bad) return { ok: false, reason: bad };
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(schema)) {
    const spec = schema[key] as FieldSpec;
    const d = Object.getOwnPropertyDescriptor(input, key);
    const raw: unknown = d !== undefined && Object.hasOwn(d, "value") ? d.value : undefined;
    if (raw === undefined && isOptional(spec)) continue;
    const v = copyField(raw, key, spec);
    if (!v.ok) return v;
    Object.defineProperty(out, key, dataDesc(v.value, false));
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === "string" && Object.hasOwn(schema, key)) continue;
    const extra = nestedPlainError((Object.getOwnPropertyDescriptor(input, key) as PropertyDescriptor).value, `${what}.${String(key)}`);
    if (extra) return { ok: false, reason: extra };
  }
  return { ok: true, value: Object.freeze(out) as T };
}
