// 非测试套件的已知缺口探针：真正的 reply 已提交后，contact.activity 是否发出 replying→idle。
// 预期当前集成基线退出1；不把thinking→idle冒充replying，不在本切片改共同生产写点。
import assert from "node:assert/strict";
import { setup, cleanupKit } from "../src/test-kit.ts";
const s = setup({ mind: () => ({ async round(i) {
  return { actions: i.fresh.flatMap(f => f.kind === "message" ? [{ kind: "reply" as const, roomId: f.roomId, text: "实际回复已提交", replyToSeq: f.seq }] : []), stateNote: null };
} }) });
const activity: { activity: string; roomId: string | null }[] = [];
const off = s.svc.subscribe(e => { if (e.type === "contact.activity") activity.push({ activity: e.activity, roomId: e.roomId }); });
try {
  const c = s.host.createContact({ name: "回复活动探针" }); const dm = s.host.openDm(c.id);
  const send = await s.svc.handle("messages.send", { roomId: dm.id, clientActionId: "replying-probe", text: "请实际回复" }); assert.ok(send.ok);
  await s.host.idle(); await new Promise(r => setTimeout(r, 20)); await s.host.idle();
  const replies = s.host.listMessages(dm.id, {}).messages.filter(m => m.sender.kind === "contact");
  console.log(JSON.stringify({ replies: replies.map(m => ({ seq: m.seq, text: m.text })), activity }));
  assert.equal(replies.length, 1);
  const replying = activity.findIndex(e => e.activity === "replying" && e.roomId === dm.id);
  assert.ok(replying >= 0 && activity.slice(replying + 1).some(e => e.activity === "idle" && e.roomId === null), "真实replying→idle尚无生产发射，需活动生命周期owner修复");
} finally { off(); await s.host.close(); cleanupKit(); }
