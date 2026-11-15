// PR #98 第 2 轮探针:带在途任务的「移出中」路径(rooms.removeMember stopTasks)。真实 Host + service,脚本化 Compute(不调模型)。
// 用法: node probe-leaving-r2.mjs <仓库绝对路径>
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { pathToFileURL } from "node:url";
const repo = process.argv[2];
const imp = (p) => import(pathToFileURL(path.join(repo, p)));
const { Host } = await imp("packages/server/src/host.ts");
const { createService } = await imp("packages/server/src/service.ts");
const { all } = await imp("packages/server/src/db.ts");
const { scriptedCompute } = await imp("packages/server/src/fakes.ts");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr98-r2-leaving-"));
const ASK = /^每 (\d+) 条消息总结一次$/;
const mind = () => () => ({ async round(input) { const actions = []; for (const f of input.fresh) { if (f.kind !== "message") continue; const m = ASK.exec(f.text); if (!m) continue;
  actions.push({ kind: "commit", roomId: f.roomId, sourceSeq: f.seq, text: f.text, taskId: null, everyNMessages: Number(m[1]) }); actions.push({ kind: "reply", roomId: f.roomId, text: "好,记下了", replyToSeq: f.seq }); } return { actions, stateNote: null }; } });
async function settle(host) { for (let i = 0; i < 400; i++) { await host.idle(); await new Promise((r) => setTimeout(r, 5)); if (!host.loop.busy()) return; } throw new Error("没安静下来"); }
const contact = (id) => ({ kind: "contact", id });
let finish; const stopped = new Promise((r) => (finish = r));
const compute = scriptedCompute({ script: () => [{ kind: "started", sessionId: "s", resumed: false }], quiesce: async () => { await stopped; return { ok: true, killed: 1 }; } });
const h = new Host({ file: path.join(dir, "l.db"), mind: mind(), compute: () => compute.adapter, maxDeferMs: 5 });
const svc = createService(h);
const trig = () => all(h.db, "SELECT covered_seq, status, closed_reason FROM gg_count_triggers");
const wins = () => all(h.db, "SELECT from_seq, to_seq, status FROM gg_count_windows ORDER BY to_seq");
const last = () => all(h.db, "SELECT max(seq) AS s FROM events WHERE session LIKE 'room:%'")[0].s;
const steps = []; const step = (label, d = {}) => steps.push({ label, lastSeq: last(), triggers: trig(), windows: wins(), ...d });
let defect = null;
try {
  const a = h.createContact({ name: "小记" }); const g = h.createGroup("研发群", [contact(a.id)]);
  h.send({ roomId: g.id, clientActionId: "ask", text: "每 2 条消息总结一次" }); await settle(h);
  for (let i = 1; i <= 3; i++) h.send({ roomId: g.id, clientActionId: `m${i}`, text: `第 ${i} 条` }); await settle(h);
  const t = await svc.handle("tasks.create", { clientActionId: "t1", roomId: g.id, title: "长活", ownerContactId: a.id }); await settle(h);
  step("有在途任务,已有 1 个 pending 窗口", { taskOk: t.ok });
  const rm = await svc.handle("rooms.removeMember", { roomId: g.id, member: contact(a.id), stopTasks: true });
  step("removeMember stopTasks 返回的那一刻(移出中)", { ok: rm.ok, leaving: rm.value?.leavingMembers?.map((m) => m.id) });
  const atBegin = { status: trig()[0].status, pending: wins().filter((w) => w.status === "pending").length };
  finish(); await settle(h); await new Promise((r) => setTimeout(r, 100)); await settle(h);
  const members = all(h.db, "SELECT member_id FROM gg_members WHERE room_id = ? AND kind = 'contact'", g.id).length;
  step("停止确认放行、移出完成", { contactMembers: members });
  const back = await svc.handle("rooms.addMembers", { roomId: g.id, members: [contact(a.id)] });
  const view = (await svc.handle("commitments.list", { roomId: g.id })).value.commitments.map((c) => c.trigger);
  step("拉回(不发新消息)", { ok: back.ok, error: back.error, view });
  h.send({ roomId: g.id, clientActionId: "m4", text: "拉回后一条" }); await settle(h);
  step("拉回后再发 1 条");
  const end = { status: trig()[0].status, windows: wins().map((w) => w.status) };
  defect = { closedAtBegin: atBegin.status === "closed" && atBegin.pending === 0, revivedAfterRejoin: !(end.status === "closed" && end.windows.length === 1 && end.windows[0] === "cancelled"), atBegin, end };
} finally { finish(); compute.close(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
console.log(JSON.stringify({ repo, defect, steps }, null, 1));
process.exit(defect && (!defect.closedAtBegin || defect.revivedAfterRejoin) ? 1 : 0);
