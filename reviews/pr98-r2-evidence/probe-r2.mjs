// PR #98 第 2 轮独立探针(审查人 Claude)。真实 Host + service 入口,规则替身脑子(不调模型),临时 SQLite 库。
// 用法: node probe-r2.mjs <仓库绝对路径>
// 每个场景输出观察到的 SQL 状态与判定;任何场景出现「应关闭的旧触发又生效」→ 退出 1。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
const imp = (p) => import(pathToFileURL(path.join(repo, p)));
const { Host } = await imp("packages/server/src/host.ts");
const { createService } = await imp("packages/server/src/service.ts");
const { all, tx } = await imp("packages/server/src/db.ts");
const { scriptedCompute } = await imp("packages/server/src/fakes.ts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr98-r2-probe-"));
let n = 0;
const file = () => path.join(dir, `p${++n}.db`);
const ASK = /^每 (\d+) 条消息总结一次$/;
const mind = () => () => ({
  async round(input) {
    const actions = [];
    for (const f of input.fresh) {
      if (f.kind !== "message") continue;
      const m = ASK.exec(f.text);
      if (!m) continue;
      actions.push({ kind: "commit", roomId: f.roomId, sourceSeq: f.seq, text: f.text, taskId: null, everyNMessages: Number(m[1]) });
      actions.push({ kind: "reply", roomId: f.roomId, text: "好,记下了", replyToSeq: f.seq });
    }
    return { actions, stateNote: null };
  },
});
async function settle(host) {
  for (let i = 0; i < 400; i++) { await host.idle(); await new Promise((r) => setTimeout(r, 5)); if (!host.loop.busy()) return; }
  throw new Error("没安静下来");
}
const contact = (id) => ({ kind: "contact", id });
const trig = (h) => all(h.db, "SELECT room_id, every_n, covered_seq, status, closed_reason FROM gg_count_triggers ORDER BY created_at, id");
const wins = (h) => all(h.db, "SELECT w.from_seq, w.to_seq, w.status, t.room_id FROM gg_count_windows w JOIN gg_count_triggers t ON t.id = w.trigger_id ORDER BY t.created_at, w.to_seq");
const view = async (svc, roomId) => (await svc.handle("commitments.list", { roomId })).value.commitments.map((c) => ({ status: c.status, trigger: c.trigger }));
const call = async (svc, method, params) => { const r = await svc.handle(method, params); return r.ok ? { ok: true } : { ok: false, error: r.error }; };

const results = [];
async function scenario(name, fn) {
  const rec = { name, steps: [] };
  const step = (label, data) => rec.steps.push({ label, ...data });
  const hosts = [];
  try { rec.defect = await fn(step, (h) => { hosts.push(h); return h; }); }
  catch (e) { rec.error = String(e?.stack ?? e); }
  finally { for (const h of hosts) { try { await h.close(); } catch { /* 已关 */ } } }
  results.push(rec);
}
const open = (f) => new Host({ file: f, mind: mind(), maxDeferMs: 5 });
async function seed(h, svc, title = "研发群") {
  const a = h.createContact({ name: "小记" });
  const g = h.createGroup(title, [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 2 条消息总结一次" });
  await settle(h);
  for (let i = 1; i <= 3; i++) h.send({ roomId: g.id, clientActionId: `m${i}`, text: `第 ${i} 条` });
  await settle(h);
  return { a, g };
}

// S1:第 1 轮 CORR-001 原路径——移出后不发消息立即拉回,再发一条
await scenario("S1 rooms.removeMember 后立即 rooms.addMembers", async (step, keep) => {
  const h = keep(open(file())); const svc = createService(h);
  const { a, g } = await seed(h, svc);
  step("登记 N=2 后发 3 条", { triggers: trig(h), windows: wins(h) });
  step("removeMember", { r: await call(svc, "rooms.removeMember", { roomId: g.id, member: contact(a.id) }), triggers: trig(h), windows: wins(h) });
  step("addMembers", { r: await call(svc, "rooms.addMembers", { roomId: g.id, members: [contact(a.id)] }), triggers: trig(h), view: await view(svc, g.id) });
  h.send({ roomId: g.id, clientActionId: "m4", text: "拉回后一条" }); await settle(h);
  step("拉回后再发 1 条", { triggers: trig(h), windows: wins(h), view: await view(svc, g.id) });
  const t = trig(h)[0]; const w = wins(h);
  return !(t.status === "closed" && w.length === 1 && w[0].status === "cancelled");
});

// S2:跨重启——移出拉回后关宿主重开(启动 reconcile),再发两条
await scenario("S2 移出拉回后重启宿主", async (step, keep) => {
  const f = file(); const h1 = keep(open(f)); const svc1 = createService(h1);
  const { a, g } = await seed(h1, svc1);
  await call(svc1, "rooms.removeMember", { roomId: g.id, member: contact(a.id) });
  await call(svc1, "rooms.addMembers", { roomId: g.id, members: [contact(a.id)] });
  step("移出拉回后", { triggers: trig(h1), windows: wins(h1) });
  await h1.close();
  const h2 = keep(open(f)); const svc2 = createService(h2); await settle(h2);
  h2.send({ roomId: g.id, clientActionId: "r1", text: "重启后一" }); h2.send({ roomId: g.id, clientActionId: "r2", text: "重启后二" }); await settle(h2);
  step("重启并再发 2 条", { triggers: trig(h2), windows: wins(h2), view: await view(svc2, g.id) });
  const t = trig(h2)[0]; const w = wins(h2);
  return !(t.status === "closed" && w.length === 1 && w[0].status === "cancelled");
});

// S3:别的房间与已结算窗口保持原值
await scenario("S3 同一联系人两个群:移出一群,二群触发与一群已结算窗口不受影响", async (step, keep) => {
  const h = keep(open(file())); const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const g1 = h.createGroup("一群", [contact(a.id)]); const g2 = h.createGroup("二群", [contact(a.id)]);
  h.send({ roomId: g1.id, clientActionId: "a1", text: "每 2 条消息总结一次" }); h.send({ roomId: g2.id, clientActionId: "a2", text: "每 2 条消息总结一次" }); await settle(h);
  for (let i = 1; i <= 4; i++) h.send({ roomId: g1.id, clientActionId: `x${i}`, text: `一群 ${i}` });
  for (let i = 1; i <= 2; i++) h.send({ roomId: g2.id, clientActionId: `y${i}`, text: `二群 ${i}` });
  await settle(h);
  const t1 = all(h.db, "SELECT id FROM gg_count_triggers WHERE room_id = ?", g1.id)[0];
  const first = all(h.db, "SELECT to_seq FROM gg_count_windows WHERE trigger_id = ? ORDER BY to_seq", t1.id)[0];
  const settled = tx(h.db, () => h.countTriggers.settleWindowTx(t1.id, first.to_seq, "done"));
  step("两群各自冻结,一群第 1 个窗口已结算", { settled, windows: wins(h).map((w) => [w.room_id === g1.id ? "g1" : "g2", w.status]) });
  await call(svc, "rooms.removeMember", { roomId: g1.id, member: contact(a.id) });
  const tr = trig(h).map((t) => [t.room_id === g1.id ? "g1" : "g2", t.status, t.closed_reason]);
  const ws = wins(h).map((w) => [w.room_id === g1.id ? "g1" : "g2", w.status]);
  step("移出一群后", { triggers: tr, windows: ws });
  const sorted = (x) => JSON.stringify([...x].map((e) => JSON.stringify(e)).sort());
  return !(sorted(tr) === sorted([["g1", "closed", "联系人已不在这个会话"], ["g2", "active", null]]) && sorted(ws) === sorted([["g1", "done"], ["g1", "cancelled"], ["g2", "pending"]]));
});

// S4:群解散——不发新消息就应持久关闭、pending 取消
await scenario("S4 rooms.dissolve 后不发消息", async (step, keep) => {
  const h = keep(open(file())); const svc = createService(h);
  const { g } = await seed(h, svc);
  step("dissolve", { r: await call(svc, "rooms.dissolve", { roomId: g.id, clientActionId: "d1" }), triggers: trig(h), windows: wins(h) });
  const t = trig(h)[0]; const w = wins(h);
  return !(t.status === "closed" && t.closed_reason === "会话已解散" && w[0].status === "cancelled");
});

// S5:删除联系人(contacts.remove 会把它从所有群移出)后不发消息立即拉回,再发一条
await scenario("S5 contacts.remove 后立即 rooms.addMembers", async (step, keep) => {
  const h = keep(open(file())); const svc = createService(h);
  const { a, g } = await seed(h, svc);
  step("contacts.remove", { r: await call(svc, "contacts.remove", { contactId: a.id }), members: all(h.db, "SELECT kind, member_id FROM gg_members WHERE room_id = ?", g.id).length, triggers: trig(h), windows: wins(h), view: await view(svc, g.id) });
  const back = await call(svc, "rooms.addMembers", { roomId: g.id, members: [contact(a.id)] });
  step("addMembers", { r: back, triggers: trig(h), view: await view(svc, g.id) });
  h.send({ roomId: g.id, clientActionId: "m4", text: "拉回后一条" }); await settle(h);
  step("再发 1 条", { triggers: trig(h), windows: wins(h), view: await view(svc, g.id) });
  const t = trig(h)[0]; const w = wins(h);
  return !(t.status === "closed" && w.every((x) => x.status !== "pending") && w.length === 1);
});

// S6:删除联系人后不拉回、不发消息:触发与 pending 是否已持久关闭
await scenario("S6 contacts.remove 后不发消息(只看是否持久关闭)", async (step, keep) => {
  const h = keep(open(file())); const svc = createService(h);
  const { a, g } = await seed(h, svc);
  await call(svc, "contacts.remove", { contactId: a.id });
  step("contacts.remove 后", { triggers: trig(h), windows: wins(h), view: await view(svc, g.id) });
  const t = trig(h)[0]; const w = wins(h);
  return !(t.status === "closed" && w[0].status === "cancelled");
});

// S7:私聊里的触发——删除联系人后(私聊成员行保留)继续在私聊发 2 条
await scenario("S7 私聊触发:contacts.remove 后在私聊再发 2 条", async (step, keep) => {
  const h = keep(open(file())); const svc = createService(h);
  const a = h.createContact({ name: "小记" });
  const dm = h.openDm(a.id);
  h.send({ roomId: dm.id, clientActionId: "ask", text: "每 2 条消息总结一次" }); await settle(h);
  step("私聊登记后", { triggers: trig(h) });
  if (trig(h).length === 0) return null;
  step("contacts.remove", { r: await call(svc, "contacts.remove", { contactId: a.id }), triggers: trig(h) });
  const sent = [];
  for (let i = 1; i <= 2; i++) { try { h.send({ roomId: dm.id, clientActionId: `d${i}`, text: `删后 ${i}` }); sent.push("ok"); } catch (e) { sent.push(String(e.message ?? e)); } }
  await settle(h);
  step("删后在私聊发 2 条", { sent, triggers: trig(h), windows: wins(h) });
  return wins(h).length > 0;
});

// S8:同一个群两个联系人各有触发——移出其中一个,另一个的触发与窗口保持原值
await scenario("S8 同群两个联系人:移出甲,乙的触发不受影响", async (step, keep) => {
  const h = keep(open(file())); const svc = createService(h);
  const a = h.createContact({ name: "甲" }); const b = h.createContact({ name: "乙" });
  const g = h.createGroup("研发群", [contact(a.id), contact(b.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 2 条消息总结一次" }); await settle(h);
  const who = () => all(h.db, "SELECT contact_id, status, closed_reason FROM gg_count_triggers ORDER BY contact_id").map((t) => [t.contact_id === a.id ? "甲" : "乙", t.status, t.closed_reason]);
  step("登记后", { triggers: who() });
  if (who().length !== 2) return null;
  step("removeMember 甲", { r: await call(svc, "rooms.removeMember", { roomId: g.id, member: contact(a.id) }), triggers: who() });
  const t = Object.fromEntries(who().map((x) => [x[0], x[1]]));
  return !(t["甲"] === "closed" && t["乙"] === "active");
});

fs.rmSync(dir, { recursive: true, force: true });
const summary = results.map((r) => ({ name: r.name, defect: r.defect ?? null, error: r.error ? r.error.split("\n")[0] : undefined }));
console.log(JSON.stringify({ repo, summary, results }, null, 1));
process.exit(results.some((r) => r.defect === true) ? 1 : results.some((r) => r.error) ? 3 : 0);
