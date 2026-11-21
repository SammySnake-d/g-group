import {
  compactMaterial, planMemoryWrite, validateCapture,
  type ContactCompactor, type ContactProfile, type Inbound, type InboundMessage, type MemoryEntry,
  type MindAction, type ReflectResult, type ReflectSource, type UsageSink,
} from "@g-group/kernel";
import { renderInbound } from "./assemble.ts";
import { getDoc, putDoc, tx, type Db } from "./db.ts";
import { deterministicSummary, MAX_SUMMARY_BYTES } from "./compaction-summary.ts";
import { MemoryCoverage, type CaptureWrite } from "./memory-coverage.ts";

export const PERSONA_ANCHOR = "persona-suggestion";
export type PendingBatch = { id: string; inputs: Inbound[] };
type PendingNote = { inputs: Inbound[]; batches?: PendingBatch[] };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pendingKey = (id: string) => `note-pending:${id}`;
export function readPendingNote(db: Db, id: string): { ver: number; batches: PendingBatch[] } {
  const doc = getDoc<PendingNote>(db, pendingKey(id));
  return {
    ver: doc?.ver ?? 0,
    batches: doc?.value.batches ?? (doc?.value.inputs.length ? [{ id: "legacy", inputs: doc.value.inputs }] : []),
  };
}

export function writePendingNote(db: Db, id: string, ver: number, batches: PendingBatch[]) {
  putDoc(db, pendingKey(id), ver, { inputs: batches.flatMap(b => b.inputs), batches });
}

export function scrubPendingNote(db: Db, id: string, visible: (inputs: readonly Inbound[]) => Inbound[]) {
  const { ver, batches } = readPendingNote(db, id);
  const clean = batches.map(b => ({ id: b.id, inputs: visible(b.inputs) })).filter(b => b.inputs.length);
  if (!same(clean, batches)) writePendingNote(db, id, ver, clean);
}

export function formatMemoryProvenance(e: MemoryEntry): string {
  return `(溯源: 更新于 ${e.updatedAt}${e.source ? ` · 来源 ${e.source.roomId}#${e.source.seq}` : ""}${e.supersedes.length ? ` · 替代 ${e.supersedes.join("、")}` : ""}${e.refines.length ? ` · 细化 ${e.refines.join("、")}` : ""})`;
}

export function committedPiFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "PiContactMindError") return false;
  const failure = error as Error & { committed?: boolean; retryableTruncation?: boolean };
  return failure.committed === true && failure.retryableTruncation !== true;
}

export function noteWithPending(note: string | null, pending: readonly Inbound[], excerpt = true): string | null {
  if (!pending.length) return note;
  const material = compactMaterial(pending, []);
  const prefix = note ?? "(没有旧状态笔记)";
  if (!excerpt || Buffer.byteLength(material) <= MAX_SUMMARY_BYTES) return `${prefix}\n[之前压缩失败,保留的未压缩原文]\n${material}`;
  // Only the main round gets bounded excerpts. The retrying compactor reads the full, revalidated material.
  const summary = deterministicSummary(pending.map((item) => ({
    id: item.kind === "message" ? `${item.roomId}#${item.seq}` : item.at,
    role: item.kind === "message" && item.sender.kind === "user" ? "user" : "assistant",
    text: renderInbound(item),
  })));
  return `${prefix}\n${summary}`;
}

type Remember = Extract<MindAction, { kind: "remember" }>;
type Appended = { roomId: string; seq: number };
interface RoundJob {
  contact: ContactProfile;
  compactor: ContactCompactor | undefined;
  max: number | null;
  roundId: string;
  fresh: readonly Inbound[];
  actions: readonly MindAction[];
  roomIdsAtStart: readonly string[];
  committedNote: string | null;
  noteVerAfterCommit: number;
  usage(kind: "compact" | "reflect"): UsageSink;
}
interface CompactionPorts {
  db: Db;
  memory: ConstructorParameters<typeof MemoryCoverage>[1];
  now(): string;
  newId(prefix: string): string;
  rooms(contactId: string): string[];
  visible(inputs: readonly Inbound[], rooms: readonly string[], scrubCopies?: boolean): Inbound[];
  scrub(contactId: string, note: string, rooms: readonly string[]): string;
  sources(inputs: readonly Inbound[]): ReflectSource[];
  neighbors(contactId: string, q: { rooms: readonly string[]; text: string }): { id: string; title: string; body: string }[];
  remember(contactId: string, a: Remember, rooms: Set<string>, actionId: string, appended: Appended[], fresh: readonly Inbound[]): string | null;
  afterAppend(contactId: string, sent: Appended): void;
  notify(contactId: string): void;
  report(what: string, detail: unknown): void;
}

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

function capture(ports: CompactionPorts, job: RoundJob, sources: ReflectSource[], memories: ReflectResult["memories"]) {
  const { contact: { id: contactId, speakingModel }, fresh, roomIdsAtStart } = job;
  const coverage = new MemoryCoverage(ports.db, ports.memory);
  const work = coverage.begin(contactId, sources.map(s => ({ roomId: s.roomId, seq: s.seq, revision: s.revision })), [], roomIdsAtStart, speakingModel);
  const entries = ports.memory.list(contactId);
  const current = ports.sources(fresh);
  const writes: CaptureWrite[] = [];
  let unresolved = 0;
  for (const [index, m] of memories.entries()) {
    if (m.roomId === undefined && m.sourceSeq === undefined && m.evidence === undefined) continue;
    if ((m.relation === null) !== (m.target === null)) {
      unresolved++;
      ports.report("memory-capture-rejected", { contactId, reason: "relation 和 target 必须一起提供" });
      continue;
    }
    const check = validateCapture(m, sources, current);
    if (!check.ok) { unresolved++; ports.report("memory-capture-rejected", { contactId, reason: check.reason }); continue; }
    const plan = planMemoryWrite(entries, {
      title: m.title, body: m.text, anchors: check.anchors,
      source: { roomId: check.source.roomId, seq: check.source.seq, revision: check.source.revision, userQuote: true, quote: m.evidence!, senderId: check.source.senderId },
      relation: m.relation === null ? null : { kind: m.relation, target: m.target ?? "" },
    }, ports.now(), () => ports.newId("m"));
    if (plan.kind === "invalid") { unresolved++; continue; }
    const id = `${work.id}:${index}:${m.roomId}:${m.sourceSeq}:${m.title}`;
    const after = plan.changed.map(e => ({ ...e, captureIds: [...(e.captureIds ?? []), id] }));
    writes.push({
      id, before: plan.changed.map(e => entries.find(x => x.id === e.id) ?? null), after,
      question: plan.kind === "ask-user" ? { roomId: check.source.roomId, text: `记忆“${m.title}”与已有记忆冲突，请确认是否保留这条新说法。` } : null,
    });
    for (const e of after) {
      const at = entries.findIndex(x => x.id === e.id);
      if (at < 0) entries.push(e); else entries[at] = e;
    }
  }
  coverage.prepare(work.id, writes, unresolved);
  coverage.apply(work.id, () => ports.notify(contactId));
}

async function settleNote(ports: CompactionPorts, job: RoundJob, previous: string | null, signal: AbortSignal, sourcesChanged: () => boolean) {
  const { contact, compactor, max, fresh, actions, roomIdsAtStart, committedNote, usage } = job;
  const contactId = contact.id;
  const stale = () => signal.aborted || sourcesChanged();
  const material = compactMaterial(fresh, actions);
  let note = committedNote;
  const remember: Remember[] = [];
  let persona: string | null = null;
  let applyCapture: (() => void) | undefined;
  let reflected = false;
  if (compactor?.reflect && fresh.length) {
    if (stale()) return null;
    const neighbors = ports.neighbors(contactId, { rooms: roomIdsAtStart, text: [previous ?? "", ...fresh.map(f => f.kind === "message" ? f.text : f.kind === "schedule" ? f.prompt : f.summary)].join("\n") });
    const sources = ports.sources(fresh);
    try {
      const r = await compactor.reflect({ contact, kind: "round-note", previous, material, maxBytes: max, neighbors, sources, noteWritten: committedNote }, signal, usage("reflect"));
      reflected = true;
      if (note === null) note = r.note;
      const lastUser = [...fresh].reverse().find((f): f is InboundMessage => f.kind === "message" && f.sender.kind === "user");
      const roomId = lastUser?.roomId ?? fresh[0]!.roomId;
      for (const m of r.memories) {
        if (m.roomId === undefined && m.sourceSeq === undefined && m.evidence === undefined) {
          remember.push({ kind: "remember", roomId, sourceSeq: lastUser?.seq ?? null, title: m.title, text: m.text, anchors: m.anchors, quote: null, relation: m.relation, target: m.target });
        }
      }
      applyCapture = () => capture(ports, job, sources, r.memories);
      persona = r.personaSuggestion;
    } catch (e) {
      if (committedPiFailure(e)) reflected = true;
      ports.report("reflect-failed", { contactId, error: errorText(e) });
    }
  }
  if (note === null && !reflected && compactor && fresh.length) {
    if (stale()) return null;
    try {
      note = await compactor.compact({ contact, kind: "round-note", previous, material, maxBytes: max }, signal, usage("compact"));
    } catch (e) {
      ports.report("compact-failed", { contactId, kind: "round-note", error: errorText(e) });
    }
  }
  if (note !== null && max !== null && Buffer.byteLength(note, "utf8") > max) {
    if (stale()) return null;
    if (compactor) {
      try {
        const shorter = await compactor.compact({ contact, kind: "shrink", previous: note, material: "", maxBytes: max }, signal, usage("compact"));
        if (Buffer.byteLength(shorter, "utf8") < Buffer.byteLength(note, "utf8")) note = shorter;
      } catch (e) {
        ports.report("compact-failed", { contactId, kind: "shrink", error: errorText(e) });
      }
    }
    if (Buffer.byteLength(note, "utf8") > max) ports.report("state-note-over-limit", { contactId, bytes: Buffer.byteLength(note, "utf8"), max });
  }
  if (stale()) return null;
  return { note: note === null ? null : ports.scrub(contactId, note, roomIdsAtStart), remember, persona, capture: applyCapture };
}

interface Queue {
  jobs: RoundJob[];
  done: Promise<void>;
}

/** Per-contact FIFO. Only successful adoption can advance a queued job's expected note version. */
export class BgCompactionCoordinator {
  private readonly queues = new Map<string, Queue>();
  private readonly controller = new AbortController();

  private readonly ports: CompactionPorts;

  constructor(ports: CompactionPorts) { this.ports = ports; }

  enqueue(job: RoundJob) {
    const { contact: { id, speakingModel }, committedNote, fresh, max } = job;
    if (this.controller.signal.aborted) return;
    if (job.compactor?.model !== undefined && job.compactor.model !== speakingModel) {
      this.ports.report("compression-model-mismatch", { contactId: id, reason: `压缩必须用 ${speakingModel},拒绝改用 ${job.compactor.model}` });
      job = { ...job, compactor: undefined };
    }
    if (!(job.compactor && fresh.length) && committedNote === null) return;
    if (committedNote !== null && (max === null || Buffer.byteLength(committedNote, "utf8") <= max) && !job.compactor?.reflect) return;
    const queue = this.queues.get(id);
    if (queue) {
      queue.jobs.push(job);
      return;
    }
    const next: Queue = { jobs: [job], done: Promise.resolve() };
    next.done = Promise.resolve().then(() => this.drain(id, next));
    this.queues.set(id, next);
  }

  busy(): boolean { return this.queues.size > 0; }

  async idle(): Promise<void> {
    while (this.busy()) await Promise.all([...this.queues.values()].map(q => q.done));
  }

  abortAll() { this.controller.abort(); }

  private async drain(contactId: string, queue: Queue) {
    while (!this.controller.signal.aborted && queue.jobs.length) {
      const job = queue.jobs.shift()!;
      try {
        const version = await this.run(job);
        if (version === undefined) continue;
        // New foreground batches can inherit this adoption, while an explicit note fences older work.
        for (const queued of queue.jobs) {
          if (queued.committedNote === null && queued.noteVerAfterCommit === job.noteVerAfterCommit) queued.noteVerAfterCommit = version;
        }
      } catch (e) {
        this.ports.report("bg-compaction-failed", { contactId, error: errorText(e) });
      }
    }
    // Retire the queue synchronously with the last empty check so enqueue cannot append to a drained queue.
    this.queues.delete(contactId);
  }

  private async run(job: RoundJob): Promise<number | undefined> {
    const ports = this.ports;
    const { db } = ports;
    const signal = this.controller.signal;
    const { contact: { id: contactId }, roomIdsAtStart, roundId, fresh, committedNote, noteVerAfterCommit } = job;
    const noteKey = `note:${contactId}`;
    const currentNote = getDoc<{ text: string }>(db, noteKey);
    const { batches } = readPendingNote(db, contactId);
    const idx = batches.findIndex(b => b.id === roundId);
    if (committedNote === null && idx < 0) return;
    const priorInputs = idx > 0 ? ports.visible(batches.slice(0, idx).flatMap(b => b.inputs), roomIdsAtStart, true) : [];
    const cleanNote = () => currentNote ? ports.scrub(contactId, currentNote.value.text, roomIdsAtStart) : null;
    const noteAtStart = cleanNote();
    const batchAtStart = batches[idx];
    const bgSourcesChanged = () => {
      const nowRooms = ports.rooms(contactId);
      return !same(nowRooms, roomIdsAtStart)
        || !same(ports.visible(priorInputs, nowRooms, true), priorInputs)
        || !same(ports.visible(fresh, nowRooms), fresh)
        || (getDoc(db, noteKey)?.ver ?? 0) !== noteVerAfterCommit
        || (batchAtStart !== undefined && !same(readPendingNote(db, contactId).batches.find(b => b.id === roundId), batchAtStart))
        || cleanNote() !== noteAtStart;
    };
    const previous = noteWithPending(noteAtStart, priorInputs, false);
    const settled = bgSourcesChanged() ? null : await settleNote(ports, job, previous, signal, bgSourcesChanged);
    if (signal.aborted) return;
    if (!settled || bgSourcesChanged()) {
      ports.report("stale-round", { contactId, reason: "检查期间压缩来源发生变化" });
      tx(db, () => scrubPendingNote(db, contactId, inputs => ports.visible(inputs, ports.rooms(contactId), true)));
      return;
    }
    const appended: Appended[] = [];
    let version: number | undefined;
    tx(db, () => {
      if (settled.note !== null && settled.note !== committedNote) {
        version = putDoc(db, noteKey, noteVerAfterCommit, { text: settled.note });
      }
      if (settled.note !== null && idx >= 0) {
        const live = readPendingNote(db, contactId);
        const watermark = live.batches.findIndex(b => b.id === roundId);
        if (watermark >= 0) writePendingNote(db, contactId, live.ver, live.batches.slice(watermark + 1));
      }
      const rooms = new Set(roomIdsAtStart);
      for (const [i, action] of settled.remember.entries()) {
        const reason = ports.remember(contactId, action, rooms, `${roundId}:reflect:${i}`, appended, fresh);
        if (reason) ports.report("action-rejected", { contactId, action, reason });
      }
      if (settled.persona) {
        const plan = planMemoryWrite(ports.memory.list(contactId), { title: "建议改人格", body: settled.persona, anchors: [PERSONA_ANCHOR], source: null, relation: null }, ports.now(), () => ports.newId("m"));
        if (plan.kind !== "invalid") for (const e of plan.changed) ports.memory.put(contactId, e);
        ports.report("persona-suggestion", { contactId, text: settled.persona });
      }
    });
    // A post-commit failure must not hide the note version already adopted by this job.
    try {
      settled.capture?.();
      for (const message of appended) ports.afterAppend(contactId, message);
    } catch (e) {
      ports.report("bg-compaction-failed", { contactId, error: errorText(e) });
    }
    return version;
  }
}
