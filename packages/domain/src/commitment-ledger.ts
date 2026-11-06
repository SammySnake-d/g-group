import { types } from "node:util";

export interface Actor { readonly kind: "user" | "contact" | "compute"; readonly id: string }
export interface Message {
  readonly id: string;
  readonly seq: number;
  readonly sender: Actor;
  readonly text: string;
  readonly taskId: string | null;
  readonly replyToSeq: number | null;
  readonly handled: boolean;
}
export interface Commitment {
  readonly id: string;
  readonly sourceSeq: number;
  readonly taskId: string;
  readonly text: string;
  readonly status: "active" | "done" | "revoked" | "superseded" | "blocked";
  readonly resolution: { readonly detail: string | null; readonly artifact: string | null } | null;
}
export interface Ledger {
  readonly ownerId: string;
  readonly version: number;
  readonly messages: readonly Message[];
  readonly commitments: readonly Commitment[];
  readonly actions: readonly { readonly id: string; readonly payload: string }[];
  readonly activity: readonly { readonly roundId: string; readonly commitmentId: string; readonly taskId: string; readonly actor: Actor; readonly kind: "progress" | "close"; readonly text: string | null }[];
}
export type Proposal = { readonly id: string; readonly taskId: string; readonly text: string };
/** Candidate fields are data only. This slice does not interpret or enable them. */
export interface CandidatePolicy {
  readonly disposition?: unknown;
  readonly reconciliation?: unknown;
  readonly stepBoundary?: unknown;
  readonly wake?: unknown;
  readonly labels?: unknown;
}
export type Command =
  | { readonly type: "receive"; readonly actionId: string; readonly message: Omit<Message, "handled"> }
  | { readonly type: "process"; readonly actionId: string; readonly seq: number; readonly accepted: boolean; readonly commitments: readonly Proposal[] }
  | { readonly type: "progress"; readonly actionId: string; readonly commitmentId: string; readonly taskId: string; readonly actor: Actor; readonly roundId: string; readonly text: string }
  | { readonly type: "close"; readonly actionId: string; readonly commitmentId: string; readonly taskId: string; readonly actor: Actor; readonly roundId: string; readonly outcome: "done" | "revoked" | "superseded" | "blocked"; readonly artifact: string | null; readonly detail: string | null };
export type Failure = { readonly ok: false; readonly reason: string };
export type Result = { readonly ok: true; readonly ledger: Ledger; readonly duplicate: boolean } | Failure;
export type Reconciliation = { readonly ok: true; readonly ready: boolean; readonly pending: readonly string[] } | { readonly ok: false; readonly reason: string };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// External values are copied through descriptors before any property is read.
function jsonCopy(value: unknown, ancestors = new Set<object>()): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) throw new TypeError("invalid JSON data");
  const proto = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new TypeError("invalid prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) throw new TypeError("symbol key");
  ancestors.add(value);
  const out: Json[] | { [key: string]: Json } = array ? [] : {};
  const length = array ? (descriptors.length?.value as number) : 0;
  if (array && (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1)) throw new TypeError("invalid array");
  for (const key of keys as string[]) {
    if (array && key === "length") continue;
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.get || descriptor.set ||
      key === "__proto__" || key === "prototype" || key === "constructor" ||
      (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) throw new TypeError("invalid property");
    Object.defineProperty(out, key, { value: jsonCopy(descriptor.value, ancestors), enumerable: true, configurable: true, writable: true });
  }
  ancestors.delete(value);
  return out;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

const obj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;
const maybeText = (x: unknown): x is string | null => x === null || text(x);
const seq = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const version = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const keys = (x: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(x).length === expected.length && expected.every((key) => Object.hasOwn(x, key));
const actor = (x: unknown): x is Actor => obj(x) && keys(x, ["kind", "id"]) &&
  (x.kind === "user" || x.kind === "contact" || x.kind === "compute") && text(x.id);
const message = (x: unknown, handled: boolean): boolean => obj(x) &&
  keys(x, handled ? ["id", "seq", "sender", "text", "taskId", "replyToSeq", "handled"] : ["id", "seq", "sender", "text", "taskId", "replyToSeq"]) &&
  text(x.id) && seq(x.seq) && actor(x.sender) && text(x.text) && maybeText(x.taskId) &&
  (x.replyToSeq === null || seq(x.replyToSeq)) && (!handled || typeof x.handled === "boolean");
const proposal = (x: unknown): x is Proposal => obj(x) && keys(x, ["id", "taskId", "text"]) && text(x.id) && text(x.taskId) && text(x.text);

function isLedger(x: unknown): x is Ledger {
  if (!obj(x) || !keys(x, ["ownerId", "version", "messages", "commitments", "actions", "activity"]) ||
      !text(x.ownerId) || !version(x.version) || !Array.isArray(x.messages) || !Array.isArray(x.commitments) ||
      !Array.isArray(x.actions) || !Array.isArray(x.activity)) return false;
  if (!x.messages.every((m: unknown) => message(m, true))) return false;
  if (!x.commitments.every((c: unknown) => obj(c) && keys(c, ["id", "sourceSeq", "taskId", "text", "status", "resolution"]) &&
      text(c.id) && seq(c.sourceSeq) && text(c.taskId) && text(c.text) &&
      (c.status === "active" || c.status === "done" || c.status === "revoked" || c.status === "superseded" || c.status === "blocked") &&
      (c.resolution === null || (obj(c.resolution) && keys(c.resolution, ["detail", "artifact"]) && maybeText(c.resolution.detail) && maybeText(c.resolution.artifact))))) return false;
  if (!x.actions.every((a: unknown) => obj(a) && keys(a, ["id", "payload"]) && text(a.id) && typeof a.payload === "string") ||
      !x.activity.every((a: unknown) => obj(a) && keys(a, ["roundId", "commitmentId", "taskId", "actor", "kind", "text"]) && text(a.roundId) && text(a.commitmentId) && text(a.taskId) &&
        actor(a.actor) && (a.kind === "progress" || a.kind === "close") && maybeText(a.text))) return false;
  const messages = x.messages as Message[];
  const commitments = x.commitments as Commitment[];
  const actions = x.actions as { id: string }[];
  return new Set(messages.map((m) => m.id)).size === messages.length && new Set(messages.map((m) => m.seq)).size === messages.length &&
    new Set(commitments.map((c) => c.id)).size === commitments.length && new Set(actions.map((a) => a.id)).size === actions.length &&
    commitments.every((c) => messages.some((m) => m.seq === c.sourceSeq && m.handled) &&
      (c.status === "active" ? c.resolution === null : c.resolution !== null &&
        (c.status === "done" ? text(c.resolution.artifact) : text(c.resolution.detail)))) &&
    x.activity.every((a: { commitmentId: string; taskId: string }) => commitments.some((c) => c.id === a.commitmentId && c.taskId === a.taskId));
}

function isCommand(x: unknown): x is Command {
  if (!obj(x) || !text(x.actionId)) return false;
  if (x.type === "receive") return keys(x, ["type", "actionId", "message"]) && message(x.message, false);
  if (x.type === "process") return keys(x, ["type", "actionId", "seq", "accepted", "commitments"]) && seq(x.seq) &&
    typeof x.accepted === "boolean" && Array.isArray(x.commitments) && x.commitments.every(proposal);
  if (x.type === "progress") return keys(x, ["type", "actionId", "commitmentId", "taskId", "actor", "roundId", "text"]) &&
    text(x.commitmentId) && text(x.taskId) && actor(x.actor) && text(x.roundId) && text(x.text);
  return x.type === "close" && keys(x, ["type", "actionId", "commitmentId", "taskId", "actor", "roundId", "outcome", "artifact", "detail"]) &&
    text(x.commitmentId) && text(x.taskId) && actor(x.actor) && text(x.roundId) &&
    (x.outcome === "done" || x.outcome === "revoked" || x.outcome === "superseded" || x.outcome === "blocked") &&
    maybeText(x.artifact) && maybeText(x.detail);
}

function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}

const fail = (reason: string): Failure => ({ ok: false, reason });

export function emptyLedger(ownerId: unknown): Ledger | Failure {
  if (!text(ownerId)) return fail("invalid-input");
  return freeze({ ownerId, version: 0, messages: [], commitments: [], actions: [], activity: [] });
}

/** Produces a proposed snapshot. The host must persist it atomically before the next action. */
export function applyLedger(ledger: Ledger, expectedVersion: number, command: Command, artifactExists?: (id: string) => boolean): Result {
  let state: unknown;
  let input: unknown;
  try { state = jsonCopy(ledger); input = jsonCopy(command); } catch { return fail("invalid-input"); }
  if (!isLedger(state) || !isCommand(input) || !version(expectedVersion)) return fail("invalid-input");
  const payload = canonical(input as unknown as Json);
  const previous = state.actions.find((a) => a.id === input.actionId);
  if (previous) return previous.payload === payload ? { ok: true, ledger: freeze(state), duplicate: true } : fail("action-id-conflict");
  if (state.version !== expectedVersion) return fail("version-conflict");

  let messages = [...state.messages];
  let commitments = [...state.commitments];
  const activity = [...state.activity];
  if (input.type === "receive") {
    const m = input.message;
    if (m.sender.kind === "compute") return fail("sender-not-allowed");
    const old = messages.find((entry) => entry.id === m.id);
    if (old) {
      const { handled: _handled, ...prior } = old;
      if (canonical(prior as unknown as Json) !== canonical(m as unknown as Json)) return fail("message-id-conflict");
      const repeat: Ledger = { ...state, version: state.version + 1, actions: [...state.actions, { id: input.actionId, payload }] };
      return { ok: true, ledger: freeze(repeat), duplicate: true };
    }
    if (messages.some((entry) => entry.seq === m.seq)) return fail("seq-conflict");
    if (m.replyToSeq !== null) {
      const parent = messages.find((entry) => entry.seq === m.replyToSeq);
      if (!parent) return fail("reply-not-found");
      if (parent.taskId !== m.taskId) return fail("task-mismatch");
    }
    messages.push({ ...m, handled: false });
  } else if (input.type === "process") {
    const m = messages.find((entry) => entry.seq === input.seq);
    if (!m) return fail("message-not-found");
    if (m.handled) return fail("already-processed");
    if (m.sender.kind === "user" && !input.accepted && input.commitments.length) return fail("not-accepted");
    if (m.sender.kind === "contact" && m.sender.id !== state.ownerId && input.commitments.length) return fail("actor-not-allowed");
    if (input.commitments.some((c) => m.taskId !== null && c.taskId !== m.taskId)) return fail("task-mismatch");
    const ids = input.commitments.map((c) => c.id);
    if (new Set(ids).size !== ids.length || ids.some((id) => commitments.some((c) => c.id === id))) return fail("commitment-id-conflict");
    messages = messages.map((entry) => entry.seq === m.seq ? { ...entry, handled: true } : entry);
    commitments.push(...input.commitments.map((c) => ({ ...c, sourceSeq: m.seq, status: "active" as const, resolution: null })));
  } else {
    const current = commitments.find((c) => c.id === input.commitmentId);
    if (!current) return fail("commitment-not-found");
    if (current.taskId !== input.taskId) return fail("task-mismatch");
    if (current.status !== "active") return fail("commitment-closed");
    if (input.type === "progress") {
      if (input.actor.kind === "user" || (input.actor.kind === "contact" && input.actor.id !== state.ownerId)) return fail("actor-not-allowed");
    } else {
      if (input.actor.kind === "compute" || (input.actor.kind === "contact" && input.actor.id !== state.ownerId) ||
          (input.actor.kind === "user" && input.outcome !== "revoked")) return fail("actor-not-allowed");
      if (input.outcome === "done") {
        let exists = false;
        try { exists = !!input.artifact && typeof artifactExists === "function" && !types.isProxy(artifactExists) && artifactExists(input.artifact) === true; } catch { /* unresolved is not completion */ }
        if (!exists) return fail("artifact-not-found");
      } else if (!input.detail || input.artifact !== null) return fail("resolution-required");
      commitments = commitments.map((c) => c.id === current.id ? { ...c, status: input.outcome, resolution: { artifact: input.artifact, detail: input.detail } } : c);
    }
    activity.push({ roundId: input.roundId, commitmentId: current.id, taskId: current.taskId, actor: input.actor,
      kind: input.type, text: input.type === "progress" ? input.text : input.detail });
  }
  const next: Ledger = { ...state, version: state.version + 1, messages, commitments, activity,
    actions: [...state.actions, { id: input.actionId, payload }] };
  return { ok: true, ledger: freeze(next), duplicate: false };
}

export function reconcileRound(ledger: Ledger, roundId: string, boundIds: readonly string[]): Reconciliation {
  let state: unknown;
  let ids: unknown;
  try { state = jsonCopy(ledger); ids = jsonCopy(boundIds); } catch { return { ok: false, reason: "invalid-input" }; }
  if (!isLedger(state) || !text(roundId) || !Array.isArray(ids) || !ids.every(text) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid-input" };
  if (ids.some((id) => !state.commitments.some((c) => c.id === id))) return { ok: false, reason: "commitment-not-found" };
  const pending = ids.filter((id) => {
    const c = state.commitments.find((entry) => entry.id === id)!;
    return c.status === "active" && !state.activity.some((a) => a.roundId === roundId && a.commitmentId === id && a.taskId === c.taskId);
  });
  return { ok: true, ready: pending.length === 0, pending: Object.freeze(pending) };
}
