// AC-36 ⑤ F11 休眠门参数合同(T-177 B-F11):宿主在构造运行台账时用 checkWakePolicy 校验参数,不合格当场拒绝——
// 不能交给 wakeTick,它对非法参数静默退回初始态,休眠检测会永久失效。
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_WAKE_POLICY, checkWakePolicy } from "./retry-policy.ts";

test("F11 休眠门参数:不给取默认值,只给一项时另一项取默认,返回冻结副本", () => {
  const none = checkWakePolicy(undefined);
  assert.deepEqual(none, { ok: true, policy: { jumpMs: 60000, graceMs: 180000 } });
  assert.ok(none.ok && none.policy === DEFAULT_WAKE_POLICY, "不给参数直接用内核默认值");
  const grace = checkWakePolicy({ graceMs: 300000 });
  assert.deepEqual(grace, { ok: true, policy: { jumpMs: 60000, graceMs: 300000 } });
  const jump = checkWakePolicy({ jumpMs: 90000 });
  assert.deepEqual(jump, { ok: true, policy: { jumpMs: 90000, graceMs: 180000 } });
  assert.ok(jump.ok && Object.isFrozen(jump.policy));
  const zero = checkWakePolicy({ jumpMs: 61000.5, graceMs: 0 });
  assert.deepEqual(zero, { ok: true, policy: { jumpMs: 61000.5, graceMs: 0 } }, "jumpMs 可以是非整数,graceMs 可以是 0(不宽限)");
});

test("F11 休眠门参数:jumpMs 不是正数、graceMs 不是非负整数、不是对象、带访问器,一律拒收并给原因,不调用访问器", () => {
  const reasons = [
    { jumpMs: 0 },
    { jumpMs: -1 },
    { jumpMs: "60000" },
    { graceMs: -1 },
    { graceMs: 1.5 },
  ].map((p) => checkWakePolicy(p));
  for (const r of reasons) assert.deepEqual(r, { ok: false, reason: "jumpMs 必须是正数、graceMs 必须是非负整数" });
  // 无穷大、NaN 在普通数据合同那一层就拒(plainData)
  assert.deepEqual(checkWakePolicy({ jumpMs: Number.POSITIVE_INFINITY }), { ok: false, reason: "休眠门参数.jumpMs:数字必须有限" });
  assert.deepEqual(checkWakePolicy({ graceMs: Number.NaN }), { ok: false, reason: "休眠门参数.graceMs:数字必须有限" });
  const notObj = [null, 60000, [60000, 180000]].map((p) => checkWakePolicy(p));
  for (const r of notObj) assert.equal(r.ok, false);
  assert.deepEqual(notObj.map((r) => (r.ok ? "" : r.reason)), ["休眠门参数 必须是对象", "休眠门参数 必须是对象", "休眠门参数 必须是对象"]);
  let called = 0;
  const getter = checkWakePolicy(
    Object.defineProperty({}, "jumpMs", {
      enumerable: true,
      get() {
        called++;
        return 60000;
      },
    }),
  );
  assert.equal(getter.ok, false);
  assert.equal(called, 0, "访问器不被调用");
});
