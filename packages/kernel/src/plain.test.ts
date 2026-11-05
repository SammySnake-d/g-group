// 统一的普通数据对象判定(与 PR #3 同一契约):先 isProxy → 原型 → 逐层属性描述符,getter/setter 拒绝且永不调用。
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeThrown, plainData, plainItems, safeDescribe } from "./plain.ts";

function getterOn<T extends object>(o: T, key: string, counter: { n: number }): T {
  Object.defineProperty(o, key, { enumerable: true, configurable: true, get() { counter.n++; return "x"; } });
  return o;
}

test("JSON 可产生的形状判定通过,返回冻结副本,对象原型为 null,undefined 属性按 JSON 规则去掉", () => {
  const src = { a: 1, b: "s", c: true, d: null, e: [1, { f: "g" }], h: undefined };
  const r = plainData(src);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const v = r.value as Record<string, unknown> & { e: [number, Record<string, unknown>] };
  assert.deepEqual(JSON.parse(JSON.stringify(v)), { a: 1, b: "s", c: true, d: null, e: [1, { f: "g" }] });
  assert.equal("h" in v, false);
  assert.equal(Object.getPrototypeOf(v), null);
  assert.equal(Object.getPrototypeOf(v.e[1]), null);
  assert.equal(Object.isFrozen(v) && Object.isFrozen(v.e) && Object.isFrozen(v.e[1]), true);
  src.e.push(3);
  assert.equal(v.e.length, 2, "副本和原对象不共享");
});

test("判定顺序:Proxy 先于原型检查,原型先于描述符检查,三者都点名原因", () => {
  const p = plainData(new Proxy({ a: 1 }, {}), "x");
  assert.deepEqual(p.ok === false && [p.path, p.why], ["x", "不允许 Proxy"]);
  const m = plainData(new Map(), "x");
  assert.equal(m.ok === false && m.path, "x");
  if (!m.ok) assert.match(m.why, /原型/);
  const counter = { n: 0 };
  const g = plainData({ a: getterOn({}, "b", counter) }, "x");
  assert.deepEqual(g.ok === false && [g.path, g.why], ["x.a.b", "不允许 getter/setter"]);
  assert.equal(counter.n, 0);
});

test("对象与数组元素的 getter、setter 都拒绝并点名路径,getter 调用 0 次", () => {
  const counter = { n: 0 };
  const arr: unknown[] = [];
  getterOn(arr, "0", counter);
  const setter = {};
  Object.defineProperty(setter, "s", { enumerable: true, set() { counter.n++; } });
  const cases: [unknown, string][] = [[{ a: getterOn({}, "k", counter) }, "x.a.k"], [{ list: arr }, "x.list[0]"], [[arr], "x[0][0]"], [setter, "x.s"]];
  for (const [v, path] of cases) {
    const r = plainData(v, "x");
    assert.deepEqual(r.ok === false && [r.path, r.why], [path, "不允许 getter/setter"]);
  }
  const it = plainItems(arr, "x");
  assert.deepEqual(it.ok === false && [it.path, it.why], ["x[0]", "不允许 getter/setter"]);
  assert.equal(counter.n, 0);
});

test("非 JSON 形状都拒绝:BigInt、Symbol 值与键、NaN、Infinity、非顶层函数、稀疏数组、数组额外属性、不可枚举属性", () => {
  const sparse: unknown[] = [];
  sparse[1] = 1;
  const hidden = {};
  Object.defineProperty(hidden, "h", { value: 1, enumerable: false });
  for (const v of [{ b: 1n }, { s: Symbol("s") }, { [Symbol("k")]: 1 }, { n: Number.NaN }, { n: Number.POSITIVE_INFINITY }, { f: { g: () => 1 } }, { a: sparse }, { a: Object.assign([1], { t: 1 }) }, hidden, [undefined]]) {
    assert.equal(plainData(v).ok, false, String(Object.keys(v)));
  }
});

test("顶层函数只在 topFunctions 打开时放行,原样保留引用(单开关对照)", () => {
  const fn = () => 1;
  assert.equal(plainData({ fn }).ok, false);
  const r = plainData({ fn }, "x", { topFunctions: true });
  assert.equal(r.ok && (r.value as { fn: unknown }).fn, fn);
});

test("plainItems 只检查数组容器,元素原样返回不克隆", () => {
  const inner = { a: 1 };
  const r = plainItems([inner, 2]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.items[0], inner);
  assert.equal(plainItems({ length: 0 }).ok, false);
  assert.equal(plainItems(new Proxy([], {})).ok, false);
});

test("判定过程中陷阱抛错也返回拒绝,判定函数自身不抛错", () => {
  const evil = new Proxy({}, { getPrototypeOf() { throw new Error("原型陷阱"); } });
  let r: ReturnType<typeof plainData> | undefined;
  assert.doesNotThrow(() => { r = plainData({ inner: [evil] }); });
  assert.equal(r?.ok, false);
  const bad = new Error("x");
  Object.defineProperty(bad, "message", { get() { throw new Error("message getter"); } });
  assert.equal(typeof describeThrown(bad), "string");
});

// —— 原型链污染:临时字段表与结果数组不经过原型链上的同名属性
/** 在 target 的 key 上临时装一个属性,只在 fn 执行期间生效,结束后一定复原 */
function withPolluted<T>(target: object, key: string, desc: PropertyDescriptor, fn: () => T): T {
  const had = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...desc });
  try { return fn(); } finally {
    if (had) Object.defineProperty(target, key, had);
    else delete (target as Record<string, unknown>)[key];
  }
}

test("原型无污染时数组照常克隆(四种原型条件之一:基线)", () => {
  const a = plainData(["A", "B"]);
  assert.deepEqual(a.ok && [...(a.value as string[])], ["A", "B"]);
  const it = plainItems(["A"]);
  assert.deepEqual(it.ok && [...it.items], ["A"]);
});

test("Array.prototype 上有同名可写下标时,结果是自有元素,不读原型(四种原型条件之二)", () => {
  const desc = { value: "污染", writable: true, enumerable: false };
  const a = withPolluted(Array.prototype, "0", desc, () => plainData(["A"]));
  const it = withPolluted(Array.prototype, "0", desc, () => plainItems(["A"]));
  const empty = withPolluted(Array.prototype, "0", desc, () => plainData([]));
  assert.equal(a.ok && Object.hasOwn(a.value as object, "0") && (a.value as string[])[0], "A");
  assert.equal(it.ok && Object.hasOwn(it.items, "0") && it.items[0], "A");
  assert.equal(empty.ok && Object.hasOwn(empty.value as object, "0"), false, "空数组不长出原型上的元素");
});

test("Array.prototype 上有同名 setter 时,克隆不调用它,元素照常写入(四种原型条件之三)", () => {
  let calls = 0;
  const desc = { set() { calls++; }, enumerable: false };
  const a = withPolluted(Array.prototype, "0", desc, () => plainData(["A", { k: ["B"] }]));
  const it = withPolluted(Array.prototype, "0", desc, () => plainItems(["A"]));
  assert.equal(calls, 0);
  assert.equal(a.ok, true);
  if (a.ok) {
    const v = a.value as [string, { k: string[] }];
    assert.deepEqual([Object.hasOwn(v, "0"), Object.getOwnPropertyDescriptor(v, "0")?.value, Object.getOwnPropertyDescriptor(v[1].k, "0")?.value], [true, "A", "B"]);
  }
  assert.equal(it.ok && Object.getOwnPropertyDescriptor(it.items, "0")?.value, "A");
});

test("Array.prototype 上有同名不可写下标时,合法输入不被误拒(四种原型条件之四)", () => {
  const desc = { value: "锁住", writable: false, enumerable: false };
  const a = withPolluted(Array.prototype, "0", desc, () => plainData(["A"]));
  const it = withPolluted(Array.prototype, "0", desc, () => plainItems(["A"]));
  assert.equal(a.ok, true, a.ok ? "" : `${a.path} ${a.why}`);
  assert.equal(a.ok && Object.getOwnPropertyDescriptor(a.value as object, "0")?.value, "A");
  assert.equal(it.ok && Object.getOwnPropertyDescriptor(it.items, "0")?.value, "A");
});

test("Object.prototype 上有同名下标描述符形状的值时,稀疏数组仍按稀疏拒绝,不借原型补洞", () => {
  const sparse: unknown[] = [];
  sparse[1] = "B";
  const fake = { value: "污染", enumerable: true, writable: true, configurable: true };
  const desc = { value: fake, writable: true, enumerable: false };
  const a = withPolluted(Object.prototype, "0", desc, () => plainData(sparse, "x"));
  const it = withPolluted(Object.prototype, "0", desc, () => plainItems(sparse, "x"));
  assert.deepEqual(a.ok === false && [a.path, a.why], ["x[0]", "不允许稀疏数组"]);
  assert.deepEqual(it.ok === false && [it.path, it.why], ["x[0]", "不允许稀疏数组"]);
});

test("Object.prototype 上有同名 setter 时,对象结果照常写入且不调用它", () => {
  let calls = 0;
  const r = withPolluted(Object.prototype, "k", { set() { calls++; }, enumerable: false }, () => plainData({ k: "A", n: { k: "B" } }));
  assert.equal(calls, 0);
  assert.equal(r.ok, true);
  if (r.ok) {
    const v = r.value as { k: string; n: { k: string } };
    assert.deepEqual([Object.getOwnPropertyDescriptor(v, "k")?.value, Object.getOwnPropertyDescriptor(v.n, "k")?.value], ["A", "B"]);
  }
});

test("safeDescribe 与 describeThrown 给出确切的诊断文字", () => {
  assert.equal(safeDescribe({ a: 1, b: [2n] }), '{"a":1,"b":["2n"]}');
  assert.equal(safeDescribe("原样"), "原样");
  assert.equal(describeThrown(new Error("限流")), "限流");
  assert.equal(describeThrown(42), "42");
  const bad = new Error("x");
  Object.defineProperty(bad, "message", { get() { throw new Error("坏"); } });
  assert.equal(describeThrown(bad), "{}");
});
