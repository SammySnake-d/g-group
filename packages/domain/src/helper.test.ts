// Helper 三种入口(用户 g-group#1365、#1353):
// 全局入口隔离,不在任何对话里展示;在聊天里 @Helper,回复作为消息出现在这个聊天里;在聊天里打开 Helper 侧边栏,带当前聊天上下文,但不作为消息。
// Helper 只为用户本人服务,不是项目成员,不认领任务。
import assert from "node:assert/strict";
import { test } from "node:test";
import { helperMayClaimTasks, routeHelper } from "./helper.ts";

const me = { kind: "user", id: "u1" } as const;

test("全局入口:回复在全局面板,不进任何对话,不读任何会话上下文", () => {
  const r = routeHelper({ kind: "global" }, me, "u1");
  assert.deepEqual(r, { ok: true, route: { replyIn: "global-panel", becomesMessage: false, contextConversation: null, replyToSeq: null } });
});

test("在聊天里 @Helper:回复作为消息出现在这个聊天里,并引用那条 @ 消息", () => {
  const r = routeHelper({ kind: "mention", conversationId: "g-group", seq: 1365 }, me, "u1");
  assert.deepEqual(r, { ok: true, route: { replyIn: "conversation", becomesMessage: true, contextConversation: "g-group", replyToSeq: 1365 } });
});

test("在聊天里打开侧边栏:带当前聊天上下文,但回复不作为消息", () => {
  const r = routeHelper({ kind: "sidebar", conversationId: "g-group" }, me, "u1");
  assert.deepEqual(r, { ok: true, route: { replyIn: "sidebar", becomesMessage: false, contextConversation: "g-group", replyToSeq: null } });
});

test("Helper 只听用户本人:三种入口下联系人(哪怕 id 与用户相同)和其他用户都被拒", () => {
  const entries = [{ kind: "global" }, { kind: "mention", conversationId: "g-group", seq: 9 }, { kind: "sidebar", conversationId: "g-group" }] as const;
  for (const e of entries) {
    for (const caller of [{ kind: "contact", id: "c-astra" }, { kind: "contact", id: "u1" }, { kind: "user", id: "u2" }] as const) {
      const r = routeHelper(e, caller, "u1");
      assert.equal(r.ok, false, `${e.kind} ${caller.kind}:${caller.id}`);
    }
    assert.equal(routeHelper(e, me, "u1").ok, true, e.kind);
  }
});

test("Helper 不是项目成员,不认领任务", () => {
  assert.equal(helperMayClaimTasks(), false);
});

const okEntries = [
  [{ kind: "global" }, { replyIn: "global-panel", becomesMessage: false, contextConversation: null, replyToSeq: null }],
  [{ kind: "mention", conversationId: "g-group", seq: 0 }, { replyIn: "conversation", becomesMessage: true, contextConversation: "g-group", replyToSeq: 0 }],
  [{ kind: "sidebar", conversationId: "g-group" }, { replyIn: "sidebar", becomesMessage: false, contextConversation: "g-group", replyToSeq: null }],
] as const;

test("CH-27 三入口 × 本人/他人/同 ID 联系人:JSON、null 原型对象与带变体外字段的输入结果相同", () => {
  for (const [entry, route] of okEntries) {
    const variants = [entry, JSON.parse(JSON.stringify(entry)), Object.assign(Object.create(null), entry), { ...entry, debug: 1, seq: 7, conversationId: "x" }];
    for (const e of entry.kind === "global" ? variants : variants.slice(0, 3)) {
      assert.deepEqual(routeHelper(e as never, me, "u1"), { ok: true, route }, entry.kind);
      assert.deepEqual(routeHelper(e as never, Object.assign(Object.create(null), me), "u1"), { ok: true, route }, `${entry.kind} null 原型调用方`);
      for (const caller of [{ kind: "user", id: "u2" }, { kind: "contact", id: "u1" }] as const) {
        const r = routeHelper(e as never, caller, "u1");
        assert.equal(!r.ok && r.reason, "Helper 只为用户本人服务,其他人叫它不执行", `${entry.kind} ${caller.kind}`);
      }
    }
  }
});

test("CH-27 入口形状不对:未知 kind、缺字段、错类型、空 id、非法 seq 都返回带理由的失败,不抛、不返回 undefined", () => {
  const bad: [unknown, string][] = [
    [null, "Helper 入口 必须是对象"],
    [[], "Helper 入口 必须是对象"],
    ["global", "Helper 入口 必须是对象"],
    [{}, "kind 必须是字符串"],
    [{ kind: 1 }, "kind 必须是字符串"],
    [{ kind: "bogus" }, "Helper 入口种类 bogus 不认识"],
    [{ kind: "mention" }, "conversationId 必须是字符串"],
    [{ kind: "mention", conversationId: "g", seq: "9" }, "seq 必须是数字"],
    [{ kind: "mention", conversationId: 3, seq: 9 }, "conversationId 必须是字符串"],
    [{ kind: "mention", conversationId: " ", seq: 9 }, "conversationId 必须是非空字符串"],
    [{ kind: "mention", conversationId: "g", seq: -1 }, "seq -1 不是合法的消息位置(非负整数)"],
    [{ kind: "mention", conversationId: "g", seq: 1.5 }, "seq 1.5 不是合法的消息位置(非负整数)"],
    [{ kind: "mention", conversationId: "g", seq: Number.MAX_SAFE_INTEGER + 1 }, `seq ${Number.MAX_SAFE_INTEGER + 1} 不是合法的消息位置(非负整数)`],
    [{ kind: "sidebar" }, "conversationId 必须是字符串"],
    [{ kind: "sidebar", conversationId: "" }, "conversationId 必须是非空字符串"],
    [{ kind: "sidebar", conversationId: null }, "conversationId 必须是字符串"],
  ];
  for (const [entry, reason] of bad) {
    let r: unknown;
    assert.doesNotThrow(() => { r = routeHelper(entry as never, me, "u1"); }, JSON.stringify(entry));
    assert.deepEqual(r, { ok: false, reason }, JSON.stringify(entry));
  }
  assert.equal(routeHelper({ kind: "mention", conversationId: "g", seq: Number.MAX_SAFE_INTEGER }, me, "u1").ok, true);
});

test("CH-27 调用方与 owner 形状不对:返回带理由的失败;合法本人通过(对照)", () => {
  const e = { kind: "global" } as const;
  const bad: [unknown, unknown, string][] = [
    [null, "u1", "调用方 必须是对象"],
    [{ kind: "user" }, "u1", "id 必须是字符串"],
    [{ kind: "admin", id: "u1" }, "u1", "调用方种类 admin 不认识"],
    [{ kind: "user", id: "" }, "u1", "调用方 id 不能为空"],
    [{ kind: "user", id: 1 }, "u1", "id 必须是字符串"],
    [me, "", "owner 必须是非空字符串"],
    [me, "  ", "owner 必须是非空字符串"],
    [me, 7, "owner 必须是非空字符串"],
    [me, null, "owner 必须是非空字符串"],
  ];
  for (const [caller, owner, reason] of bad) {
    let r: unknown;
    assert.doesNotThrow(() => { r = routeHelper(e, caller as never, owner as never); });
    assert.deepEqual(r, { ok: false, reason }, `${JSON.stringify(caller)} / ${String(owner)}`);
  }
  assert.equal(routeHelper(e, me, "u1").ok, true);
});

test("CH-27 普通数据合同:entry/caller 是 Proxy、可撤销 Proxy、类实例、自定义原型或含访问器时拒绝,getter 调用 0 次", () => {
  const e = { kind: "mention", conversationId: "g", seq: 1 } as const;
  const revoked = Proxy.revocable({ kind: "global" }, {});
  revoked.revoke();
  class Caller { kind = "user" as const; id = "u1"; }
  const cases: [unknown, unknown, string][] = [
    [new Proxy({ ...e }, {}), me, "Helper 入口 只接受普通数据对象"],
    [revoked.proxy, me, "Helper 入口 只接受普通数据对象"],
    [Object.assign(Object.create({ x: 1 }), e), me, "Helper 入口 只接受普通数据对象"],
    [e, new Proxy({ ...me }, {}), "调用方 只接受普通数据对象"],
    [e, new Caller(), "调用方 只接受普通数据对象"],
  ];
  for (const [entry, caller, reason] of cases) {
    let r: unknown;
    assert.doesNotThrow(() => { r = routeHelper(entry as never, caller as never, "u1"); });
    assert.deepEqual(r, { ok: false, reason });
  }
  for (const [label, base, key, isEntry] of [["entry.kind", e, "kind", true], ["entry.conversationId", e, "conversationId", true], ["entry.seq", e, "seq", true], ["caller.kind", me, "kind", false], ["caller.id", me, "id", false]] as const) {
    let n = 0;
    const o: Record<string, unknown> = { ...base };
    delete o[key];
    Object.defineProperty(o, key, { enumerable: true, get: () => { n++; return (base as Record<string, unknown>)[key]; } });
    const r = isEntry ? routeHelper(o as never, me, "u1") : routeHelper(e, o as never, "u1");
    assert.deepEqual(r, { ok: false, reason: `${isEntry ? "Helper 入口" : "调用方"} 只接受普通数据对象(${key} 是访问器属性)` }, label);
    assert.equal(n, 0, label);
  }
  assert.equal(routeHelper(e, me, "u1").ok, true);
});

/** 在 Object.prototype 上临时放同名属性(描述符空原型),跑完 f 立即恢复;返回 setter 调用次数。 */
const polluted = (keys: readonly string[], mode: "none" | "readonly" | "setter" | "readonlyTrue", f: () => void): number => {
  const np = (d: PropertyDescriptor): PropertyDescriptor => Object.assign(Object.create(null) as PropertyDescriptor, d);
  const saved: [string, PropertyDescriptor | undefined][] = [];
  let calls = 0;
  try {
    if (mode !== "none") for (const key of keys) {
      saved.push([key, Object.getOwnPropertyDescriptor(Object.prototype, key)]);
      Object.defineProperty(Object.prototype, key, np(mode === "setter" ? { set() { calls++; }, configurable: true } : { value: mode === "readonlyTrue" ? true : "污染", writable: false, configurable: true }));
    }
    f();
  } finally {
    for (const [key, d] of saved.reverse()) { if (d) Object.defineProperty(Object.prototype, key, np(d)); else delete (Object.prototype as Record<string, unknown>)[key]; }
  }
  return calls;
};
const okRoutes = [
  [{ kind: "global" }, "global-panel"],
  [{ kind: "mention", conversationId: "g-group", seq: 9 }, "conversation"],
  [{ kind: "sidebar", conversationId: "g-group" }, "sidebar"],
] as const;

test("CH-29/CH-35 Object.prototype.value 被污染或无污染时,caller/entry 含访问器(可枚举、不可枚举、Symbol 键)一律拒绝,getter 调用 0 次", () => {
  for (const mode of ["none", "readonly"] as const) {
    let n = 0;
    const out: [string, boolean, string][] = [];
    const sym = Symbol("s");
    const mk = (base: object, key: string | symbol, enumerable: boolean) => Object.defineProperty({ ...base }, key, Object.assign(Object.create(null) as PropertyDescriptor, { enumerable, get: () => { n++; return "u1"; } }));
    polluted(["value"], mode, () => {
      for (const [entry] of okRoutes) {
        for (const [label, key, en] of [["可枚举", "extra", true], ["不可枚举", "extra", false], ["Symbol", sym, true], ["不可枚举 Symbol", sym, false]] as const) {
          const r1 = routeHelper(mk(entry, key, en) as never, me, "u1");
          out.push([`${mode} ${entry.kind} entry ${label}`, r1.ok, r1.ok ? "" : r1.reason]);
          const r2 = routeHelper(entry, mk(me, key, en) as never, "u1");
          out.push([`${mode} ${entry.kind} caller ${label}`, r2.ok, r2.ok ? "" : r2.reason]);
        }
      }
    });
    for (const [label, ok, reason] of out) { assert.equal(ok, false, label); assert.match(reason, /是访问器属性/, label); }
    assert.equal(n, 0, `${mode} getter 调用次数`);
  }
});

test("CH-35 caller/entry 上不可枚举或 Symbol 键的普通数据属性不影响结果,三入口都照常路由(对照)", () => {
  const sym = Symbol("s");
  for (const [entry, replyIn] of okRoutes) {
    for (const add of [(o: object) => Object.defineProperty(o, "extra", { enumerable: false, value: 1 }), (o: object) => Object.defineProperty(o, sym, { enumerable: true, value: 1 })]) {
      const r1 = routeHelper(add({ ...entry }) as never, me, "u1");
      const r2 = routeHelper(entry, add({ ...me }) as never, "u1");
      assert.equal(r1.ok && r1.route.replyIn, replyIn);
      assert.equal(r2.ok && r2.route.replyIn, replyIn);
    }
  }
});

test("CH-30 Object.prototype.get/set 被放成 setter 或只读属性时,带 get/set 普通字段的 caller/entry 照常路由、不抛、setter 调用 0 次;无污染时同样(对照)", () => {
  for (const mode of ["none", "setter", "readonly"] as const) {
    const out: [string, unknown][] = [];
    const calls = polluted(["get", "set"], mode, () => {
      for (const [entry, replyIn] of okRoutes) {
        try {
          const r = routeHelper({ ...entry, get: "x", set: "y" } as never, { ...me, get: "x" } as never, "u1");
          out.push([entry.kind, r.ok && r.route.replyIn === replyIn]);
        } catch (e) { out.push([entry.kind, `抛出 ${(e as Error).message}`]); }
      }
    });
    for (const [label, v] of out) assert.equal(v, true, `${mode} ${label}`);
    assert.equal(calls, 0, `${mode} setter 调用次数`);
  }
});

test("CH-31 caller 与每个入口变体的每个必填字段:缺失或类型不对拒绝、不抛,正常值接受;Object.prototype.optional 被放成只读 true 时结果相同", () => {
  const wrong: Record<string, unknown> = { kind: 1, id: 7, conversationId: 3, seq: "9" };
  for (const mode of ["none", "readonlyTrue"] as const) {
    const out: [string, unknown, boolean][] = [];
    polluted(["optional"], mode, () => {
      const run = (label: string, f: () => { ok: boolean }, want: boolean) => { try { out.push([label, f().ok, want]); } catch (e) { out.push([label, `抛出 ${(e as Error).message}`, want]); } };
      for (const [entry] of okRoutes) {
        for (const key of Object.keys(entry)) {
          const missing = { ...entry } as Record<string, unknown>;
          delete missing[key];
          run(`${entry.kind}.${key} 缺失`, () => routeHelper(missing as never, me, "u1"), false);
          run(`${entry.kind}.${key} 类型不对`, () => routeHelper({ ...entry, [key]: wrong[key] } as never, me, "u1"), false);
        }
        for (const key of Object.keys(me)) {
          const missing = { ...me } as Record<string, unknown>;
          delete missing[key];
          run(`${entry.kind} caller.${key} 缺失`, () => routeHelper(entry, missing as never, "u1"), false);
          run(`${entry.kind} caller.${key} 类型不对`, () => routeHelper(entry, { ...me, [key]: wrong[key] } as never, "u1"), false);
        }
        run(`${entry.kind} 正常`, () => routeHelper(entry, me, "u1"), true);
      }
    });
    for (const [label, got, want] of out) assert.equal(got, want, `${mode} ${label}`);
  }
});
