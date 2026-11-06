// biome-ignore-all lint/correctness/noUnusedVariables lint/correctness/noUnusedFunctionParameters lint/correctness/noUnusedImports lint/correctness/noUnusedPrivateClassMembers: 红提交空壳,绿提交恢复实现
import { types } from "node:util";

// 领域层内部模块:普通数据对象合同的规范化工具。只供 contact.ts、helper.ts 内部使用,
// 包入口(src/index.ts,package.json exports 只有 ".")不导出本模块,schema 参数只来自本包源码里的常量,不是公开入口的参数(CH-36)。

// ---------------------------------------------------------------- 入参规范化(普通数据对象合同)
// 领域层所有公开入口(联系人与 Helper)的对象参数都先经 normalize,包括调用方传回来的状态(Contact、Directory)。合同:只接受 JSON 能产生的普通数据对象,依次检查——
//   1. 不是 Proxy(node:util types.isProxy);
//   2. 对象原型为 Object.prototype 或 null,数组为原型 Array.prototype 的真数组;
//   3. 用 Reflect.ownKeys 逐个取全部自有属性(含不可枚举、Symbol 键)的描述符,描述符自己没有 value 就是访问器,直接拒绝,getter 永不调用。
// 只认自有属性:描述符的 value、schema 的 optional/of 标记都用 Object.hasOwn 判定,不读原型链。
// 通过后只从数据属性取值,读到立即复制成冻结纯数据;数组按 length 逐个下标取值,不走迭代器,空位或类型不对的项拒绝。
// 快照是空原型(Object.create(null))对象,字段与数组项用 defineProperty 写入,属性描述符本身也是空原型对象,
// 不会从 Object.prototype 继承 get/set/value 等字段,也不经过原型链上的同名 setter 或不可写属性。
// 之后的校验、判断、错误理由和存储/输出只用这份快照;输出的联系人只按声明字段重新构造,状态里多出来的字段(如旧版本的 focus)不会带出。
// schema 没声明的字段丢掉;可选字段只有缺省或 undefined 算缺省,显式 null 按类型不对拒绝。本层不承诺防御任意 JS 元编程对象。
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

/** 普通数据检查(调用前已排除 Proxy):返回 null 表示通过,否则返回拒绝理由。不调用任何 getter。 */
export function plainDataError(v: object, what: string, wantArray: boolean): string | null {
  throw new Error("未实现");
}

/** 复制一个普通数据数组:按 length 逐个下标取自有数据属性复制成本地数组,不走迭代器;空位取成 undefined,交给调用方按项类型拒绝。 */
const copyArray = (v: unknown, field: string, want: string): unknown[] | { reason: string } => {
  if (typeof v !== "object" || v === null) return { reason: `${field} 必须是${want}` };
  if (types.isProxy(v)) return { reason: `${field} 只接受普通数据数组` };
  if (!Array.isArray(v)) return { reason: `${field} 必须是${want}` };
  const bad = plainDataError(v, field, true);
  if (bad) return { reason: bad };
  const len = (Object.getOwnPropertyDescriptor(v, "length") as PropertyDescriptor).value as number;
  const out: unknown[] = [];
  for (let i = 0; i < len; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    Object.defineProperty(out, i, dataDesc(d !== undefined && Object.hasOwn(d, "value") ? d.value : undefined, true));
  }
  return out;
};

/** 读一个入参数组:必须是普通数据数组,每项都是原始字符串。 */
const readList = (v: unknown, field: string): string[] | { reason: string } => {
  const out = copyArray(v, field, "字符串数组");
  if (!Array.isArray(out)) return out;
  return out.every((x) => typeof x === "string") ? (out as string[]) : { reason: `${field} 里只能是字符串` };
};

/** 读一个对象数组:必须是普通数据数组,每项按 of 规范化成快照。 */
const readObjects = (v: unknown, field: string, of: Schema): FieldResult => {
  const arr = copyArray(v, field, "对象数组");
  if (!Array.isArray(arr)) return { ok: false, reason: arr.reason };
  const out: unknown[] = [];
  for (let i = 0; i < arr.length; i++) {
    const n = normalize(arr[i], of, `${field}[${i}]`);
    if (!n.ok) return n;
    Object.defineProperty(out, i, dataDesc(n.value, true));
  }
  return { ok: true, value: Object.freeze(out) };
};

const SCHEDULE_SCHEMA: Schema = { cron: { kind: "string" }, tz: { kind: "string" }, toleranceSec: { kind: "number" } };

function copyField(v: unknown, field: string, spec: FieldSpec): FieldResult {
  switch (spec.kind) {
    case "string": return typeof v === "string" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是字符串` };
    case "stringOrNull": return v === null || typeof v === "string" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是字符串或 null` };
    case "boolean": return typeof v === "boolean" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是布尔值` };
    case "number": return typeof v === "number" ? { ok: true, value: v } : { ok: false, reason: `${field} 必须是数字` };
    case "strings": { const l = readList(v, field); return Array.isArray(l) ? { ok: true, value: Object.freeze(l) } : { ok: false, reason: l.reason }; }
    case "schedule": return v === null ? { ok: true, value: null } : normalize(v, SCHEDULE_SCHEMA, field);
    case "objects": return readObjects(v, field, Object.hasOwn(spec, "of") ? (spec.of as Schema) : {});
  }
}

/** 把一个入参对象按 schema 规范化成冻结纯数据快照;不合普通数据合同或字段类型不对时给出理由。 */
export function normalize<T>(input: unknown, schema: Schema, what: string): Normalized<T> {
  throw new Error("未实现");
}
