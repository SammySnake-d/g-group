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
  readonly activity: readonly { readonly roundId: string; readonly commitmentId: string; readonly taskId: string }[];
}
export type Proposal = { readonly id: string; readonly taskId: string; readonly text: string };
export type Command =
  | { readonly type: "receive"; readonly actionId: string; readonly message: Omit<Message, "handled"> }
  | { readonly type: "process"; readonly actionId: string; readonly seq: number; readonly accepted: boolean; readonly commitments: readonly Proposal[] }
  | { readonly type: "progress"; readonly actionId: string; readonly commitmentId: string; readonly taskId: string; readonly actor: Actor; readonly roundId: string; readonly text: string }
  | { readonly type: "close"; readonly actionId: string; readonly commitmentId: string; readonly taskId: string; readonly actor: Actor; readonly roundId: string; readonly outcome: "done" | "revoked" | "superseded" | "blocked"; readonly artifact: string | null; readonly detail: string | null };
export type Result = { readonly ok: true; readonly ledger: Ledger; readonly duplicate: boolean } | { readonly ok: false; readonly reason: string };
export type Reconciliation = { readonly ok: true; readonly ready: boolean; readonly pending: readonly string[] } | { readonly ok: false; readonly reason: string };

export function emptyLedger(ownerId: string): Ledger {
  return { ownerId, version: 0, messages: [], commitments: [], actions: [], activity: [] };
}

export function applyLedger(_ledger: Ledger, _expectedVersion: number, _command: Command, _artifactExists?: (id: string) => boolean): Result {
  return { ok: false, reason: "not-implemented" };
}

export function reconcileRound(_ledger: Ledger, _roundId: string, _boundIds: readonly string[]): Reconciliation {
  return { ok: false, reason: "not-implemented" };
}
