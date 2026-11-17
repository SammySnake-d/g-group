// AC-53 定时三视角(U95/D28.2):群视角只看本群、联系人视角看它在各群的定时与所属群、总览不必逐个点头像就有所有人的定时;
// 改同一条后三个视角读到同一新值,其他条不变。总览排序为参数(默认下次触发时间,其次创建顺序;D28 待确认 ② 排序待定)。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { ScheduleView } from "@g-group/api-contract";
import { scriptedMind } from "./fakes.ts";
import { Host } from "./host.ts";
import { createService } from "./service.ts";

const dir = mkdtempSync(path.join(tmpdir(), "gg-schv-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;

function opts() {
  let n = 0;
  return {
    file: path.join(dir, `v${++fileNo}.db`),
    mind: () => scriptedMind(),
    clockMs: () => Date.parse("2026-11-09T00:00:00Z"),
    timers: { set: () => 0, clear: () => {} },
    newId: (p: string) => `${p}-${String(++n).padStart(3, "0")}`,
    maxDeferMs: 5,
  };
}
async function seed(host: Host) {
  const svc = createService(host);
  const x = host.createContact({ name: "小X" });
  const y = host.createContact({ name: "小Y" });
  const members = [{ kind: "contact" as const, id: x.id }, { kind: "contact" as const, id: y.id }];
  const a = host.createGroup("群A", members);
  const b = host.createGroup("群B", members);
  const mk = (contactId: string, roomId: string, title: string, cron: string) => host.scheduler.create({ contactId, roomId, title, cron, tz: "UTC", prompt: title });
  // 创建顺序:XA, YA, XB, YB;下次触发:YA 07:00 < XB 08:00 < XA 09:00 < YB 10:00
  const xa = mk(x.id, a.id, "X在A", "0 9 * * *");
  const ya = mk(y.id, a.id, "Y在A", "0 7 * * *");
  const xb = mk(x.id, b.id, "X在B", "0 8 * * *");
  const yb = mk(y.id, b.id, "Y在B", "0 10 * * *");
  const list = async (q: Record<string, unknown>): Promise<ScheduleView[]> => {
    const r = await svc.handle("schedules.list", q);
    assert.ok(r.ok, JSON.stringify(r));
    return (r.value as { schedules: ScheduleView[] }).schedules;
  };
  return { svc, x, y, a, b, xa, ya, xb, yb, list };
}

test("三视角:群 A 只有 A 的定时;联系人 X 有它在 A、B 的定时并带所属群名;总览含所有人并带联系人名,默认按下次触发排序", async () => {
  const host = new Host(opts());
  const { x, y, a, b, xa, ya, xb, yb, list } = await seed(host);
  const roomA = await list({ roomId: a.id });
  assert.deepEqual(roomA.map((s) => s.id), [ya.id, xa.id]);
  assert.deepEqual(roomA.map((s) => s.roomId), [a.id, a.id]);
  const ofX = await list({ contactId: x.id });
  assert.deepEqual(ofX.map((s) => [s.id, s.roomId, s.roomTitle]), [[xb.id, b.id, "群B"], [xa.id, a.id, "群A"]]);
  const all = await list({});
  assert.deepEqual(all.map((s) => [s.id, s.contactName, s.roomTitle, s.nextRunAt]), [
    [ya.id, "小Y", "群A", "2026-11-09T07:00:00.000Z"],
    [xb.id, "小X", "群B", "2026-11-09T08:00:00.000Z"],
    [xa.id, "小X", "群A", "2026-11-09T09:00:00.000Z"],
    [yb.id, "小Y", "群B", "2026-11-09T10:00:00.000Z"],
  ]);
  assert.deepEqual((await list({ order: "created" })).map((s) => s.id), [xa.id, ya.id, xb.id, yb.id]);
  assert.deepEqual((await list({ contactId: y.id, roomId: b.id })).map((s) => s.id), [yb.id]);
  // 停用的没有下次触发时间,默认排序排在最后
  host.scheduler.update(ya.id, { enabled: false });
  assert.deepEqual((await list({})).map((s) => s.id), [xb.id, xa.id, yb.id, ya.id]);
  await host.close();
});

test("仅修改 X 在 A 的定时:群 A、联系人 X、总览三个视角读到同一新值,B 与其他定时不变", async () => {
  const host = new Host(opts());
  const { x, a, xa, list } = await seed(host);
  const before = await list({});
  const updated = host.scheduler.update(xa.id, { title: "X在A-改", cron: "0 6 * * *" });
  assert.equal(updated.nextRunAt, "2026-11-09T06:00:00.000Z");
  const views = [await list({ roomId: a.id }), await list({ contactId: x.id }), await list({})];
  for (const v of views) {
    const hit = v.find((s) => s.id === xa.id);
    assert.deepEqual(hit, updated);
    assert.deepEqual([hit?.title, hit?.roomTitle, hit?.contactName], ["X在A-改", "群A", "小X"]);
    assert.equal(v[0]?.id, xa.id, "改到 06:00 后排在最前");
  }
  const after_ = await list({});
  assert.deepEqual(after_.filter((s) => s.id !== xa.id), before.filter((s) => s.id !== xa.id));
  await host.close();
});
