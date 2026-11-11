// 只追加的会话记录(AC-05)与发言者约束(AC-03)。
// 记录是不可变的事件序列:编辑、撤回都是新事件,永远不改旧事件;每个事件带 prev/hash 组成链,原地改写可被 verify 查出。
import { createHash } from "node:crypto";
import { DomainError } from "./errors.ts";

/**
 * 会话里能发言的主体。Compute 不在其中:它的结果只能由联系人转述(AC-03)。Helper 只在被叫到的会话里作答。
 * system 只给宿主自己的通知用(如解散说明):照常写进只追加记录,对联系人只作上下文(见 contextOnly)。
 */
export type SenderKind = "user" | "contact" | "helper" | "system";
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
const SENDERS: ReadonlySet<string> = new Set<SenderKind>(["user", "contact", "helper", "system"]);

/**
 * 追加时的额外权限,由宿主按会话查出后传入:群主能撤回群里任何人的消息(U26「群主删消息」、U03);
 * 编辑仍只认原发言者。不给(私聊、非群)就只有原发言者能编辑或撤回。
 */
export interface AppendAuthority {
  readonly groupOwner?: { readonly kind: string; readonly id: string } | null;
}

/** 只作上下文的发言者(宿主的 system 通知):联系人收到它不产生处置义务——不进待处理、不能作为接活或承诺的来源。 */
export function contextOnly(sender: { readonly kind: string }): boolean {
  return sender.kind === "system";
}

const sameSender = (a: { kind: string; id: string }, b: { kind: string; id: string }) => a.kind === b.kind && a.id === b.id;

function hashOf(e: Omit<LogEvent, "hash">): string {
  return createHash("sha256").update(JSON.stringify([e.seq, e.at, e.sender.kind, e.sender.id, e.body, e.prev])).digest("hex");
}

export function emptyLog(): Log {
  return Object.freeze({ events: Object.freeze([]) });
}

/** 只拷贝合同里的字段,和调用方不共享任何可变引用;冻结后已提交事件不能被原地改写。 */
function snapshotBody(b: EventBody): EventBody {
  switch (b.kind) {
    case "message": return Object.freeze({ kind: "message", text: String(b.text) });
    case "edit": return Object.freeze({ kind: "edit", target: Number(b.target), text: String(b.text) });
    case "retract": return Object.freeze({ kind: "retract", target: Number(b.target) });
  }
}

function assertSender(s: { kind: string; id: string }): asserts s is Sender {
  if (!SENDERS.has(s.kind)) throw new DomainError("sender-not-allowed", s.kind);
}

function checkTarget(log: Log, sender: Sender, body: Exclude<EventBody, { kind: "message" }>, owner: { kind: string; id: string } | null): void {
  const target = body.target;
  const msg = log.events.find((e) => e.seq === target);
  if (!msg) throw new DomainError("target-not-found", String(target));
  if (msg.body.kind !== "message") throw new DomainError("target-not-message", String(target));
  // 原发言者本人;或撤回时发起人正是群主(只认宿主给的群主身份,发起人自称不算)
  const byOwner = body.kind === "retract" && owner !== null && sameSender(owner, sender);
  if (!sameSender(msg.sender, sender) && !byOwner) throw new DomainError("not-original-sender", String(target));
  if (log.events.some((e) => e.body.kind === "retract" && e.body.target === target)) throw new DomainError("target-retracted", String(target));
}

export function append(log: Log, sender: { kind: string; id: string }, body: EventBody, at: string, authority: AppendAuthority = {}): Log {
  assertSender(sender);
  if (body.kind !== "retract" && body.text.trim() === "") throw new DomainError("empty-text");
  const o = authority.groupOwner;
  if (body.kind !== "message") checkTarget(log, sender, body, o ? { kind: String(o.kind), id: String(o.id) } : null);
  const last = log.events.at(-1);
  const draft = {
    seq: (last?.seq ?? 0) + 1,
    at: String(at),
    sender: Object.freeze({ kind: sender.kind, id: String(sender.id) }),
    body: snapshotBody(body),
    prev: last?.hash ?? GENESIS,
  };
  const event: LogEvent = Object.freeze({ ...draft, hash: hashOf(draft) });
  return Object.freeze({ events: Object.freeze([...log.events, event]) });
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
    if (b.kind === "message") out.set(e.seq, { seq: e.seq, sender: { ...e.sender }, text: b.text, edited: false, retracted: false });
    else {
      const m = out.get(b.target);
      if (!m) continue;
      if (b.kind === "edit") out.set(b.target, { ...m, text: b.text, edited: true });
      else out.set(b.target, { ...m, text: "", retracted: true });
    }
  }
  return [...out.values()];
}
