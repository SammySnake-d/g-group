// 普通数据对象判定(与 PR #3 统一的输入契约):"普通数据对象"即 JSON 可产生的形状。
// 判定顺序:先 types.isProxy → 原型 Object.prototype / null(数组为 Array.prototype)→ 逐层用属性描述符检查,
// 所有自有属性(含数组元素)必须是数据属性;出现 getter/setter 直接拒绝,永不调用。
// 只接受:字符串、有限数字、布尔、null、普通数组(不稀疏、只有下标与 length)、普通对象(可枚举的字符串键)。
// 对象属性值为 undefined 时按 JSON.stringify 的规则当作不存在;数组元素不能是 undefined。
// 中间表与结果都不经过原型链:描述符表放在空原型对象里,结果数组用 pushOwn(defineProperty)追加,
// 传给 defineProperty 的描述符本身也是空原型对象,检查访问器只看描述符的自有 get/set 字段;
// Object.prototype / Array.prototype 上的同名 setter、只读属性或可写值都不会被调用、挡住或借来补洞。
// 内核所有对外入口(插件注册、发送请求与回执、拉取结果、上下文装配、入站分类)都用这一个函数。
// 内核插件契约只接受普通数据对象,不承诺防御任意 JS 元编程对象:遇到就拒绝并点名路径。
import { types } from "node:util";
import { dataDesc, pushOwn } from "./own.ts";

export type PlainResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly path: string; readonly why: string };
export type PlainItems = { readonly ok: true; readonly items: readonly unknown[] } | { readonly ok: false; readonly path: string; readonly why: string };
export interface PlainOptions {
  /** 顶层对象的直接字段可以是函数(插件的 send/pull、装配的 recompress);函数原样保留引用 */
  readonly topFunctions?: boolean;
}

const MAX_DEPTH = 32;
const INDEX = /^(0|[1-9]\d*)$/;
const bad = (path: string, why: string) => ({ ok: false as const, path, why });

/** 是不是访问器:只看描述符自己的 get/set 字段,不看继承来的同名属性 */
const isAccessor = (d: PropertyDescriptor): boolean => Object.hasOwn(d, "get") || Object.hasOwn(d, "set");

/** 自有属性描述符表,放进空原型对象:按键取值不会走到 Object.prototype 上的同名属性 */
function ownDescs(x: object): Record<string, PropertyDescriptor> {
  const table: Record<string, PropertyDescriptor> = Object.create(null);
  for (const k of Reflect.ownKeys(x)) {
    const d = Reflect.getOwnPropertyDescriptor(x, k);
    if (d && typeof k === "string") Object.defineProperty(table, k, dataDesc(d));
  }
  return table;
}

/** 往数组末尾追加自有元素:用 defineProperty,不经过 Array.prototype 上的同名 setter 或只读下标。内核所有结果数组都用它。
 *  公开入口,目标按普通数组合同整体判定(与 plainItems 同一套:非 Proxy、原型 Array.prototype、只有下标与 length、
 *  不稀疏、元素都是可枚举数据属性);不合格时抛受控 TypeError,不调用任何访问器,也不写入。 */
export function appendOwn<T>(out: T[], v: T): void {
  if (!items(out, "appendOwn 的目标").ok) throw new TypeError("appendOwn 的目标必须是普通数组");
  pushOwn(out, v);
}

/** 路径参数也是外部输入:只收字符串(不传按默认值)。typeof 不会触发访问器或 Proxy 陷阱,判定在任何插值之前。 */
const PATH_ARG = "<路径参数>";
const badPath = () => bad(PATH_ARG, "路径参数必须是字符串");

/** 判定选项本身也按普通数据对象判:整个对象逐个看自有属性,只允许数据属性 topFunctions(布尔),
 *  getter/setter(可枚举或不可枚举)、其它键、Symbol 键、非普通对象都判非法(返回 undefined),访问器不调用 */
function topFunctionsOf(opts: unknown): boolean | undefined {
  if (opts === undefined) return false;
  if (typeof opts !== "object" || opts === null || types.isProxy(opts)) return undefined;
  const proto = Object.getPrototypeOf(opts);
  if (proto !== Object.prototype && proto !== null) return undefined;
  let value: unknown;
  for (const k of Reflect.ownKeys(opts)) {
    const d = Reflect.getOwnPropertyDescriptor(opts, k);
    if (!d || isAccessor(d) || k !== "topFunctions") return undefined;
    value = d.value;
  }
  if (value === undefined) return false;
  if (typeof value !== "boolean") return undefined;
  return value;
}

/** 判定并克隆:通过时返回递归冻结的纯数据副本(对象原型为 null),之后只读这份副本。自身不抛错。 */
export function plainData(x: unknown, at: string = "输入", opts?: PlainOptions): PlainResult {
  if (typeof at !== "string") return badPath();
  try {
    const fns = topFunctionsOf(opts);
    if (fns === undefined) return bad(at, "判定选项只接受普通数据对象,只能有布尔数据属性 topFunctions");
    return walk(x, at, 0, fns);
  } catch (err) {
    return bad(at, `检查时出错:${describeThrown(err)}`);
  }
}

/** 只判定数组容器本身(Proxy、原型、只有下标与 length、不稀疏、元素是数据属性),返回元素原值,不读下标。自身不抛错。 */
export function plainItems(x: unknown, at: string = "输入"): PlainItems {
  if (typeof at !== "string") return badPath();
  try { return items(x, at); } catch (err) {
    return bad(at, `检查时出错:${describeThrown(err)}`);
  }
}

function walk(x: unknown, at: string, depth: number, fns: boolean): PlainResult {
  if (depth > MAX_DEPTH) return bad(at, "嵌套过深");
  if (x === null || typeof x === "string" || typeof x === "boolean") return { ok: true, value: x };
  if (typeof x === "number") return Number.isFinite(x) ? { ok: true, value: x } : bad(at, "数字必须有限");
  if (typeof x !== "object") return bad(at, `不支持 ${typeof x}`);
  if (types.isProxy(x)) return bad(at, "不允许 Proxy");
  if (Array.isArray(x)) {
    const r = items(x, at);
    if (!r.ok) return r;
    const out: unknown[] = [];
    for (let i = 0; i < r.items.length; i++) {
      const c = child(Object.getOwnPropertyDescriptor(r.items, i)?.value, `${at}[${i}]`, depth, false);
      if (!c.ok) return c;
      pushOwn(out, c.value);
    }
    return { ok: true, value: Object.freeze(out) };
  }
  const proto = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) {
    return bad(at, "只允许普通对象,原型必须是 Object.prototype 或 null;Map/Set/Date/类实例(含私有字段 #x)与继承原型的对象都带快照不到的内部状态");
  }
  for (const k of Reflect.ownKeys(x)) if (typeof k === "symbol") return bad(`${at}[${String(k.description ?? "symbol")}]`, "不允许 Symbol 键");
  const descs = ownDescs(x);
  const out: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(descs)) {
    const d = descs[k] as PropertyDescriptor;
    if (isAccessor(d)) return bad(`${at}.${k}`, "不允许 getter/setter");
    if (!d.enumerable) return bad(`${at}.${k}`, "不允许不可枚举属性");
    if (d.value === undefined) continue;
    const c = child(d.value, `${at}.${k}`, depth, fns && depth === 0);
    if (!c.ok) return c;
    Object.defineProperty(out, k, dataDesc(c.value));
  }
  return { ok: true, value: Object.freeze(out) };
}

function child(v: unknown, path: string, depth: number, fnsHere: boolean): PlainResult {
  if (typeof v === "function") {
    if (!fnsHere) return bad(path, "只有顶层字段可以是函数");
    return types.isProxy(v) ? bad(path, "不允许 Proxy") : { ok: true, value: v };
  }
  return walk(v, path, depth + 1, false);
}

function items(x: unknown, at: string): PlainItems {
  if (typeof x !== "object" || x === null) return bad(at, "必须是普通数组");
  if (types.isProxy(x)) return bad(at, "不允许 Proxy");
  if (!Array.isArray(x)) return bad(at, "必须是普通数组");
  if (Object.getPrototypeOf(x) !== Array.prototype) return bad(at, "数组原型必须是 Array.prototype");
  for (const k of Reflect.ownKeys(x)) if (typeof k === "symbol") return bad(`${at}[${String(k.description ?? "symbol")}]`, "不允许 Symbol 键");
  const descs = ownDescs(x);
  const lenDesc = descs.length as PropertyDescriptor;
  const len = lenDesc.value as number;
  // 每个自有键都按「真数组索引 + 落在当前 length 内」校验(R11-02)。
  // INDEX 只挡前导零、符号与非数字文本,2^32-1(2^32-1 不是数组索引)与 9007199254740992 这类十进制数字名
  // 照样通过它;它们不改变 length,后面的 0..length-1 循环又不会查它们的描述符,于是挂在它们上面的访问器
  // 会被静默净化成 ok:true/[]。真数组索引最大是 2^32-2,而 length 最大是 2^32-1,所以「索引 < length」
  // 一条就把非索引数字名与超界下标一起挡掉,不需要另列上界常数。length 本身在真实数组上必然是
  // 自有的非访问器数据属性(JS 引擎强制),这里只读它的值。
  for (const k of Object.keys(descs)) {
    if (k === "length") continue;
    if (!INDEX.test(k) || Number(k) >= len) return bad(`${at}[${k}]`, "数组只能有下标元素");
  }
  const out: unknown[] = [];
  for (let i = 0; i < len; i++) {
    const d = descs[String(i)];
    if (!d) return bad(`${at}[${i}]`, "不允许稀疏数组");
    if (isAccessor(d)) return bad(`${at}[${i}]`, "不允许 getter/setter");
    if (!d.enumerable) return bad(`${at}[${i}]`, "不允许不可枚举属性");
    pushOwn(out, d.value);
  }
  return { ok: true, items: out };
}

/** 诊断型入口(与 plainData 的"拒绝"合同不同,这里给安全占位):任何值都能得到一段诊断文字,自己绝不抛错,也绝不执行被描述对象的代码:
 *  不调用 getter/setter、toJSON、toString,不走原型链;只读自有数据属性。
 *  访问器记作 "[getter/setter]",函数记作 "<函数>",Proxy 记作 "<Proxy>",循环记作 "[循环]",BigInt 记作 "1n"。 */
export function safeDescribe(x: unknown): string {
  try {
    if (typeof x === "string") return x;
    if (typeof x === "bigint") return `${x}n`;
    if (typeof x === "symbol" || x === undefined) return String(x);
    return render(x, new WeakSet<object>(), 0);
  } catch {
    return "<无法描述>";
  }
}

function render(v: unknown, seen: WeakSet<object>, depth: number): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "bigint") return JSON.stringify(`${v}n`);
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "symbol") return JSON.stringify(String(v));
  if (typeof v === "function") return JSON.stringify("<函数>");
  if (types.isProxy(v)) return JSON.stringify("<Proxy>");
  if (seen.has(v)) return JSON.stringify("[循环]");
  if (depth > MAX_DEPTH) return JSON.stringify("[过深]");
  seen.add(v);
  const descs = ownDescs(v);
  const field = (d: PropertyDescriptor | undefined) => (d === undefined ? "null" : isAccessor(d) ? JSON.stringify("[getter/setter]") : render(d.value, seen, depth + 1));
  if (Array.isArray(v)) {
    const lenDesc = descs.length;
    const len = lenDesc && !isAccessor(lenDesc) && typeof lenDesc.value === "number" ? lenDesc.value : 0;
    const parts: string[] = [];
    for (let i = 0; i < len && i < 1000; i++) pushOwn(parts, field(descs[String(i)]));
    return `[${parts.join(",")}]`;
  }
  const parts: string[] = [];
  for (const k of Object.keys(descs)) {
    const d = descs[k] as PropertyDescriptor;
    if (!d.enumerable) continue;
    pushOwn(parts, `${JSON.stringify(k)}:${field(d)}`);
  }
  return `{${parts.join(",")}}`;
}

/** 抛出的东西来自外部:原生异常只读自有数据属性 message(不调 getter、不走 instanceof),其余按 safeDescribe 描述 */
export function describeThrown(err: unknown): string {
  try {
    if (typeof err === "object" && err !== null && !types.isProxy(err) && types.isNativeError(err)) {
      const d = Reflect.getOwnPropertyDescriptor(err, "message");
      if (d && !isAccessor(d) && typeof d.value === "string") return d.value;
    }
  } catch { /* 读取失败,退回整体描述 */ }
  return safeDescribe(err);
}
