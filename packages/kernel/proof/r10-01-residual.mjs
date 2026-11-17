// R10-01 残余形态证据(第十一轮):内核挂不上拒绝处理的几种形态,逐一说明为什么做不到、或要付什么代价才做得到。
// 只用内置 Promise.prototype.then 与 await(内核能用的全部挂处理入口最终都走 SpeciesConstructor:x.constructor → 其 Symbol.species)。
// 每例在已处理的 Promise 上演示(先挂好处理再实验,本脚本自己不留未处理拒绝),不导入内核、不改写之后不恢复的内置对象。
// 用法: node packages/kernel/proof/r10-01-residual.mjs
const ex = (_ok, fail) => fail(new Error("预期拒绝"));
const locked = (v) => { const p = new Promise(ex); Reflect.apply(Promise.prototype.then, p, [undefined, () => {}]); Object.defineProperty(p, "constructor", { value: v, writable: false, enumerable: false, configurable: false }); return p; };
const tryThen = (p) => { try { Reflect.apply(Promise.prototype.then, p, [undefined, () => {}]); return "挂上"; } catch (e) { return `抛 ${e.constructor.name}: ${e.message}`; } };
const out = [];
const log = (s) => { out.push(s); console.log(s); };
log(`node ${process.version}`);

// 1. constructor 锁成非 undefined 的原始值:SpeciesConstructor 第 3 步 Type(C) 不是 Object 即抛 TypeError,发生在 PerformPromiseThen 之前。
//    await / Promise.resolve 先比 constructor(不等于 %Promise%)再走 thenable 任务,任务里调用的仍是同一个 then,同样抛错。
for (const v of [null, 0, "x"]) {
  const p = locked(v);
  log(`1 constructor=${JSON.stringify(v)} 不可写不可配置:内置 then ${tryThen(p)};Object.isExtensible 无关(值本身改不了)`);
}

// 2. constructor 锁成 Proxy:取 Symbol.species 就是 Proxy 的 get 陷阱(外部代码),描述符或原型链读取也是陷阱。
{
  let traps = 0;
  const P = new Proxy(function F() {}, { get(t, k, r) { traps++; return Reflect.get(t, k, r); } });
  const p = locked(P);
  const r = tryThen(p);
  log(`2 constructor=Proxy:内置 then ${r},get 陷阱被调用 ${traps} 次(没有不进陷阱就拿到 species 的公开办法)`);
}

// 3. constructor 锁成带 species getter 的内置构造器(以 Array 为例):内置 species getter 返回 Array 本身,
//    NewPromiseCapability(Array) 不调用 executor → resolve 不是函数 → TypeError。不执行外部代码,但挂不上。
//    唯一不执行外部代码的做法是临时改写内置 Array[Symbol.species](下面演示可行,随即恢复);内核不改写内置对象,未纳入,待拍板。
{
  const p = locked(Array);
  log(`3 constructor=Array:内置 then ${tryThen(p)}`);
  const before = Object.getOwnPropertyDescriptor(Array, Symbol.species);
  Object.defineProperty(Array, Symbol.species, { value: Promise, configurable: true });
  const r = tryThen(p);
  Object.defineProperty(Array, Symbol.species, before);
  log(`3 同一对象临时改写内置 Array[Symbol.species]=Promise 后:内置 then ${r};已恢复=${Object.getOwnPropertyDescriptor(Array, Symbol.species).get === before.get}`);
}

// 4. constructor 锁成冻结的 Promise 子类(species 继承自内置 Promise):内置 species getter 返回子类本身 → new 子类(executor),
//    子类构造函数是插件代码。子类冻结(不能新建自有 species),链上只剩内置 Promise,要临时改写内置 Promise[Symbol.species] 才能挂上。
{
  let ctor = 0;
  class F extends Promise { constructor(e) { ctor++; super(e); } }
  Object.freeze(F);
  const p = locked(F);
  const r = tryThen(p);
  log(`4 constructor=冻结子类:内置 then ${r},子类构造被执行 ${ctor} 次(即执行了外部代码,内核因此不能直接调用)`);
}

// 5. 子类带自有、不可配置的 species getter(例如冻结的类上 static get [Symbol.species]):取 species 就调用 getter(外部代码),
//    既不能改值也不能重定义;实例不可扩展且 prototype.constructor 也改不了时,三条路都走不通。
{
  let gets = 0;
  class G extends Promise { static get [Symbol.species]() { gets++; return Promise; } }
  Object.freeze(G); Object.freeze(G.prototype);
  const p = new G(ex); Reflect.apply(Promise.prototype.then, p, [undefined, () => {}]); gets = 0; Object.freeze(p);
  const r = tryThen(p);
  log(`5 实例、prototype、类全部冻结且 species 是不可配置 getter:内置 then ${r},species getter 被调用 ${gets} 次`);
  log(`5 描述符:G 的 species configurable=${Object.getOwnPropertyDescriptor(G, Symbol.species).configurable},G.prototype.constructor writable=${Object.getOwnPropertyDescriptor(G.prototype, "constructor").writable} configurable=${Object.getOwnPropertyDescriptor(G.prototype, "constructor").configurable},实例可扩展=${Object.isExtensible(p)}`);
}

// 6. 边界(不是形态问题,所有在已拒绝 Promise 上补挂处理的路径都有,含 await 普通原生 Promise):Node 在"已拒绝后才挂处理"时
//    经普通 [[Get]](走原型链)读 promise[async_id_symbol] / promise[trigger_async_id_symbol]。插件若先用 async_hooks 拿到这两个
//    Node 内部 symbol,再在自己类的 prototype 上定义同名 getter、删掉实例上的自有值,内核挂处理时这个 getter 会被调用。
//    原型链上的 Proxy 已用"临时换原型"避开;这种主动拿内部 symbol 的做法内核无法一般性避开(实例自有 getter 也能这样放),记为边界。
{
  const { createHook } = await import("node:async_hooks");
  const { createRegistry } = await import(new URL("../src/plugins.ts", import.meta.url).href);
  const h = createHook({ init() {} }).enable();
  const syms = Object.getOwnPropertySymbols(Promise.resolve()).filter((s) => String(s).includes("async_id"));
  h.disable();
  let gets = 0;
  class Sub extends Promise {}
  const p = new Sub(ex);
  for (const s of Object.getOwnPropertySymbols(p)) delete p[s];
  for (const s of syms) Object.defineProperty(Sub.prototype, s, { get() { gets++; return undefined; }, set() {}, configurable: true });
  const reg = createRegistry({ now: () => 0 });
  reg.register({ kind: "data-source", id: "p", sources: ["g"], pull: () => p });
  const r = await reg.pull("p", "g");
  log(`6 拿到的内部 symbol:${syms.map(String).join("、")};内核拒收 ${r.reason},子类 prototype 上的同名 getter 被 Node 调用 ${gets} 次`);
}

// 7. 原型链上有 Proxy 且实例不可扩展(实例本身不是 Proxy、没有自有 constructor):内置 then 读 constructor 走到 Proxy 的 get 陷阱;
//    实例不可扩展,既不能新建自有 constructor 也不能换原型(setPrototypeOf 返回 false),做不到。是否算进用户排除的"Proxy"由用户定。
{
  let traps = 0;
  const p = new Promise(ex); Reflect.apply(Promise.prototype.then, p, [undefined, () => {}]);
  Object.setPrototypeOf(p, new Proxy(Promise.prototype, { get(t, k, r) { traps++; return Reflect.get(t, k, r); } }));
  Object.preventExtensions(p);
  const swap = Reflect.setPrototypeOf(p, Promise.prototype);
  const own = Reflect.defineProperty(p, "constructor", { value: Promise, configurable: true });
  const r = tryThen(p);
  log(`7 原型为 Proxy 且实例不可扩展:换原型=${swap},新建自有 constructor=${own},内置 then ${r},get 陷阱被调用 ${traps} 次`);
}
