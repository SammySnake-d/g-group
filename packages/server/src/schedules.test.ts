// 定时(用户 #719:定时要能用 cron 表达式;U74 常驻承诺每天 8 点、显式时区;AC-35 ① 控制指令与触发校验的宿主部分)。
// 到点送进联系人注意循环(唯一入口),联系人自己决定怎么做;宿主关着期间错过的按容差与 missedPolicy 处理,不连发。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { TimerApi } from "@g-group/kernel";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-sched-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `s${++n}.db`);

function clock(startIso: string) {
  let now = Date.parse(startIso);
  const pending = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const timers: TimerApi = {
    set(fn, ms) {
      pending.set(++id, { at: now + ms, fn });
      return id;
    },
    clear(h) {
      pending.delete(h as number);
    },
  };
  return {
    timers,
    clockMs: () => now,
    async advanceTo(iso: string, host: Host) {
      const target = Date.parse(iso);
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = Math.max(now, due[1].at);
        pending.delete(due[0]);
        due[1].fn();
        await host.idle();
      }
      now = target;
      await host.idle();
    },
  };
}
const texts = (h: Host, roomId: string) => h.listMessages(roomId, {}).messages.map((m) => `${m.sender.kind}:${m.text}`);

test("每天 8 点(上海)到点送进联系人的注意循环,联系人在会话里说话;下次时间顺延到明天", async () => {
  const c = clock("2026-11-08T23:00:00+08:00");
  const host = new Host({ file: file(), mind: () => scriptedMind(), timers: c.timers, clockMs: c.clockMs, maxDeferMs: 5 });
  const k = host.createContact({ name: "小秘" });
  const dm = host.openDm(k.id);
  const s = host.scheduler.create({ contactId: k.id, roomId: dm.id, title: "早报", cron: "0 8 * * *", tz: "Asia/Shanghai", prompt: "总结昨天的群消息" });
  assert.equal(s.nextRunAt, "2026-11-09T00:00:00.000Z");
  await c.advanceTo("2026-11-09T07:59:00+08:00", host);
  assert.deepEqual(texts(host, dm.id), [], "还没到点");
  await c.advanceTo("2026-11-09T08:00:30+08:00", host);
  assert.deepEqual(texts(host, dm.id), ["contact:定时到了:总结昨天的群消息"]);
  const after = host.scheduler.list({ contactId: k.id })[0]!;
  assert.equal(after.nextRunAt, "2026-11-10T00:00:00.000Z");
  assert.equal(after.lastRun?.status, "ok");
  await host.close();
});

test("停用后不触发;改 cron 立即重算下次时间;删除后不再出现", async () => {
  const c = clock("2026-11-08T10:00:00Z");
  const host = new Host({ file: file(), mind: () => scriptedMind(), timers: c.timers, clockMs: c.clockMs, maxDeferMs: 5 });
  const k = host.createContact({ name: "小秘" });
  const dm = host.openDm(k.id);
  const s = host.scheduler.create({ contactId: k.id, roomId: dm.id, title: "整点", cron: "0 * * * *", tz: "UTC", prompt: "报时" });
  host.scheduler.update(s.id, { enabled: false });
  await c.advanceTo("2026-11-08T12:30:00Z", host);
  assert.deepEqual(texts(host, dm.id), []);
  const re = host.scheduler.update(s.id, { enabled: true, cron: "45 * * * *" });
  assert.equal(re.nextRunAt, "2026-11-08T12:45:00.000Z");
  await c.advanceTo("2026-11-08T12:46:00Z", host);
  assert.deepEqual(texts(host, dm.id), ["contact:定时到了:报时"]);
  host.scheduler.remove(s.id);
  await c.advanceTo("2026-11-08T14:00:00Z", host);
  assert.equal(texts(host, dm.id).length, 1);
  assert.deepEqual(host.scheduler.list({}), []);
  await host.close();
});

test("宿主关着错过了:skip 记 missed 不补;run-once 只补一次,不按错过次数连发", async () => {
  const f = file();
  const c1 = clock("2026-11-08T07:00:00Z");
  const h1 = new Host({ file: f, mind: () => scriptedMind(), timers: c1.timers, clockMs: c1.clockMs, maxDeferMs: 5 });
  const k = h1.createContact({ name: "小秘" });
  const dm = h1.openDm(k.id);
  const skip = h1.scheduler.create({ contactId: k.id, roomId: dm.id, title: "跳过", cron: "0 8 * * *", tz: "UTC", prompt: "A", toleranceSec: 60, missedPolicy: "skip" });
  const once = h1.scheduler.create({ contactId: k.id, roomId: dm.id, title: "补一次", cron: "0 * * * *", tz: "UTC", prompt: "B", toleranceSec: 60, missedPolicy: "run-once" });
  await h1.close();
  // 三天后才打开:skip 错过 3 次、run-once 错过几十次
  const c2 = clock("2026-11-11T09:30:00Z");
  const h2 = new Host({ file: f, mind: () => scriptedMind(), timers: c2.timers, clockMs: c2.clockMs, maxDeferMs: 5 });
  await h2.idle();
  const msgs = texts(h2, dm.id);
  assert.equal(msgs.length, 1, "只补了 run-once 的一次");
  assert.match(msgs[0]!, /^contact:定时到了:\(补跑:原定 2026-11-08T08:00:00.000Z\)B$/);
  assert.equal(h2.scheduler.history(skip.id, 10)[0]?.status, "missed");
  assert.match(h2.scheduler.history(skip.id, 10)[0]?.error ?? "", /超过容差 60 秒/);
  assert.equal(h2.scheduler.list({}).find((x) => x.id === skip.id)?.nextRunAt, "2026-11-12T08:00:00.000Z");
  assert.equal(h2.scheduler.list({}).find((x) => x.id === once.id)?.nextRunAt, "2026-11-11T10:00:00.000Z");
  await h2.close();
});

test("服务层:预览给人话描述与接下来几次;非法 cron/时区、联系人不在会话里都被拒", async () => {
  const host = new Host({ file: file(), mind: () => scriptedMind(), maxDeferMs: 5 });
  const svc = createService(host);
  const ok = await svc.handle("schedules.preview", { cron: "30 9 * * 1-5", tz: "Asia/Shanghai", count: 2 });
  assert.ok(ok.ok);
  const v = ok.value as { valid: boolean; description: string; next: string[] };
  assert.equal(v.valid, true);
  assert.equal(v.description, "每周一、二、三、四、五 09:30(Asia/Shanghai)");
  assert.equal(v.next.length, 2);
  const bad = await svc.handle("schedules.preview", { cron: "0 25 * * *", tz: "Asia/Shanghai" });
  assert.deepEqual(bad, { ok: true, value: { valid: false, description: null, next: [], error: "时字段「25」超出范围 0–23" } });
  const k = host.createContact({ name: "A" });
  const other = host.createContact({ name: "B" });
  const dm = host.openDm(k.id);
  const notMember = await svc.handle("schedules.create", { clientActionId: "s1", contactId: other.id, roomId: dm.id, title: "x", cron: "0 8 * * *", tz: "UTC", prompt: "x" });
  assert.equal(!notMember.ok && notMember.error.code, "forbidden");
  const badTz = await svc.handle("schedules.create", { clientActionId: "s2", contactId: k.id, roomId: dm.id, title: "x", cron: "0 8 * * *", tz: "Mars/Base", prompt: "x" });
  assert.equal(!badTz.ok && badTz.error.message, "不认识的时区 Mars/Base");
  const created = await svc.handle("schedules.create", { clientActionId: "s3", contactId: k.id, roomId: dm.id, title: "早报", cron: "0 8 * * *", tz: "UTC", prompt: "x" });
  assert.ok(created.ok);
  const list = await svc.handle("schedules.list", { roomId: dm.id });
  assert.ok(list.ok);
  assert.equal((list.value as { schedules: unknown[] }).schedules.length, 1);
  await host.close();
});
