// 统一的普通数据对象判定(与 PR #3 同一契约):先 isProxy → 原型 → 逐层属性描述符,getter/setter 拒绝且永不调用。
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendOwn, describeThrown, plainData, plainItems, safeDescribe } from "./plain.ts";

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

// —— 第六轮:描述符字段名污染(R6-01)、判定选项 getter(R6-03)、诊断不执行外部代码(R6-04)、普通小数(R6-M1)
const DESC_KEYS = ["get", "set", "value", "writable", "enumerable", "configurable"] as const;
/** 在 Object.prototype 上临时装同名 setter(计数)或不可写普通值;结束后一定复原 */
function underDescKey<T>(key: string, mode: "setter" | "readonly", counter: { n: number }, fn: () => T): T {
  const d: PropertyDescriptor = Object.create(null);
  d.configurable = true;
  if (mode === "setter") d.set = () => { counter.n++; };
  else { d.value = 17; d.writable = false; }
  return withPolluted(Object.prototype, key, d, fn);
}

test("Object.prototype 上有描述符字段名(get/set/value/writable/enumerable/configurable)的 setter 或只读值时,合法输入照常通过且结果正确(R6-01 阳性埋雷)", () => {
  for (const key of DESC_KEYS) for (const mode of ["setter", "readonly"] as const) {
    const counter = { n: 0 };
    const r = underDescKey(key, mode, counter, () => plainData({ x: 1, list: ["a", { y: 2 }] }));
    const it = underDescKey(key, mode, counter, () => plainItems(["a", "b"]));
    assert.equal(r.ok, true, `${key}/${mode}: ${r.ok ? "" : `${r.path} ${r.why}`}`);
    assert.deepEqual(r.ok && JSON.parse(JSON.stringify(r.value)), { x: 1, list: ["a", { y: 2 }] }, `${key}/${mode}`);
    assert.deepEqual(it.ok && [...it.items], ["a", "b"], `${key}/${mode}`);
    assert.equal(counter.n, 0, `${key}/${mode} setter 被调用`);
  }
});

test("描述符字段名污染下 getter 仍被拒绝并点名路径,getter 调用 0 次(R6-01 单开关对照)", () => {
  for (const key of DESC_KEYS) {
    const calls = { n: 0 };
    const input = { a: getterOn({}, "k", calls) }; // 污染前构造:测试自己的 defineProperty 不受污染影响
    const r = underDescKey(key, "readonly", { n: 0 }, () => plainData(input, "x"));
    assert.deepEqual(r.ok === false && [r.path, r.why], ["x.a.k", "不允许 getter/setter"], key);
    assert.equal(calls.n, 0);
  }
});

test("判定选项 topFunctions 是 getter 时拒绝,getter 调用 0 次;数据属性照常生效(R6-03 阳性埋雷)", () => {
  const calls = { n: 0 };
  const opts = getterOn({}, "topFunctions", calls);
  const r = plainData({ fn: () => 1 }, "x", opts as never);
  assert.deepEqual(r.ok === false && [r.path, r.why], ["x", "判定选项只接受普通数据对象,只能有布尔数据属性 topFunctions"]);
  assert.equal(calls.n, 0);
  assert.equal(plainData({ fn: () => 1 }, "x", { topFunctions: true }).ok, true);
});

test("safeDescribe 不执行 getter、toJSON 与 toString,访问器记作占位;describeThrown 不读 message getter(R6-04 阳性埋雷)", () => {
  const calls = { n: 0 };
  const o = getterOn({ a: 1 }, "g", calls);
  const toJSON = () => { calls.n++; return "被调用"; };
  assert.equal(safeDescribe(o), '{"a":1,"g":"[getter/setter]"}');
  assert.equal(safeDescribe({ toJSON }), '{"toJSON":"<函数>"}');
  assert.equal(safeDescribe([1, getterOn([2], "0", calls)]), '[1,["[getter/setter]"]]');
  const err = new Error("x");
  Object.defineProperty(err, "message", { enumerable: true, get() { calls.n++; return "读到了"; } });
  assert.equal(describeThrown(err), '{"message":"[getter/setter]"}');
  assert.equal(calls.n, 0);
});

test("有限小数照常通过并原样保留(R6-M1 单开关对照:只拒绝 NaN 与无穷)", () => {
  const r = plainData({ ratio: 2.5, neg: -0.125, list: [0.1] });
  assert.deepEqual(r.ok && JSON.parse(JSON.stringify(r.value)), { ratio: 2.5, neg: -0.125, list: [0.1] });
});

// —— 第七轮:公开工具 appendOwn 与判定选项(R7-02)、topFunctions:false 单开关(R7-M1)
test("appendOwn 的目标不是普通数组(带 length getter 的对象、Proxy 数组、null)时抛受控 TypeError,getter 调用 0 次;普通数组照常追加(R7-02 阳性埋雷)", () => {
  const calls = { n: 0 };
  const fake = getterOn({}, "length", calls);
  for (const target of [fake, new Proxy([], {}), null, { length: 0 }]) {
    assert.throws(() => appendOwn(target as never, "x"), (e: unknown) => e instanceof TypeError && e.message === "appendOwn 的目标必须是普通数组");
  }
  assert.equal(calls.n, 0);
  const real: string[] = ["a"];
  appendOwn(real, "b");
  assert.deepEqual([real.length, Object.hasOwn(real, "1"), real[1]], [2, true, "b"]);
});

test("判定选项里任何 getter/setter(可枚举或不可枚举)、其它键或非布尔 topFunctions 都拒绝,访问器调用 0 次(R7-02 阳性埋雷)", () => {
  const calls = { n: 0 };
  const visible = getterOn({ topFunctions: true }, "other", calls);
  const hidden = { topFunctions: true };
  Object.defineProperty(hidden, "other", { enumerable: false, get() { calls.n++; return 1; } });
  const setter = { topFunctions: true };
  Object.defineProperty(setter, "other", { enumerable: true, set() { calls.n++; } });
  for (const opts of [visible, hidden, setter, { topFunctions: true, other: 1 }, { topFunctions: "yes" }, { [Symbol("k")]: 1 }]) {
    const r = plainData({ x: 1 }, "x", opts as never);
    assert.deepEqual(r.ok === false && [r.path, r.why], ["x", "判定选项只接受普通数据对象,只能有布尔数据属性 topFunctions"]);
  }
  assert.equal(calls.n, 0);
  assert.equal(plainData({ x: 1 }, "x", {}).ok, true);
});

test("topFunctions:false 与不传一样拒绝顶层函数,只有 true 放行(R7-M1 单开关对照)", () => {
  const fn = () => 1;
  const off = plainData({ fn }, "x", { topFunctions: false });
  assert.deepEqual(off.ok === false && [off.path, off.why], ["x.fn", "只有顶层字段可以是函数"]);
  assert.equal(plainData({ fn }, "x", { topFunctions: true }).ok, true);
});
