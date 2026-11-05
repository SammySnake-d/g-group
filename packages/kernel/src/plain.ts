// 普通数据对象判定(与 PR #3 统一的输入契约):"普通数据对象"即 JSON 可产生的形状。
// 判定顺序:先 types.isProxy → 原型 Object.prototype / null(数组为 Array.prototype)→ 逐层用属性描述符检查,
// 所有自有属性(含数组元素)必须是数据属性;出现 getter/setter 直接拒绝,永不调用。
// 只接受:字符串、有限数字、布尔、null、普通数组(不稀疏、只有下标与 length)、普通对象(可枚举的字符串键)。
// 对象属性值为 undefined 时按 JSON.stringify 的规则当作不存在;数组元素不能是 undefined。
// 中间表与结果都不经过原型链:描述符表放在空原型对象里,结果数组用 defineProperty 追加,
// 原型上的同名 setter、只读下标或可写值都不会被调用、挡住或借来补洞。
// 内核所有对外入口(插件注册、发送请求与回执、拉取结果、上下文装配、入站分类)都用这一个函数。
// 内核插件契约只接受普通数据对象,不承诺防御任意 JS 元编程对象:遇到就拒绝并点名路径。
import { types } from "node:util";

export type PlainResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly path: string; readonly why: string };
export type PlainItems = { readonly ok: true; readonly items: readonly unknown[] } | { readonly ok: false; readonly path: string; readonly why: string };
export interface PlainOptions {
  /** 顶层对象的直接字段可以是函数(插件的 send/pull、装配的 recompress);函数原样保留引用 */
  readonly topFunctions?: boolean;
}

const MAX_DEPTH = 32;
const INDEX = /^(0|[1-9]\d*)$/;
const bad = (path: string, why: string) => ({ ok: false as const, path, why });

/** 自有属性描述符表,放进空原型对象:按键取值不会走到 Object.prototype 上的同名属性 */
function ownDescs(x: object): Record<string, PropertyDescriptor> {
  const table: Record<string, PropertyDescriptor> = Object.create(null);
  for (const k of Reflect.ownKeys(x)) {
    const d = Reflect.getOwnPropertyDescriptor(x, k);
    if (d && typeof k === "string") Object.defineProperty(table, k, { value: d, enumerable: true });
  }
  return table;
}

/** 往结果数组追加元素:用 defineProperty 定义自有属性,不经过 Array.prototype 上的同名 setter 或只读下标 */
function put(out: unknown[], v: unknown): void {
  Object.defineProperty(out, out.length, { value: v, writable: true, enumerable: true, configurable: true });
}

/** 判定并克隆:通过时返回递归冻结的纯数据副本(对象原型为 null),之后只读这份副本。自身不抛错。 */
export function plainData(x: unknown, at = "输入", opts: PlainOptions = {}): PlainResult {
  try { return walk(x, at, 0, opts.topFunctions === true); } catch (err) {
    return bad(at, `检查时出错:${describeThrown(err)}`);
  }
}

/** 只判定数组容器本身(Proxy、原型、只有下标与 length、不稀疏、元素是数据属性),返回元素原值,不读下标。自身不抛错。 */
export function plainItems(x: unknown, at = "输入"): PlainItems {
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
      put(out, c.value);
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
    if ("get" in d || "set" in d) return bad(`${at}.${k}`, "不允许 getter/setter");
    if (!d.enumerable) return bad(`${at}.${k}`, "不允许不可枚举属性");
    if (d.value === undefined) continue;
    const c = child(d.value, `${at}.${k}`, depth, fns && depth === 0);
    if (!c.ok) return c;
    Object.defineProperty(out, k, { value: c.value, writable: true, enumerable: true, configurable: true });
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
  for (const k of Object.keys(descs)) if (k !== "length" && !INDEX.test(k)) return bad(`${at}[${k}]`, "数组只能有下标元素");
  const len = (descs.length as PropertyDescriptor).value as number;
  const out: unknown[] = [];
  for (let i = 0; i < len; i++) {
    const d = descs[String(i)];
    if (!d) return bad(`${at}[${i}]`, "不允许稀疏数组");
    if ("get" in d || "set" in d) return bad(`${at}[${i}]`, "不允许 getter/setter");
    if (!d.enumerable) return bad(`${at}[${i}]`, "不允许不可枚举属性");
    put(out, d.value);
  }
  return { ok: true, items: out };
}

/** 任何值都能得到一段诊断文字,自己绝不抛错(循环对象、BigInt、toJSON 抛错、Symbol……)。 */
export function safeDescribe(x: unknown): string {
  try {
    if (typeof x === "string") return x;
    if (typeof x === "bigint") return `${x}n`;
    if (typeof x === "symbol" || typeof x === "function" || x === undefined) return String(x);
    const seen = new WeakSet<object>();
    const s = JSON.stringify(x, (_k, v: unknown) => {
      if (typeof v === "bigint") return `${v}n`;
      if (typeof v === "object" && v !== null) { if (seen.has(v)) return "[循环]"; seen.add(v); }
      return v;
    });
    return s ?? String(x);
  } catch (err) {
    let tag = "unknown";
    try { tag = Object.prototype.toString.call(x); } catch { /* 保持 unknown */ }
    let why = "";
    try { why = err instanceof Error ? err.message : String(err); } catch { /* 异常本身也不可读 */ }
    return `<无法序列化 ${tag}${why ? `: ${why}` : ""}>`;
  }
}

/** 抛出的东西可能带恶意 getter:instanceof 和 message 的读取也不能逃出异常 */
export function describeThrown(err: unknown): string {
  try {
    if (err instanceof Error) return safeDescribe(err.message);
  } catch { /* 读取失败,退回整体描述 */ }
  return safeDescribe(err);
}
