import type { Task, TaskModelRecord } from "@g-group/domain";
import type { InboundMessage } from "@g-group/kernel";
import type { ArtifactRef } from "./artifacts.ts";
import { type Db, HostError, all, getDoc, listDocs, one } from "./db.ts";

export interface TaskDoc {
  readonly task: Task;
  readonly title: string;
  readonly roomId: string;
  readonly sourceSeq: number;
  readonly brief: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result: string | null;
  readonly causeRoots?: readonly string[];
  readonly description?: string;
  readonly deliveredSeq?: number | null;
  readonly models?: TaskModelRecord;
  readonly artifacts?: readonly ArtifactRef[];
}

export function requireTaskContact(db: Db, roomId: string, contactId: string): void {
  if (!one(db, "SELECT 1 FROM gg_members WHERE room_id = ? AND kind = 'contact' AND member_id = ?", roomId, contactId)) {
    throw new HostError("invalid_params", "这位联系人不在这个会话里");
  }
}

export function taskIdForAction(db: Db, key: string): string | null {
  const row = one<{ payload: string }>(db, "SELECT payload FROM actions WHERE action_id = ?", key);
  return row ? (JSON.parse(row.payload) as { taskId: string }).taskId : null;
}

export function readTaskBoardItem(db: Db, id: string, claimable: Map<string, number | undefined>,
  canRead: (roomId: string) => boolean, ownerName: (id: string) => string): string | null {
  const current = getDoc<TaskDoc>(db, `task:${id}`);
  if (!current || !canRead(current.value.roomId)) return null;
  const { task, title, brief } = current.value;
  if (task.state === "T1_Open") claimable.set(id, current.ver);
  return JSON.stringify({
    taskId: id, title, description: brief, state: task.state, revision: current.ver,
    owner: task.owner ? ownerName(task.owner) : null,
  });
}

export function claimRefusal(db: Db, contactId: string, source: InboundMessage, kind: "existing-task" | "new-task"): string | null {
  const rows = all<{ member_id: string }>(db, "SELECT member_id FROM gg_members WHERE room_id = ? AND kind = 'contact'", source.roomId);
  const contacts = new Set(rows.map(row => row.member_id));
  const mentioned = source.mentions.filter(id => contacts.has(id));
  if (mentioned.length > 0 && !mentioned.includes(contactId)) {
    return `这条消息 @ 的是别的联系人,不是你(${source.roomId} #${source.seq})`;
  }
  if (kind === "existing-task") return null;
  const taken = listDocs<TaskDoc>(db, "task:").find(({ value: { roomId, sourceSeq, task } }) =>
    roomId === source.roomId && sourceSeq === source.seq && task.owner !== null
    && task.owner !== contactId && task.state !== "T10_Cancelled" && task.state !== "T11_Failed");
  return taken ? `${source.roomId} #${source.seq} 已由联系人 ${taken.value.task.owner} 接手(任务 ${taken.value.task.id})` : null;
}
