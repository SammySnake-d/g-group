// 只追加的会话记录(AC-05)与发言者约束(AC-03)。
// 记录是不可变的事件序列:编辑、撤回都是新事件,永远不改旧事件;每个事件带 prev/hash 组成链,原地改写可被 verify 查出。
import { createHash } from "node:crypto";
import { DomainError } from "./errors.ts";

/** 会话里能发言的主体。Compute 不在其中:它的结果只能由联系人转述(AC-03)。Helper 只在被叫到的会话里作答。 */
export type SenderKind = "user" | "contact" | "helper";
export interface Sender { readonly kind: SenderKind; readonly id: string }
export type EventBody =
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "edit"; readonly target: number; readonly text: string }
  | { readonly kind: "retract"; readonly target: number };
export interface LogEvent {
  readonly seq: number;
  readonly at: string;
  readonly sender: Sender;
  readonly body: EventBody;
  readonly prev: string;
  readonly hash: string;
}
export interface Log { readonly events: readonly LogEvent[] }
export interface ProjectedMessage { seq: number; sender: Sender; text: string; edited: boolean; retracted: boolean }
export type VerifyResult = { ok: true } | { ok: false; brokenAt: number };

const GENESIS = "0".repeat(64);
const SENDERS: ReadonlySet<string> = new Set<SenderKind>(["user", "contact", "helper"]);

function hashOf(e: Omit<LogEvent, "hash">): string {
  return createHash("sha256").update(JSON.stringify([e.seq, e.at, e.sender.kind, e.sender.id, e.body, e.prev])).digest("hex");
}

export function emptyLog(): Log {
  return { events: [] };
}

function assertSender(s: { kind: string; id: string }): asserts s is Sender {
  if (!SENDERS.has(s.kind)) throw new DomainError("sender-not-allowed", s.kind);
}

function checkTarget(log: Log, sender: Sender, target: number): void {
  const msg = log.events.find((e) => e.seq === target);
  if (!msg) throw new DomainError("target-not-found", String(target));
  if (msg.body.kind !== "message") throw new DomainError("target-not-message", String(target));
  if (msg.sender.kind !== sender.kind || msg.sender.id !== sender.id) throw new DomainError("not-original-sender", String(target));
  if (log.events.some((e) => e.body.kind === "retract" && e.body.target === target)) throw new DomainError("target-retracted", String(target));
}

export function append(log: Log, sender: { kind: string; id: string }, body: EventBody, at: string): Log {
  assertSender(sender);
  if (body.kind !== "retract" && body.text.trim() === "") throw new DomainError("empty-text");
  if (body.kind !== "message") checkTarget(log, sender, body.target);
  const last = log.events.at(-1);
  const draft = { seq: (last?.seq ?? 0) + 1, at, sender: { kind: sender.kind, id: sender.id }, body, prev: last?.hash ?? GENESIS };
  return { events: [...log.events, { ...draft, hash: hashOf(draft) }] };
}

export function verify(log: Log): VerifyResult {
  let prev = GENESIS;
  for (const e of log.events) {
    const { hash, ...rest } = e;
    if (e.prev !== prev || hashOf(rest) !== hash) return { ok: false, brokenAt: e.seq };
    prev = hash;
  }
  return { ok: true };
}

/** 把事件序列折叠成用户看到的消息列表;只读,不改记录。 */
export function project(log: Log): ProjectedMessage[] {
  const out = new Map<number, ProjectedMessage>();
  for (const e of log.events) {
    const b = e.body;
    if (b.kind === "message") out.set(e.seq, { seq: e.seq, sender: e.sender, text: b.text, edited: false, retracted: false });
    else {
      const m = out.get(b.target);
      if (!m) continue;
      if (b.kind === "edit") out.set(b.target, { ...m, text: b.text, edited: true });
      else out.set(b.target, { ...m, text: "", retracted: true });
    }
  }
  return [...out.values()];
}
