// 同步观察器:Debugger 在真实源码的所有可停位置暂停;每次停下读独立的描述符基线。
// 不冻结对象、不替换内置方法、不代理被测值。只承诺由本文件的双侧控制校准的写法,
// 不声称能观察无停点的任意本机代码。测试和变异都执行同一实际 plugins.ts。
import inspector from 'node:inspector';
import { createHook } from 'node:async_hooks';
import { types } from 'node:util';
import { parentPort } from 'node:worker_threads';

const session = new inspector.Session();
session.connect();
function post(method, params = {}) {
  let result, error, done = false;
  session.post(method, params, (e, r) => { error = e; result = r; done = true; });
  if (!done) throw new Error(`调试协议没有同步返回:${method}`);
  if (error) throw error;
  return result;
}
const scripts = [];
session.on('Debugger.scriptParsed', ({ params }) => scripts.push(params));
post('Runtime.enable');
post('Debugger.enable');
const { createRegistry } = await import('../src/plugins.ts');

// 从当前 realm 的原生构造器出发,只沿数据描述符闭包搜集内置对象;Map/WeakMap 等不是手填清单。
function nativeObjects() {
  const all = new Set();
  for (const d of Object.values(Object.getOwnPropertyDescriptors(globalThis))) {
    if (typeof d.value === 'function' && /\[native code\]/.test(Function.prototype.toString.call(d.value))) all.add(d.value);
  }
  for (const o of all) {
    for (const d of Object.values(Object.getOwnPropertyDescriptors(o))) {
      const v = d.value;
      if (v !== null && (typeof v === 'object' || typeof v === 'function') && !types.isProxy(v)) all.add(v);
    }
    const p = Object.getPrototypeOf(o);
    if (p !== null) all.add(p);
  }
  return [...all];
}
const hosts = nativeObjects();
const snap = (o) => ({ proto: Object.getPrototypeOf(o), extensible: Object.isExtensible(o), descriptors: Object.getOwnPropertyDescriptors(o) });
const same = (a, b) => {
  if (a.proto !== b.proto || a.extensible !== b.extensible) return false;
  const ak = Reflect.ownKeys(a.descriptors), bk = Reflect.ownKeys(b.descriptors);
  if (ak.length !== bk.length || ak.some((k) => !Object.hasOwn(b.descriptors, k))) return false;
  return ak.every((k) => {
    const x = a.descriptors[k], y = b.descriptors[k];
    return ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every((p) => Object.hasOwn(x, p) === Object.hasOwn(y, p) && Object.is(x[p], y[p]));
  });
};
let armed = false, watched = [], bases = [], changes = new Set(), pauses = 0, events = 0, observerError;
function inspect() {
  for (let i = 0; i < watched.length; i++) if (!same(snap(watched[i]), bases[i])) changes.add(i === 0 ? 'returned' : 'builtin');
}
session.on('Debugger.paused', () => {
  try { if (armed) { pauses++; inspect(); } } catch (e) { observerError = String(e); }
  finally { post('Debugger.resume'); }
});
function breakpoints(script) {
  const { locations } = post('Debugger.getPossibleBreakpoints', { start: { scriptId: script.scriptId, lineNumber: 0 }, end: { scriptId: script.scriptId, lineNumber: script.endLine, columnNumber: script.endColumn } });
  for (const location of locations) post('Debugger.setBreakpoint', { location });
  return locations.length;
}
const product = scripts.find((s) => s.url.endsWith('/src/plugins.ts'));
if (!product) throw new Error('找不到实际 plugins.ts 调试脚本');
const productPoints = breakpoints(product);

// 与实际源码使用同一观察路径;每个写入和恢复都是可停语句,源码变异另作标定。
const control = post('Runtime.compileScript', { expression: `globalThis.__neutral_window_control = (function(o, what, withEvent) {
  if (what === 'value-assign') { const old = o.then; o.then = 1; if (withEvent) void Promise.resolve(); o.then = old; }
  if (what === 'value-define') { const old = Object.getOwnPropertyDescriptor(o, 'then'); Object.defineProperty(o, 'then', { ...old, value: 1 }); if (withEvent) void Promise.resolve(); Object.defineProperty(o, 'then', old); }
  if (what === 'value-reflect') { const old = o.then; Reflect.set(o, 'then', 1); if (withEvent) void Promise.resolve(); Reflect.set(o, 'then', old); }
  if (what === 'map-define') { Object.defineProperty(Map.prototype, '__neutral_temporary__', { value: 1, configurable: true }); if (withEvent) void Promise.resolve(); Reflect.deleteProperty(Map.prototype, '__neutral_temporary__'); }
  if (what === 'weakmap-reflect') { Reflect.defineProperty(WeakMap.prototype, '__neutral_temporary__', { value: 1, configurable: true }); if (withEvent) void Promise.resolve(); Reflect.deleteProperty(WeakMap.prototype, '__neutral_temporary__'); }
  if (what === 'clean' && withEvent) void Promise.resolve();
  return 'done';
})`, sourceURL: 'neutral-window-controls.js', persistScript: true });
post('Runtime.runScript', { scriptId: control.scriptId });
const controlScript = scripts.find((s) => s.scriptId === control.scriptId);
const controlPoints = breakpoints(controlScript);
const hook = createHook({ init() { if (armed) events++; } });

const make = () => { const p = Promise.resolve([]); Object.defineProperty(p, 'then', { value: function pluginFn() {}, writable: true, configurable: true }); return p; };
function begin(o) { watched = [o, ...hosts]; bases = watched.map(snap); pauses = 0; events = 0; changes = new Set(); observerError = undefined; armed = true; }
function end() { inspect(); armed = false; return { changed: [...changes], pauses, events, restored: watched.every((o, i) => same(snap(o), bases[i])), observerError }; }
const controls = [];
for (const what of ['clean', 'value-assign', 'value-define', 'value-reflect', 'map-define', 'weakmap-reflect']) for (const withEvent of [false, true]) {
  const o = make();
  hook.enable();
  // 临时引用在基线之前设好,暂停的源码本身不会改它。
  globalThis.__neutral_observer_object = o;
  begin(o);
  const r = post('Runtime.evaluate', { expression: `__neutral_window_control(__neutral_observer_object, ${JSON.stringify(what)}, ${withEvent})` });
  controls.push({ what, withEvent, exception: r.exceptionDetails?.text, ...end() });
}
const actual = [];
hook.disable();
for (const withHook of [false, true]) for (const key of ['then', 'constructor']) for (const mode of ['send', 'pull']) {
  const o = Promise.resolve([]);
  Object.defineProperty(o, key, { value: function pluginFn() {}, writable: true, configurable: true });
  if (withHook) hook.enable(); else hook.disable();
  const reg = createRegistry({ now: () => 0 });
  reg.register(mode === 'send' ? { kind: 'outbound-channel', id: 'p', endpoint: 'A', idempotency: 'none', send: () => o } : { kind: 'data-source', id: 'p', sources: ['g'], pull: () => o });
  begin(o);
  const pending = mode === 'send' ? reg.send('p', { action_id: 'a', payload: 'x' }) : reg.pull('p', 'g');
  const observed = end();
  const result = await pending;
  actual.push({ mode, key, withHook, result, ...observed });
}
hook.disable();
session.disconnect();
const out = { productPoints, controlPoints, hostCount: hosts.length, includesMap: hosts.includes(Map.prototype), includesWeakMap: hosts.includes(WeakMap.prototype), controls, actual };
if (parentPort) parentPort.postMessage(out); else console.log(JSON.stringify(out, null, 2));
