// 极小的运行时校验组合子:同一份定义既推出 TypeScript 类型(Infer),又在边界上校验未知输入。
// 不依赖第三方库,渲染进程、preload、主进程三处都能直接引用。
// 只接受「普通 JSON 数据」:数组用 Array.isArray,对象要求原型是 Object.prototype 或 null,不读取 getter(只看自有数据属性)。

export type Issue = { readonly path: string; readonly message: string };
export type Check<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly Issue[] };

export interface Schema<T> {
  readonly kind: string;
  /** 校验并返回一份只含声明字段的新值;未声明的对象字段被丢弃,不回传调用方原对象。 */
  check(input: unknown, path?: string): Check<T>;
}
export type Infer<S> = S extends Schema<infer T> ? T : never;

const ok = <T>(value: T): Check<T> => ({ ok: true, value });
const bad = (path: string, message: string): Check<never> => ({ ok: false, issues: [{ path: path || "$", message }] });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
function ownData(o: Record<string, unknown>, key: string): { has: boolean; value: unknown } {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (!d) return { has: false, value: undefined };
  if (!("value" in d)) return { has: true, value: Symbol.for("gg.accessor") };
  return { has: true, value: d.value };
}
const ACCESSOR = Symbol.for("gg.accessor");

export const str = (opts: { min?: number; max?: number; pattern?: RegExp } = {}): Schema<string> => ({
  kind: "string",
  check(v, path = "") {
    if (typeof v !== "string") return bad(path, "应为字符串");
    if (opts.min !== undefined && v.length < opts.min) return bad(path, `长度至少 ${opts.min}`);
    if (opts.max !== undefined && v.length > opts.max) return bad(path, `长度至多 ${opts.max}`);
    if (opts.pattern && !opts.pattern.test(v)) return bad(path, `格式不符 ${opts.pattern.source}`);
    return ok(v);
  },
});
/** 非空标识符:1–200 字符,不含控制字符。 */
export const id = (): Schema<string> => {
  const base = str({ min: 1, max: 200 });
  return {
    kind: "id",
    check(v, path = "") {
      const r = base.check(v, path);
      if (!r.ok) return r;
      for (let i = 0; i < r.value.length; i++) {
        const c = r.value.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return bad(path, "不能含控制字符");
      }
      return r;
    },
  };
};
/** ISO-8601 时间串(带时区)。 */
export const isoTime = (): Schema<string> => str({ pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/ });

export const int = (opts: { min?: number; max?: number } = {}): Schema<number> => ({
  kind: "int",
  check(v, path = "") {
    if (typeof v !== "number" || !Number.isSafeInteger(v)) return bad(path, "应为安全整数");
    if (opts.min !== undefined && v < opts.min) return bad(path, `应 ≥ ${opts.min}`);
    if (opts.max !== undefined && v > opts.max) return bad(path, `应 ≤ ${opts.max}`);
    return ok(v);
  },
});
/** 会话记录序号:非负安全整数。 */
export const seq = (): Schema<number> => int({ min: 0 });

export const num = (): Schema<number> => ({
  kind: "number",
  check(v, path = "") {
    return typeof v === "number" && Number.isFinite(v) ? ok(v) : bad(path, "应为有限数字");
  },
});
export const bool = (): Schema<boolean> => ({
  kind: "boolean",
  check(v, path = "") {
    return typeof v === "boolean" ? ok(v) : bad(path, "应为布尔值");
  },
});
export const lit = <const L extends string | number | boolean>(value: L): Schema<L> => ({
  kind: "literal",
  check(v, path = "") {
    return v === value ? ok(value) : bad(path, `应为 ${JSON.stringify(value)}`);
  },
});
export const oneOf = <const L extends readonly string[]>(values: L): Schema<L[number]> => ({
  kind: "enum",
  check(v, path = "") {
    return typeof v === "string" && (values as readonly string[]).includes(v) ? ok(v as L[number]) : bad(path, `应为 ${values.join(" | ")} 之一`);
  },
});
export const nullable = <T>(s: Schema<T>): Schema<T | null> => ({
  kind: `nullable<${s.kind}>`,
  check(v, path = "") {
    return v === null ? ok(null) : s.check(v, path);
  },
});
export const arr = <T>(s: Schema<T>, opts: { max?: number } = {}): Schema<T[]> => ({
  kind: `array<${s.kind}>`,
  check(v, path = "") {
    if (!Array.isArray(v)) return bad(path, "应为数组");
    if (opts.max !== undefined && v.length > opts.max) return bad(path, `元素至多 ${opts.max} 个`);
    const out: T[] = [];
    const issues: Issue[] = [];
    for (let i = 0; i < v.length; i++) {
      const d = Object.getOwnPropertyDescriptor(v, i);
      if (!d || !("value" in d)) {
        issues.push({ path: `${path}[${i}]`, message: "缺元素或为访问器" });
        continue;
      }
      const r = s.check(d.value, `${path}[${i}]`);
      if (r.ok) out.push(r.value);
      else issues.push(...r.issues);
    }
    return issues.length ? { ok: false, issues } : ok(out);
  },
});

/** 可选字段标记:对象里可以不出现;出现时必须合法(undefined 视为不出现)。 */
export interface Optional<T> {
  readonly optional: true;
  readonly inner: Schema<T>;
}
export const opt = <T>(s: Schema<T>): Optional<T> => ({ optional: true, inner: s });

type Field = Schema<unknown> | Optional<unknown>;
type Shape = Record<string, Field>;
type ReqKeys<S extends Shape> = { [K in keyof S]: S[K] extends Optional<unknown> ? never : K }[keyof S];
type OptKeys<S extends Shape> = { [K in keyof S]: S[K] extends Optional<unknown> ? K : never }[keyof S];
type FieldType<F> = F extends Optional<infer T> ? T : F extends Schema<infer T> ? T : never;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type ObjectOf<S extends Shape> = Simplify<{ [K in ReqKeys<S>]: FieldType<S[K]> } & { [K in OptKeys<S>]?: FieldType<S[K]> }>;

const isOptional = (f: Field): f is Optional<unknown> => "optional" in f && f.optional === true;

export interface ObjectSchema<S extends Shape> extends Schema<ObjectOf<S>> {
  readonly shape: S;
}
export const obj = <S extends Shape>(shape: S): ObjectSchema<S> => ({
  kind: "object",
  shape,
  check(v, path = "") {
    if (!isPlainObject(v)) return bad(path, "应为普通对象");
    const out: Record<string, unknown> = {};
    const issues: Issue[] = [];
    for (const [key, field] of Object.entries(shape)) {
      const p = path ? `${path}.${key}` : key;
      const { has, value } = ownData(v, key);
      if (value === ACCESSOR) {
        issues.push({ path: p, message: "字段不能是访问器" });
        continue;
      }
      if (!has || value === undefined) {
        if (!isOptional(field)) issues.push({ path: p, message: "缺少必填字段" });
        continue;
      }
      const r = (isOptional(field) ? field.inner : field).check(value, p);
      if (r.ok) out[key] = r.value;
      else issues.push(...r.issues);
    }
    return issues.length ? { ok: false, issues } : ok(out as ObjectOf<S>);
  },
});

/** 按判别字段分派的联合。tag 字段值必须是字面量。 */
export const tagged = <K extends string, const M extends Record<string, ObjectSchema<Shape>>>(
  tag: K,
  variants: M,
): Schema<{ [V in keyof M]: Infer<M[V]> }[keyof M]> => ({
  kind: `tagged<${tag}>`,
  check(v, path = "") {
    if (!isPlainObject(v)) return bad(path, "应为普通对象");
    const { value } = ownData(v, tag);
    if (typeof value !== "string" || !Object.hasOwn(variants, value)) {
      return bad(path ? `${path}.${tag}` : tag, `应为 ${Object.keys(variants).join(" | ")} 之一`);
    }
    return variants[value]!.check(v, path) as Check<{ [V in keyof M]: Infer<M[V]> }[keyof M]>;
  },
});

/** 任意 JSON 值(插件配置等由插件自己校验的负载)。深度与大小有界,拒绝非普通对象。 */
export const json = (opts: { maxDepth?: number } = {}): Schema<unknown> => ({
  kind: "json",
  check(v, path = "") {
    const maxDepth = opts.maxDepth ?? 32;
    const walk = (x: unknown, depth: number, p: string): Issue | null => {
      if (depth > maxDepth) return { path: p || "$", message: `嵌套超过 ${maxDepth} 层` };
      if (x === null || typeof x === "string" || typeof x === "boolean") return null;
      if (typeof x === "number") return Number.isFinite(x) ? null : { path: p || "$", message: "数字必须有限" };
      if (Array.isArray(x)) {
        for (let i = 0; i < x.length; i++) {
          const e = walk(x[i], depth + 1, `${p}[${i}]`);
          if (e) return e;
        }
        return null;
      }
      if (isPlainObject(x)) {
        for (const k of Object.keys(x)) {
          const { value } = ownData(x, k);
          if (value === ACCESSOR) return { path: `${p}.${k}`, message: "字段不能是访问器" };
          const e = walk(value, depth + 1, p ? `${p}.${k}` : k);
          if (e) return e;
        }
        return null;
      }
      return { path: p || "$", message: "不是 JSON 值" };
    };
    const e = walk(v, 0, path);
    return e ? { ok: false, issues: [e] } : ok(structuredClone(v));
  },
});
