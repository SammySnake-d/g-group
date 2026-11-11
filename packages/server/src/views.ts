// 联系人资料(AC-54)与会话文件(AC-57 文件列表与窗口联动)的读取接口。只读宿主已有状态,不建新存储:
// 预设 = 联系人文档 persona;工作记忆 = 状态笔记 note:<id>;长期记忆 = memory-store 条目概览(memory-api.ts);职责 = 承诺账本 + 在途任务 + 定时 + 所在会话。
// 文件 = 会话消息里的附件(gg_attachments)+ 本会话任务的结果(task:<id>/result);工件存储方式不在这里改。
import { readFileSync } from "node:fs";
import type { ContactProfileView, FileEntry } from "@g-group/api-contract";
import { HostError, all, getDoc, one } from "./db.ts";
import type { Host } from "./host.ts";
import { longTermMemory } from "./memory-api.ts";

const DONE_STATES = new Set(["T8_Accepted", "T10_Cancelled", "T11_Failed"]);
const DEFAULT_MAX_BYTES = 1024 * 1024;

export function contactProfile(host: Host, contactId: string): ContactProfileView {
  const doc = host.contactDoc(contactId).value;
  const note = getDoc<{ text: string }>(host.db, `note:${contactId}`);
  return {
    contact: host.contactView(doc),
    persona: doc.persona ?? "",
    memory: { stateNote: note ? { text: note.value.text, version: note.ver } : null, longTerm: longTermMemory(host, contactId) },
    duties: {
      commitments: host.listCommitments({ contactId, status: "active" }),
      tasks: host.listTasks({ contactId }).filter((t) => !DONE_STATES.has(t.state)),
      schedules: host.scheduler.list({ contactId }),
      rooms: host.roomsOfContact(contactId).map((r) => ({ roomId: r.id, kind: r.kind, title: r.title })),
    },
  };
}

function userIn(host: Host, roomId: string) {
  return host.members(roomId).some((m) => m.kind === "user" && m.id === host.userId);
}
function msgAt(host: Host, roomId: string, seq: number) {
  return one<{ at: string }>(host.db, "SELECT at FROM events WHERE session = ? AND seq = ?", `room:${roomId}`, seq)?.at ?? "";
}

function filesOf(host: Host, roomId: string): FileEntry[] {
  const out: FileEntry[] = [];
  const seen = new Set<string>();
  for (const row of all<{ seq: number; attachments: string }>(host.db, "SELECT seq, attachments FROM gg_msg WHERE room_id = ? ORDER BY seq", roomId)) {
    for (const ref of JSON.parse(row.attachments) as string[]) {
      if (seen.has(ref)) continue;
      const a = one<{ name: string; mime: string; bytes: number }>(host.db, "SELECT name, mime, bytes FROM gg_attachments WHERE ref = ?", ref);
      if (!a) continue;
      seen.add(ref);
      out.push({ ref, name: a.name, mime: a.mime, bytes: a.bytes, source: "attachment", seq: row.seq, taskId: null, at: msgAt(host, roomId, row.seq) });
    }
  }
  for (const t of host.listTasks({ roomId })) {
    const doc = host.taskDoc(t.id).value;
    if (!doc.result) continue;
    out.push({ ref: `task:${t.id}/result`, name: `${doc.title} · 结果`, mime: "text/plain", bytes: Buffer.byteLength(doc.result), source: "task-result", seq: doc.deliveredSeq ?? doc.sourceSeq, taskId: t.id, at: doc.updatedAt });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export function listFiles(host: Host, roomId: string): FileEntry[] {
  host.roomView(roomId);
  if (!userIn(host, roomId)) throw new HostError("forbidden", "你不在这个会话里");
  return filesOf(host, roomId);
}

export function readFile(host: Host, ref: string, maxBytes?: number): { ref: string; name: string; mime: string; bytes: number; encoding: "text" | "base64"; content: string; truncated: boolean } {
  const task = /^task:(.+)\/result$/.exec(ref);
  const att = task ? undefined : one<{ path: string }>(host.db, "SELECT path FROM gg_attachments WHERE ref = ?", ref);
  const taskDoc = task ? getDoc<{ result: string | null }>(host.db, `task:${task[1]}`)?.value : undefined;
  if (!att && !taskDoc?.result) throw new HostError("not_found", `没有文件 ${ref}`);
  const entry = host
    .roomsOfUser()
    .flatMap((r) => filesOf(host, r.id))
    .find((f) => f.ref === ref);
  if (!entry) throw new HostError("forbidden", "这个文件没有出现在你所在的会话里");
  const data = att ? readFileSync(att.path) : Buffer.from(taskDoc!.result!, "utf8");
  const limit = maxBytes ?? DEFAULT_MAX_BYTES;
  const cut = data.subarray(0, limit);
  const text = entry.mime.startsWith("text/") || entry.mime === "application/json";
  return { ref, name: entry.name, mime: entry.mime, bytes: data.length, encoding: text ? "text" : "base64", content: text ? cut.toString("utf8") : cut.toString("base64"), truncated: data.length > limit };
}
