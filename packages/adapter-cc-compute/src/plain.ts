// 纯数据输入合同(R4-01,与内核 plain.ts 同一判定顺序;g-group#2662:只保证内置原型未被改的环境):
// 先 types.isProxy → 原型必须是 Object.prototype / null(数组为 Array.prototype)→ 逐个看自有属性描述符,
// 所有自有属性(含数组元素)必须是可枚举的数据属性;getter/setter(含不可枚举的)、Symbol 键、函数、非有限数字一律拒绝。
// 判定过程只读描述符,从不读属性值本身:访问器与 Proxy 陷阱调用次数为 0。通过后返回递归冻结的副本,之后只读副本。
// 对象属性值为 undefined 时按 JSON.stringify 的规则当作不存在;数组不能稀疏、不能有下标以外的键、元素不能是 undefined。
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
  const out: unknown[] | Record<string, unknown> = isArray ? [] : Object.create(null);
  let count = 0;
  let length = 0;
  for (const k of Reflect.ownKeys(x)) {
    if (typeof k === "symbol") return bad(at, "不允许 Symbol 键");
    const path = isArray ? `${at}[${k}]` : `${at}.${k}`;
    const d = Reflect.getOwnPropertyDescriptor(x, k);
    if (!d) return bad(path, "属性在检查时消失");
    if (isAccessor(d)) return bad(path, "不允许 getter/setter");
    if (isArray && k === "length") { length = d.value as number; continue; }
    if (isArray && !INDEX.test(k)) return bad(path, "数组只能有下标元素");
    if (!d.enumerable) return bad(path, "不允许不可枚举属性");
    if (d.value === undefined) {
      if (isArray) return bad(path, "数组元素不能是 undefined");
      continue;
    }
    const c = walk(d.value, path, depth + 1);
    if (!c.ok) return c;
    if (isArray) (out as unknown[])[Number(k)] = c.value;
    else (out as Record<string, unknown>)[k] = c.value;
    count++;
  }
  if (isArray && count !== length) return bad(at, "不允许稀疏数组");
  return { ok: true, value: Object.freeze(out) };
}

/** 纯数据副本是不是普通对象(不是数组) */
export const isPlainRecord = (x: unknown): x is Readonly<Record<string, unknown>> => typeof x === "object" && x !== null && !Array.isArray(x);
