import assert from "node:assert/strict";
import { test } from "node:test";
import { checkIpcRequest, isTrustedOrigin, jsonProblem } from "./ipc.ts";

const APP = "app://renderer/index.html";
const KNOWN = new Set(["session.hello", "schedules.create", "messages.send"]);
const opts = { isMethod: (m: string) => KNOWN.has(m) };

test("isTrustedOrigin:只认 app://renderer 和显式给的开发源", () => {
  assert.equal(isTrustedOrigin(APP), true);
  assert.equal(isTrustedOrigin("app://evil/index.html"), false);
  assert.equal(isTrustedOrigin("https://renderer/index.html"), false);
  assert.equal(isTrustedOrigin("http://localhost:5199/x", "http://localhost:5199"), true);
  assert.equal(isTrustedOrigin("http://localhost:5198/x", "http://localhost:5199"), false);
  assert.equal(isTrustedOrigin("http://localhost:5199/x", ""), false);
  assert.equal(isTrustedOrigin("不是网址"), false);
});

test("jsonProblem:纯数据放行,访问器、类实例、循环引用、非有限数字、过深嵌套都拒", () => {
  assert.equal(jsonProblem({ a: [1, "x", true, null, { b: 2 }] }), undefined);
  assert.equal(jsonProblem(Object.create(null)), undefined);
  assert.match(jsonProblem({ get a() { return 1; } }) ?? "", /访问器/);
  assert.match(jsonProblem(new Date()) ?? "", /普通对象/);
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.match(jsonProblem(loop) ?? "", /循环/);
  assert.match(jsonProblem({ n: Number.NaN }) ?? "", /有限/);
  assert.match(jsonProblem({ f: () => 1 }) ?? "", /function/);
  let deep: unknown = 0;
  for (let i = 0; i < 40; i++) deep = [deep];
  assert.match(jsonProblem(deep) ?? "", /嵌套/);
  assert.match(jsonProblem({ [Symbol("s")]: 1 }) ?? "", /symbol/);
});

test("checkIpcRequest:来源、形状、方法白名单、参数体积逐项把关", () => {
  assert.deepEqual(checkIpcRequest({ method: "session.hello" }, APP, opts), { ok: true, method: "session.hello", params: null });
  assert.deepEqual(checkIpcRequest({ method: "schedules.create", params: { cron: "0 9 * * 1-5" } }, APP, opts), { ok: true, method: "schedules.create", params: { cron: "0 9 * * 1-5" } });
  const fromWeb = checkIpcRequest({ method: "session.hello" }, "https://example.com/", opts);
  assert.equal(fromWeb.ok, false);
  assert.equal(!fromWeb.ok && fromWeb.error, "来源不是本应用页面");
  const unknown = checkIpcRequest({ method: "fs.readFile", params: {} }, APP, opts);
  assert.equal(!unknown.ok && unknown.error, "不认识的方法 fs.readFile");
  const notObj = checkIpcRequest(["session.hello"], APP, opts);
  assert.equal(!notObj.ok && notObj.error, "请求必须是对象");
  const getter = checkIpcRequest({ method: "session.hello", params: { get x() { return 1; } } }, APP, opts);
  assert.match(!getter.ok ? getter.error : "", /不是纯数据/);
  const big = checkIpcRequest({ method: "messages.send", params: { text: "x".repeat(300 * 1024) } }, APP, opts);
  assert.match(!big.ok ? big.error : "", /超过上限/);
  const dev = checkIpcRequest({ method: "session.hello" }, "http://localhost:5199/", { ...opts, devOrigin: "http://localhost:5199" });
  assert.equal(dev.ok, true);
});
