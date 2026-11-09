// 纯数据输入合同(R4-01,与内核 plain.ts 同一判定顺序;g-group#2662:只保证内置原型未被改的环境):
// 先 types.isProxy → 原型必须是 Object.prototype / null(数组为 Array.prototype)→ 逐个看自有属性描述符,
// 所有自有属性(含数组元素)必须是可枚举的数据属性;getter/setter(含不可枚举的)、Symbol 键、函数、非有限数字一律拒绝。
// 判定过程只读描述符,从不读属性值本身:访问器与 Proxy 陷阱调用次数为 0。通过后返回递归冻结的副本,之后只读副本。
// 对象属性值为 undefined 时照样作为自有键保留在副本里(R5-01):字段存在与否以自有描述符为准,值为 undefined 不能绕过
// 调用方的字段白名单;声明过的可选字段为 undefined 怎么处理由各入口自己决定(本包一律按没给处理)。
// 数组不能稀疏、不能有下标以外的键、元素不能是 undefined(R8-01):先逐键核对,每个自有键只能是 length 或 0..length-1 内的
// 规范十进制下标(4294967295 这类越界数字键与 01、-1 一律拒收);再按 0..length-1 逐个取描述符,缺任何一个下标都按空位拒收。
// 键核对全部通过之前不读任何元素值。
// 本文件只依赖 node 内置模块:report_progress MCP 服务器进程经 report-schema.ts 直接 import。
import { types } from "node:util";

export type PlainResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly path: string; readonly why: string };

const MAX_DEPTH = 32;
const INDEX = /^(0|[1-9]\d*)$/;
const bad = (path: string, why: string): PlainResult => ({ ok: false, path, why });
/** 是不是访问器:只看描述符自己的 get/set 字段 */
const isAccessor = (d: PropertyDescriptor): boolean => Object.hasOwn(d, "get") || Object.hasOwn(d, "set");

/** 判定并克隆。自身不抛错:任何意外都按拒绝返回 */
export function plainData(x: unknown, at: string): PlainResult {
  try {
    return walk(x, at, 0);
  } catch {
    return bad(at, "检查时出错");
  }
}

function walk(x: unknown, at: string, depth: number): PlainResult {
  if (depth > MAX_DEPTH) return bad(at, "嵌套过深或有循环引用");
  if (x === null || typeof x === "string" || typeof x === "boolean") return { ok: true, value: x };
  if (typeof x === "number") return Number.isFinite(x) ? { ok: true, value: x } : bad(at, "数字必须有限");
  if (typeof x !== "object") return bad(at, `不支持 ${typeof x}`);
  if (types.isProxy(x)) return bad(at, "不允许 Proxy");
  const isArray = Array.isArray(x);
  const proto = Object.getPrototypeOf(x);
  if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
    return bad(at, isArray ? "数组原型必须是 Array.prototype" : "只允许普通对象,原型必须是 Object.prototype 或 null");
  }
  return isArray ? walkArray(x as unknown[], at, depth) : walkRecord(x, at, depth);
}

/** 判定一个属性描述符(数组元素或对象属性)并递归克隆它的值 */
function walkValue(d: PropertyDescriptor | undefined, path: string, depth: number, inArray: boolean): PlainResult {
  if (!d) return bad(path, "属性在检查时消失");
  if (isAccessor(d)) return bad(path, "不允许 getter/setter");
  if (!d.enumerable) return bad(path, "不允许不可枚举属性");
  if (d.value === undefined) return inArray ? bad(path, "数组元素不能是 undefined") : { ok: true, value: undefined };
  return walk(d.value, path, depth + 1);
}

function walkRecord(x: object, at: string, depth: number): PlainResult {
  const out: Record<string, unknown> = Object.create(null);
  for (const k of Reflect.ownKeys(x)) {
    if (typeof k === "symbol") return bad(at, "不允许 Symbol 键");
    const c = walkValue(Reflect.getOwnPropertyDescriptor(x, k), `${at}.${k}`, depth, false);
    if (!c.ok) return c;
    out[k] = c.value;
  }
  return { ok: true, value: Object.freeze(out) };
}

function walkArray(x: unknown[], at: string, depth: number): PlainResult {
  const ld = Reflect.getOwnPropertyDescriptor(x, "length");
  if (!ld || isAccessor(ld) || typeof ld.value !== "number") return bad(at, "数组 length 不可用");
  const length = ld.value;
  // 第一步只看键、不读值:每个自有键必须是 length 或 0..length-1 内的规范下标
  for (const k of Reflect.ownKeys(x)) {
    if (typeof k === "symbol") return bad(at, "不允许 Symbol 键");
    if (k === "length") continue;
    if (!INDEX.test(k) || Number(k) >= length) return bad(`${at}[${k}]`, "数组只能有 0..length-1 的下标元素");
  }
  // 第二步按下标逐个取描述符:0..length-1 每一个都必须存在,遇到第一个空位就拒收(不会为大 length 的空数组空转)
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const path = `${at}[${i}]`;
    const d = Reflect.getOwnPropertyDescriptor(x, String(i));
    if (!d) return bad(path, "不允许稀疏数组");
    const c = walkValue(d, path, depth, true);
    if (!c.ok) return c;
    out.push(c.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

/** 纯数据副本是不是普通对象(不是数组) */
export const isPlainRecord = (x: unknown): x is Readonly<Record<string, unknown>> => typeof x === "object" && x !== null && !Array.isArray(x);

/** 递归冻结本包自己构造的值(对外事件、返回值),原地冻结后返回同一个对象。只用于本包新建的纯数据,不用于外部输入 */
export function freezeDeep<T>(x: T): T {
  if (typeof x === "object" && x !== null) {
    for (const v of Object.values(x)) freezeDeep(v);
    Object.freeze(x);
  }
  return x;
}
