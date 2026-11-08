// 群聊派活驱动:CLI `group` 命令与真实运行用。建(或复用)群与联系人 → 用户在群里 @ 某联系人发一条 → 等联系人与任务都收尾;
// 另给 AC-03 发言者核对:群消息的发言者只能是用户或联系人,Compute 实例不能出现在发言者里。
import type { ContactView, MessageView, RoomView } from "@g-group/api-contract";
import { all } from "./db.ts";
import type { Host } from "./host.ts";

export interface DriveRun {
  readonly sent: MessageView;
  readonly transcript: MessageView[];
  readonly timedOut: boolean;
}
export interface SenderOffender {
  readonly seq: number;
  readonly sender: MessageView["sender"];
  readonly reason: string;
}

const RUNNING: ReadonlySet<string> = new Set(["T1_Open", "T2_Claimed", "T3_Running"]);

/** 按名字建(或复用)联系人与群;群按标题复用,缺的成员补进去。 */
export function ensureGroup(host: Host, title: string, names: readonly string[]): { room: RoomView; contacts: ContactView[] } {
  const contacts = names.map((n) => host.listContacts().find((c) => c.name === n) ?? host.createContact({ name: n }));
  const refs = contacts.map((c) => ({ kind: "contact" as const, id: c.id }));
  const existing = host.roomsOfUser().find((r) => r.kind === "group" && r.title === title);
  if (!existing) return { room: host.createGroup(title, refs), contacts };
  const missing = refs.filter((m) => !existing.members.some((x) => x.kind === m.kind && x.id === m.id));
  return { room: missing.length ? host.addMembers(existing.id, missing) : existing, contacts };
}

/** 用户在会话里发一条(mention 按联系人名字 @),等到联系人空闲、没有执行中的任务;超过 timeoutMs 记 timedOut。 */
export async function sendAndWait(host: Host, roomId: string, text: string, o: { mention?: string; timeoutMs: number; settleMs?: number }): Promise<DriveRun> {
  const room = host.roomView(roomId);
  let mentions: { id: string; source: "manual" }[] = [];
  if (o.mention !== undefined) {
    const c = host.listContacts().find((x) => x.name === o.mention && room.members.some((m) => m.kind === "contact" && m.id === x.id));
    if (!c) throw new Error(`群里没有联系人「${o.mention}」`);
    mentions = [{ id: c.id, source: "manual" }];
  }
  const sent = host.send({ roomId, clientActionId: `drive-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, text, mentions });
  const deadline = Date.now() + o.timeoutMs;
  const step = o.settleMs ?? 500;
  let timedOut = false;
  for (;;) {
    await Promise.race([host.idle(), new Promise((r) => setTimeout(r, step))]);
    await new Promise((r) => setTimeout(r, step));
    const running = host.listTasks({ roomId }).some((t) => RUNNING.has(t.state));
    if (!running && !host.loop.busy()) {
      // 再看一眼:Compute 收尾事件可能刚把联系人唤醒
      await new Promise((r) => setTimeout(r, step));
      if (!host.loop.busy() && !host.listTasks({ roomId }).some((t) => RUNNING.has(t.state))) break;
    }
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
  }
  return { sent, transcript: host.listMessages(roomId, { limit: 500 }).messages, timedOut };
}

/** AC-03:逐条核对会话消息的发言者。 */
export function senderAudit(host: Host, roomId: string): { ok: boolean; checked: number; offenders: SenderOffender[] } {
  const computeIds = new Set(all<{ compute_id: string }>(host.db, "SELECT compute_id FROM gg_compute").map((r) => r.compute_id));
  const msgs = host.listMessages(roomId, { limit: 500 }).messages;
  const offenders: SenderOffender[] = [];
  for (const m of msgs) {
    if (m.sender.kind !== "user" && m.sender.kind !== "contact") offenders.push({ seq: m.seq, sender: m.sender, reason: "发言者不是用户或联系人" });
    else if (computeIds.has(m.sender.id)) offenders.push({ seq: m.seq, sender: m.sender, reason: "发言者是 Compute 实例" });
  }
  return { ok: offenders.length === 0, checked: msgs.length, offenders };
}
