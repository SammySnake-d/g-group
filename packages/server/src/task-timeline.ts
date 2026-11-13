// U80/D21: append actual facts at the existing transaction seams. No bus replay,
// SQL triggers or reconstruction from current TaskView. Message bodies stay in chat.
import type { TaskTimelineEvent } from "@g-group/api-contract";
import type { Task, TaskEvent, TaskModelRecord, followups } from "@g-group/domain";
import { type Db, HostError, all, run } from "./db.ts";

type Actor = { kind: "user" | "contact"; id: string };
interface FactDoc {
  readonly task: Task;
  readonly roomId: string;
  readonly sourceSeq: number;
  readonly updatedAt: string;
  readonly models?: TaskModelRecord;
}
interface FollowFact {
  readonly state: followups.FollowUps;
  readonly rounds: readonly number[];
  readonly resultVer: number | null;
  readonly queued: readonly string[];
}
export interface TaskFactOrigin { readonly cause?: string; readonly actor?: Actor; readonly data?: unknown }
const snapshot = (t: Task) => ({ state: t.state, owner: t.owner, constraintVer: t.constraintVer, computeId: t.computeId });
function append(db: Db, doc: FactDoc, before: Task | null, kind: TaskTimelineEvent["kind"], cause: string, data: unknown, actor: Actor | null, at = doc.updatedAt) {
  const payload: Omit<TaskTimelineEvent, "id"> = { taskId: doc.task.id, roomId: doc.roomId, sourceSeq: doc.sourceSeq, at, kind, cause, actor, before: before ? snapshot(before) : null, after: snapshot(doc.task), data };
  run(db, "INSERT INTO gg_task_events (task_id, room_id, at, payload) VALUES (?, ?, ?, ?)", doc.task.id, doc.roomId, at, JSON.stringify(payload));
}
/** One call after each successful TaskDoc CAS; the state change and facts share its transaction. */
export function recordTaskFacts(db: Db, before: FactDoc | null, doc: FactDoc, cause: string, actor: Actor | null = null, data: unknown = null) {
  if (!before || JSON.stringify(before.task) !== JSON.stringify(doc.task)) append(db, doc, before?.task ?? null, before ? "task" : "created", cause, data, actor);
  // Only attempts actually appended now; pre-existing ledgers do not become invented old events.
  for (const attempt of (doc.models?.attempts ?? []).slice(before?.models?.attempts.length ?? 0)) {
    append(db, doc, before?.task ?? null, "model-attempt", "ComputeAttempt", attempt, null, attempt.at);
  }
}
const eventActor = (event: TaskEvent, doc: FactDoc): Actor | null => {
  if (event.kind === "Claim") return { kind: "contact", id: event.by };
  if (event.kind === "Cancel" || event.kind === "Amend" || event.kind === "UserAccept" || event.kind === "UserReject") return { kind: "user", id: event.by };
  if (event.kind === "HumanReply") return { kind: "user", id: doc.task.requester };
  if (event.kind === "Review") return { kind: "contact", id: event.reviewerId };
  return null;
};
export function recordTaskTransition(db: Db, before: FactDoc, doc: FactDoc, event: TaskEvent, origin: TaskFactOrigin = {}) {
  recordTaskFacts(db, before, doc, origin.cause ?? event.kind, origin.actor ?? eventActor(event, doc), { event, ...(origin.data === undefined ? {} : { origin: origin.data }) });
}
const followSnapshot = (f: FollowFact) => ({
  bindingVer: f.state.bindingVer,
  links: f.state.links.map((l) => ({ roomId: l.roomId, seq: l.seq, state: l.state, ver: l.ver, appliedIn: l.appliedIn, appliedVer: l.appliedVer, reboundTo: l.reboundTo })),
  pendingRollback: f.state.pendingRollback, rounds: [...f.rounds], resultVer: f.resultVer, queuedCount: f.queued.length,
});
/** Follow-up receipt, queue, accepted resume and artifact application remain separate facts. */
export function recordFollowFacts(db: Db, doc: FactDoc, before: FollowFact, next: FollowFact, cause: string, at: string, actor: Actor | null = null) {
  const prev = followSnapshot(before); const data = followSnapshot(next);
  if (JSON.stringify(prev) !== JSON.stringify(data)) append(db, doc, doc.task, "follow-up", cause, data, actor, at);
}
export function readTaskTimeline(db: Db, q: { taskId: string; cursor?: string; limit?: number }): { events: TaskTimelineEvent[]; nextCursor: string | null } {
  const limit = q.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new HostError("invalid_params", "时间线 limit 应为 1–200 的整数");
  let after = 0;
  if (q.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(q.cursor)) throw new Error("encoding");
      const bytes = Buffer.from(q.cursor, "base64url");
      if (bytes.toString("base64url") !== q.cursor) throw new Error("canonical encoding");
      const v: unknown = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(v) || v.length !== 2 || v[0] !== q.taskId || !Number.isSafeInteger(v[1]) || v[1] < 1) throw new Error("binding");
      after = v[1] as number;
    } catch { throw new HostError("invalid_params", "时间线游标无效或不属于这个任务"); }
  }
  const rows = all<{ id: number; payload: string }>(db, "SELECT id, payload FROM gg_task_events WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT ?", q.taskId, after, limit + 1);
  const events = rows.slice(0, limit).map((r) => ({ ...JSON.parse(r.payload), id: r.id }) as TaskTimelineEvent);
  return { events, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([q.taskId, events.at(-1)!.id])).toString("base64url") : null };
}
